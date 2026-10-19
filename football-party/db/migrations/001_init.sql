-- Pitchside schema. Portable across PostgreSQL 14+ and PGlite.
-- All football facts carry provenance (source_id) and timestamps so freshness can be shown honestly.

CREATE TABLE data_sources (
  id           text PRIMARY KEY,
  label        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sample','live','import')),
  license      text NOT NULL,
  attribution  text NOT NULL,
  notes        text NOT NULL DEFAULT '',
  current_season integer NOT NULL,
  generated_at   timestamptz NOT NULL,
  last_synced_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seasons (
  start_year  integer PRIMARY KEY,
  label       text NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL
);

CREATE TABLE teams (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('club','national')),
  name         text NOT NULL,
  short_name   text NOT NULL,
  country      text NOT NULL DEFAULT '',
  color        text NOT NULL DEFAULT '#2b3a33',
  aliases      jsonb NOT NULL DEFAULT '[]',
  name_norm    text NOT NULL,
  source_id    text NOT NULL REFERENCES data_sources(id),
  provider_ids jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_name_norm_idx ON teams (name_norm);
CREATE INDEX teams_source_idx ON teams (source_id);

CREATE TABLE competitions (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('league','cup','international')),
  name         text NOT NULL,
  short_name   text NOT NULL,
  country      text,
  aliases      jsonb NOT NULL DEFAULT '[]',
  name_norm    text NOT NULL,
  source_id    text NOT NULL REFERENCES data_sources(id),
  provider_ids jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX competitions_source_idx ON competitions (source_id);

-- A team belonged to a competition for seasons [from_season, to_season] (NULL = ongoing).
CREATE TABLE competition_memberships (
  team_id        text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  competition_id text NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  from_season    integer NOT NULL,
  to_season      integer,
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','unknown')),
  source_id      text NOT NULL REFERENCES data_sources(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, competition_id, from_season),
  CHECK (to_season IS NULL OR to_season >= from_season)
);

CREATE TABLE players (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  name_norm    text NOT NULL,
  aliases      jsonb NOT NULL DEFAULT '[]',
  birth_year   integer,
  position     text CHECK (position IN ('GK','DEF','MID','FWD')),
  tier         smallint NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
  source_id    text NOT NULL REFERENCES data_sources(id),
  provider_ids jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_name_norm_idx ON players (name_norm);
CREATE INDEX players_source_idx ON players (source_id);

-- Player-team affiliations with explicit season ranges and precision.
-- precision: season (usable for league logic) | year (ambiguous) | unknown (no dates).
-- status 'unknown' rows are stored for transparency but never used for validation.
CREATE TABLE player_affiliations (
  id           text PRIMARY KEY,
  player_id    text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id      text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  from_season  integer,
  to_season    integer,
  precision    text NOT NULL CHECK (precision IN ('season','year','unknown')),
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','unknown')),
  source_id    text NOT NULL REFERENCES data_sources(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_season IS NULL OR to_season IS NULL OR to_season >= from_season)
);
CREATE INDEX affiliations_player_idx ON player_affiliations (player_id);
CREATE INDEX affiliations_team_idx ON player_affiliations (team_id);
CREATE INDEX affiliations_source_idx ON player_affiliations (source_id);

-- Explicit record of anything the pipeline could not reconcile or had to drop.
CREATE TABLE data_conflicts (
  id           bigserial PRIMARY KEY,
  source_id    text NOT NULL REFERENCES data_sources(id),
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  kind         text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  detected_at  timestamptz NOT NULL DEFAULT now(),
  sync_run_id  bigint,
  UNIQUE (source_id, entity_type, entity_id, kind)
);

CREATE TABLE sync_runs (
  id           bigserial PRIMARY KEY,
  source_id    text NOT NULL,
  trigger      text NOT NULL CHECK (trigger IN ('manual','schedule','startup','cli')),
  status       text NOT NULL CHECK (status IN ('running','success','failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}',
  error        text
);
CREATE INDEX sync_runs_source_idx ON sync_runs (source_id, started_at DESC);

-- Optional casual profiles. No email, no password: a random bearer secret kept on the device.
CREATE TABLE profiles (
  id           text PRIMARY KEY,
  nickname     text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_results (
  id           bigserial PRIMARY KEY,
  game_id      text NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  player_count integer NOT NULL
);

CREATE TABLE profile_results (
  profile_id   text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  result_id    bigint NOT NULL REFERENCES game_results(id) ON DELETE CASCADE,
  game_id      text NOT NULL,
  score        integer NOT NULL,
  won          boolean NOT NULL,
  PRIMARY KEY (profile_id, result_id)
);
