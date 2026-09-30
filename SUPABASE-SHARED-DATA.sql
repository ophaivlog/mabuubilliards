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
