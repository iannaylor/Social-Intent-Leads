"""
Airtable-backed product context — replaces the earlier hardcoded
product_config.py dict. A product's positioning, keywords, and ICP live in
the "Social Intent Products" table (base appIvaVZZwTj8xr0F, table
tblAP6BukAjMrMh4Z) instead of Python, so a new product can be added or an
existing one refined entirely from the extension's Products tab — no code
change or redeploy needed.
"""

import os
from typing import Optional

import httpx

BASE_ID = "appIvaVZZwTj8xr0F"
TABLE_ID = "tblAP6BukAjMrMh4Z"
AIRTABLE_API_URL = f"https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}"

FIELD_IDS = {
    "key": "fldYGRKEO0WUpQ6Ue",
    "name": "fldkW7AFdEfqeZiQH",
    "context": "fldtfsIsvtSoFVcsz",
    "broadKeywords": "fldvxHA7m8V2050zg",
    "highIntentKeywords": "fldTJXgm7kMMb17kK",
    "icpTitles": "fldR0F7QLaTjnsvbh",
    "icpCompanySizeMin": "fldPhaMFG33iztqjT",
    "icpCompanySizeMax": "fldgQwiZDmzoRhMsz",
    "icpIndustries": "fld2P6xA0NqBdcAZQ",
}
REVERSE_FIELD_IDS = {v: k for k, v in FIELD_IDS.items()}


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def _record_to_product(record: dict) -> dict:
    product = {"recordId": record["id"]}
    for field_id, value in record.get("fields", {}).items():
        key = REVERSE_FIELD_IDS.get(field_id)
        if key:
            product[key] = value
    return product


def _to_config_shape(product: dict) -> dict:
    """Shapes a stored product into what claude_client.py / pipeline.py expect."""
    split = lambda s: [p.strip() for p in (s or "").split(",") if p.strip()]
    return {
        "name": product.get("name", product.get("key", "")),
        "positioning": product.get("context", ""),
        "broad_keywords": split(product.get("broadKeywords")),
        "high_intent_keywords": split(product.get("highIntentKeywords")),
        "icp_titles": split(product.get("icpTitles")),
        "icp_company_size_min": product.get("icpCompanySizeMin", 1),
        "icp_company_size_max": product.get("icpCompanySizeMax", 100000),
        "icp_industries": split(product.get("icpIndustries")),
    }


async def list_products() -> list[dict]:
    products = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {"pageSize": "100", "returnFieldsByFieldId": "true"}
            if offset:
                params["offset"] = offset
            resp = await client.get(AIRTABLE_API_URL, headers=_headers(), params=params)
            resp.raise_for_status()
            data = resp.json()
            products.extend(_record_to_product(r) for r in data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break
    return products


async def get_product_config(key: str) -> dict:
    """Returns the config shape pipeline.py/claude_client.py expect. Raises
    KeyError with a clear message if the product hasn't been set up yet —
    the fix is adding it via the extension's Products tab, not a code change."""
    products = await list_products()
    for p in products:
        if p.get("key") == key:
            return _to_config_shape(p)
    raise KeyError(
        f"No product '{key}' found in the Social Intent Products table. "
        f"Add it via the extension's Products tab first."
    )


async def infer_product_from_text(text: str) -> Optional[dict]:
    """Best-effort fallback for content scraped straight off a LinkedIn page
    with no Airtable record to look up (e.g. a reply on a post that was
    never scanned, or a stale postUrl format mismatch) — count keyword hits
    per product and return the best match's config shape, or None if
    nothing scores above zero. None is a legitimate, expected result: the
    reply drafter treats it as "draft without product context" rather than
    guessing wrong, which is safer than mentioning the wrong product."""
    if not text:
        return None
    haystack = text.lower()
    products = await list_products()
    best, best_score = None, 0
    for p in products:
        config = _to_config_shape(p)
        keywords = config["broad_keywords"] + config["high_intent_keywords"]
        score = sum(1 for kw in keywords if kw.lower() in haystack)
        if score > best_score:
            best, best_score = config, score
    return best


async def upsert_product(product: dict) -> dict:
    """Create or update by 'key'. product is a dict with the same shape as
    the extension's Products form: key, name, context, broadKeywords,
    highIntentKeywords, icpTitles, icpCompanySizeMin, icpCompanySizeMax,
    icpIndustries."""
    existing = await list_products()
    match = next((p for p in existing if p.get("key") == product["key"]), None)

    fields = {}
    for k, field_id in FIELD_IDS.items():
        if k in product and product[k] is not None:
            fields[field_id] = product[k]

    async with httpx.AsyncClient(timeout=30) as client:
        if match:
            resp = await client.patch(
                f"{AIRTABLE_API_URL}/{match['recordId']}",
                headers=_headers(),
                json={"fields": fields},
            )
        else:
            resp = await client.post(
                AIRTABLE_API_URL, headers=_headers(), json={"fields": fields}
            )
        resp.raise_for_status()
        return _record_to_product(resp.json())
