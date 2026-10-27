-- Android builds of the worker app, uploaded by the system admin and downloaded by admins.
-- The file itself lives on disk (UPLOADS_DIR/apk/<id>.apk); only metadata is stored here.
CREATE TABLE app_releases (
  id           SERIAL PRIMARY KEY,
  version_name TEXT NOT NULL,
  notes        TEXT,
  size_bytes   BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  uploaded_by  INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_releases_created_idx ON app_releases (created_at DESC);
