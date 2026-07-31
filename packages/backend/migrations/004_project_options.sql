ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT
    '{"default_viewports":["pc"],"cache_mode":"reuse"}'::jsonb;
