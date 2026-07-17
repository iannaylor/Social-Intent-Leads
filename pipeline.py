"""
Two-phase pipeline for social-intent-leads. Ported from
claude-code/skills/social-intent-leads/SKILL.md, then split into phases
after the first real run processed all 151 candidates found (enrichment
included) when only 10 were wanted — expensive and wasteful, and anything
that didn't make the top 10 was silently discarded with no record at all.

Phase 1 — search_and_score(): cheap-ish (search + Claude scoring only, no
RichAPI enrichment). Runs on the FULL candidate pool and writes every one
of them to Airtable immediately — score-0s as a final "skip", everyone
else as "pending_batch" (found and scored, not yet enriched or drafted).
Nothing is lost or hidden at this stage.

Phase 2 — process_batch(): the expensive part (enrich_profile,
company_enricher, find_emails/verify_emails, Claude drafting), run only on
a caller-specified batch size at a time, highest-priority candidates
first, pulled from the pending_batch pool written by phase 1. Can be
called any time later — the pool is durable in Airtable, not held in
memory. Candidates that fail the ICP check are kept as a "skip" WITH the
real reason (their actual title/company size), not discarded — that's
also how "who's just outside my exact parameters" becomes visible instead
of invisible.
"""

import asyncio
import datetime
from typing import Optional

import claude_client
import airtable_store
from products_store import get_product_config
from richapi_client import RichAPIClient


async def _gather_limited(coros, limit: int = 5):
    semaphore = asyncio.Semaphore(limit)

    async def _run(coro):
        async with semaphore:
            return await coro

    return await asyncio.gather(*[_run(c) for c in coros], return_exceptions=True)


def _resolve_icp(profile: dict, product_config: dict):
    icp_titles = (
        [t.strip() for t in profile["titles"].split(",") if t.strip()]
        if profile.get("titles")
        else product_config["icp_titles"]
    )
    icp_size_min = profile.get("companySizeMin", product_config["icp_company_size_min"])
    icp_size_max = profile.get("companySizeMax", product_config["icp_company_size_max"])
    icp_industries = (
        [profile["companyType"]] if profile.get("companyType") else product_config["icp_industries"]
    )
    # Optional — blank means anywhere. post_keyword_search has no location
    # filter, so this can only be checked here, at enrichment time, not at
    # search time.
    icp_location = (profile.get("location") or "").strip() or None
    return icp_titles, icp_size_min, icp_size_max, icp_industries, icp_location


def _location_matches(profile_data: dict, icp_location: Optional[str]) -> Optional[bool]:
    """None = not checked (no location requested, or nothing to check against)."""
    if not icp_location:
        return None
    location = profile_data.get("location") or {}
    haystack = " ".join(
        str(v) for v in [location.get("city"), location.get("state"), location.get("country"), location.get("defaultValue")] if v
    ).lower()
    if not haystack:
        return None
    return icp_location.lower() in haystack


def _connect_reason(score: int, is_influencer: bool) -> Optional[str]:
    """Precomputed at scoring time (phase 1) since it only depends on score
    + influencer flag, not on ICP fit — used to sort the pending_batch pool
    by priority before ICP fit is even known."""
    if score == 5:
        return "direct-buyer"
    if is_influencer and score >= 2:
        return "influencer"
    return None


