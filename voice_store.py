"""
Per-user voice/tone profile storage. Keyed by the caller's own backend API
key — one row per person using the extension (Ian, Becky, Max, ...), applied
to every comment they draft regardless of which product it's for. This is
deliberately NOT per-product: voice belongs to the human doing the
commenting, not the thing being commented about.

Table: base appIvaVZZwTj8xr0F, table tblwhU0vawDYEKty9 ("Social Intent
Voice Profiles").
"""

import os
from typing import Optional

import httpx

BASE_ID = "appIvaVZZwTj8xr0F"
TABLE_ID = "tblwhU0vawDYEKty9"
AIRTABLE_API_URL = f"https://api.airtable.com/v0/{BASE_ID}/{TABLE_ID}"

FIELD_IDS = {
    "apiKey": "fldhxgis2a6IwJ9Fw",
    "userName": "fldbu2scsOx0tZ2Q3",
    "linkedinUrl": "fldpNIH12w4AUpqEW",
    "voiceBrief": "flds33XYJo64nNmDd",
    "replyLength": "fldCk0rChMTCVREQs",
    "replyStyle": "fld6T4DpwKE3jYSqj",
}
REVERSE_FIELD_IDS = {v: k for k, v in FIELD_IDS.items()}


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def _record_to_profile(record: dict) -> dict:
    profile = {"recordId": record["id"]}
    for field_id, value in record.get("fields", {}).items():
        key = REVERSE_FIELD_IDS.get(field_id)
        if key:
            profile[key] = value
    return profile


async def get_voice_profile(api_key: str) -> Optional[dict]:
    filter_formula = f"{{{FIELD_IDS['apiKey']}}} = '{api_key}'"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            AIRTABLE_API_URL,
            headers=_headers(),
            params={"filterByFormula": filter_formula, "maxRecords": 1, "returnFieldsByFieldId": "true"},
        )
        resp.raise_for_status()
        records = resp.json().get("records", [])
        return _record_to_profile(records[0]) if records else None


async def upsert_voice_profile(api_key: str, fields: dict) -> dict:
    """fields may include any of: userName, linkedinUrl, voiceBrief,
    replyLength, replyStyle. Only provided keys are written."""
    existing = await get_voice_profile(api_key)
    payload = {FIELD_IDS[k]: v for k, v in fields.items() if k in FIELD_IDS and v is not None}
    payload[FIELD_IDS["apiKey"]] = api_key

    async with httpx.AsyncClient(timeout=30) as client:
        if existing:
            resp = await client.patch(
                f"{AIRTABLE_API_URL}/{existing['recordId']}",
                headers=_headers(),
                json={"fields": payload, "typecast": True},
            )
        else:
            resp = await client.post(
                AIRTABLE_API_URL, headers=_headers(), json={"fields": payload, "typecast": True}
            )
        resp.raise_for_status()
        return _record_to_profile(resp.json())
