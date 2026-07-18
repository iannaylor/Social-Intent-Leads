# Social Intent Leads — hosted backend + Chrome extension

Find LinkedIn posts signaling buying intent, score 0-5, flag agency/
consultant "influencers," draft comments/connection notes/DMs/replies —
a hosted backend (this repo) plus a Chrome extension (`chrome-extension/`,
also in this repo) that together run standalone, no local Claude Code
session required.

📖 **[socialintent.app](https://socialintent.app/)** — how it works, FAQ,
and setup walkthroughs for both the self-hosted (this repo) and managed
backend options. Start there if you're new to the project; this repo is
the code behind it.

Judgment calls (scoring, influencer detection, drafting voice) go through
the Claude API directly (`claude_client.py`) — quality doesn't trade off
against being self-hosted.

## Structure

- `app.py` — FastAPI app: scans, batches, queue, products, voice profiles, reply drafting
- `pipeline.py` — the two-phase scan/batch orchestration
- `claude_client.py` — Anthropic API calls for scoring/influencer-flagging/drafting/replies
- `richapi_client.py` — MCP client for RichAPI (search, enrich, email finding/verification)
- `airtable_store.py` / `products_store.py` / `voice_store.py` — Airtable-backed storage for leads, product config, and per-user voice profiles
- `airtable_setup.py` — auto-provisions the required Airtable tables in a fresh base on first run
- `models.py` — Pydantic request/response shapes
- `chrome-extension/` — the companion Chrome extension (side panel UI, reply/notification detection, live browsing overlay)

## Deploying

See `SETUP.md` for the full step-by-step (Render + required API keys + loading the extension).

## Keeping this in sync with SKILL.md

If the rubric, drafting voice, or ICP logic changes in `SKILL.md`, port the
same change here — `claude_client.py`'s system prompts and `pipeline.py`'s
step logic are meant to match it, not diverge into a second source of truth.
