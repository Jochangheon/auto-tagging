-- Bind analysis payloads and generated taxonomy to a concrete project.
ALTER TABLE page_analyses
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE page_analyses
  DROP CONSTRAINT IF EXISTS page_analyses_user_id_page_url_norm_viewport_key;

CREATE UNIQUE INDEX IF NOT EXISTS page_analyses_project_url_viewport_uidx
  ON page_analyses (project_id, page_url_norm, viewport);

CREATE INDEX IF NOT EXISTS page_analyses_project_updated_idx
  ON page_analyses (project_id, updated_at DESC);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS taxonomy JSONB;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS taxonomy_confirmed_at TIMESTAMPTZ;
