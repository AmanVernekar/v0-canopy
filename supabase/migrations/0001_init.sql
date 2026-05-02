-- Canopy schema. Paste into Supabase SQL editor and Run.
-- Idempotent — safe to re-run.

create extension if not exists "uuid-ossp";

-- LSOAs ----------------------------------------------------------------
create table if not exists public.lsoas (
  lsoa_code text primary key,
  city text not null,
  lad_name text,
  name text not null,
  vulnerability_score numeric,
  vulnerability_flood numeric,
  imd_decile int,
  canopy_cover_pct numeric,
  population int,
  pop_density_per_ha numeric,
  pct_over_65 numeric,
  pct_under_5 numeric,
  building_count int default 0,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists lsoas_city_idx on public.lsoas (city);
create index if not exists lsoas_vuln_idx on public.lsoas (vulnerability_score desc);

alter table public.lsoas enable row level security;

drop policy if exists "lsoas read all" on public.lsoas;
create policy "lsoas read all" on public.lsoas for select using (true);

-- Analyses (per-session dossier persistence) ---------------------------
create table if not exists public.analyses (
  id uuid primary key default uuid_generate_v4(),
  session_id text not null,
  lsoa_code text not null references public.lsoas(lsoa_code),
  area_name text,
  messages jsonb not null,
  parsed_dossier jsonb,
  critic_enabled boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, lsoa_code)
);

create index if not exists analyses_session_idx on public.analyses (session_id, updated_at desc);

alter table public.analyses enable row level security;

drop policy if exists "analyses read all" on public.analyses;
create policy "analyses read all" on public.analyses for select using (true);

drop policy if exists "analyses write all" on public.analyses;
create policy "analyses write all" on public.analyses for insert with check (true);

drop policy if exists "analyses update all" on public.analyses;
create policy "analyses update all" on public.analyses for update using (true) with check (true);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $func$
begin
  new.updated_at = now();
  return new;
end;
$func$;

drop trigger if exists analyses_touch on public.analyses;
create trigger analyses_touch
before update on public.analyses
for each row execute function public.touch_updated_at();

-- Funds cache ---------------------------------------------------------
create table if not exists public.funds_cache (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  url text not null unique,
  status text,
  deadline date,
  max_grant_gbp numeric,
  match_required_pct numeric,
  covered_axes text[] default '{}',
  scraped_text text,
  last_scraped_at timestamptz,
  notes text
);

alter table public.funds_cache enable row level security;

drop policy if exists "funds read all" on public.funds_cache;
create policy "funds read all" on public.funds_cache for select using (true);
