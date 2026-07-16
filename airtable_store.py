"""
Airtable storage layer for the Social Intent Leads table.

Table: base appIvaVZZwTj8xr0F ("Content Pipeline" base already used by every
other skill in this workspace), table tblYlMKksVwVfVxx4 ("Social Intent
Leads"), created for this project.

Status is tracked server-side here (not per-browser like the original local
extension) on purpose: with more than one person potentially working the
same lead pool, "has anyone already actioned this post" needs to be shared,
not per-user, or two people could both comment on the same post.

Two-phase pipeline (added after the "process everything then cap at 10"
cost problem was flagged): a scan writes every candidate immediately,
including ones only scored so far (action="pending_batch", commentary
stored so drafting can happen anytime later, not just right after the
scan). Enrichment/emails/drafting then happen in caller-controlled batches
against that stored pool, via get_pending_batch()/update_items() below.
"""

import os
from typing import Optional

import httpx

BASE_ID = "appIvaVZZwTj8xr0F"
TABLE_ID = "tblYlMKksVwVfVxx4"
AIRTABLE_API_URL = f"https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}"

FIELD_IDS = {
    "postUrl": "fldojNUN32gUQGm7N",
    "name": "fldtqniNQAgeqvbfL",
    "profileUrl": "fldi9GXmHstrF0p8E",
    "product": "fldTwS20G2Lo7E3WO",
    "score": "fldhcYG2qcbqzpfM5",
    "isInfluencer": "fld33E8YLuYgRF7bP",
    "connectReason": "fldMxq3QEXiiAftkF",
    "action": "fldMMA7pHSXqPAfio",
    "skipReason": "fldEfQUBjbxjw8OB3",
    "comment": "fld7WZvqLmBwYPBJV",
    "connectionNote": "fld9nzcMsWqQFLiMv",
    "dmMessage": "fldiO9rI3R5I5qUAg",
    "email": "fldlXhZZ25wt2izFF",
    "emailStatus": "fldu1QynPPE3SfqhQ",
    "sourceLabel": "fldnVIags6z4RCAJI",
    "runId": "fldxl2eT5eQOEwcI7",
    "itemStatus": "fldBTjEfdSpxQk0Eh",
    "commentary": "fldMPV90LqzD9eoXn",
    "profileSlug": "fldguRjTkLahqaEts",
}
REVERSE_FIELD_IDS = {v: k for k, v in FIELD_IDS.items()}


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def _item_to_fields(item: dict, run_id: Optional[str] = None) -> dict:
    fields = {}
    for key, field_id in FIELD_IDS.items():
        if key == "runId":
            if run_id is not None:
                fields[field_id] = run_id
            continue
        if key == "itemStatus":
            continue  # lifecycle status — only ever set via set_item_status
        value = item.get(key)
        if value is None:
            continue
        fields[field_id] = value
    return fields


def _record_to_item(record: dict) -> dict:
    item = {"recordId": record["id"]}
    for field_id, value in record.get("fields", {}).items():
        key = REVERSE_FIELD_IDS.get(field_id)
        if key:
            item[key] = value
    return item


