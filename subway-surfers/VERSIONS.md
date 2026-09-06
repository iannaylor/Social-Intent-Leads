# Saved versions

Fallback points. Each is a commit on `claude/photorealistic-subway-surfers-5v46j2`
and a `release/*` branch that never moves.

| Version | Commit | Branch | What it is |
|---|---|---|---|
| v1.0-street | `be694b0` | `release/v1.0-street` | Street mode on Google Street View with the eye moving across to the lane, real cars, wings and magnet pickups, music, geo-first start card, Supabase leaderboards (world / country / county / town / area, one line per position on the wipeout card), localsurfer.app live. 6 Sep 2026. |

## Rolling back the live site

From the repo root, on the working branch:

```
git checkout be694b0 -- subway-surfers
git commit -m "Roll back to v1.0-street"
git push origin claude/photorealistic-subway-surfers-5v46j2
```

GitHub Pages redeploys from the push. To look at an old version without
touching the site, check out the release branch.
