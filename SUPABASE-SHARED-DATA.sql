create table if not exists public.mini_game_settings (
  id text primary key,
  prizes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.mini_game_history (
  id uuid primary key default gen_random_uuid(),
  prize text not null,
  spun_at timestamptz not null default now()
);

create table if not exists public.loyalty_members (
  phone text primary key check (phone ~ '^[0-9]{9,11}$'),
  name text not null,
  points integer not null default 0 check (points >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.loyalty_receipts (
  invoice_number text primary key,
  member_phone text not null references public.loyalty_members(phone),
  member_name text not null,
  points integer not null check (points > 0),
  used_at timestamptz not null default now()
);

alter table public.mini_game_settings enable row level security;
alter table public.mini_game_history enable row level security;
alter table public.loyalty_members enable row level security;
alter table public.loyalty_receipts enable row level security;

revoke all on public.mini_game_settings, public.mini_game_history, public.loyalty_members, public.loyalty_receipts from anon, authenticated;
grant all on public.mini_game_settings, public.mini_game_history, public.loyalty_members, public.loyalty_receipts to service_role;

create or replace function public.apply_loyalty_receipt(p_invoice_number text, p_member_phone text, p_points integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  member_row public.loyalty_members%rowtype;
begin
  if p_points is null or p_points <= 0 then
    raise exception 'INVALID_POINTS';
  end if;

  select * into member_row
  from public.loyalty_members
  where phone = p_member_phone
  for update;

  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  insert into public.loyalty_receipts(invoice_number, member_phone, member_name, points)
  values (p_invoice_number, member_row.phone, member_row.name, p_points)
  on conflict (invoice_number) do nothing;

  if not found then
    raise exception 'INVOICE_ALREADY_USED';
  end if;

  update public.loyalty_members
  set points = points + p_points
  where phone = member_row.phone
  returning * into member_row;

  return jsonb_build_object(
    'member', jsonb_build_object('phone', member_row.phone, 'name', member_row.name, 'points', member_row.points, 'created_at', member_row.created_at),
    'receipt', jsonb_build_object('invoice_number', p_invoice_number, 'member_phone', member_row.phone, 'member_name', member_row.name, 'points', p_points, 'used_at', now())
  );
end;
$$;

revoke all on function public.apply_loyalty_receipt(text, text, integer) from public, anon, authenticated;
grant execute on function public.apply_loyalty_receipt(text, text, integer) to service_role;

create table if not exists public.loyalty_reward_claims (
  id bigint generated always as identity primary key,
  member_phone text not null references public.loyalty_members(phone),
  reward_code text not null check (reward_code in ('glove_1500', 'chalk_3000', 'shirt_5000', 'cash_7000', 'cue_15000')),
  claimed_at timestamptz not null default now(),
  unique (member_phone, reward_code)
);

alter table public.loyalty_reward_claims enable row level security;
revoke all on public.loyalty_reward_claims from anon, authenticated;
grant all on public.loyalty_reward_claims to service_role;

create or replace function public.claim_loyalty_reward(p_member_phone text, p_reward_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reward_threshold integer;
  current_points integer;
  claim_row public.loyalty_reward_claims%rowtype;
begin
  reward_threshold := case p_reward_code
    when 'glove_1500' then 1500
    when 'chalk_3000' then 3000
    when 'shirt_5000' then 5000
    when 'cash_7000' then 7000
    when 'cue_15000' then 15000
    else null
  end;

  if reward_threshold is null then
    raise exception 'INVALID_REWARD';
  end if;

  perform 1 from public.loyalty_members where phone = p_member_phone for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  select coalesce(sum(points), 0)::integer into current_points
  from public.loyalty_receipts
  where member_phone = p_member_phone
    and used_at >= now() - interval '12 months';

  if current_points < reward_threshold then
    raise exception 'MILESTONE_NOT_REACHED';
  end if;

  insert into public.loyalty_reward_claims(member_phone, reward_code)
  values (p_member_phone, p_reward_code)
  on conflict (member_phone, reward_code) do nothing
  returning * into claim_row;

  if not found then
    raise exception 'REWARD_ALREADY_CLAIMED';
  end if;

  return jsonb_build_object(
    'reward_code', claim_row.reward_code,
    'claimed_at', claim_row.claimed_at
  );
end;
$$;

revoke all on function public.claim_loyalty_reward(text, text) from public, anon, authenticated;
grant execute on function public.claim_loyalty_reward(text, text) to service_role;
