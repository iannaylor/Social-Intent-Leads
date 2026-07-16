# Social Intent Leads — hosted backend

Hosted version of the `social-intent-leads` Claude Code skill
(`claude-code/skills/social-intent-leads/SKILL.md` in the main workspace).
Same pipeline — find LinkedIn posts signaling buying intent, score 0-5,
flag agency/consultant "influencers," draft comments/connection notes/DMs —
running as a standalone API so the companion Chrome extension can work
without a local Claude Code session.

Judgment calls (scoring, influencer detection, drafting voice) still go
through the Claude API directly (`claude_client.py`), using the same rubric
text as `SKILL.md`, so quality doesn't degrade versus the interactive
version — this is a hosting change, not a logic downgrade.

## Structure

- `app.py` — FastAPI app: `POST /runs`, `GET /runs/{id}`, `GET /queue`, `POST /queue/status`
- `pipeline.py` — the STEP 1-8 orchestration, ported from `SKILL.md`
- `claude_client.py` — Anthropic API calls for scoring/influencer-flagging/drafting
- `richapi_client.py` — MCP client for RichAPI (search, enrich, email finding/verification)
- `airtable_store.py` — reads/writes the `Social Intent Leads` Airtable table
- `product_config.py` — mirrors `SKILL.md`'s PRODUCT CONFIG table
- `models.py` — Pydantic request/response shapes

## Deploying

See `SETUP.md` for the full step-by-step (Render + required API keys).

## Keeping this in sync with SKILL.md

If the rubric, drafting voice, or ICP logic changes in `SKILL.md`, port the
same change here — `claude_client.py`'s system prompts and `pipeline.py`'s
step logic are meant to match it, not diverge into a second source of truth.
