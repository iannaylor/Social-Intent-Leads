"""
FastAPI app for the hosted social-intent-leads pipeline.

Endpoints:
  POST /runs                        — phase 1: search + score every candidate (cheap-ish)
  POST /runs/{run_id}/process-batch — phase 2: enrich/email/draft the next N pending candidates
  GET  /runs/{run_id}               — poll run or batch-job status/summary
  GET  /queue                        — fetch all actionable items (what the extension renders)
  POST /queue/status                 — mark an item queued_followup or done
  GET  /products                     — list configured products (name/context/keywords/ICP)
  POST /products                     — create or update a product's context (upsert by key)

Split into two phases after the first real run processed all 151 candidates
found (enrichment included) when only 10 were wanted. Phase 1 is always run
in full — it's just search + Claude scoring, no RichAPI enrichment. Phase 2
(the expensive part) only runs on a caller-specified batch size at a time,
via POST /runs/{run_id}/process-batch, callable any time later since the
pending pool is durable in Airtable, not held in memory.

Auth: simple Bearer token against BACKEND_API_KEYS (comma-separated env var).
Good enough for a handful of internal users — not meant to scale past that
without revisiting (see SETUP.md).

Run status is kept in an in-process dict, not a database — it resets on
restart/redeploy, but that's fine, since actual results are durably written
to Airtable by the time a run completes. Only in-flight run status is
ephemeral.
"""

import os
import uuid
import datetime
import traceback

from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware

from models import SearchProfile, ProcessBatchRequest
import pipeline
import airtable_store
import products_store
import profiles_store
import claude_client
import voice_store
import voice_generator
import airtable_setup

app = FastAPI(title="Social Intent Leads Backend")

# Chrome extensions call this from a chrome-extension:// origin — CORS must
# allow it. Tightening this to a specific extension ID is possible later;
# "*" is fine for an internal tool with its own API-key auth layer.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _provision_airtable_tables():
    """A fresh deploy against a brand new (empty) Airtable base won't have
    any of the tables this app needs — auto-create them instead of
    requiring a user to hand-build a schema that was never documented.
    Logged but not fatal: missing/bad credentials at this point shouldn't
    take the whole service down (so /health still responds instead of the
    app failing to boot) — a real request against a missing table will
    just surface Airtable's own 404 until the env vars are fixed and the
    service restarts, which re-runs this."""
    try:
        await airtable_setup.ensure_table(airtable_setup.LEADS_TABLE, airtable_setup.LEADS_FIELDS)
        await airtable_setup.ensure_table(airtable_setup.PRODUCTS_TABLE, airtable_setup.PRODUCTS_FIELDS)
        await airtable_setup.ensure_table(airtable_setup.PROFILES_TABLE, airtable_setup.PROFILES_FIELDS)
        await airtable_setup.ensure_table(airtable_setup.VOICE_TABLE, airtable_setup.VOICE_FIELDS)
        print("[app] Airtable tables verified/created", flush=True)
    except Exception as e:
        print(f"[app] Airtable table provisioning failed at startup (will retry lazily on first use): {e}", flush=True)


RUNS: dict[str, dict] = {}


