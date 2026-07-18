"""
Airtable storage layer for the Social Intent Leads table.

Table lives in whatever base AIRTABLE_BASE_ID points at — auto-created
there (see airtable_setup.py) if a table by this name doesn't exist yet,
so a fresh deploy against an empty base works without any manual Airtable
setup. Fields are addressed by NAME, not Airtable's generated field IDs —
names are portable across bases (an ID from one base means nothing in
another), and since this app is the one creating the table in the first
place, there's no risk of a user renaming a column out from under it the
way there might be for a hand-built table.

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

from typing import Optional

import httpx

import airtable_setup

TABLE_NAME = airtable_setup.LEADS_TABLE

FIELD_NAMES = {
    "postUrl": "Post URL",
    "name": "Name",
    "profileUrl": "Profile URL",
    "product": "Product",
    "score": "Score",
    "isInfluencer": "Is Influencer",
    "connectReason": "Connect Reason",
    "action": "Action",
    "skipReason": "Skip Reason",
    "comment": "Comment",
    "connectionNote": "Connection Note",
    "dmMessage": "DM Message",
    "email": "Email",
    "emailStatus": "Email Status",
    "sourceLabel": "Source Label",
    "runId": "Run ID",
    "itemStatus": "Item Status",
    "commentary": "Commentary",
    "profileSlug": "Profile Slug",
}


def _url() -> str:
    return airtable_setup.table_url(TABLE_NAME)


def _headers() -> dict:
    return airtable_setup.headers()


def _item_to_fields(item: dict, run_id: Optional[str] = None) -> dict:
    fields = {}
    for key, field_name in FIELD_NAMES.items():
        if key == "runId":
            if run_id is not None:
                fields[field_name] = run_id
            continue
        if key == "itemStatus":
            continue  # lifecycle status — only ever set via set_item_status
        value = item.get(key)
        if value is None:
            continue
        fields[field_name] = value
    return fields


def _record_to_item(record: dict) -> dict:
    item = {"recordId": record["id"]}
    for field_name, value in record.get("fields", {}).items():
        for key, name in FIELD_NAMES.items():
            if name == field_name:
                item[key] = value
                break
    return item


async def _fetch_existing_by_post_url() -> dict[str, str]:
    """Returns {postUrl: recordId} for every existing record, paginated."""
    existing: dict[str, str] = {}
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {
                "fields[]": FIELD_NAMES["postUrl"],
                "pageSize": "100",
            }
            if offset:
                params["offset"] = offset
            resp = await client.get(_url(), headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()
            for record in data.get("records", []):
                post_url = record.get("fields", {}).get(FIELD_NAMES["postUrl"])
                if post_url:
                    existing[post_url] = record["id"]
            offset = data.get("offset")
            if not offset:
                break
    return existing


async def get_item_by_post_url(post_url: str) -> Optional[dict]:
    """Single-record lookup — used by the on-demand 'generate a comment for
    this skip anyway' override, so it doesn't need to fetch the whole
    table just to find one record."""
    filter_formula = f"{{{FIELD_NAMES['postUrl']}}} = '{post_url}'"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            _url(),
            headers=_headers(),
            params={"filterByFormula": filter_formula, "maxRecords": 1},
        )
        resp.raise_for_status()
        records = resp.json().get("records", [])
        return _record_to_item(records[0]) if records else None


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
                        FIELD_NAMES["itemStatus"]: "pending",
                    }
                }
                for item in batch
            ]
            resp = await client.post(
                _url(),
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
                _url(),
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
    filter_formula = f"AND({{{FIELD_NAMES['product']}}} = '{product}', {{{FIELD_NAMES['action']}}} = 'pending_batch')"

    records = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {
                "pageSize": "100",
                "filterByFormula": filter_formula,
            }
            if offset:
                params["offset"] = offset
            resp = await client.get(_url(), headers=_headers(), params=params)
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
        filter_parts.append(f"{{{FIELD_NAMES['product']}}} = '{product}'")
    if profile_slug:
        filter_parts.append(f"{{{FIELD_NAMES['profileSlug']}}} = '{profile_slug}'")
    filter_formula = "AND(" + ", ".join(filter_parts) + ")" if filter_parts else None

    records = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {"pageSize": "100"}
            if filter_formula:
                params["filterByFormula"] = filter_formula
            if offset:
                params["offset"] = offset
            resp = await client.get(_url(), headers=_headers(), params=params)
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
            f"{_url()}/{record_id}",
            headers=_headers(),
            json={"fields": {FIELD_NAMES["itemStatus"]: status}},
        )
        resp.raise_for_status()
    return True
