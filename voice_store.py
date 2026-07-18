"""
Per-user voice/tone profile storage. Keyed by the caller's own backend API
key — one row per person using the extension (Ian, Becky, Max, ...), applied
to every comment they draft regardless of which product it's for. This is
deliberately NOT per-product: voice belongs to the human doing the
commenting, not the thing being commented about.

Table lives in whatever base AIRTABLE_BASE_ID points at — auto-created
there (see airtable_setup.py) if it doesn't exist yet.
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


def _url() -> str:
    return airtable_setup.table_url(TABLE_NAME)


def _headers() -> dict:
    return airtable_setup.headers()


def _record_to_profile(record: dict) -> dict:
    profile = {"recordId": record["id"]}
    for field_name, value in record.get("fields", {}).items():
        for key, name in FIELD_NAMES.items():
            if name == field_name:
                profile[key] = value
                break
    return profile


async def get_voice_profile(api_key: str) -> Optional[dict]:
    filter_formula = f"{{{FIELD_NAMES['apiKey']}}} = '{api_key}'"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            _url(),
            headers=_headers(),
            params={"filterByFormula": filter_formula, "maxRecords": 1},
        )
        resp.raise_for_status()
        records = resp.json().get("records", [])
        return _record_to_profile(records[0]) if records else None


async def upsert_voice_profile(api_key: str, fields: dict) -> dict:
    """fields may include any of: userName, linkedinUrl, voiceBrief,
    replyLength, replyStyle. Only provided keys are written."""
    existing = await get_voice_profile(api_key)
    payload = {FIELD_NAMES[k]: v for k, v in fields.items() if k in FIELD_NAMES and v is not None}
    payload[FIELD_NAMES["apiKey"]] = api_key

    async with httpx.AsyncClient(timeout=30) as client:
        if existing:
            resp = await client.patch(
                f"{_url()}/{existing['recordId']}",
                headers=_headers(),
                json={"fields": payload, "typecast": True},
            )
        else:
            resp = await client.post(
                _url(), headers=_headers(), json={"fields": payload, "typecast": True}
            )
        resp.raise_for_status()
        return _record_to_profile(resp.json())
