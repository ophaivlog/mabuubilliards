# Supabase setup

## 1. Create a table

Open Supabase SQL Editor and run:

```sql
create table if not exists public.tournament_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tournament_state enable row level security;

create policy "Public read tournament state"
on public.tournament_state
for select
using (true);

create policy "Admin insert tournament state"
on public.tournament_state
for insert
to authenticated
with check (true);

create policy "Admin update tournament state"
on public.tournament_state
for update
to authenticated
using (true)
with check (true);

create table if not exists public.tournament_registration_requests (
  id uuid primary key default gen_random_uuid(),
  tournament_id text not null default 'main',
  tournament_name text,
  name text not null,
  phone text not null,
  note text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.tournament_registration_requests enable row level security;

grant usage on schema public to anon, authenticated;
grant insert on public.tournament_registration_requests to anon, authenticated;
grant select, update on public.tournament_registration_requests to authenticated;

create policy "Public create registration requests"
on public.tournament_registration_requests
for insert
to anon, authenticated
with check (status = 'pending');

create policy "Admin read registration requests"
on public.tournament_registration_requests
for select
to authenticated
using (true);

create policy "Admin update registration requests"
on public.tournament_registration_requests
for update
to authenticated
using (true)
with check (true);
```

If you already created the earlier public-write policies, remove them first:

```sql
drop policy if exists "Basic public insert tournament state" on public.tournament_state;
drop policy if exists "Basic public update tournament state" on public.tournament_state;
```

## 2. Fill config

Edit `supabase-config.js`:

```js
window.MABUU_SUPABASE = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_SUPABASE_ANON_KEY",
  table: "tournament_state",
  requestsTable: "tournament_registration_requests",
  recordId: "main",
};
```

## 3. Use the pages

- `admin.html`: create players, bracket, scores, and approve registration requests. Changes auto-save to Supabase.
- `index.html`: viewer page. It reads tournament data and lets players send registration requests for admin approval.

## 4. Create the admin account

In Supabase, open Authentication > Users > Add user.

Create one email/password account for the admin. Use that email/password on `admin.html`.
