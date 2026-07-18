"""
Per-user voice/tone profile storage. Keyed by the caller's own backend API
key — one row per person using the extension (Ian, Becky, Max, ...), applied
to every comment they draft regardless of which product it's for. This is
deliberately NOT per-product: voice belongs to the human doing the
commenting, not the thing being commented about.

Table lives in whatever base AIRTABLE_BASE_ID points at — auto-created
there (see airtable_setup.py) if it doesn't exist yet.

Every function accepts optional base_id/airtable_api_key overrides — see
airtable_store.py's module docstring for why (self-hosted vs. managed
multi-tenant callers). Named airtable_api_key specifically, not api_key,
since api_key already means something else in this file (the caller's own
backend key, which is what voice profiles are looked up BY) — don't
confuse the two.
"""

from typing import Optional

import httpx

import airtable_setup

TABLE_NAME = airtable_setup.VOICE_TABLE

FIELD_NAMES = {
    "apiKey": "API Key",
    "userName": "User Name",
    "linkedinUrl": "LinkedIn URL",
    "voiceBrief": "Voice Brief",
    "replyLength": "Reply Length",
    "replyStyle": "Reply Style",
}


def _url(base_id: Optional[str] = None) -> str:
    return airtable_setup.table_url(TABLE_NAME, base_id)


def _headers(airtable_api_key: Optional[str] = None) -> dict:
    return airtable_setup.headers(airtable_api_key)


def _record_to_profile(record: dict) -> dict:
    profile = {"recordId": record["id"]}
    for field_name, value in record.get("fields", {}).items():
        for key, name in FIELD_NAMES.items():
            if name == field_name:
                profile[key] = value
                break
    return profile


async def get_voice_profile(
    api_key: str, base_id: Optional[str] = None, airtable_api_key: Optional[str] = None
) -> Optional[dict]:
    filter_formula = f"{{{FIELD_NAMES['apiKey']}}} = '{api_key}'"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            _url(base_id),
            headers=_headers(airtable_api_key),
            params={"filterByFormula": filter_formula, "maxRecords": 1},
        )
        resp.raise_for_status()
        records = resp.json().get("records", [])
        return _record_to_profile(records[0]) if records else None


async def upsert_voice_profile(
    api_key: str, fields: dict, base_id: Optional[str] = None, airtable_api_key: Optional[str] = None
) -> dict:
    """fields may include any of: userName, linkedinUrl, voiceBrief,
    replyLength, replyStyle. Only provided keys are written."""
    existing = await get_voice_profile(api_key, base_id, airtable_api_key)
    payload = {FIELD_NAMES[k]: v for k, v in fields.items() if k in FIELD_NAMES and v is not None}
    payload[FIELD_NAMES["apiKey"]] = api_key

    async with httpx.AsyncClient(timeout=30) as client:
        if existing:
            resp = await client.patch(
                f"{_url(base_id)}/{existing['recordId']}",
                headers=_headers(airtable_api_key),
                json={"fields": payload, "typecast": True},
            )
        else:
            resp = await client.post(
                _url(base_id), headers=_headers(airtable_api_key), json={"fields": payload, "typecast": True}
            )
        resp.raise_for_status()
        return _record_to_profile(resp.json())
