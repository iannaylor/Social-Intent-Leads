"""
FastAPI app for the hosted social-intent-leads pipeline.

Endpoints:
  POST /runs              — kick off a pipeline run from a search profile
  GET  /runs/{run_id}     — poll run status/summary
  GET  /queue              — fetch all non-done items (what the extension renders)
  POST /queue/status       — mark an item queued_followup or done
  GET  /products           — list configured products (name/context/keywords/ICP)
  POST /products           — create or update a product's context (upsert by key)

Auth: simple Bearer token against BACKEND_API_KEYS (comma-separated env var).
Good enough for a handful of internal users — not meant to scale past that
without revisiting (see SETUP.md).

Run status is kept in an in-process dict, not a database — it resets on
restart/redeploy, but that's fine, since actual results are durably written
to Airtable by the time a run completes. Only in-flight run status is
ephemeral.
"""

import os
import uuid
import datetime
import traceback

from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware

from models import SearchProfile
import pipeline
import airtable_store
import products_store

app = FastAPI(title="Social Intent Leads Backend")

# Chrome extensions call this from a chrome-extension:// origin — CORS must
# allow it. Tightening this to a specific extension ID is possible later;
# "*" is fine for an internal tool with its own API-key auth layer.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RUNS: dict[str, dict] = {}


def _valid_keys() -> set[str]:
    raw = os.environ.get("BACKEND_API_KEYS", "")
    return {k.strip() for k in raw.split(",") if k.strip()}


def require_auth(authorization: str = Header(default="")) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token not in _valid_keys():
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/runs")
async def create_run(
    profile: SearchProfile,
    background_tasks: BackgroundTasks,
    authorization: str = Header(default=""),
):
    require_auth(authorization)
    run_id = str(uuid.uuid4())
    RUNS[run_id] = {
        "runId": run_id,
        "status": "pending",
        "product": profile.product,
        "createdAt": datetime.datetime.utcnow().isoformat(),
        "error": None,
        "report": None,
    }
    background_tasks.add_task(_execute_run, run_id, profile.model_dump())
    return RUNS[run_id]


async def _execute_run(run_id: str, profile: dict):
    RUNS[run_id]["status"] = "running"
    try:
        report = await pipeline.run_pipeline(profile, run_id)
        RUNS[run_id]["status"] = "completed"
        RUNS[run_id]["report"] = report
    except Exception as e:
        RUNS[run_id]["status"] = "failed"
        RUNS[run_id]["error"] = f"{e}\n{traceback.format_exc()}"


@app.get("/runs/{run_id}")
async def get_run(run_id: str, authorization: str = Header(default="")):
    require_auth(authorization)
    if run_id not in RUNS:
        raise HTTPException(status_code=404, detail="Unknown run_id")
    return RUNS[run_id]


@app.get("/queue")
async def get_queue(product: str | None = None, authorization: str = Header(default="")):
    require_auth(authorization)
    items = await airtable_store.get_queue(product=product)
    return {"items": items}


@app.post("/queue/status")
async def set_status(body: dict, authorization: str = Header(default="")):
    require_auth(authorization)
    post_url = body.get("postUrl")
    status = body.get("status")
    if not post_url or status not in ("pending", "queued_followup", "done"):
        raise HTTPException(status_code=400, detail="postUrl and a valid status are required")
    updated = await airtable_store.set_item_status(post_url, status)
    if not updated:
        raise HTTPException(status_code=404, detail="No item with that postUrl")
    return {"ok": True}


@app.get("/products")
async def list_products(authorization: str = Header(default="")):
    require_auth(authorization)
    return {"products": await products_store.list_products()}


@app.post("/products")
async def upsert_product(body: dict, authorization: str = Header(default="")):
    require_auth(authorization)
    if not body.get("key") or not body.get("name"):
        raise HTTPException(status_code=400, detail="key and name are required")
    return await products_store.upsert_product(body)
