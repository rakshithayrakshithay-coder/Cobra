const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { requireEnvironment } = require('./environment');

const DATABASE_PATH = process.env.COVERAGECAPTURE_DB_PATH || path.join(__dirname, 'db', 'coveragecapture.db');

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);

database.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS coverage_sessions (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('recording', 'done', 'failed')),
    test_name TEXT NOT NULL DEFAULT '',
    test_description TEXT NOT NULL DEFAULT '',
    test_suite TEXT NOT NULL DEFAULT 'Manual',
    environment TEXT NOT NULL,
    build_version TEXT NOT NULL DEFAULT '',
    site_origin TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    stopped_at TEXT,
    raw_coverage_json TEXT,
    interactions_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS coverage_files (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    total_functions INTEGER NOT NULL DEFAULT 0,
    covered_functions INTEGER NOT NULL DEFAULT 0,
    functions_json TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (job_id) REFERENCES coverage_sessions(job_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS delta_coverage (
    id INTEGER PRIMARY KEY,
    site_origin TEXT NOT NULL DEFAULT '',
    build_version TEXT NOT NULL DEFAULT '',
    baseline_ref TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    delta_json TEXT NOT NULL,
    UNIQUE(site_origin, build_version)
  );

  CREATE TABLE IF NOT EXISTS delta_coverage_by_environment (
    id INTEGER PRIMARY KEY,
    site_origin TEXT NOT NULL,
    environment TEXT NOT NULL,
    build_version TEXT NOT NULL DEFAULT '',
    baseline_ref TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    delta_json TEXT NOT NULL,
    UNIQUE(site_origin, environment, build_version)
  );

  CREATE INDEX IF NOT EXISTS coverage_files_job_id_idx ON coverage_files(job_id);
  CREATE INDEX IF NOT EXISTS coverage_sessions_started_at_idx ON coverage_sessions(started_at DESC);

`);

// Existing databases created before site_origin was introduced need a safe migration.
const sessionColumns = database.prepare('PRAGMA table_info(coverage_sessions)').all();
if (!sessionColumns.some((column) => column.name === 'site_origin')) {
  database.exec("ALTER TABLE coverage_sessions ADD COLUMN site_origin TEXT NOT NULL DEFAULT ''");
}
if (!sessionColumns.some((column) => column.name === 'interactions_json')) {
  database.exec("ALTER TABLE coverage_sessions ADD COLUMN interactions_json TEXT NOT NULL DEFAULT '[]'");
}
if (!sessionColumns.some((column) => column.name === 'test_suite')) {
  database.exec("ALTER TABLE coverage_sessions ADD COLUMN test_suite TEXT NOT NULL DEFAULT 'Manual'");
}
if (!sessionColumns.some((column) => column.name === 'environment')) {
  database.exec("ALTER TABLE coverage_sessions ADD COLUMN environment TEXT NOT NULL DEFAULT 'Unspecified'");
}
if (!sessionColumns.some((column) => column.name === 'build_version')) {
  database.exec("ALTER TABLE coverage_sessions ADD COLUMN build_version TEXT NOT NULL DEFAULT ''");
}
database.exec('CREATE INDEX IF NOT EXISTS coverage_sessions_site_origin_idx ON coverage_sessions(site_origin)');
database.exec('CREATE INDEX IF NOT EXISTS coverage_sessions_origin_environment_started_at_idx ON coverage_sessions(site_origin, environment, started_at DESC)');
database.exec('CREATE INDEX IF NOT EXISTS delta_coverage_environment_idx ON delta_coverage_by_environment(site_origin, environment, created_at DESC)');

const insertSession = database.prepare(`
  INSERT INTO coverage_sessions (job_id, status, test_name, test_description, test_suite, environment, build_version, site_origin, started_at)
  VALUES (?, 'recording', ?, ?, ?, ?, ?, ?, ?)
`);
const completeSession = database.prepare(`
  UPDATE coverage_sessions
  SET status = 'done', started_at = ?, stopped_at = ?, raw_coverage_json = ?, interactions_json = ?, error = NULL
  WHERE job_id = ? AND status = 'recording'
`);
const insertFile = database.prepare(`
  INSERT INTO coverage_files (job_id, url, total_functions, covered_functions, functions_json)
  VALUES (?, ?, ?, ?, ?)
`);
const getSession = database.prepare('SELECT * FROM coverage_sessions WHERE job_id = ?');
const getFiles = database.prepare('SELECT url, total_functions, covered_functions, functions_json FROM coverage_files WHERE job_id = ? ORDER BY id');
const listSessions = database.prepare('SELECT * FROM coverage_sessions WHERE site_origin = ? AND environment = ? ORDER BY started_at DESC');
const deleteSession = database.prepare('DELETE FROM coverage_sessions WHERE job_id = ? AND environment = ?');
const deleteSessionsForOrigin = database.prepare('DELETE FROM coverage_sessions WHERE site_origin = ? AND environment = ?');
const sessionsWithoutOrigin = database.prepare("SELECT job_id FROM coverage_sessions WHERE site_origin = ''");
const updateSessionOrigin = database.prepare('UPDATE coverage_sessions SET site_origin = ? WHERE job_id = ?');
const upsertDeltaCoverage = database.prepare(`
  INSERT INTO delta_coverage_by_environment (site_origin, environment, build_version, baseline_ref, created_at, delta_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(site_origin, environment, build_version) DO UPDATE SET baseline_ref = excluded.baseline_ref, created_at = excluded.created_at, delta_json = excluded.delta_json
`);
const getLatestDeltaCoverage = database.prepare('SELECT * FROM delta_coverage_by_environment WHERE site_origin = ? AND environment = ? ORDER BY created_at DESC LIMIT 1');

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function inferSiteOrigin(files) {
  const originCounts = new Map();
  for (const file of files) {
    try {
      const origin = new URL(file.url).origin;
      if (origin !== 'null') originCounts.set(origin, (originCounts.get(origin) || 0) + 1);
    } catch {
      // Ignore non-URL coverage entries.
    }
  }
  return [...originCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// Backfill sessions saved before site_origin was added, so their history remains visible.
for (const session of sessionsWithoutOrigin.all()) {
  const siteOrigin = inferSiteOrigin(getFiles.all(session.job_id));
  if (siteOrigin) updateSessionOrigin.run(siteOrigin, session.job_id);
}

function createSession({ jobId, testName = '', testDescription = '', testSuite = 'Manual', environment, buildVersion = '', siteOrigin = '', startedAt }) {
  const normalizedEnvironment = requireEnvironment(environment);
  insertSession.run(jobId, testName, testDescription, testSuite || 'Manual', normalizedEnvironment, buildVersion || '', siteOrigin || '', startedAt);
  return getCoverageSession(jobId);
}

function completeCoverageSession({ jobId, coverage, files, interactions = [], startTimestamp, stopTimestamp }) {
  database.exec('BEGIN');
  try {
    const result = completeSession.run(startTimestamp, stopTimestamp, JSON.stringify(coverage), JSON.stringify(Array.isArray(interactions) ? interactions : []), jobId);
    if (result.changes !== 1) {
      database.exec('ROLLBACK');
      return null;
    }

    for (const file of files) {
      insertFile.run(
        jobId,
        String(file?.url || ''),
        Number(file?.totalFunctions || 0),
        Number(file?.coveredFunctions || 0),
        JSON.stringify(Array.isArray(file?.functions) ? file.functions : [])
      );
    }
    database.exec('COMMIT');
    return getCoverageSession(jobId);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function toCoverageSession(session, includeRawCoverage = true) {
  if (!session) return null;

  const files = getFiles.all(session.job_id).map((file) => ({
    url: file.url,
    totalFunctions: file.total_functions,
    coveredFunctions: file.covered_functions,
    functions: parseJson(file.functions_json, []),
  }));

  return {
    jobId: session.job_id,
    status: session.status,
    testName: session.test_name,
    testDescription: session.test_description,
    testSuite: session.test_suite || 'Manual',
    environment: session.environment || 'Unspecified',
    buildVersion: session.build_version || '',
    siteOrigin: session.site_origin,
    startedAt: session.started_at,
    stoppedAt: session.stopped_at,
    result: session.status === 'done' ? {
      files,
      interactions: parseJson(session.interactions_json, []),
      ...(includeRawCoverage ? { coverage: parseJson(session.raw_coverage_json, []) } : {}),
    } : null,
    error: session.error,
  };
}

function getCoverageSession(jobId) {
  return toCoverageSession(getSession.get(jobId));
}

function listCoverageSessions(siteOrigin, environment) {
  return listSessions.all(siteOrigin, requireEnvironment(environment)).map((session) => toCoverageSession(session, false));
}

function removeCoverageSession(jobId, environment) {
  return deleteSession.run(jobId, requireEnvironment(environment)).changes > 0;
}

function removeCoverageSessionsForOrigin(siteOrigin, environment) {
  return deleteSessionsForOrigin.run(siteOrigin, requireEnvironment(environment)).changes;
}

function saveDeltaCoverage({ siteOrigin = '', environment, buildVersion = '', baselineRef = '', delta }) {
  const normalizedEnvironment = requireEnvironment(environment);
  upsertDeltaCoverage.run(siteOrigin, normalizedEnvironment, buildVersion, baselineRef, new Date().toISOString(), JSON.stringify(delta));
  return getDeltaCoverage(siteOrigin, normalizedEnvironment);
}

function getDeltaCoverage(siteOrigin, environment) {
  const row = getLatestDeltaCoverage.get(siteOrigin, requireEnvironment(environment));
  if (!row) return null;
  return { siteOrigin: row.site_origin, environment: row.environment, buildVersion: row.build_version, baselineRef: row.baseline_ref, createdAt: row.created_at, delta: parseJson(row.delta_json, null) };
}

module.exports = {
  DATABASE_PATH,
  createSession,
  completeCoverageSession,
  getCoverageSession,
  listCoverageSessions,
  removeCoverageSession,
  removeCoverageSessionsForOrigin,
  saveDeltaCoverage,
  getDeltaCoverage,
};
