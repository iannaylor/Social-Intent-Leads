# Deploying the Social Intent Leads backend

This turns the local `social-intent-leads` pipeline into a hosted service, so
the Chrome extension can run searches on its own — no dependency on this
laptop or a Claude Code session. Judgment quality (scoring, influencer
detection, drafting) is preserved because it still calls the Claude API
directly, using the same rubric as `SKILL.md`, just from server code instead
of an interactive session.

## What you'll need before starting

| Secret | Where to get it | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key | New key, billed per-token on your Anthropic account. |
| `RICHAPI_API_KEY` | Your existing RichAPI key — the same one Claude Code already uses. If you don't have it recorded elsewhere, it's in `~/.claude.json` under `mcpServers.richapi.headers["x-api-key"]` on this laptop. | Same account, same credit balance as today. |
| `AIRTABLE_API_KEY` | Your existing Airtable PAT (used by every other skill in this workspace), or mint a fresh one scoped to base `appIvaVZZwTj8xr0F` at [airtable.com/create/tokens](https://airtable.com/create/tokens) with `data.records:read` + `data.records:write` on that base. | Needs write access to the new "Social Intent Leads" table (`tblYlMKksVwVfVxx4`), already created in that base. |
| `BACKEND_API_KEYS` | Generate one per person who'll use this: `python3 -c "import secrets; print(secrets.token_hex(24))"` | Comma-separate multiple keys, e.g. `abc123...,def456...` — one per user, so access is individually revocable. |

None of these get committed to git — `render.yaml` marks them `sync: false`,
which means Render prompts you to paste each one into its dashboard after
connecting the repo, and stores them as encrypted environment variables.

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
4. It'll prompt for the four env vars marked `sync: false` above — paste in the real values.
5. Deploy. Render gives you a URL like `https://social-intent-leads-backend.onrender.com`.

## 3. Verify it's alive

```bash
curl https://<your-service>.onrender.com/health
# expect: {"status":"ok"}
```

## 4. Point the extension at it

In the extension, open the **Settings** tab:
- **Backend URL**: the Render URL from step 2.
- **API key**: one of the values you put in `BACKEND_API_KEYS`.
- Click **Test Connection**, then **Save**.

The Queue and Search Profiles tabs now use the hosted backend instead of the local `data.json` file. Go to **Search Profiles**, create or edit a profile, and click **Run in Cloud** — it polls automatically and reports back into the same panel.

## Giving a colleague access

They install the same extension (share the `chrome-extension-template/` folder, or eventually publish it), open **Settings**, and enter the same Backend URL plus their **own** API key — add a second key to the `BACKEND_API_KEYS` env var in Render (comma-separated) and redeploy for it to take effect. Everyone shares the same lead pool (Airtable), so status (who's already commented/connected) stays in sync — nobody duplicates another person's outreach.

## Costs to expect

- **Render Starter plan**: check current pricing on render.com — historically around $7/month for this tier.
- **Anthropic API**: pay-per-token, scales with usage. A scoring call is small; a drafting call (comment + connect note + DM) is a bit more. Cost per candidate is modest, but running large weekly batches across multiple products adds up — worth checking the Anthropic console's usage dashboard after the first few runs to see real numbers rather than guessing.
- **RichAPI**: same credit-based billing as today, unchanged.

## One thing to verify on first live run

`richapi_client.py` is written against the documented `mcp` Python package API for connecting to a remote HTTP-based MCP server (this is genuinely how RichAPI is exposed — verified from `~/.claude.json` — but this exact client code hasn't been executed from this environment). The first real run is the smoke test: if `POST /runs` comes back `failed` with an error mentioning the `mcp` package, check `GET /runs/{run_id}` for the traceback and share it — likely just a small API-shape fix, not a redesign.

Similarly, `pipeline.py`'s `_resolve_company_url()` (used to go from a candidate's profile to their company's LinkedIn page for the size/industry check) tries a few plausible field names from `enrich_profile`'s response, since the exact field wasn't directly observed in testing. If ICP qualification looks like it's letting too much through or dropping too much, that function is the first place to check.