def _valid_keys() -> set[str]:
    raw = os.environ.get("BACKEND_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


def require_auth(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token not in _valid_keys():
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/runs")
async def create_run(
    profile: SearchProfile,
    background_tasks: BackgroundTasks,
    authorization: str = Header(default=""),
):
    """Phase 1 only — search + score. Does not enrich, email, or draft
    anything yet. Call POST /runs/{run_id}/process-batch afterward to
    actually process candidates, as many or as few at a time as wanted."""
    require_auth(authorization)
    run_id = str(uuid.uuid4())
    RUNS[run_id] = {
        "runId": run_id,
        "kind": "scan",
        "status": "pending",
        "product": profile.product,
        "createdAt": datetime.datetime.utcnow().isoformat(),
        "error": None,
        "report": None,
    }
    background_tasks.add_task(_execute_scan, run_id, profile.model_dump())
    return RUNS[run_id]


async def _execute_scan(run_id: str, profile: dict):
    RUNS[run_id]["status"] = "running"
    try:
        report = await pipeline.search_and_score(profile, run_id)
        RUNS[run_id]["status"] = "completed"
        RUNS[run_id]["report"] = report
    except Exception as e:
        RUNS[run_id]["status"] = "failed"
        RUNS[run_id]["error"] = f"{e}\n{traceback.format_exc()}"


@app.post("/runs/{run_id}/process-batch")
async def create_batch(
    run_id: str,
    body: ProcessBatchRequest,
    background_tasks: BackgroundTasks,
    authorization: str = Header(default=""),
):
    """Phase 2 — enrich, email-find, and draft the next `batchSize`
    highest-priority candidates still sitting in the pending pool for this
    product. Safe to call repeatedly, any time later — the pool lives in
    Airtable, not in this process's memory."""
    api_key = require_auth(authorization)
    voice_profile = await voice_store.get_voice_profile(api_key)
    batch_id = str(uuid.uuid4())
    RUNS[batch_id] = {
        "runId": batch_id,
        "kind": "batch",
        "parentRunId": run_id,
        "status": "pending",
        "product": body.profile.product,
        "createdAt": datetime.datetime.utcnow().isoformat(),
        "error": None,
        "report": None,
    }
    background_tasks.add_task(
        _execute_batch, batch_id, run_id, body.profile.model_dump(), body.batchSize, voice_profile
    )
    return RUNS[batch_id]


async def _execute_batch(batch_id: str, run_id: str, profile: dict, batch_size: int, voice_profile: dict | None):
    RUNS[batch_id]["status"] = "running"
    try:
        report = await pipeline.process_batch(profile, run_id, batch_size, voice_profile)
        RUNS[batch_id]["status"] = "completed"
        RUNS[batch_id]["report"] = report
    except Exception as e:
        RUNS[batch_id]["status"] = "failed"
        RUNS[batch_id]["error"] = f"{e}\n{traceback.format_exc()}"


@app.get("/runs/{run_id}")
async def get_run(run_id: str, authorization: str = Header(default="")):
    require_auth(authorization)
    if run_id not in RUNS:
        raise HTTPException(status_code=404, detail="Unknown run_id")
    return RUNS[run_id]


@app.get("/queue")
async def get_queue(
    product: str | None = None,
    profileSlug: str | None = None,
    authorization: str = Header(default=""),
):
    require_auth(authorization)
    items = await airtable_store.get_queue(product=product, profile_slug=profileSlug)
    return {"items": items}


@app.get("/pending-preview")
async def pending_preview(product: str, limit: int = 10, authorization: str = Header(default="")):
    """Free look at the pending_batch pool for a product before spending
    anything on it — score distribution and the highest-priority items
    that 'Process next N' would actually pick up. Pure Airtable read (the
    scores/flags were already set for free during phase 1), so this can be
    checked as often as wanted before deciding whether processing the next
    batch is worth it or just more of the same low-priority backlog."""
    require_auth(authorization)
    pool = await airtable_store.get_pending_batch(product)
    score_distribution = {str(i): 0 for i in range(1, 6)}
    direct_buyer_count = 0
    influencer_count = 0
    for item in pool:
        score = item.get("score")
        if score in range(1, 6):
            score_distribution[str(score)] += 1
        if item.get("connectReason") == "direct-buyer":
            direct_buyer_count += 1
        if item.get("isInfluencer"):
            influencer_count += 1
    return {
        "totalPending": len(pool),
        "scoreDistribution": score_distribution,
        "directBuyerCount": direct_buyer_count,
        "influencerCount": influencer_count,
        "nextBatch": [
            {
                "name": item.get("name"),
                "score": item.get("score"),
                "isInfluencer": item.get("isInfluencer", False),
                "connectReason": item.get("connectReason"),
            }
            for item in pool[:limit]
        ],
    }


@app.post("/queue/status")
async def set_status(body: dict, authorization: str = Header(default="")):
    require_auth(authorization)
    post_url = body.get("postUrl")
    status = body.get("status")
    if not post_url or status not in ("pending", "queued_followup", "done"):
        raise HTTPException(status_code=400, detail="postUrl and a valid status are required")
    updated = await airtable_store.set_item_status(post_url, status)
    if not updated:
        raise HTTPException(status_code=404, detail="No item with that postUrl")
    return {"ok": True}


@app.post("/queue/generate-comment")
async def generate_comment(body: dict, authorization: str = Header(default="")):
    """On-demand override for a reviewed skip: 'the AI called this off-topic,
    but I read the post and there's actually something here — draft it
    anyway.' Synchronous (one Claude call, fast) rather than a background
    job like scans/batches. Drafts as a plain comment, never comment+connect
    — an override is a judgment call worth a comment, not automatically a
    connection request."""
    api_key = require_auth(authorization)
    post_url = body.get("postUrl")
    if not post_url:
        raise HTTPException(status_code=400, detail="postUrl is required")

    item = await airtable_store.get_item_by_post_url(post_url)
    if not item:
        raise HTTPException(status_code=404, detail="No item with that postUrl")
    if not item.get("commentary"):
        raise HTTPException(
            status_code=422,
            detail="No stored post content to draft from (an older record from before this was saved).",
        )

    voice_profile = await voice_store.get_voice_profile(api_key)
    product_config = await products_store.get_product_config(item["product"])
    try:
        draft = await claude_client.draft_content(
            product_config,
            item["commentary"],
            item.get("score", 0),
            item.get("isInfluencer", False),
            "comment",
            None,
            voice_profile,
        )
    except Exception as e:
        # draft_content() now raises on an empty comment (previously it
        # would have silently returned one, writing a blank Comment field
        # with no way to tell from the UI that drafting actually failed —
        # same class of bug fixed in pipeline.py's batch path). Surface it
        # as a clean error here too instead of a raw unhandled 500, so the
        # "Generate Comment Anyway" click visibly fails and can be retried.
        raise HTTPException(status_code=502, detail=f"Comment drafting failed: {e}")
    await airtable_store.update_items(
        [
            {
                "recordId": item["recordId"],
                "action": "comment",
                "comment": draft.get("comment"),
                "skipReason": "",  # explicitly clear — this is no longer a skip
            }
        ]
    )
    return {"comment": draft.get("comment")}


@app.post("/queue/retry-enrichment")
async def retry_enrichment(body: dict, authorization: str = Header(default="")):
    """A genuine retry, not an override: re-runs the actual ICP
    verification (enrich_profile + company_enricher) for a candidate that
    got skipped because that call failed transiently — distinct from
    /queue/generate-comment, which bypasses verification entirely rather
    than re-attempting it. Live feedback (2026-07-21): a RichAPI account
    with plenty of credits remaining still hit an enrich_profile failure,
    and there was no way to just try again short of a full batch re-run."""
    api_key = require_auth(authorization)
    post_url = body.get("postUrl")
    if not post_url:
        raise HTTPException(status_code=400, detail="postUrl is required")

    item = await airtable_store.get_item_by_post_url(post_url)
    if not item:
        raise HTTPException(status_code=404, detail="No item with that postUrl")

    voice_profile = await voice_store.get_voice_profile(api_key)
    result = await pipeline.retry_enrichment(item, voice_profile)
    await airtable_store.update_items([{"recordId": item["recordId"], **result}])
    return result


@app.post("/overlay/quick-add")
async def overlay_quick_add(body: dict, authorization: str = Header(default="")):
    """The live-browsing overlay (content.js, opt-in) flags posts matching a
    product's keywords while the user is just scrolling their feed —
    outside the normal search/scan pipeline entirely, no Airtable record
    exists for them yet. This is the "Generate Comment" action on that
    badge: the click itself IS the relevance signal (a human already
    looked at it), so this skips score_post() and drafts directly, then
    creates a real record so the post (a) shows up in the normal Queue,
    and (b) gets picked up by the existing reply-detection machinery once
    the comment is actually posted and someone replies to it."""
    api_key = require_auth(authorization)
    post_url = body.get("postUrl")
    post_text = body.get("postText")
    if not post_url or not post_text:
        raise HTTPException(status_code=400, detail="postUrl and postText are required")

    product_key = body.get("productKey")
    if product_key:
        try:
            product_config = await products_store.get_product_config(product_key)
        except KeyError as e:
            raise HTTPException(status_code=422, detail=str(e))
    else:
        # No key sent — fall back to best-effort keyword inference, same
        # pattern /queue/draft-reply already uses for scraped-page content
        # with no Airtable match to look up a product from.
        product_config = await products_store.infer_product_from_text(post_text)
    if not product_config:
        raise HTTPException(status_code=422, detail="Could not resolve a product for this post")

    voice_profile = await voice_store.get_voice_profile(api_key)
    # Manually assigned, not run through score_post() — the overlay only
    # ever badges a keyword hit a human then chose to act on, which is a
    # stronger signal than an unreviewed AI score. 4 sits at the "product
    # mention allowed" threshold draft_content's own prompt rule checks
    # (claude_client.py), same as a real score_post() 4/5 would.
    score = 4
    try:
        draft = await claude_client.draft_content(
            product_config, post_text, score, False, "comment", None, voice_profile,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Comment drafting failed: {e}")

    item = {
        "postUrl": post_url,
        "name": body.get("authorName"),
        "profileUrl": body.get("authorProfileUrl"),
        "product": product_key or product_config["name"],
        "commentary": post_text,
        "score": score,
        "action": "comment",
        "comment": draft.get("comment"),
        "sourceLabel": "live-overlay",
    }
    await airtable_store.upsert_items([item], None)
    return {"comment": draft.get("comment")}


@app.get("/queue/lookup-by-name")
async def lookup_by_name(name: str, authorization: str = Header(default="")):
    """Resolves a person's name to their stored record — for surfaces with
    no post link at all to go on, e.g. a LinkedIn DIRECT MESSAGE ('thanks
    for your comment on my post') with nothing but the sender's name.
    /queue/draft-reply already does its own lookup once given a postUrl,
    so this only needs to bridge name -> postUrl; nothing else duplicates
    that endpoint's logic."""
    require_auth(authorization)
    item = await airtable_store.get_item_by_name(name)
    if not item:
        raise HTTPException(status_code=404, detail="No record found for that name")
    # postText/ownComment included directly — /queue/draft-reply validates
    # "at least one of postText/ownComment" BEFORE it does its own
    # postUrl lookup, so a caller working from a name (no scraped page
    # content at all) needs to pass these through itself rather than
    # relying on that endpoint's internal enrichment alone.
    return {
        "postUrl": item.get("postUrl"),
        "name": item.get("name"),
        "postText": item.get("commentary"),
        "ownComment": item.get("comment"),
    }


@app.post("/queue/draft-reply")
async def draft_reply(body: dict, authorization: str = Header(default="")):
    """Someone replied to a comment already left on their post — the
    extension's content script scrapes the original post, our own comment,
    and their reply directly off the LinkedIn page and sends all three
    here. postUrl is optional enrichment, not a requirement: if it matches
    a tracked Airtable record, that record's stored text/product/score are
    preferred (cleaner, and gives accurate product context); if not, the
    scraped text alone is enough to draft from, with product identified by
    best-effort keyword matching (or left out entirely rather than risk
    naming the wrong one). Never auto-posts anything; this only returns a
    draft for the human to review, edit, and paste in themselves, same
    boundary as every other draft in this pipeline."""
    api_key = require_auth(authorization)
    post_url = body.get("postUrl")
    reply_text = body.get("replyText")
    post_text = body.get("postText")
    own_comment = body.get("ownComment")
    if not reply_text or not (post_text or own_comment):
        raise HTTPException(
            status_code=400,
            detail="replyText and at least one of postText/ownComment are required",
        )

    item = await airtable_store.get_item_by_post_url(post_url) if post_url else None
    if item and item.get("commentary"):
        post_text = item["commentary"]
    if item and item.get("comment"):
        own_comment = item["comment"]

    voice_profile = await voice_store.get_voice_profile(api_key)
    if item:
        product_config = await products_store.get_product_config(item["product"])
    else:
        product_config = await products_store.infer_product_from_text(post_text or own_comment or "")

    draft = await claude_client.draft_reply(
        product_config,
        post_text or "(original post text not available)",
        own_comment or "(original comment not available)",
        reply_text,
        item.get("score", 0) if item else 0,
        voice_profile,
    )
    return {"replyText": draft.get("replyText")}


@app.get("/voice")
async def get_voice(authorization: str = Header(default="")):
    """Per-user voice/tone profile — keyed by the caller's own API key, not
    by product. Applied to every comment that user drafts, regardless of
    which product it's for."""
    api_key = require_auth(authorization)
    profile = await voice_store.get_voice_profile(api_key)
    return profile or {}


@app.post("/voice/generate")
async def generate_voice(body: dict, authorization: str = Header(default="")):
    """Drafts a voice brief from the caller's own recent post texts,
    scraped client-side (content.js, via a temporary background tab on
    their own recent-activity page) and sent directly in the request body
    — no RichAPI call, no server-side fetch of any kind. linkedinUrl is
    stored alongside for record-keeping only, not used to fetch anything
    here. Returned for the user to review/edit in Settings before saving
    — POST /voice persists whatever they approve, not this raw draft."""
    api_key = require_auth(authorization)
    linkedin_url = body.get("linkedinUrl")
    posts = body.get("posts")
    if not linkedin_url:
        raise HTTPException(status_code=400, detail="linkedinUrl is required")
    if not posts or not isinstance(posts, list):
        raise HTTPException(status_code=400, detail="posts (a non-empty array of scraped post texts) is required")
    try:
        result = await voice_generator.generate_voice_brief(posts)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        # Only the Claude API call can fail here now — RichAPI is out of
        # the picture entirely — but still worth catching broadly rather
        # than letting an unexpected failure fall through to FastAPI's
        # default plain-text 500 (the exact bug just fixed elsewhere).
        raise HTTPException(status_code=502, detail=f"Voice generation failed: {type(e).__name__}: {e}")
    await voice_store.upsert_voice_profile(
        api_key, {"linkedinUrl": linkedin_url, "voiceBrief": result["voiceBrief"]}
    )
    return result


@app.post("/voice")
async def save_voice(body: dict, authorization: str = Header(default="")):
    """Saves user-edited voice brief + preferences."""
    api_key = require_auth(authorization)
    fields = {
        k: body.get(k)
        for k in ("userName", "linkedinUrl", "voiceBrief", "replyLength", "replyStyle")
        if body.get(k) is not None
    }
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to save")
    return await voice_store.upsert_voice_profile(api_key, fields)


@app.get("/products")
async def list_products(authorization: str = Header(default="")):
    require_auth(authorization)
    return {"products": await products_store.list_products()}


@app.post("/products")
async def upsert_product(body: dict, authorization: str = Header(default="")):
    require_auth(authorization)
    if not body.get("key") or not body.get("name"):
        raise HTTPException(status_code=400, detail="key and name are required")
    return await products_store.upsert_product(body)


@app.get("/profiles")
async def list_search_profiles(authorization: str = Header(default="")):
    require_auth(authorization)
    return {"profiles": await profiles_store.list_profiles()}


@app.post("/profiles")
async def upsert_search_profile(body: dict, authorization: str = Header(default="")):
    require_auth(authorization)
    if not body.get("slug") or not body.get("name"):
        raise HTTPException(status_code=400, detail="slug and name are required")
    return await profiles_store.upsert_profile(body)


@app.delete("/profiles/{slug}")
async def delete_search_profile(slug: str, authorization: str = Header(default="")):
    require_auth(authorization)
    if not await profiles_store.delete_profile(slug):
        raise HTTPException(status_code=404, detail="No profile with that slug")
    return {"ok": True}
