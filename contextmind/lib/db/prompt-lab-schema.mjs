/**
 * Prompt Lab SQLite schema (spec §36, ADR-0008 / ADR-0012).
 *
 * Same convention as lib/db/schema.mjs: one `ensureXxxSchema(db)` + version
 * bump in a meta table, applied on the writable prompt-lab.db.
 *
 * Consumer-driven table set (round-3 decision, ADR-0012 D2):
 *   prompt_meta / prompt_documents / prompt_versions / prompt_blocks /
 *   prompt_findings / prompt_patches / prompt_fingerprints /
 *   provider_capabilities
 * The three eval_* tables (prompt_eval_runs / prompt_eval_cases /
 * prompt_eval_results) are created here — round-4 Step 9 lands a real Eval
 * consumer (BuiltinEvaluator, ADR-0013). ADR-0008: never create tables for
 * consumers that do not exist yet.
 */

export const PROMPT_LAB_SCHEMA_VERSION = 2;

export const PROMPT_LAB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prompt_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_documents (
  id          TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL UNIQUE,
  title       TEXT,
  source_type TEXT,
  provider    TEXT,
  model       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL,
  version_no         INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  parent_version_id  TEXT,
  mode               TEXT,
  source_hash        TEXT NOT NULL,
  root_fingerprint   TEXT,
  provider           TEXT,
  model              TEXT,
  engine_version     TEXT,
  rule_pack_version  TEXT,
  tokenizer_version  TEXT,
  optimizer_version  TEXT,
  tokens_before      INTEGER,
  tokens_after       INTEGER,
  delta_tokens       INTEGER,
  quality_score      REAL,
  cache_score        REAL,
  token_score        REAL,
  determinism_score  REAL,
  risk_score         REAL,
  stable_prefix_ratio REAL,
  content_json       TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (document_id, version_no)
);

CREATE TABLE IF NOT EXISTS prompt_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id   TEXT NOT NULL,
  block_index  INTEGER NOT NULL,
  block_id     TEXT NOT NULL,
  occurrence   INTEGER NOT NULL,
  kind         TEXT,
  role         TEXT,
  lane         TEXT,
  stability    TEXT,
  mutability   TEXT,
  hash         TEXT,
  token_count  INTEGER,
  text         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_findings (
  id                TEXT PRIMARY KEY,
  prompt_version_id TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  category          TEXT,
  severity          TEXT,
  block_ids_json    TEXT,
  title             TEXT,
  explanation       TEXT,
  proposal_json     TEXT,
  requires_eval     INTEGER NOT NULL DEFAULT 0,
  auto_applicable   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_patches (
  id                TEXT PRIMARY KEY,
  version_id        TEXT NOT NULL,
  child_version_id  TEXT,
  operations_json   TEXT NOT NULL,
  base_fingerprint  TEXT,
  patch_risk        TEXT,
  ops_count         INTEGER NOT NULL DEFAULT 0,
  applied           INTEGER NOT NULL DEFAULT 0,
  reversed          INTEGER NOT NULL DEFAULT 0,
  why               TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_fingerprints (
  id                    TEXT PRIMARY KEY,
  version_id            TEXT NOT NULL,
  root                  TEXT NOT NULL,
  segments_json         TEXT NOT NULL,
  stable_prefix_tokens  INTEGER,
  first_dynamic_block   TEXT,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider            TEXT PRIMARY KEY,
  model_family        TEXT,
  capabilities_json   TEXT NOT NULL,
  tokenizer_id        TEXT,
  tokenizer_mode      TEXT,
  source              TEXT,
  last_verified_at    INTEGER NOT NULL
);

-- Eval (Step 9; spec §27–§30, ADR-0013). One run = one execution of the
-- eval dataset against a prompt version (or a content snapshot when no
-- version exists yet). A run that passes every case/assertion is the Eval
-- evidence that moves gate.critical_assertions_pass from UNKNOWN to PASS.
CREATE TABLE IF NOT EXISTS prompt_eval_runs (
  id                   TEXT PRIMARY KEY,
  eval_provider        TEXT NOT NULL,            -- builtin | promptfoo
  kind                 TEXT NOT NULL,            -- content | version | regression
  prompt_version_id    TEXT,                     -- bound version when kind=version
  content_hash         TEXT NOT NULL,
  dataset              TEXT NOT NULL,            -- dataset id / "builtin-1"
  total_cases          INTEGER NOT NULL,
  passed_cases         INTEGER NOT NULL,
  assertions_total     INTEGER NOT NULL,
  assertions_passed    INTEGER NOT NULL,
  negative_controls_total INTEGER NOT NULL,
  negative_controls_detected INTEGER NOT NULL,
  regression_count     INTEGER NOT NULL DEFAULT 0,
  all_passed           INTEGER NOT NULL,         -- 1 = every case+assertion passed
  metrics_json         TEXT NOT NULL,
  summary_json         TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_eval_cases (
  id            TEXT PRIMARY KEY,                -- case_id from dataset
  dataset       TEXT NOT NULL,
  category      TEXT,
  title         TEXT,
  definition_json TEXT NOT NULL,
  source        TEXT,                            -- builtin-dataset | fixture
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_eval_results (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  case_id       TEXT NOT NULL,
  passed        INTEGER NOT NULL,
  variant       TEXT NOT NULL,                   -- seed | negative
  assertions_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  metrics_json  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_doc ON prompt_versions(document_id, version_no);
CREATE INDEX IF NOT EXISTS idx_prompt_blocks_version ON prompt_blocks(version_id);
CREATE INDEX IF NOT EXISTS idx_prompt_findings_version ON prompt_findings(prompt_version_id);
CREATE INDEX IF NOT EXISTS idx_prompt_patches_version ON prompt_patches(version_id);
CREATE INDEX IF NOT EXISTS idx_prompt_fingerprints_version ON prompt_fingerprints(version_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_version ON prompt_eval_runs(prompt_version_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON prompt_eval_results(run_id);
`;

export function ensurePromptLabSchema(db) {
	if (!db) return false;
	try {
		db.exec(PROMPT_LAB_SCHEMA_SQL);
		db.prepare(
			`INSERT INTO prompt_meta(key, value) VALUES('schema_version', ?)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		).run(String(PROMPT_LAB_SCHEMA_VERSION));
		return true;
	} catch {
		return false;
	}
}
