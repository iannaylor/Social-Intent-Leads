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


def headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
        "Content-Type": "application/json",
    }


def base_id() -> str:
    return os.environ["AIRTABLE_BASE_ID"]


def table_url(table_name: str) -> str:
    return f"https://api.airtable.com/v0/{base_id()}/{urllib.parse.quote(table_name)}"


# Checked once per table per process lifetime — table existence doesn't
# change while the app is running, and re-checking on every request would
# just be a wasted round trip to the Metadata API.
_verified_tables: set[str] = set()


async def ensure_table(table_name: str, fields: list[dict]) -> None:
    """No-ops if already verified this process, or if a table with this
    name already exists in the base. Creates it (with the given Airtable
    field schema, first field becomes the primary field) if not."""
    if table_name in _verified_tables:
        return

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{AIRTABLE_META_URL}/{base_id()}/tables", headers=headers())
        resp.raise_for_status()
        existing = resp.json().get("tables", [])
        if any(t["name"] == table_name for t in existing):
            _verified_tables.add(table_name)
            return

        print(f"[airtable_setup] table '{table_name}' not found in base {base_id()}, creating it", flush=True)
        resp = await client.post(
            f"{AIRTABLE_META_URL}/{base_id()}/tables",
            headers=headers(),
            json={"name": table_name, "fields": fields},
        )
        resp.raise_for_status()
        print(f"[airtable_setup] created table '{table_name}'", flush=True)
        _verified_tables.add(table_name)


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
