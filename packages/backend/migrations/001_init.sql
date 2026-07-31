-- Auto-tagging: users, auth sessions, per-user page analysis cache
-- Works on PostgreSQL and embedded PGlite (no pgcrypto required).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microsoft_oid TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS page_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  page_url_norm TEXT NOT NULL,
  viewport TEXT NOT NULL DEFAULT 'pc',
  page_name TEXT,
  payload JSONB NOT NULL,
  selection JSONB,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, page_url_norm, viewport)
);

CREATE INDEX IF NOT EXISTS page_analyses_user_updated_idx
  ON page_analyses (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS page_analyses_user_url_idx
  ON page_analyses (user_id, page_url_norm);
