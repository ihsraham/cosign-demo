create extension if not exists "pgcrypto";

create table if not exists public.rooms (
  id uuid primary key,
  created_by text not null,
  participant_a text not null,
  participant_b text not null,
  chain_id integer not null,
  asset_symbol text not null,
  status text not null check (status in ('open', 'closed')),
  app_session_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists rooms_participant_a_idx on public.rooms (participant_a);
create index if not exists rooms_participant_b_idx on public.rooms (participant_b);
create index if not exists rooms_created_at_idx on public.rooms (created_at desc);

create table if not exists public.proposals (
  id uuid primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  kind text not null check (kind in ('create_session', 'operate', 'close_session')),
  payload_json jsonb not null,
  payload_hash text not null,
  required_quorum integer not null,
  signatures_json jsonb not null default '{}'::jsonb,
  status text not null check (status in ('pending', 'ready', 'submitted', 'expired', 'failed')),
  sdk_result_json jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists proposals_room_id_idx on public.proposals (room_id);
create index if not exists proposals_status_idx on public.proposals (status);
create index if not exists proposals_created_at_idx on public.proposals (created_at desc);

create unique index if not exists proposals_active_kind_unique
  on public.proposals (room_id, kind)
  where status in ('pending', 'ready');

create table if not exists public.events (
  id uuid primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  proposal_id uuid references public.proposals(id) on delete set null,
  actor text not null,
  event_type text not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_room_id_idx on public.events (room_id);
create index if not exists events_created_at_idx on public.events (created_at desc);

alter table public.rooms enable row level security;
alter table public.proposals enable row level security;
alter table public.events enable row level security;

create policy "rooms_public_select" on public.rooms
  for select
  using (true);

create policy "proposals_public_select" on public.proposals
  for select
  using (true);

create policy "events_public_select" on public.events
  for select
  using (true);

-- Realtime subscriptions in Supabase dashboard should include: rooms, proposals, events.
