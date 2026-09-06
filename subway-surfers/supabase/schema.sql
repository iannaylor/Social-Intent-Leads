-- Local Surfer leaderboards. Paste the whole file into Supabase → SQL Editor → Run. Safe to run again.
-- The browser only ever calls the functions at the bottom with the public key; it cannot read or write the
-- tables directly.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  device_key  text unique not null,            -- random id kept in the player's browser; ties their runs together
  name        text not null,
  created_at  timestamptz not null default now(),
  constraint players_name_len check (char_length(name) between 2 and 14)
);

create table if not exists public.runs (
  id            bigserial primary key,
  player_id     uuid not null references public.players(id) on delete cascade,
  mode          text not null check (mode in ('street', 'tunnel')),
  score         int  not null check (score between 0 and 2000000),
  coins         int  not null default 0 check (coins between 0 and 100000),
  distance_m    int  not null check (distance_m between 0 and 200000),
  duration_s    real not null check (duration_s between 0 and 7200),
  country_code  text,          -- 'GB'
  country       text,          -- 'England'
  county        text,          -- 'Nottinghamshire'
  town          text,          -- 'Keyworth'
  area          text,          -- 'NG12'
  geohash5      text,          -- ~5 km cell; no exact position is stored
  client_build  text,
  hidden        boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists runs_score        on public.runs (score desc);
create index if not exists runs_country      on public.runs (country_code, score desc);
create index if not exists runs_county       on public.runs (county, score desc);
create index if not exists runs_town         on public.runs (town, score desc);
create index if not exists runs_area         on public.runs (area, score desc);
create index if not exists runs_player_time  on public.runs (player_id, created_at desc);

alter table public.players enable row level security;
alter table public.runs    enable row level security;
revoke all on public.players from anon, authenticated;
revoke all on public.runs    from anon, authenticated;

create or replace function public.period_start(p_period text) returns timestamptz
language sql immutable as $$
  select case p_period when 'week' then date_trunc('week', now()) when 'month' then date_trunc('month', now()) else '-infinity'::timestamptz end;
$$;

-- top N players (best run each) in a scope: 'world' | 'country' | 'county' | 'town' | 'area', period 'all' | 'week' | 'month'
create or replace function public.top_runs(p_scope text, p_key text, p_period text, p_limit int default 20)
returns table (rank int, name text, score int, town text, created_at timestamptz)
language sql security definer set search_path = public stable as $$
  with best as (
    select distinct on (r.player_id) r.player_id, r.score, r.town, r.created_at
    from runs r
    where not r.hidden and r.created_at >= period_start(p_period)
      and case p_scope when 'world' then true when 'country' then r.country_code = p_key when 'county' then r.county = p_key
                       when 'town' then r.town = p_key when 'area' then r.area = p_key else false end
    order by r.player_id, r.score desc
  )
  select (row_number() over (order by b.score desc, b.created_at))::int, p.name, b.score, b.town, b.created_at
  from best b join players p on p.id = b.player_id
  order by b.score desc, b.created_at
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

-- where a score lands among players' best runs in a scope
create or replace function public.rank_of(p_scope text, p_key text, p_period text, p_score int)
returns table (rank int, total int)
language sql security definer set search_path = public stable as $$
  with best as (
    select distinct on (r.player_id) r.player_id, r.score
    from runs r
    where not r.hidden and r.created_at >= period_start(p_period)
      and case p_scope when 'world' then true when 'country' then r.country_code = p_key when 'county' then r.county = p_key
                       when 'town' then r.town = p_key when 'area' then r.area = p_key else false end
    order by r.player_id, r.score desc
  )
  select (count(*) filter (where b.score > p_score))::int + 1, count(*)::int from best b;
$$;

-- record a run; returns the ranks it earns. Rejects implausible runs and floods.
create or replace function public.submit_run(
  p_device text, p_name text, p_mode text, p_score int, p_coins int, p_distance int, p_duration real,
  p_country_code text default null, p_country text default null, p_county text default null, p_town text default null,
  p_area text default null, p_geohash5 text default null, p_build text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_player uuid; v_last timestamptz; v_today int; v_name text; v_out json;
begin
  if p_device is null or char_length(p_device) < 16 or char_length(p_device) > 64 then raise exception 'bad device'; end if;
  v_name := left(btrim(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9 _.\-]', '', 'g')), 14);
  if char_length(v_name) < 2 then raise exception 'name too short'; end if;
  if v_name ~* '(fuck|shit|cunt|nigg|twat|wank|cock|dick)' then v_name := 'Runner'; end if;
  insert into players (device_key, name) values (p_device, v_name)
    on conflict (device_key) do update set name = excluded.name
    returning id into v_player;
  -- plausibility: top speed is 31 m/s; score cannot exceed 4.5 x distance + 60 x coins + 500
  if p_duration < 1 or p_distance > p_duration * 31 + 30 or p_score > p_distance * 4.5 + p_coins * 60 + 500 or p_coins > p_distance then
    raise exception 'implausible run';
  end if;
  select max(created_at) into v_last from runs where player_id = v_player;
  if v_last is not null and v_last > now() - interval '6 seconds' then raise exception 'too fast'; end if;
  select count(*) into v_today from runs where player_id = v_player and created_at > now() - interval '1 day';
  if v_today >= 300 then raise exception 'daily limit'; end if;
  insert into runs (player_id, mode, score, coins, distance_m, duration_s, country_code, country, county, town, area, geohash5, client_build)
  values (v_player, p_mode, p_score, p_coins, p_distance, p_duration, p_country_code, p_country, p_county, p_town, p_area, p_geohash5, p_build);
  select json_build_object(
    'world',   (select row_to_json(x) from rank_of('world', null, 'all', p_score) x),
    'country', case when p_country_code is null then null else (select row_to_json(x) from rank_of('country', p_country_code, 'all', p_score) x) end,
    'county',  case when p_county is null then null else (select row_to_json(x) from rank_of('county', p_county, 'all', p_score) x) end,
    'town',    case when p_town is null then null else (select row_to_json(x) from rank_of('town', p_town, 'all', p_score) x) end,
    'area',    case when p_area is null then null else (select row_to_json(x) from rank_of('area', p_area, 'all', p_score) x) end,
    'week',    (select row_to_json(x) from rank_of('world', null, 'week', p_score) x)
  ) into v_out;
  return v_out;
end $$;

-- a player can remove everything under their device key
create or replace function public.remove_my_runs(p_device text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from players where device_key = p_device; get diagnostics n = row_count; return n;
end $$;

revoke all on function public.submit_run(text,text,text,int,int,int,real,text,text,text,text,text,text,text) from public;
revoke all on function public.remove_my_runs(text) from public;
grant execute on function public.period_start(text) to anon, authenticated;
grant execute on function public.top_runs(text,text,text,int) to anon, authenticated;
grant execute on function public.rank_of(text,text,text,int) to anon, authenticated;
grant execute on function public.submit_run(text,text,text,int,int,int,real,text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.remove_my_runs(text) to anon, authenticated;
