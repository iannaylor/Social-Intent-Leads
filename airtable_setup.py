"""
Auto-provisions the three tables this app depends on inside whatever
Airtable base the operator points AIRTABLE_BASE_ID at — a fresh deploy
won't have Ian's specific base, and previously the code assumed it did
(hardcoded base ID shared across three files, plus hardcoded per-field
IDs that only exist inside that one base). A first-time setup now just
needs an empty Airtable base and its ID; the right tables and fields get
created automatically on first use instead of needing to be hand-built
to match an undocumented internal schema.

Airtable's REST API accepts a table's NAME directly in place of its ID in
request URLs — so once a table exists with the expected name, the store
modules never need to know or cache its generated ID at all. This module
only has one job: given a table name and its field schema, make sure a
table by that name exists in the configured base, creating it if not.
"""

import os
import urllib.parse

import httpx

AIRTABLE_META_URL = "https://api.airtable.com/v0/meta/bases"


def headers(api_key: str | None = None) -> dict:
    """api_key overrides AIRTABLE_API_KEY when given — the managed
    multi-tenant backend resolves a per-request key (its own, always;
    Airtable access itself stays Ian's account regardless of tenant) while
    self-hosted deploys keep relying on the env var, unchanged."""
    return {
        "Authorization": f"Bearer {api_key or os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def base_id(override: str | None = None) -> str:
    """override lets a caller resolve a per-tenant base ID explicitly
    (e.g. the managed backend, per customer) instead of the single
    AIRTABLE_BASE_ID env var self-hosted deploys use."""
    return override or os.environ["AIRTABLE_BASE_ID"]


def table_url(table_name: str, base_id_override: str | None = None) -> str:
    return f"https://api.airtable.com/v0/{base_id(base_id_override)}/{urllib.parse.quote(table_name)}"


# Checked once per (base, table) per process lifetime — table existence
# doesn't change while the app is running, and re-checking on every
# request would just be a wasted round trip to the Metadata API. Keyed by
# base too, not just table name, since a multi-tenant caller verifies the
# same table name across many different bases (one per customer) — a
# single table-name-only cache would incorrectly skip verifying a brand
# new customer's base just because some OTHER customer's table already
# passed.
_verified_tables: set[tuple[str, str]] = set()


async def ensure_table(
    table_name: str, fields: list[dict], base_id_override: str | None = None, api_key_override: str | None = None
) -> None:
    """No-ops if already verified this process, or if a table with this
    name already exists in the base. Creates it (with the given Airtable
    field schema, first field becomes the primary field) if not."""
    resolved_base = base_id(base_id_override)
    cache_key = (resolved_base, table_name)
    if cache_key in _verified_tables:
        return

    hdrs = headers(api_key_override)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{AIRTABLE_META_URL}/{resolved_base}/tables", headers=hdrs)
        resp.raise_for_status()
        existing = resp.json().get("tables", [])
        if any(t["name"] == table_name for t in existing):
            _verified_tables.add(cache_key)
            return

        print(f"[airtable_setup] table '{table_name}' not found in base {resolved_base}, creating it", flush=True)
        resp = await client.post(
            f"{AIRTABLE_META_URL}/{resolved_base}/tables",
            headers=hdrs,
            json={"name": table_name, "fields": fields},
        )
        resp.raise_for_status()
        print(f"[airtable_setup] created table '{table_name}' in base {resolved_base}", flush=True)
        _verified_tables.add(cache_key)


def select_field(name: str, choices: list[str]) -> dict:
    return {"name": name, "type": "singleSelect", "options": {"choices": [{"name": c} for c in choices]}}


def text_field(name: str) -> dict:
    return {"name": name, "type": "singleLineText"}


def long_text_field(name: str) -> dict:
    return {"name": name, "type": "multilineText"}


def number_field(name: str) -> dict:
    return {"name": name, "type": "number", "options": {"precision": 0}}


def checkbox_field(name: str) -> dict:
    return {"name": name, "type": "checkbox", "options": {"icon": "check", "color": "greenBright"}}


def url_field(name: str) -> dict:
    return {"name": name, "type": "url"}


LEADS_TABLE = "Social Intent Leads"
LEADS_FIELDS = [
    text_field("Post URL"),  # first field = primary field
    text_field("Name"),
    url_field("Profile URL"),
    text_field("Product"),
    number_field("Score"),
    checkbox_field("Is Influencer"),
    select_field("Connect Reason", ["direct-buyer", "influencer"]),
    select_field("Action", ["skip", "comment", "comment+connect", "pending_batch", "enriched_pending_draft"]),
    long_text_field("Skip Reason"),
    long_text_field("Comment"),
    long_text_field("Connection Note"),
    long_text_field("DM Message"),
    text_field("Email"),
    select_field("Email Status", ["valid", "risky", "invalid", "unknown"]),
    text_field("Source Label"),
    text_field("Run ID"),
    select_field("Item Status", ["pending", "queued_followup", "done"]),
    long_text_field("Commentary"),
    text_field("Profile Slug"),
]

PRODUCTS_TABLE = "Social Intent Products"
PRODUCTS_FIELDS = [
    text_field("Key"),  # first field = primary field
    text_field("Name"),
    long_text_field("Context"),
    url_field("Landing Page URL"),
    text_field("Broad Keywords"),
    text_field("High Intent Keywords"),
    text_field("ICP Titles"),
    number_field("ICP Company Size Min"),
    number_field("ICP Company Size Max"),
    text_field("ICP Industries"),
]

VOICE_TABLE = "Social Intent Voice Profiles"
VOICE_FIELDS = [
    text_field("API Key"),  # first field = primary field
    text_field("User Name"),
    url_field("LinkedIn URL"),
    long_text_field("Voice Brief"),
    select_field("Reply Length", ["short", "long"]),
    select_field("Reply Style", ["casual", "professional"]),
]
