-- My Digital World — initial schema (Cloudflare D1 / SQLite). Foreign keys are enforced by D1.

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_locked   INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL DEFAULT '',
  repo          TEXT,
  project_type  TEXT,
  lifecycle     TEXT NOT NULL DEFAULT 'new',
  activity_level TEXT NOT NULL DEFAULT 'observed' CHECK (activity_level IN ('observed','developing')),
  test_status   TEXT NOT NULL DEFAULT 'unknown',
  test_ts       INTEGER NOT NULL DEFAULT 0,
  deploy_raw    TEXT NOT NULL DEFAULT 'none',
  deploy_ts     INTEGER NOT NULL DEFAULT 0,
  deploy_status TEXT NOT NULL DEFAULT 'none',
  deploy_hints  TEXT NOT NULL DEFAULT '[]',
  user_paused   INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_projects_last_active ON projects(last_active DESC);

-- Where a project lives in the 3D world (persisted so refreshes never reset the city).
CREATE TABLE project_locations (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  building   TEXT NOT NULL,
  slot       INTEGER NOT NULL DEFAULT 0,
  x          REAL NOT NULL,
  z          REAL NOT NULL,
  hue        INTEGER NOT NULL
);
CREATE INDEX idx_locations_building ON project_locations(building);

-- Identity keys (remote / path hash / root commit) bound to a project.
CREATE TABLE project_aliases (
  alias      TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_aliases_project ON project_aliases(project_id);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  status          TEXT NOT NULL,
  last_event_at   INTEGER NOT NULL,
  state_ts        INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT
);
CREATE INDEX idx_sessions_project ON sessions(project_id, status);
CREATE INDEX idx_sessions_status ON sessions(status, last_event_at);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,
  summary          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  state_ts         INTEGER NOT NULL,
  completed_at     INTEGER,
  completion_basis TEXT,
  fail_streak      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tasks_project ON tasks(project_id, status);
CREATE INDEX idx_tasks_session ON tasks(session_id, created_at);
CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);

-- Append-only event log. `seq` is the replay cursor; `id` makes ingestion idempotent.
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  session_id     TEXT,
  task_id        TEXT,
  ts             INTEGER NOT NULL,
  ingested_at    INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  source         TEXT NOT NULL,
  late           INTEGER NOT NULL DEFAULT 0,
  data           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_project ON events(project_id, seq DESC);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type ON events(type, seq DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_folders_unique ON folders(COALESCE(parent_id, ''), name);
CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL CHECK (size >= 0),
  folder_id  TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_files_folder ON files(folder_id, name);

-- Revocable credentials for the local bridge. Only SHA-256 hashes are stored.
CREATE TABLE bridge_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- Dashboard login sessions. The cookie holds a random token; only its hash is stored.
CREATE TABLE auth_sessions (
  id_hash    TEXT PRIMARY KEY,
  csrf       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_expires ON auth_sessions(expires_at);

CREATE TABLE rate_limits (
  key    TEXT NOT NULL,
  window INTEGER NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
