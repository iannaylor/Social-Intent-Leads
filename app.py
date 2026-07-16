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
import claude_client
import voice_store
import voice_generator

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
    draft = await claude_client.draft_content(
        product_config,
        item["commentary"],
        item.get("score", 0),
        item.get("isInfluencer", False),
        "comment",
        None,
        voice_profile,
    )
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
    """Analyzes the caller's own real LinkedIn posts and drafts a voice
    brief. Returned for the user to review/edit in Settings before saving
    — POST /voice persists whatever they approve, not this raw draft."""
    api_key = require_auth(authorization)
    linkedin_url = body.get("linkedinUrl")
    if not linkedin_url:
        raise HTTPException(status_code=400, detail="linkedinUrl is required")
    try:
        result = await voice_generator.generate_voice_brief(linkedin_url)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
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
