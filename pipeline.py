"""
Direct code port of claude-code/skills/social-intent-leads/SKILL.md STEP 1-8.
Keep both in sync — this is the hosted/multi-user path, SKILL.md remains the
interactive Claude-Code path. They should produce the same quality of result
because they share the same rubric text (see claude_client.py) and the same
step structure.

Two spots are flagged inline as needing verification against real API
responses on first live run, since they're written from documented/observed
shapes rather than a live test from this environment:
  1. RichAPIClient itself (richapi_client.py) — the mcp package's exact
     client API.
  2. Resolving a candidate's company LinkedIn URL from enrich_profile's
     response, needed to call enrich_company. The exact field name wasn't
     directly observed in this session's testing, so this tries a few
     plausible paths defensively.
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


def _resolve_company_url(profile_data: dict) -> Optional[str]:
    """Best-effort extraction of a LinkedIn company page URL from
    enrich_profile's response. NEEDS VERIFICATION against a real payload —
    tries the plausible field paths in order."""
    company = profile_data.get("company") or {}
    for candidate in [
        company.get("linkedinUrl"),
        company.get("url"),
        profile_data.get("companyUrl"),
    ]:
        if candidate:
            return candidate
    orgs = profile_data.get("organizations") or []
    if orgs and isinstance(orgs, list):
        return orgs[0].get("url")
    return None


async def run_pipeline(profile: dict, run_id: str) -> dict:
    product_config = await get_product_config(profile["product"])

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
    extra_keywords = (
        [k.strip() for k in profile["intentKeywords"].split(",") if k.strip()]
        if profile.get("intentKeywords")
        else []
    )
    recency = profile.get("recency", "PAST_WEEK")
    count_target = profile.get("count", 10)
    fetch_emails = profile.get("fetchEmails", True)

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
        "droppedAtIcp": 0,
        "hiringSignals": 0,
        "emailsFound": 0,
        "emailsVerified": 0,
        "queuedCommentOnly": 0,
        "queuedConnect": 0,
    }

    async with RichAPIClient() as richapi:
        # ---- STEP 2: search ----
        candidates: dict[str, dict] = {}
        for kw in all_keywords:
            result = await richapi.call(
                "post_keyword_search",
                {"keyword": kw, "datePosted": recency, "sort": "DATE_POSTED", "size": 30},
            )
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

        # ---- STEP 3: score + influencer flag ----
        cand_list = list(candidates.values())
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
            report["scoreDistribution"][str(cand["score"])] += 1
            if cand.get("isInfluencer"):
                report["influencerFlagged"] += 1
            if cand.get("isHiringSignal"):
                report["hiringSignals"] += 1

        survivors = [c for c in cand_list if c.get("score", 0) > 0]
        for c in survivors:
            if c["score"] == 5:
                c["action"], c["connectReason"] = "comment+connect", "direct-buyer"
            elif c.get("isInfluencer") and c["score"] >= 2:
                c["action"], c["connectReason"] = "comment+connect", "influencer"
            else:
                c["action"], c["connectReason"] = "comment", None

        # ---- STEP 4: ICP qualification ----
        # Personal-buyer candidates (score>=3, not influencer) get the strict
        # title/size check. Influencers bypass it (lightweight sanity check only).
        qualified = []
        for c in survivors:
            needs_icp_check = c["score"] >= 3 and not c.get("isInfluencer")
            is_influencer_survivor = c.get("isInfluencer") and c["score"] >= 2

            if not (needs_icp_check or is_influencer_survivor):
                qualified.append(c)  # score 1-2, non-influencer: comment-only, no ICP check needed
                continue

            if not c.get("profileUrl"):
                report["droppedAtIcp"] += 1
                continue

            try:
                profile_data = await richapi.call("enrich_profile", {"url": c["profileUrl"]})
            except Exception:
                qualified.append(c)  # can't verify, don't silently drop
                continue

            if is_influencer_survivor:
                qualified.append(c)  # bypasses strict ICP check by design
                continue

            headline = (profile_data.get("headline") or "")
            title_ok = any(t.lower() in headline.lower() for t in icp_titles)

            company_url = _resolve_company_url(profile_data)
            size_ok = True  # default true if we can't check, rather than wrongly dropping
            if company_url:
                try:
                    company_data = await richapi.call("enrich_company", {"url": company_url})
                    employee_count = company_data.get("employee_count")
                    if isinstance(employee_count, int):
                        size_ok = icp_size_min <= employee_count <= icp_size_max
                except Exception:
                    pass

            if title_ok or size_ok:
                qualified.append(c)
            else:
                report["droppedAtIcp"] += 1

        # cap to count target, direct-buyers first, then influencers, then by score
        def _sort_key(c):
            return (
                0 if c.get("connectReason") == "direct-buyer" else (1 if c.get("isInfluencer") else 2),
                -c["score"],
            )

        qualified.sort(key=_sort_key)
        qualified = qualified[:count_target] if count_target else qualified

        # ---- STEP 5: find & verify emails ----
        if fetch_emails and qualified:
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
                    r["refId"]: r["email"]
                    for r in find_result.get("results", [])
                    if r.get("email")
                }
                report["emailsFound"] = len(found_by_ref)

                if found_by_ref:
                    verify_targets = [
                        {"refId": ref, "email": email} for ref, email in found_by_ref.items()
                    ]
                    verify_job = await richapi.call("verify_emails", {"data": verify_targets})
                    verify_result = await richapi.poll("check_email_verification", verify_job["jobId"])
                    status_by_ref = {
                        r["refId"]: r["status"] for r in verify_result.get("results", [])
                    }
                    for c in qualified:
                        if c["postUrl"] in found_by_ref:
                            c["email"] = found_by_ref[c["postUrl"]]
                            c["emailStatus"] = status_by_ref.get(c["postUrl"], "unknown")
                            if c["emailStatus"] == "valid":
                                report["emailsVerified"] += 1

        # ---- STEP 6: draft content ----
        draft_results = await _gather_limited(
            [
                claude_client.draft_content(
                    product_config,
                    c["commentary"],
                    c["score"],
                    c.get("isInfluencer", False),
                    c["action"],
                    c.get("connectReason"),
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

        # ---- STEP 7: assemble final items (including score-0 skips) ----
        skipped = [c for c in cand_list if c.get("score", 0) == 0]
        for c in skipped:
            c["action"] = "skip"
            c["connectReason"] = None

        final_items = []
        for c in qualified + skipped:
            final_items.append(
                {
                    "name": c["name"],
                    "profileUrl": c.get("profileUrl"),
                    "postUrl": c["postUrl"],
                    "score": c.get("score", 0),
                    "isInfluencer": c.get("isInfluencer", False),
                    "connectReason": c.get("connectReason"),
                    "action": c["action"],
                    "skipReason": c.get("skipReason"),
                    "comment": c.get("comment"),
                    "connectionNote": c.get("connectionNote"),
                    "dmMessage": c.get("dmMessage"),
                    "email": c.get("email"),
                    "emailStatus": c.get("emailStatus"),
                    "sourceLabel": source_label,
                    "product": profile["product"],
                }
            )

        await airtable_store.upsert_items(final_items, run_id)

    return report