async def search_and_score(profile: dict, run_id: str) -> dict:
    """Phase 1. Searches every keyword, scores every candidate found, and
    writes all of them to Airtable — score-0 as a final skip, everyone
    else as pending_batch, ready for process_batch() whenever."""
    print(f"[pipeline] run {run_id}: PHASE 1 (search+score) starting for profile: {profile}", flush=True)
    product_config = await get_product_config(profile["product"])

    extra_keywords = (
        [k.strip() for k in profile["intentKeywords"].split(",") if k.strip()]
        if profile.get("intentKeywords")
        else []
    )
    recency = profile.get("recency", "PAST_WEEK")

    all_keywords = list(
        dict.fromkeys(
            product_config["broad_keywords"]
            + product_config["high_intent_keywords"]
            + extra_keywords
        )
    )

    today = datetime.date.today().isoformat()
    run_label = profile.get("name") or "manual run"
    keyword_summary = ", ".join(extra_keywords) if extra_keywords else "A/B testing intent"
    source_label = f"{product_config['name']} — {keyword_summary}, {recency}, {run_label} {today}"

    report = {
        "candidatesFound": 0,
        "scoreDistribution": {str(i): 0 for i in range(6)},
        "influencerFlagged": 0,
        "hiringSignals": 0,
        "pendingBatchCount": 0,
        "skippedCount": 0,
    }

    print(f"[pipeline] run {run_id}: connecting to RichAPI...", flush=True)
    async with RichAPIClient() as richapi:
        print(f"[pipeline] run {run_id}: connected. STEP 2 — searching {len(all_keywords)} keywords", flush=True)
        candidates: dict[str, dict] = {}
        for i, kw in enumerate(all_keywords, 1):
            print(f"[pipeline] run {run_id}: STEP 2 ({i}/{len(all_keywords)}) keyword='{kw}'", flush=True)
            try:
                result = await richapi.call(
                    "post_keyword_search",
                    {"keyword": kw, "datePosted": recency, "sort": "DATE_POSTED", "size": 30},
                )
            except Exception as e:
                # One keyword failing (a transient RichAPI/network hiccup)
                # used to abort the whole scan, silently discarding every
                # candidate already found from earlier keywords in this same
                # loop, since nothing gets written to Airtable until the loop
                # finishes. Skip just this keyword and keep going instead —
                # same "don't lose paid work on a partial failure" principle
                # phase 2's checkpointing already applies.
                print(f"[pipeline] run {run_id}: keyword '{kw}' search failed, skipping: {e}", flush=True)
                continue
            for post in result.get("content", []):
                actor = post.get("actor", {})
                if actor.get("profileType") == "COMPANY":
                    continue
                name = actor.get("name") or f"{actor.get('firstName','')} {actor.get('lastName','')}".strip()
                if not name or name in candidates:
                    continue
                profile_id = actor.get("profileId")
                candidates[name] = {
                    "name": name,
                    "profileUrl": f"https://www.linkedin.com/in/{profile_id}" if profile_id else None,
                    "postUrl": post.get("shareUrl"),
                    "commentary": post.get("commentary") or "",
                }
    report["candidatesFound"] = len(candidates)
    print(f"[pipeline] run {run_id}: STEP 2 done — {len(candidates)} unique candidates", flush=True)

    cand_list = list(candidates.values())
    print(f"[pipeline] run {run_id}: STEP 3 — scoring {len(cand_list)} candidates via Claude", flush=True)
    score_results = await _gather_limited(
        [claude_client.score_post(product_config, c["commentary"]) for c in cand_list],
        limit=5,
    )
    for cand, score_result in zip(cand_list, score_results):
        if isinstance(score_result, Exception):
            cand["score"] = 0
            cand["skipReason"] = f"Scoring failed: {score_result}"
            cand["isInfluencer"] = False
            continue
        cand.update(score_result)
        report["scoreDistribution"][str(cand.get("score", 0))] += 1
        if cand.get("isInfluencer"):
            report["influencerFlagged"] += 1
        if cand.get("isHiringSignal"):
            report["hiringSignals"] += 1
    print(f"[pipeline] run {run_id}: STEP 3 done", flush=True)

    final_items = []
    for c in cand_list:
        score = c.get("score", 0)
        is_influencer = c.get("isInfluencer", False)
        if score == 0:
            action = "skip"
            report["skippedCount"] += 1
        else:
            action = "pending_batch"
            report["pendingBatchCount"] += 1
        final_items.append(
            {
                "name": c["name"],
                "profileUrl": c.get("profileUrl"),
                "postUrl": c["postUrl"],
                "commentary": c.get("commentary"),
                "score": score,
                "isInfluencer": is_influencer,
                "connectReason": _connect_reason(score, is_influencer) if action == "pending_batch" else None,
                "action": action,
                "skipReason": c.get("skipReason") if action == "skip" else None,
                "sourceLabel": source_label,
                "product": profile["product"],
                "profileSlug": profile.get("slug"),
            }
        )

    print(f"[pipeline] run {run_id}: writing {len(final_items)} items to Airtable", flush=True)
    await airtable_store.upsert_items(final_items, run_id)
    print(f"[pipeline] run {run_id}: PHASE 1 done.", flush=True)
    return report


