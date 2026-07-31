import { query } from "./pool.js";

export type DbUser = {
  id: string;
  microsoft_oid: string;
  email: string | null;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function upsertMicrosoftUser(input: {
  microsoftOid: string;
  email?: string | null;
  displayName?: string | null;
}): Promise<DbUser> {
  const { rows } = await query<DbUser>(
    `INSERT INTO users (microsoft_oid, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (microsoft_oid) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       updated_at = now()
     RETURNING *`,
    [input.microsoftOid, input.email ?? null, input.displayName ?? null]
  );
  return rows[0];
}

export async function getUserById(id: string): Promise<DbUser | null> {
  const { rows } = await query<DbUser>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Local/dev synthetic user when AUTH_DISABLED=1 (scripts only). */
export async function ensureDevUser(): Promise<DbUser> {
  const oid = process.env.DEV_MICROSOFT_OID?.trim() || "local-dev-oid";
  return upsertMicrosoftUser({
    microsoftOid: oid,
    email: process.env.DEV_USER_EMAIL?.trim() || "dev@localhost",
    displayName: process.env.DEV_USER_NAME?.trim() || "Local Dev",
  });
}
