import { query } from "./pool.js";

export type DbAuthSession = {
  id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export async function createAuthSession(userId: string): Promise<DbAuthSession> {
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const { rows } = await query<DbAuthSession>(
    `INSERT INTO auth_sessions (user_id, expires_at)
     VALUES ($1, $2)
     RETURNING *`,
    [userId, expires.toISOString()]
  );
  return rows[0];
}

export async function getValidAuthSession(
  sessionId: string
): Promise<(DbAuthSession & { email: string | null; display_name: string | null; microsoft_oid: string }) | null> {
  const { rows } = await query<
    DbAuthSession & { email: string | null; display_name: string | null; microsoft_oid: string }
  >(
    `SELECT s.*, u.email, u.display_name, u.microsoft_oid
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function deleteAuthSession(sessionId: string): Promise<void> {
  await query(`DELETE FROM auth_sessions WHERE id = $1`, [sessionId]);
}

export async function deleteExpiredAuthSessions(): Promise<void> {
  await query(`DELETE FROM auth_sessions WHERE expires_at <= now()`);
}