async def process_batch(profile: dict, run_id: str, batch_size: int, voice_profile: dict | None = None) -> dict:
    """Phase 2. Pulls the next `batch_size` highest-priority pending_batch
    candidates for this product (optionally scoped to run_id) and runs
    ICP qualification, email finding, and drafting on just them.
    voice_profile (if given) is the CALLER's own voice/tone brief — applied
    to every comment they draft, regardless of product, since voice belongs
    to the person, not the thing being commented about."""
    print(f"[pipeline] run {run_id}: PHASE 2 (batch of {batch_size}) starting", flush=True)
    product_config = await get_product_config(profile["product"])
    icp_titles, icp_size_min, icp_size_max, icp_industries, icp_location = _resolve_icp(profile, product_config)
    fetch_emails = profile.get("fetchEmails", True)

    pool = await airtable_store.get_pending_batch(profile["product"], run_id)
    batch = pool[:batch_size]
    remaining_after = max(0, len(pool) - len(batch))
    print(f"[pipeline] run {run_id}: pool has {len(pool)} pending, processing {len(batch)}, {remaining_after} will remain", flush=True)

    report = {
        "requested": batch_size,
        "processed": len(batch),
        "remainingInPool": remaining_after,
        "qualified": 0,
        "droppedAtIcp": 0,
        "emailsFound": 0,
        "emailsVerified": 0,
        "queuedCommentOnly": 0,
        "queuedConnect": 0,
    }

    if not batch:
        print(f"[pipeline] run {run_id}: PHASE 2 — nothing left in pool", flush=True)
        return report

    async with RichAPIClient() as richapi:
        # ---- ICP qualification ----
        print(f"[pipeline] run {run_id}: STEP 4 — ICP qualification for {len(batch)} candidates", flush=True)
        for c in batch:
            is_influencer_survivor = c.get("connectReason") == "influencer"
            if is_influencer_survivor:
                # Influencers bypass the strict personal-buyer ICP check by
                # design (see SKILL.md) — they're not being evaluated as a
                # personal buyer.
                c["action"] = "comment+connect"
                continue

            if not c.get("profileUrl"):
                c["action"] = "skip"
                c["skipReason"] = "No LinkedIn profile URL available to verify title/company."
                report["droppedAtIcp"] += 1
                continue

            try:
                profile_data = await richapi.call("enrich_profile", {"url": c["profileUrl"]})
            except Exception as e:
                print(f"[pipeline] run {run_id}: enrich_profile failed for {c['profileUrl']}: {e}", flush=True)
                c["action"] = "skip"
                c["skipReason"] = f"Could not verify profile (enrich_profile failed): {e}"
                report["droppedAtIcp"] += 1
                continue

            headline = profile_data.get("headline") or ""
            title_ok = any(t.lower() in headline.lower() for t in icp_titles)

            company = profile_data.get("company") or {}
            domain = (company.get("website") or "").replace("https://", "").replace("http://", "").split("/")[0]
            size_ok = None  # None = unknown/unverified, distinct from False
            employee_count = None
            industry = None
            if domain:
                try:
                    company_data = await richapi.call("company_enricher", {"domain": domain})
                    employee_count = company_data.get("employee_count")
                    industry = company_data.get("industry")
                    if isinstance(employee_count, int):
                        size_ok = icp_size_min <= employee_count <= icp_size_max
                except Exception as e:
                    print(f"[pipeline] run {run_id}: company_enricher failed for {domain}: {e}", flush=True)

            location_ok = _location_matches(profile_data, icp_location)

            c["_headline"] = headline
            c["_employee_count"] = employee_count
            c["_industry"] = industry

            # Location, when requested, is a hard requirement — it's the one
            # dimension the user explicitly wants enforced, not just a soft
            # signal like title/size (which are OR'd together).
            location_fails = icp_location and location_ok is False

            if (title_ok or size_ok) and not location_fails:
                c["action"] = "comment+connect" if c.get("connectReason") == "direct-buyer" else "comment"
            else:
                c["action"] = "skip"
                title_bit = f"'{headline}'" if headline else "unknown title"
                size_bit = f"{employee_count} employees" if employee_count is not None else "unknown size"
                reason = (
                    f"Outside ICP: {title_bit} at a company with {size_bit} "
                    f"(target: {', '.join(icp_titles)} / {icp_size_min}-{icp_size_max} employees)."
                )
                if location_fails:
                    loc = (profile_data.get("location") or {}).get("defaultValue", "unknown location")
                    reason += f" Also outside requested location '{icp_location}' (found: {loc})."
                c["skipReason"] = reason
                report["droppedAtIcp"] += 1

        qualified = [c for c in batch if c["action"] in ("comment", "comment+connect")]
        print(f"[pipeline] run {run_id}: STEP 4 done — {len(qualified)}/{len(batch)} qualified", flush=True)

        # Checkpoint: save ICP results NOW, before STEP 5/6 even start. This
        # is the direct fix for a real incident — a run spent 32 paid
        # enrich_profile calls, then something later in the same pipeline
        # failed, and because everything was held in memory until one write
        # at the very end, all 32 calls' worth of results were gone with
        # nothing to show for the spend. Skips are already final at this
        # point (real skipReason, not a guess) — write those as-is. Passes
        # get a distinct interim action so a later crash leaves them
        # recoverable instead of stuck in limbo or silently lost.
        checkpoint_payload = []
        for c in batch:
            checkpoint_action = c["action"] if c["action"] == "skip" else "enriched_pending_draft"
            checkpoint_payload.append(
                {
                    "recordId": c["recordId"],
                    "action": checkpoint_action,
                    "skipReason": c.get("skipReason"),
                }
            )
        await airtable_store.update_items(checkpoint_payload)
        print(f"[pipeline] run {run_id}: STEP 4 checkpoint saved ({len(checkpoint_payload)} records)", flush=True)

        # ---- STEP 5: find & verify emails (qualified only) ----
        # Wrapped in try/except deliberately: a real run lost ALL of a
        # batch's results (32 enrich_profile calls' worth, confirmed via
        # Airtable — zero records existed after) because an unhandled
        # exception here (a poll timeout, an API shape surprise) crashed the
        # whole batch before STEP 6/7 could run or write anything back. Email
        # finding failing should cost you emails for this batch, not the
        # batch's scoring/ICP/drafting work too.
        print(f"[pipeline] run {run_id}: STEP 5 — emails {'requested' if fetch_emails else 'skipped (not requested)'}", flush=True)
        if fetch_emails and qualified:
            try:
                email_targets = []
                for c in qualified:
                    if not c.get("profileUrl"):
                        continue
                    try:
                        profile_data = await richapi.call("enrich_profile", {"url": c["profileUrl"]})
                    except Exception:
                        continue
                    domain = (profile_data.get("company") or {}).get("website")
                    if not domain:
                        continue
                    domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
                    name_parts = c["name"].split(" ", 1)
                    email_targets.append(
                        {
                            "refId": c["postUrl"],
                            "firstname": name_parts[0],
                            "lastname": name_parts[1] if len(name_parts) > 1 else "",
                            "domain": domain,
                        }
                    )

                if email_targets:
                    find_job = await richapi.call("find_emails", {"data": email_targets})
                    find_result = await richapi.poll("check_email_finding", find_job["jobId"])
                    found_by_ref = {
                        r["refId"]: r["email"] for r in find_result.get("results", []) if r.get("email")
                    }
                    report["emailsFound"] = len(found_by_ref)

                    if found_by_ref:
                        verify_targets = [{"refId": ref, "email": email} for ref, email in found_by_ref.items()]
                        verify_job = await richapi.call("verify_emails", {"data": verify_targets})
                        verify_result = await richapi.poll("check_email_verification", verify_job["jobId"])
                        status_by_ref = {r["refId"]: r["status"] for r in verify_result.get("results", [])}
                        for c in qualified:
                            if c["postUrl"] in found_by_ref:
                                c["email"] = found_by_ref[c["postUrl"]]
                                c["emailStatus"] = status_by_ref.get(c["postUrl"], "unknown")
                                if c["emailStatus"] == "valid":
                                    report["emailsVerified"] += 1
            except Exception as e:
                print(f"[pipeline] run {run_id}: STEP 5 failed, continuing without emails for this batch: {e}", flush=True)
                report["emailsError"] = str(e)
        print(f"[pipeline] run {run_id}: STEP 5 done — {report['emailsFound']} found, {report['emailsVerified']} verified", flush=True)

        # ---- STEP 6: draft content (qualified only) ----
        print(f"[pipeline] run {run_id}: STEP 6 — drafting for {len(qualified)} qualified candidates", flush=True)
        draft_results = await _gather_limited(
            [
                claude_client.draft_content(
                    product_config,
                    c.get("commentary") or "",
                    c["score"],
                    c.get("isInfluencer", False),
                    c["action"],
                    c.get("connectReason"),
                    voice_profile,
                )
                for c in qualified
            ],
            limit=5,
        )
        for c, draft in zip(qualified, draft_results):
            if isinstance(draft, Exception):
                c["comment"] = None
                continue
            c["comment"] = draft.get("comment")
            c["connectionNote"] = draft.get("connectionNote")
            c["dmMessage"] = draft.get("dmMessage")
            if c["action"] == "comment+connect":
                report["queuedConnect"] += 1
            else:
                report["queuedCommentOnly"] += 1
        report["qualified"] = len(qualified)
        print(f"[pipeline] run {run_id}: STEP 6 done", flush=True)

    # ---- write back ----
    update_payload = []
    for c in batch:
        update_payload.append(
            {
                "recordId": c["recordId"],
                "action": c["action"],
                "skipReason": c.get("skipReason"),
                "comment": c.get("comment"),
                "connectionNote": c.get("connectionNote"),
                "dmMessage": c.get("dmMessage"),
                "email": c.get("email"),
                "emailStatus": c.get("emailStatus"),
            }
        )
    await airtable_store.update_items(update_payload)
    print(f"[pipeline] run {run_id}: PHASE 2 done. {report}", flush=True)
    return report
