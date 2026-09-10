/**
 * Cache Engine SQLite schema (Ultimate Cache Engine spec §19).
 * Applied on handles.db alongside session_seen / result_cache.
 */

export const CACHE_SCHEMA_VERSION = 2;

export const CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_cache (
  cache_key      TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  prompt_hash    TEXT NOT NULL,
  context_hash   TEXT,
  model_family   TEXT,
  output_ref     TEXT NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_hit_at    INTEGER,
  expires_at     INTEGER,
  tier           TEXT NOT NULL DEFAULT 'temporary'
);

CREATE TABLE IF NOT EXISTS context_cache (
  cache_key           TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  bundle_json         TEXT NOT NULL,
  repo_commit         TEXT,
  dependency_fp       TEXT NOT NULL,
  hit_count           INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  last_hit_at         INTEGER,
  expires_at          INTEGER,
  tier                TEXT NOT NULL DEFAULT 'temporary'
);

CREATE TABLE IF NOT EXISTS tool_cache (
  cache_key      TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  args_hash      TEXT NOT NULL,
  output_ref     TEXT NOT NULL,
  dependency_fp  TEXT,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_hit_at    INTEGER,
  expires_at     INTEGER,
  tier           TEXT NOT NULL DEFAULT 'temporary'
);

CREATE TABLE IF NOT EXISTS output_cache (
  cache_key      TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload_ref    TEXT NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_hit_at    INTEGER,
  expires_at     INTEGER
);

CREATE TABLE IF NOT EXISTS semantic_cache (
  cache_key      TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  embedding_ref  TEXT,
  output_ref     TEXT NOT NULL,
  safety_class   TEXT NOT NULL DEFAULT 'read_only',
  hit_count      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER
);

CREATE TABLE IF NOT EXISTS cache_dependencies (
  cache_key       TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  dependency_id   TEXT NOT NULL,
  dependency_hash TEXT NOT NULL,
  PRIMARY KEY (cache_key, dependency_type, dependency_id)
);

CREATE TABLE IF NOT EXISTS cache_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  project_id  TEXT,
  session_id  TEXT,
  layer       TEXT NOT NULL,
  event       TEXT NOT NULL,
  cache_key   TEXT,
  saved_tokens INTEGER DEFAULT 0,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS prompt_pipeline_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  project_id   TEXT,
  session_id   TEXT,
  stage        TEXT NOT NULL,
  prompt_hash  TEXT,
  saved_tokens INTEGER DEFAULT 0,
  detail       TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_cache_project ON prompt_cache(project_id);
CREATE INDEX IF NOT EXISTS idx_context_cache_project ON context_cache(project_id);
CREATE INDEX IF NOT EXISTS idx_tool_cache_project ON tool_cache(project_id);
CREATE INDEX IF NOT EXISTS idx_cache_events_ts ON cache_events(ts);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_project ON semantic_cache(project_id);
`;

const MIGRATIONS_V2 = [
	"ALTER TABLE semantic_cache ADD COLUMN context_hash TEXT",
	"ALTER TABLE semantic_cache ADD COLUMN prompt_sig TEXT",
	"ALTER TABLE semantic_cache ADD COLUMN prompt_sample TEXT",
	"ALTER TABLE semantic_cache ADD COLUMN last_hit_at INTEGER",
];

function applyMigrations(db, fromVersion) {
	if (fromVersion >= 2) return;
	for (const sql of MIGRATIONS_V2) {
		try {
			db.exec(sql);
		} catch {
			/* column may exist */
		}
	}
}

export function ensureCacheSchema(db) {
	if (!db) return false;
	try {
		db.exec(CACHE_SCHEMA_SQL);
		const prev =
			db.prepare(`SELECT value FROM cache_meta WHERE key='schema_version'`).get()?.value ?? "0";
		applyMigrations(db, Number(prev) || 0);
		db.prepare(
			`INSERT INTO cache_meta(key, value) VALUES('schema_version', ?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		).run(String(CACHE_SCHEMA_VERSION));
		return true;
	} catch {
		return false;
	}
}
