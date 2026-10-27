CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE admins (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per physical phone, identified by its Android ID (no worker login).
CREATE TABLE devices (
  id          SERIAL PRIMARY KEY,
  android_id  TEXT NOT NULL UNIQUE,
  worker_id   INT REFERENCES workers(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked')),
  model       TEXT,
  os          TEXT,
  app_version TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id          BIGSERIAL PRIMARY KEY,
  worker_id   INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  geom        geography(Point, 4326) NOT NULL,
  accuracy    DOUBLE PRECISION,
  speed       DOUBLE PRECISION,
  heading     DOUBLE PRECISION,
  battery     INT,
  is_mock     BOOLEAN NOT NULL DEFAULT FALSE,
  -- makes retried / re-uploaded batches idempotent
  UNIQUE (device_id, recorded_at)
);
CREATE INDEX locations_worker_time_idx ON locations (worker_id, recorded_at);

CREATE TABLE worker_last_location (
  worker_id   INT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  device_id   INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  accuracy    DOUBLE PRECISION,
  speed       DOUBLE PRECISION,
  heading     DOUBLE PRECISION,
  battery     INT
);

-- A stay is a period spent within STAY_RADIUS_M of one spot. The row with open = TRUE is
-- the one still being extended by incoming points; it is only a real stay once it is long enough.
CREATE TABLE stays (
  id         BIGSERIAL PRIMARY KEY,
  worker_id  INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  point_count INT NOT NULL DEFAULT 1,
  is_open    BOOLEAN NOT NULL DEFAULT TRUE,
  address    TEXT
);
CREATE INDEX stays_worker_time_idx ON stays (worker_id, start_at);
CREATE UNIQUE INDEX stays_one_open_per_worker ON stays (worker_id) WHERE is_open;

CREATE TABLE geofences (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  radius_m   DOUBLE PRECISION NOT NULL CHECK (radius_m > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE geofence_state (
  worker_id   INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  geofence_id INT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  inside      BOOLEAN NOT NULL,
  PRIMARY KEY (worker_id, geofence_id)
);

CREATE TABLE geofence_events (
  id          BIGSERIAL PRIMARY KEY,
  worker_id   INT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  geofence_id INT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('enter', 'exit')),
  at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX geofence_events_time_idx ON geofence_events (at);
