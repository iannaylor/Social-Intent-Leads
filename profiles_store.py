"""
Airtable-backed search profiles — replaces the earlier chrome.storage.local
only version. A search profile (name, product, ICP overrides, keywords,
recency, plus its own last-run/last-scan state) lives in the "Social Intent
Search Profiles" table (auto-created in whatever base AIRTABLE_BASE_ID
points at, see airtable_setup.py) instead of a single browser's local
storage — live feedback (2026-07-21): Products already lived here, keeping
Search Profiles local-only was an inconsistent split for the same class of
data, with no way to recover a profile on a fresh browser/profile short of
manually re-entering everything.

Every function accepts optional base_id/api_key overrides — see
airtable_store.py's module docstring for why (self-hosted vs. managed
multi-tenant callers).
"""

from typing import Optional

import httpx

import airtable_setup

TABLE_NAME = airtable_setup.PROFILES_TABLE

FIELD_NAMES = {
    "slug": "Slug",
    "name": "Name",
    "product": "Product",
    "count": "Count",
    "titles": "Titles",
    "companySizeMin": "Company Size Min",
    "companySizeMax": "Company Size Max",
    "companyType": "Company Type",
    "location": "Location",
    "intentKeywords": "Intent Keywords",
    "recency": "Recency",
    "fetchEmails": "Fetch Emails",
    "lastRunAt": "Last Run At",
    "lastRunId": "Last Run ID",
    "pendingCount": "Pending Count",
    "lastScanFound": "Last Scan Found",
    "lastScanNew": "Last Scan New",
    "lastScanDuplicate": "Last Scan Duplicate",
    "lastScanSkipped": "Last Scan Skipped",
}


def _url(base_id: Optional[str] = None) -> str:
    return airtable_setup.table_url(TABLE_NAME, base_id)


def _headers(api_key: Optional[str] = None) -> dict:
    return airtable_setup.headers(api_key)


def _record_to_profile(record: dict) -> dict:
    profile = {"recordId": record["id"]}
    for field_name, value in record.get("fields", {}).items():
        for key, name in FIELD_NAMES.items():
            if name == field_name:
                profile[key] = value
                break
    return profile


async def list_profiles(base_id: Optional[str] = None, api_key: Optional[str] = None) -> list[dict]:
    profiles = []
    offset = None
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params = {"pageSize": "100"}
            if offset:
                params["offset"] = offset
            resp = await client.get(_url(base_id), headers=_headers(api_key), params=params)
            resp.raise_for_status()
            data = resp.json()
            profiles.extend(_record_to_profile(r) for r in data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break
    return profiles


async def upsert_profile(profile: dict, base_id: Optional[str] = None, api_key: Optional[str] = None) -> dict:
    """Create or update by 'slug'. profile is a dict with the same shape as
    the extension's Search Profile form: slug, name, product, count,
    titles, companySizeMin, companySizeMax, companyType, location,
    intentKeywords, recency, fetchEmails, plus optional runtime fields
    (lastRunAt, lastRunId, pendingCount, lastScanFound/New/Duplicate/
    Skipped)."""
    existing = await list_profiles(base_id, api_key)
    match = next((p for p in existing if p.get("slug") == profile["slug"]), None)

    fields = {}
    for k, field_name in FIELD_NAMES.items():
        if k in profile and profile[k] is not None:
            fields[field_name] = profile[k]

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
        return _record_to_profile(resp.json())


async def delete_profile(slug: str, base_id: Optional[str] = None, api_key: Optional[str] = None) -> bool:
    existing = await list_profiles(base_id, api_key)
    match = next((p for p in existing if p.get("slug") == slug), None)
    if not match:
        return False
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.delete(f"{_url(base_id)}/{match['recordId']}", headers=_headers(api_key))
        resp.raise_for_status()
    return True
