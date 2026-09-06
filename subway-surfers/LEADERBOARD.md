# Regional leaderboards: plan

> Status: phases 1 and 2 are built. `supabase/schema.sql` is the backend;
> the client lives in `src/game.html` under "Leaderboards". Weekly boards
> and remove-my-scores from phase 3 are in too. See README, "Leaderboards".

Goal: after a run, a player sees where they stand in the world, their country,
their county, their town and their own area, and can browse each board. Boards
are keyed to where the run **started** (the postcode or location the player
chose), so a run down your street competes with everyone else who ran there.

## 1. Architecture

The game is a static page on GitHub Pages, so the leaderboard needs a hosted
database with a public API. Recommendation: **Supabase** (managed Postgres).

- Free tier (500 MB, 50k monthly active users) covers this for a long time;
  the next tier is $25/month.
- The browser talks to it directly with the public "anon" key. Row Level
  Security (RLS) policies decide what that key may do: insert a run, read
  boards, nothing else. No server of our own to run.
- Leaderboard queries live in the database as SQL functions (RPC), so the
  client asks one question ("top 20 in Nottinghamshire this week, and my
  rank") and gets one answer.
- Alternatives considered: Firebase Firestore (fine, but ranking queries are
  awkward without SQL); Cloudflare Workers + D1 (cheap and fast, but we would
  write and maintain an API). Supabase gives SQL ranking and auth for free.

## 2. Where a run "belongs": the place hierarchy

At the start of a street run we already have a latitude and longitude. We
resolve it once into a hierarchy and store the keys with the run:

| Level    | UK source (postcodes.io, free, no key)        | Elsewhere (Google Geocoding, key we have) |
|----------|-----------------------------------------------|-------------------------------------------|
| World    | constant                                      | constant                                  |
| Country  | `country` (England, Scotland…) + code `GB`    | `country` component                       |
| County   | `admin_district` (e.g. Rushcliffe) or `admin_county` where present | `administrative_area_level_2` (or level 1) |
| Town     | `admin_ward` post town / `parish` for villages | `locality`                                |
| Area     | outward postcode (e.g. `NG12`) and `parish`/`admin_ward` | `sublocality` / `neighborhood`, else postal code prefix |

postcodes.io has a reverse-geocode endpoint (`/postcodes?lon=&lat=`) that
returns all of these from a coordinate, so a "USE MY LOCATION" start is
covered as well as a typed postcode. Outside the UK the Google Geocoding API
does the same (about £4 per thousand lookups; one lookup per run start, and we
cache by rounded coordinate so replaying the same street is free).

Tunnel runs have no place; they go on the world board only.

## 3. Data model

```sql
create table players (
  id           uuid primary key default gen_random_uuid(),
  device_key   text unique not null,        -- random id kept in the browser's localStorage
  name         text not null check (length(name) between 2 and 14),
  created_at   timestamptz default now()
);

create table runs (
  id           bigserial primary key,
  player_id    uuid references players(id) on delete cascade,
  mode         text not null check (mode in ('street','tunnel')),
  score        int  not null check (score between 0 and 2000000),
  coins        int  not null default 0,
  distance_m   int  not null,
  duration_s   real not null,
  country_code text,        -- 'GB'
  country      text,        -- 'England'
  county       text,        -- 'Rushcliffe'
  town         text,        -- 'Keyworth'
  area         text,        -- 'NG12' or parish
  geohash5     text,        -- ~5 km cell for "near me" boards; no exact position is stored
  client_build text,
  created_at   timestamptz default now()
);
create index on runs (score desc);
create index on runs (country_code, score desc);
create index on runs (county, score desc);
create index on runs (town, score desc);
create index on runs (area, score desc);
create index on runs (created_at);
```

One row per run. Boards show each player's **best** run in the scope, so a
board query is "distinct on player, ordered by score" within the scope and
period. Two periods: all time and this week (Monday to Sunday).

```sql
-- top N in a scope: scope is 'world' | 'country' | 'county' | 'town' | 'area'
create function top_runs(scope text, key text, period text, lim int)
returns table (rank int, name text, score int, town text, created_at timestamptz) ...

-- where does this score land in a scope, without inserting it
create function rank_of(scope text, key text, period text, score int) returns int ...
```

RLS: anon may `insert` into `runs` and `players`, `update` only its own player
name (matched on `device_key`), and `select` only through the two functions.

## 4. Keeping it honest

Scores come from the browser, so a determined cheater can post anything. The
aim is to keep the boards friendly, not bulletproof:

- **Plausibility in the database.** A trigger rejects runs whose score is
  higher than the run's duration allows (speed tops out at 31 m/s and the
  score formula is known), whose distance disagrees with duration, or that
  arrive faster than one every 20 seconds from the same player.
- **Signed submissions.** A small Supabase Edge Function issues a run token at
  run start and checks it on submit, so scores cannot be posted without
  having started a run in the game.
- **Name filter** on the client and in the trigger (short blocklist), names
  2 to 14 characters.
- **Rate cap** per device per day (say 200 runs).
- **Quiet removal**: a `hidden` flag on runs lets us take a score off the boards
  without deleting it.

## 5. Identity

No login to start with. The first time a player finishes a run they type a
name; a random device key in localStorage ties their runs together and lets
them rename. Later, optional sign-in with Apple or Google through Supabase
Auth would let a player keep their name across devices and claim it.

## 6. Privacy

- Store the place hierarchy and a 5 km geohash cell, never the exact
  coordinate or the postcode the player typed.
- Names are chosen by the player; no email or account is needed.
- A "remove my scores" button deletes everything under the device key.
- A short privacy note on the start card, and the same in the README.

## 7. What the player sees

- **Wipeout screen**: score, then "You're 3rd in Keyworth · 41st in
  Rushcliffe · 1,204th in England · 9,870th in the world", each tappable to
  open that board. First run asks for a name.
- **Boards panel**: tabs World / Country / County / Town / Area, and All time /
  This week; top 20 with the player's own row pinned at the bottom if outside
  the top 20.
- **Start card**: "Top run near here: 14,320 by Indi" once a place is chosen.
- **Share**: "I'm 1st in Keyworth on Local Surfer" copies a link that opens the
  game on that postcode.

## 8. Phases

1. **Backend** (half a day): create the Supabase project, tables, indexes, RLS
   policies, the two functions and the plausibility trigger. Put the project
   URL and anon key into the game's config block.
2. **Client** (one to two days): resolve the place hierarchy at run start,
   submit on wipeout, name prompt, rank line on the wipeout screen, boards
   panel with tabs.
3. **Polish** (a day): weekly boards, share link, "near here" on the start
   card, remove-my-scores, edge-function run tokens.
4. **Later**: accounts, friends boards, challenge links ("beat my run on my
   street"), a monthly reset with a hall of fame.

## 9. Costs

Supabase free tier; postcodes.io free; Google Geocoding only for runs outside
the UK, roughly £4 per thousand run starts, cached. Nothing else.
