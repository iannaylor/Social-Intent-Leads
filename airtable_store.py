"""
Airtable storage layer for the Social Intent Leads table.

Table: base appIvaVZZwTj8xr0F ("Content Pipeline" base already used by every
other skill in this workspace), table tblYlMKksVwVfVxx4 ("Social Intent
Leads"), created for this project.

Status is tracked server-side here (not per-browser like the original local
extension) on purpose: with more than one person potentially working the
same lead pool, "has anyone already actioned this post" needs to be shared,
not per-user, or two people could both comment on the same post.
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
}


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def _item_to_fields(item: dict, run_id: str) -> dict:
    fields = {}
    for key, field_id in FIELD_IDS.items():
        if key == "runId":
            fields[field_id] = run_id
            continue
        if key == "itemStatus":
            continue  # only set on create, never overwritten on update
        value = item.get(key)
        if value is None:
            continue
        fields[field_id] = value
    return fields


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
    just because the same post surfaced in a re-run)."""
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
                AIRTABLE_API_URL, headers=_headers(), json={"records": records}
            )
            resp.raise_for_status()
            created += len(resp.json().get("records", []))

    return {"created": created, "skipped_existing": len(items) - len(to_create)}


async def get_queue(product: Optional[str] = None) -> list[dict]:
    """Returns every item not yet 'done', across all runs, for the extension."""
    records = []
    offset = None
    filter_formula = None
    if product:
        filter_formula = f"{{{FIELD_IDS['product']}}} = '{product}'"

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

    reverse_map = {v: k for k, v in FIELD_IDS.items()}
    items = []
    for record in records:
        item = {"recordId": record["id"]}
        for field_id, value in record.get("fields", {}).items():
            key = reverse_map.get(field_id)
            if key:
                item[key] = value
        items.append(item)
    return items


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
