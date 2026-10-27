ALTER TABLE devices
  ADD COLUMN gps_enabled     BOOLEAN,
  ADD COLUMN permission_ok   BOOLEAN,
  ADD COLUMN battery         INT,
  ADD COLUMN last_heartbeat  TIMESTAMPTZ;

-- Condition alerts (offline, low battery, GPS off...) stay open until the condition clears, at most one open per worker and type.
-- Event alerts (geofence enter/exit) are one-shot.
CREATE TABLE alerts (
  id           BIGSERIAL PRIMARY KEY,
  worker_id    INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  message      TEXT NOT NULL,
  is_condition BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX alerts_created_idx ON alerts (created_at DESC);
CREATE INDEX alerts_unread_idx ON alerts (created_at) WHERE read_at IS NULL;
CREATE UNIQUE INDEX alerts_one_open_condition ON alerts (worker_id, type) WHERE is_condition AND resolved_at IS NULL;
