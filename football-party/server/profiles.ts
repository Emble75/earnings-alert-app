import type { Db } from './db';
import type { GameSummary } from '../shared/room/room';
import { randomToken, sha256 } from './security';
import { validateNickname } from '../shared/room/room';

export interface ProfileStats {
  id: string;
  nickname: string;
  gamesPlayed: number;
  wins: number;
  byGame: Record<string, { played: number; wins: number; points: number }>;
}

/**
 * Optional casual profiles: a nickname plus a random secret kept on the device. No email, no
 * password, no tracking beyond per-game scores. Deleting a profile erases its results.
 */
export class ProfileService {
  constructor(private db: Db) {}

  async create(rawNickname: string) {
    const nickname = validateNickname(rawNickname);
    const id = randomToken(9);
    const token = randomToken(24);
    await this.db.query('INSERT INTO profiles (id, nickname, token_hash) VALUES ($1,$2,$3)', [
      id,
      nickname,
      sha256(token),
    ]);
    return { id, nickname, token };
  }

  async authenticate(
    token: string | undefined | null,
  ): Promise<{ id: string; nickname: string } | null> {
    if (!token || token.length > 100) return null;
    const r = await this.db.query<{ id: string; nickname: string }>(
      'UPDATE profiles SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, nickname',
      [sha256(token)],
    );
    return r.rows[0] ?? null;
  }

  async delete(profileId: string) {
    await this.db.query('DELETE FROM profiles WHERE id = $1', [profileId]);
  }

  async stats(profileId: string): Promise<ProfileStats | null> {
    const p = await this.db.query<{ id: string; nickname: string }>(
      'SELECT id, nickname FROM profiles WHERE id = $1',
      [profileId],
    );
    if (!p.rows[0]) return null;
    const rows = await this.db.query<{
      game_id: string;
      played: string;
      wins: string;
      points: string;
    }>(
      `SELECT game_id, count(*) played, count(*) FILTER (WHERE won) wins, coalesce(sum(score),0) points
       FROM profile_results WHERE profile_id = $1 GROUP BY game_id`,
      [profileId],
    );
    const byGame: ProfileStats['byGame'] = {};
    let gamesPlayed = 0;
    let wins = 0;
    for (const r of rows.rows) {
      byGame[r.game_id] = {
        played: Number(r.played),
        wins: Number(r.wins),
        points: Number(r.points),
      };
      gamesPlayed += Number(r.played);
      wins += Number(r.wins);
    }
    return { id: p.rows[0].id, nickname: p.rows[0].nickname, gamesPlayed, wins, byGame };
  }

  /** Records one finished game: an anonymous result row plus per-profile rows for linked players. */
  async recordResult(s: GameSummary) {
    const linked = Object.entries(s.profiles);
    if (linked.length === 0) return;
    const top = Math.max(...Object.values(s.scores));
    await this.db.tx(async (q) => {
      const r = await q.query<{ id: string }>(
        'INSERT INTO game_results (game_id, player_count) VALUES ($1,$2) RETURNING id',
        [s.gameId, s.playerCount],
      );
      for (const [playerId, profileId] of linked) {
        const score = s.scores[playerId] ?? 0;
        await q.query(
          `INSERT INTO profile_results (profile_id, result_id, game_id, score, won) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [profileId, r.rows[0]!.id, s.gameId, score, score === top && top > 0],
        );
      }
    });
  }
}
