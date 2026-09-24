CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  addon_mode TEXT NOT NULL DEFAULT 'inherit',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  nuvio_profile_id TEXT,
  nuvio_profile_index INTEGER,
  avatar_color_hex TEXT,
  avatar_url TEXT,
  uses_primary_addons INTEGER DEFAULT 0,
  token_epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_addons (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, url)
);

CREATE TABLE IF NOT EXISTS watch_state (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  position_ticks INTEGER NOT NULL DEFAULT 0,
  played INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  media_source_id TEXT,
  subtitle_index INTEGER,
  PRIMARY KEY (profile_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_watch_state_profile_updated ON watch_state (profile_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS profile_favorites (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  content_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  name TEXT,
  poster TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_profile_favorites_profile ON profile_favorites (profile_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_connect (
  code TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  client_version TEXT NOT NULL DEFAULT '',
  authenticated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quick_connect_secret ON quick_connect (secret);

CREATE TABLE IF NOT EXISTS addon_health (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  addon_url TEXT NOT NULL,
  fails INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  latency_ms INTEGER DEFAULT 0,
  PRIMARY KEY (profile_id, addon_url)
);

CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  profile_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_app_log_recent ON app_log (id DESC);

CREATE TABLE IF NOT EXISTS hidden_items (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_key)
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, item_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_profile ON sync_tombstones (profile_id, kind);
