"""
Airtable-backed product context — replaces the earlier hardcoded
product_config.py dict. A product's positioning, keywords, and ICP live
in the "Social Intent Products" table (auto-created in whatever base
AIRTABLE_BASE_ID points at, see airtable_setup.py) instead of Python, so
a new product can be added or an existing one refined entirely from the
extension's Products tab — no code change or redeploy needed.

Every function accepts optional base_id/api_key overrides — see
airtable_store.py's module docstring for why (self-hosted vs. managed
multi-tenant callers).
"""

from typing import Optional

import httpx

import airtable_setup

TABLE_NAME = airtable_setup.PRODUCTS_TABLE

FIELD_NAMES = {
    "key": "Key",
    "name": "Name",
    "context": "Context",
    "broadKeywords": "Broad Keywords",
    "highIntentKeywords": "High Intent Keywords",
    "icpTitles": "ICP Titles",
    "icpCompanySizeMin": "ICP Company Size Min",
    "icpCompanySizeMax": "ICP Company Size Max",
    "icpIndustries": "ICP Industries",
}


def _url(base_id: Optional[str] = None) -> str:
    return airtable_setup.table_url(TABLE_NAME, base_id)


def _headers(api_key: Optional[str] = None) -> dict:
    return airtable_setup.headers(api_key)


def _record_to_product(record: dict) -> dict:
    product = {"recordId": record["id"]}
    for field_name, value in record.get("fields", {}).items():
        for key, name in FIELD_NAMES.items():
            if name == field_name:
                product[key] = value
                break
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


async def list_products(base_id: Optional[str] = None, api_key: Optional[str] = None) -> list[dict]:
    products = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {"pageSize": "100"}
            if offset:
                params["offset"] = offset
            resp = await client.get(_url(base_id), headers=_headers(api_key), params=params)
            resp.raise_for_status()
            data = resp.json()
            products.extend(_record_to_product(r) for r in data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break
    return products


async def get_product_config(key: str, base_id: Optional[str] = None, api_key: Optional[str] = None) -> dict:
    """Returns the config shape pipeline.py/claude_client.py expect. Raises
    KeyError with a clear message if the product hasn't been set up yet —
    the fix is adding it via the extension's Products tab, not a code change."""
    products = await list_products(base_id, api_key)
    for p in products:
        if p.get("key") == key:
            return _to_config_shape(p)
    raise KeyError(
        f"No product '{key}' found in the Social Intent Products table. "
        f"Add it via the extension's Products tab first."
    )


async def infer_product_from_text(
    text: str, base_id: Optional[str] = None, api_key: Optional[str] = None
) -> Optional[dict]:
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
    products = await list_products(base_id, api_key)
    best, best_score = None, 0
    for p in products:
        config = _to_config_shape(p)
        keywords = config["broad_keywords"] + config["high_intent_keywords"]
        score = sum(1 for kw in keywords if kw.lower() in haystack)
        if score > best_score:
            best, best_score = config, score
    return best


async def upsert_product(product: dict, base_id: Optional[str] = None, api_key: Optional[str] = None) -> dict:
    """Create or update by 'key'. product is a dict with the same shape as
    the extension's Products form: key, name, context, broadKeywords,
    highIntentKeywords, icpTitles, icpCompanySizeMin, icpCompanySizeMax,
    icpIndustries."""
    existing = await list_products(base_id, api_key)
    match = next((p for p in existing if p.get("key") == product["key"]), None)

    fields = {}
    for k, field_name in FIELD_NAMES.items():
        if k in product and product[k] is not None:
            fields[field_name] = product[k]

    async with httpx.AsyncClient(timeout=30) as client:
        if match:
            resp = await client.patch(
                f"{_url(base_id)}/{match['recordId']}",
                headers=_headers(api_key),
                json={"fields": fields, "typecast": True},
            )
        else:
            resp = await client.post(
                _url(base_id), headers=_headers(api_key), json={"fields": fields, "typecast": True}
            )
        resp.raise_for_status()
        return _record_to_product(resp.json())
