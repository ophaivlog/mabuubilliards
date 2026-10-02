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
