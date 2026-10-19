-- Fame score used to keep Impostor rounds to genuinely well-known footballers (higher = better known).
ALTER TABLE players ADD COLUMN fame integer NOT NULL DEFAULT 0;
CREATE INDEX players_fame_idx ON players (fame DESC);
