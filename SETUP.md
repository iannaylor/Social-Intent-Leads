# Deploying the Social Intent Leads backend

This turns the local `social-intent-leads` pipeline into a hosted service, so
the Chrome extension can run searches on its own — no dependency on this
laptop or a Claude Code session. Judgment quality (scoring, influencer
detection, drafting) is preserved because it still calls the Claude API
directly, using the same rubric as `SKILL.md`, just from server code instead
of an interactive session.

New to this project? **[socialintent.app](https://socialintent.app/)** has
a walkthrough of how the whole thing works end to end plus an FAQ — worth a
read before diving into the steps below.

## What you'll need before starting

| Secret | Where to get it | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key | New key, billed per-token on your Anthropic account. |
| `RICHAPI_API_KEY` | A RichAPI key — [richapi.ai](https://richapi.ai) or wherever you already have one, e.g. `~/.claude.json` under `mcpServers.richapi.headers["x-api-key"]` if you use it with Claude Code. | Same account, same credit balance as today. |
| `AIRTABLE_API_KEY` | Mint one at [airtable.com/create/tokens](https://airtable.com/create/tokens) with `data.records:read`, `data.records:write`, and `schema.bases:write` scopes on the base you'll use below (`schema.bases:write` is needed once, for auto-creating the tables). | Personal access token, not the old-style API key. |
| `AIRTABLE_BASE_ID` | Create a **brand new, completely empty** Airtable base (or point at an existing one you're happy to add tables to) — grab its ID from the URL, `airtable.com/appXXXXXXXXXXXXXX/...`. | Nothing needs to exist in it yet — see below. |
| `BACKEND_API_KEYS` | Generate one per person who'll use this: `python3 -c "import secrets; print(secrets.token_hex(24))"` | Comma-separate multiple keys, e.g. `abc123...,def456...` — one per user, so access is individually revocable. |

None of these get committed to git — `render.yaml` marks them `sync: false`,
which means Render prompts you to paste each one into its dashboard after
connecting the repo, and stores them as encrypted environment variables.

### About that empty Airtable base

The three tables this app needs — Social Intent Leads, Social Intent
Products, Social Intent Voice Profiles — are created automatically the
first time the backend starts up against the base you point
`AIRTABLE_BASE_ID` at, with the right fields already set up. You don't
need to hand-build a schema; just create an empty base and paste in its
ID. Check the Render **Logs** tab after first deploy for
`[airtable_setup] created table '...'` lines confirming it worked.

## 1. Push the code to GitHub

```bash
# create an empty repo at github.com/new first, then:
cd "/Users/iannaylor/Documents/Claude Code Workspace/claude-code/social-intent-leads-backend"
git remote add origin <your-new-repo-url>
git push -u origin main
```

(If you're reading this after asking Claude Code to do the push, it's already handled — this is here for reference / re-runs.)

## 2. Deploy on Render

1. Render dashboard → **New** → **Blueprint**.
2. Connect the GitHub repo you just pushed to.
3. Render reads `render.yaml` automatically and shows the `social-intent-leads-backend` web service, plan **Starter** (Render's cheapest always-on tier — needed because runs use background tasks that need the process to stay alive; the free tier spins down and would kill an in-progress run).
4. It'll prompt for the five env vars marked `sync: false` above — paste in the real values.
5. Deploy. Render gives you a URL like `https://social-intent-leads-backend.onrender.com`.

## 3. Verify it's alive

```bash
curl https://<your-service>.onrender.com/health
# expect: {"status":"ok"}
```

## 4. Load the Chrome extension

The extension lives in `chrome-extension/` in this same repo.

1. `chrome://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select the `chrome-extension/` folder.
2. Pin it (puzzle-piece icon in the toolbar → pin), then click it on any `linkedin.com` page to open the side panel.
3. Open **Settings** (gear icon) and fill in:
   - **Your name** — exactly as it appears on LinkedIn. Required before reply-detection or notification-scanning do anything; this is how the extension tells your own comments apart from everyone else's.
   - **Backend URL** — the Render URL from step 2.
   - **API key** — one of the values you put in `BACKEND_API_KEYS`.
   - Click **Test Connection**, then **Save**.

The Queue and Search tabs now use the hosted backend instead of local storage. Go to **Search**, create a profile, and click the scan (▶) icon — it polls automatically and reports back into the same panel.

## Giving a colleague access

They load the same extension from this repo (or you package/share the `chrome-extension/` folder directly), open **Settings**, and enter:
- Their own **name** (exactly as on LinkedIn).
- The same **Backend URL**.
- Their **own** API key — add a new key to the `BACKEND_API_KEYS` env var in Render (comma-separated) and redeploy for it to take effect.

Everyone shares the same lead pool (Airtable), so status (who's already commented/connected) stays in sync — nobody duplicates another person's outreach. Voice/tone profiles are per-person (keyed by API key), so each colleague's drafts sound like them, not like whoever set the product up.

## Costs to expect

- **Render Starter plan**: check current pricing on render.com — historically around $7/month for this tier.
- **Anthropic API**: pay-per-token, scales with usage. A scoring call is small; a drafting call (comment + connect note + DM) is a bit more. Cost per candidate is modest, but running large weekly batches across multiple products adds up — worth checking the Anthropic console's usage dashboard after the first few runs to see real numbers rather than guessing.
- **RichAPI**: same credit-based billing as today, unchanged.

## What broke on the first two real runs, and what's fixed

- **Deploy crash**: `requirements.txt` pinned `mcp==1.1.2`, which predates the streamable-HTTP transport module entirely. Fixed by downloading the real wheel and pinning `mcp==1.28.1`, plus correcting the function name (`streamable_http_client`, not `streamablehttp_client`) and how headers get passed (a caller-supplied `httpx.AsyncClient`, not a direct kwarg).
- **Both first real runs hung indefinitely** at `status: "running"` with no error — confirmed via Render's Logs tab that the server stayed healthy throughout (kept answering `/health`), so this was a stuck `await`, not a crash. Root cause: no timeout existed anywhere in the RichAPI MCP client, so a slow/stalled response had no ceiling. Fixed with an explicit `httpx` timeout and an `asyncio.wait_for()` ceiling around every tool call — a stall now fails loudly with a clear error instead of hanging forever and burning compute.
- **Debugging those hangs was slow because there was no visibility** into which pipeline step was stuck. `pipeline.py` now prints a checkpoint at every step (`[pipeline] run {id}: STEP N — ...`), visible directly in Render's Logs tab — check there first for any future issue rather than guessing from run status alone.
- **The Chrome extension could start a duplicate run** if you navigated away from Search Profiles and back before a run finished, since the run ID only lived in memory and was lost on view switch. Fixed — active runs now persist in `chrome.storage` keyed by profile, the button locks while one's in flight, and reopening the panel resumes polling the real run instead of allowing a fresh click.

**Still worth watching, not yet proven wrong or right:** `pipeline.py`'s `_resolve_company_url()` (going from a candidate's profile to their company's LinkedIn page for the ICP size/industry check) tries a few plausible field names from `enrich_profile`'s response, since the exact field wasn't directly observed in a real payload. If ICP qualification looks like it's letting too much through or dropping too much once a run actually completes, that function is the first place to check.
