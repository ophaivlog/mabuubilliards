create table if not exists public.loyalty_reward_claims (
  id bigint generated always as identity primary key,
  member_phone text not null references public.loyalty_members(phone),
  reward_code text not null check (reward_code in ('glove_1500', 'chalk_3000', 'shirt_5000', 'cash_7000', 'cue_15000')),
  claimed_at timestamptz not null default now(),
  handed_at timestamptz,
  unique (member_phone, reward_code)
);

alter table public.loyalty_reward_claims add column if not exists handed_at timestamptz;

create table if not exists public.loyalty_point_adjustments (
  id bigint generated always as identity primary key,
  member_phone text not null references public.loyalty_members(phone),
  points integer not null check (points <> 0),
  reason text not null default 'Admin điều chỉnh tổng điểm trong 12 tháng',
  adjusted_at timestamptz not null default now()
);

alter table public.loyalty_reward_claims enable row level security;
alter table public.loyalty_point_adjustments enable row level security;
revoke all on public.loyalty_reward_claims from anon, authenticated;
grant all on public.loyalty_reward_claims to service_role;
revoke all on public.loyalty_point_adjustments from anon, authenticated;
grant all on public.loyalty_point_adjustments to service_role;

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

  select coalesce(sum(points), 0)::integer into current_points from (
    select points from public.loyalty_receipts where member_phone = p_member_phone and used_at >= now() - interval '12 months'
    union all
    select points from public.loyalty_point_adjustments where member_phone = p_member_phone and adjusted_at >= now() - interval '12 months'
  ) point_events;

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

create or replace function public.admin_set_loyalty_points(p_member_phone text, p_target_points integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_points integer;
  point_delta integer;
  adjustment_row public.loyalty_point_adjustments%rowtype;
begin
  if p_target_points is null or p_target_points < 0 or p_target_points > 1000000000 then
    raise exception 'INVALID_TARGET_POINTS';
  end if;

  perform 1 from public.loyalty_members where phone = p_member_phone for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  select coalesce(sum(points), 0)::integer into current_points from (
    select points from public.loyalty_receipts where member_phone = p_member_phone and used_at >= now() - interval '12 months'
    union all
    select points from public.loyalty_point_adjustments where member_phone = p_member_phone and adjusted_at >= now() - interval '12 months'
  ) point_events;

  point_delta := p_target_points - current_points;
  if point_delta <> 0 then
    insert into public.loyalty_point_adjustments(member_phone, points)
    values (p_member_phone, point_delta)
    returning * into adjustment_row;
  end if;

  return jsonb_build_object(
    'member_phone', p_member_phone,
    'current_points', p_target_points,
    'adjustment', case when point_delta = 0 then null else jsonb_build_object(
      'member_phone', adjustment_row.member_phone,
      'points', adjustment_row.points,
      'reason', adjustment_row.reason,
      'adjusted_at', adjustment_row.adjusted_at
    ) end
  );
end;
$$;

revoke all on function public.admin_set_loyalty_points(text, integer) from public, anon, authenticated;
grant execute on function public.admin_set_loyalty_points(text, integer) to service_role;

create or replace function public.admin_confirm_loyalty_reward(p_member_phone text, p_reward_code text)
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
  if reward_threshold is null then raise exception 'INVALID_REWARD'; end if;

  perform 1 from public.loyalty_members where phone = p_member_phone for update;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;

  select coalesce(sum(points), 0)::integer into current_points from (
    select points from public.loyalty_receipts where member_phone = p_member_phone and used_at >= now() - interval '12 months'
    union all
    select points from public.loyalty_point_adjustments where member_phone = p_member_phone and adjusted_at >= now() - interval '12 months'
  ) point_events;
  if current_points < reward_threshold then raise exception 'MILESTONE_NOT_REACHED'; end if;

  select * into claim_row
  from public.loyalty_reward_claims
  where member_phone = p_member_phone and reward_code = p_reward_code
  for update;
  if not found then raise exception 'REWARD_NOT_CLAIMED'; end if;
  if claim_row.handed_at is not null then raise exception 'REWARD_ALREADY_HANDED'; end if;

  update public.loyalty_reward_claims
  set handed_at = now()
  where member_phone = p_member_phone and reward_code = p_reward_code
  returning * into claim_row;

  return jsonb_build_object(
    'member_phone', claim_row.member_phone,
    'reward_code', claim_row.reward_code,
    'claimed_at', claim_row.claimed_at,
    'handed_at', claim_row.handed_at
  );
end;
$$;

revoke all on function public.admin_confirm_loyalty_reward(text, text) from public, anon, authenticated;
grant execute on function public.admin_confirm_loyalty_reward(text, text) to service_role;