async def _fetch_existing_by_post_url() -> dict[str, str]:
    """Returns {postUrl: recordId} for every existing record, paginated."""
    existing: dict[str, str] = {}
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {
                "fields[]": FIELD_IDS["postUrl"],
                "pageSize": "100",
                "returnFieldsByFieldId": "true",
            }
            if offset:
                params["offset"] = offset
            resp = await client.get(AIRTABLE_API_URL, headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()
            for record in data.get("records", []):
                post_url = record.get("fields", {}).get(FIELD_IDS["postUrl"])
                if post_url:
                    existing[post_url] = record["id"]
            offset = data.get("offset")
            if not offset:
                break
    return existing


async def upsert_items(items: list[dict], run_id: str) -> dict:
    """Create new records for postUrls not already present; leave existing
    records' itemStatus untouched (don't reset someone's in-progress work
    just because the same post surfaced in a re-run). typecast=True so a
    new Action value (e.g. "pending_batch") doesn't need a manual schema
    change first — Airtable adds it to the single-select's choices."""
    existing = await _fetch_existing_by_post_url()
    to_create = [item for item in items if item["postUrl"] not in existing]

    created = 0
    async with httpx.AsyncClient(timeout=30) as client:
        for i in range(0, len(to_create), 10):
            batch = to_create[i : i + 10]
            records = [
                {
                    "fields": {
                        **_item_to_fields(item, run_id),
                        FIELD_IDS["itemStatus"]: "pending",
                    }
                }
                for item in batch
            ]
            resp = await client.post(
                AIRTABLE_API_URL,
                headers=_headers(),
                json={"records": records, "typecast": True},
            )
            resp.raise_for_status()
            created += len(resp.json().get("records", []))

    return {"created": created, "skipped_existing": len(items) - len(to_create)}


async def update_items(items: list[dict]) -> int:
    """Update existing records in place by recordId — used by batch
    processing to turn a 'pending_batch' candidate into a real comment/
    comment+connect/skip once it's been enriched and drafted. Leaves
    itemStatus untouched, same reasoning as upsert_items."""
    updated = 0
    async with httpx.AsyncClient(timeout=30) as client:
        for i in range(0, len(items), 10):
            batch = items[i : i + 10]
            records = [
                {"id": item["recordId"], "fields": _item_to_fields(item)}
                for item in batch
                if item.get("recordId")
            ]
            if not records:
                continue
            resp = await client.patch(
                AIRTABLE_API_URL,
                headers=_headers(),
                json={"records": records, "typecast": True},
            )
            resp.raise_for_status()
            updated += len(resp.json().get("records", []))
    return updated


async def get_pending_batch(product: str, run_id: Optional[str] = None) -> list[dict]:
    """Every not-yet-enriched candidate for this product (optionally scoped
    to one run), sorted highest-priority first: score-5 direct-buyers,
    then influencers, then by score descending. Sorted in Python rather
    than via Airtable's formula/sort params — pools here are at most a
    couple hundred, and this reuses the exact same priority logic as the
    original single-phase pipeline instead of re-deriving it in a formula.

    run_id is NOT used to filter by default (only passed through for
    logging) — batches work through the whole product's accumulated
    backlog, not just one scan's slice of it. A re-scan later adds to the
    same backlog rather than starting a separate, harder-to-find pool."""
    filter_formula = f"AND({{{FIELD_IDS['product']}}} = '{product}', {{{FIELD_IDS['action']}}} = 'pending_batch')"

    records = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {
                "pageSize": "100",
                "returnFieldsByFieldId": "true",
                "filterByFormula": filter_formula,
            }
            if offset:
                params["offset"] = offset
            resp = await client.get(AIRTABLE_API_URL, headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()
            records.extend(data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break

    items = [_record_to_item(r) for r in records]

    def _priority(item):
        return (
            0 if item.get("connectReason") == "direct-buyer" else (1 if item.get("isInfluencer") else 2),
            -(item.get("score") or 0),
        )

    items.sort(key=_priority)
    return items


async def get_queue(product: Optional[str] = None, profile_slug: Optional[str] = None) -> list[dict]:
    """Returns every actionable item. Excludes pending_batch (found and
    scored, not yet enriched/drafted) and enriched_pending_draft (an
    interim checkpoint state — see process_batch in pipeline.py; only
    persists past one batch call if that call crashed partway through,
    protecting the paid enrichment from being lost, but not yet a finished
    comment/skip ready to show). Recovering enriched_pending_draft items
    with a targeted "resume drafting only" pass is a reasonable future
    enhancement — for now they're just safe from being erased, not
    auto-resumed."""
    filter_parts = []
    if product:
        filter_parts.append(f"{{{FIELD_IDS['product']}}} = '{product}'")
    if profile_slug:
        filter_parts.append(f"{{{FIELD_IDS['profileSlug']}}} = '{profile_slug}'")
    filter_formula = "AND(" + ", ".join(filter_parts) + ")" if filter_parts else None

    records = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {"pageSize": "100", "returnFieldsByFieldId": "true"}
            if filter_formula:
                params["filterByFormula"] = filter_formula
            if offset:
                params["offset"] = offset
            resp = await client.get(AIRTABLE_API_URL, headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()
            records.extend(data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break

    items = [_record_to_item(r) for r in records]
    return [i for i in items if i.get("action") not in ("pending_batch", "enriched_pending_draft")]


async def set_item_status(post_url: str, status: str) -> bool:
    """Returns False if no record with that postUrl exists."""
    existing = await _fetch_existing_by_post_url()
    record_id = existing.get(post_url)
    if not record_id:
        return False
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.patch(
            f"{AIRTABLE_API_URL}/{record_id}",
            headers=_headers(),
            json={"fields": {FIELD_IDS["itemStatus"]: status}},
        )
        resp.raise_for_status()
    return True
