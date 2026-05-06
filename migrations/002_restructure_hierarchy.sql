-- Migration: Restructure to LoveBridge-style tournament hierarchy
--
-- Old: bg_tournaments (flat, type/scoring on tournament, stage as loose text)
-- New: bg_tournaments → bg_events → bg_stages (3-level hierarchy)
--
-- type/scoring moves to event level.
-- Boards link to stages. Participants link to events.

-- ── Drop old tables ─────────────────────────────────────────────

drop table if exists bsd_game_analyses cascade;
drop table if exists bg_board_results cascade;
drop table if exists bg_boards cascade;
drop table if exists bg_participants cascade;
drop table if exists bg_tournaments cascade;


-- ── 1. Tournaments (top-level container) ────────────────────────

create table bg_tournaments (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  location      text,
  date_start    date,
  date_end      date,
  source_format text not null check (source_format in ('srini', 'bridgewebs', 'sg', 'lovebridge')),
  source_meta   jsonb default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table bg_tournaments enable row level security;
create policy "Authenticated users can read tournaments"
  on bg_tournaments for select using (auth.role() = 'authenticated');


-- ── 2. Events (within a tournament) ─────────────────────────────

create table bg_events (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid references bg_tournaments on delete cascade not null,
  name          text not null,
  type          text not null check (type in ('teams', 'pairs')),
  scoring       text not null check (scoring in ('imp', 'mp', 'bam')),
  event_order   int,
  source_url    text unique,
  source_meta   jsonb default '{}',
  created_at    timestamptz default now(),

  unique (tournament_id, name)
);

alter table bg_events enable row level security;
create policy "Authenticated users can read events"
  on bg_events for select using (auth.role() = 'authenticated');

create index idx_bg_events_tournament on bg_events (tournament_id);


-- ── 3. Stages (within an event) ─────────────────────────────────

create table bg_stages (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid references bg_events on delete cascade not null,
  name             text not null,
  stage_order      int,
  arrange_type     text,
  boards_per_round int,
  number_of_rounds int,
  source_url       text unique,
  source_meta      jsonb default '{}',
  created_at       timestamptz default now(),

  unique (event_id, name)
);

alter table bg_stages enable row level security;
create policy "Authenticated users can read stages"
  on bg_stages for select using (auth.role() = 'authenticated');

create index idx_bg_stages_event on bg_stages (event_id);


-- ── 4. Participants (teams or pairs, linked to event) ───────────

create table bg_participants (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid references bg_events on delete cascade not null,
  number        int not null,
  name          text not null,
  roster        jsonb default '[]',

  unique (event_id, number)
);

alter table bg_participants enable row level security;
create policy "Authenticated users can read participants"
  on bg_participants for select using (auth.role() = 'authenticated');

create index idx_bg_participants_event on bg_participants (event_id);


-- ── 5. Boards (deals, linked to stage) ──────────────────────────

create table bg_boards (
  id            uuid primary key default gen_random_uuid(),
  stage_id      uuid references bg_stages on delete cascade not null,
  board_number  int not null,
  round         int,
  dealer        text not null check (dealer in ('N', 'E', 'S', 'W')),
  vulnerability text not null check (vulnerability in ('none', 'ns', 'ew', 'both')),

  -- hands (16 columns)
  n_spades text, n_hearts text, n_diamonds text, n_clubs text,
  e_spades text, e_hearts text, e_diamonds text, e_clubs text,
  s_spades text, s_hearts text, s_diamonds text, s_clubs text,
  w_spades text, w_hearts text, w_diamonds text, w_clubs text,

  -- high card points
  hcp_n smallint, hcp_e smallint, hcp_s smallint, hcp_w smallint,

  -- double-dummy tricks (20 columns)
  dd_n_c smallint, dd_n_d smallint, dd_n_h smallint, dd_n_s smallint, dd_n_nt smallint,
  dd_e_c smallint, dd_e_d smallint, dd_e_h smallint, dd_e_s smallint, dd_e_nt smallint,
  dd_s_c smallint, dd_s_d smallint, dd_s_h smallint, dd_s_s smallint, dd_s_nt smallint,
  dd_w_c smallint, dd_w_d smallint, dd_w_h smallint, dd_w_s smallint, dd_w_nt smallint,

  minimax       text,
  optimal_score smallint,

  unique (stage_id, round, board_number)
);

alter table bg_boards enable row level security;
create policy "Authenticated users can read boards"
  on bg_boards for select using (auth.role() = 'authenticated');

create index idx_bg_boards_stage on bg_boards (stage_id);
create index idx_bg_boards_lookup on bg_boards (stage_id, round, board_number);


-- ── 6. Board results (one row per table result) ─────────────────

create table bg_board_results (
  id                 uuid primary key default gen_random_uuid(),
  board_id           uuid references bg_boards on delete cascade not null,
  stage_id           uuid references bg_stages on delete cascade not null,

  ns_participant_id  uuid references bg_participants on delete set null,
  ew_participant_id  uuid references bg_participants on delete set null,

  match_id           text,

  -- contract
  contract           text,
  contract_level     smallint check (contract_level between 1 and 7),
  contract_denom     text check (contract_denom in ('C', 'D', 'H', 'S', 'NT')),
  contract_x         text check (contract_x in ('X', 'XX') or contract_x is null),
  declarer           text check (declarer in ('N', 'E', 'S', 'W') or declarer is null),
  passed_out         boolean default false,

  -- lead
  lead               text,
  lead_suit          text check (lead_suit in ('C', 'D', 'H', 'S') or lead_suit is null),
  lead_rank          text check (lead_rank in ('A','K','Q','J','T','9','8','7','6','5','4','3','2') or lead_rank is null),

  -- result
  tricks             smallint check (tricks between 0 and 13),
  overtricks         smallint,
  score              int not null,

  -- scoring
  mp_ns              numeric,
  mp_ew              numeric,
  imps_ns            numeric,
  imps_ew            numeric,
  datum_ns           numeric,
  datum_ew           numeric,

  -- context
  room               text check (room in ('open', 'closed') or room is null),
  round              int,
  table_number       text,

  -- players at this table
  player_n_name      text,
  player_n_id        text,
  player_s_name      text,
  player_s_id        text,
  player_e_name      text,
  player_e_id        text,
  player_w_name      text,
  player_w_id        text,

  -- complete deal record
  lin                text,
  remarks            text
);

alter table bg_board_results enable row level security;
create policy "Authenticated users can read board results"
  on bg_board_results for select using (auth.role() = 'authenticated');

create index idx_bg_results_board on bg_board_results (board_id);
create index idx_bg_results_stage on bg_board_results (stage_id);
create index idx_bg_results_match on bg_board_results (board_id, match_id) where match_id is not null;
create index idx_bg_results_contract on bg_board_results (contract_denom, contract_level);
create index idx_bg_results_room on bg_board_results (board_id, room) where room is not null;
create index idx_bg_results_ns_participant on bg_board_results (ns_participant_id);
create index idx_bg_results_ew_participant on bg_board_results (ew_participant_id);


-- ── 7. User analyses (linked to event) ──────────────────────────

create table bsd_game_analyses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users on delete cascade not null,
  name          text not null,
  event_id      uuid references bg_events on delete cascade not null,
  participant_id uuid references bg_participants on delete set null,
  filters       jsonb default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table bsd_game_analyses enable row level security;
create policy "Users can read own analyses"
  on bsd_game_analyses for select using (auth.uid() = user_id);
create policy "Users can insert own analyses"
  on bsd_game_analyses for insert with check (auth.uid() = user_id);
create policy "Users can update own analyses"
  on bsd_game_analyses for update using (auth.uid() = user_id);
create policy "Users can delete own analyses"
  on bsd_game_analyses for delete using (auth.uid() = user_id);

create index idx_bsd_analyses_user on bsd_game_analyses (user_id);
create index idx_bsd_analyses_event on bsd_game_analyses (event_id);
