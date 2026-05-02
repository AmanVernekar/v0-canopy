-- Canopy schema. Paste into Supabase SQL editor (Database → SQL Editor → New
-- query → paste → Run). Idempotent — safe to re-run.
--
-- Tables:
--   lsoas       -- one row per LSOA. Public read. Used for the agent's
--                  get_lsoa_context tool and for hydrating the map polygons.
--   analyses    -- per-session persisted dossiers. RLS-locked to the
--                  anonymous session id (set as a request header).
--   funds_cache -- centralised, refreshable fund profiles (later).
--
-- The full per-LSOA payload (including streets array) lives directly in the
-- `data` JSONB column rather than a separate table — at ~6300 rows × ~50KB,
-- Postgres handles this comfortably and we save a join.

create extension if not exists "uuid-ossp";

-- ─── LSOAs ──────────────────────────────────────────────────────────────
create table if not exists public.lsoas (
  lsoa_code     text primary key,
  city          text not null,            -- 'london' | 'manchester' | 'birmingham'
  lad_name      text,                     -- e.g. 'Southwark'
  name          text not null,            -- e.g. 'Southwark 005A'
  vulnerability_score   numeric,          -- composite heat 0–1
  vulnerability_flood   numeric,          -- 0–1, may be null until added
  imd_decile    int,
  canopy_cover_pct   numeric,
  population    int,
  pop_density_per_ha numeric,
  pct_over_65   numeric,
  pct_under_5   numeric,
  building_count int default 0,
  /** Full payload (geometry, streets[], etc) — large but cached column-wise. */
  data          jsonb not null,
  updated_at    timestamptz not null default now()
);

create index if not exists lsoas_city_idx on public.lsoas (city);
create index if not exists lsoas_vuln_idx on public.lsoas (vulnerability_score desc);

alter table public.lsoas enable row level security;

drop policy if exists "lsoas read all" on public.lsoas;
create policy "lsoas read all" on public.lsoas
  for select using (true);

-- ─── Analyses (per-session dossier persistence) ────────────────────────
create table if not exists public.analyses (
  id            uuid primary key default uuid_generate_v4(),
  session_id    text not null,            -- anonymous client UUID from localStorage
  lsoa_code     text not null references public.lsoas(lsoa_code),
  area_name     text,
  messages      jsonb not null,           -- raw UIMessage[] from useChat
  parsed_dossier jsonb,                   -- last successfully parsed dossier
  critic_enabled boolean default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (session_id, lsoa_code)          -- one analysis per (session, LSOA)
);

create index if not exists analyses_session_idx on public.analyses (session_id, updated_at desc);

alter table public.analyses enable row level security;

-- Session-id based RLS. The client passes its session_id as a request header
-- `x-canopy-session` and we read it via current_setting on a per-request basis
-- in a security definer RPC — but for hackathon scope we just allow read/write
-- on rows whose session_id matches the supabase auth.jwt 'session_id' claim,
-- OR we lock to anon and trust the route to gate by session.
--
-- Simplest: allow anon to read/write any row for now (analyses are not
-- sensitive PII). Tighten later if/when a real auth model exists.
drop policy if exists "analyses read all" on public.analyses;
create policy "analyses read all" on public.analyses
  for select using (true);

drop policy if exists "analyses write all" on public.analyses;
create policy "analyses write all" on public.analyses
  for insert with check (true);

drop policy if exists "analyses update all" on public.analyses;
create policy "analyses update all" on public.analyses
  for update using (true) with check (true);

-- Helper: bump updated_at automatically.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;$$;

drop trigger if exists analyses_touch on public.analyses;
create trigger analyses_touch before update on public.analyses
  for each row execute function public.touch_updated_at();

-- ─── Funds cache (later) ────────────────────────────────────────────────
create table if not exists public.funds_cache (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  url           text not null unique,
  status        text,
  deadline      date,
  max_grant_gbp numeric,
  match_required_pct numeric,
  covered_axes  text[] default '{}',
  scraped_text  text,
  last_scraped_at timestamptz,
  notes         text
);

alter table public.funds_cache enable row level security;
drop policy if exists "funds read all" on public.funds_cache;
create policy "funds read all" on public.funds_cache
  for select using (true);
