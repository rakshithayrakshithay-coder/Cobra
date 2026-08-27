const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

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
    environment TEXT NOT NULL DEFAULT 'Unspecified',
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
const listSessions = database.prepare('SELECT * FROM coverage_sessions WHERE site_origin = ? ORDER BY started_at DESC');
const deleteSession = database.prepare('DELETE FROM coverage_sessions WHERE job_id = ?');
const deleteSessionsForOrigin = database.prepare('DELETE FROM coverage_sessions WHERE site_origin = ?');
const sessionsWithoutOrigin = database.prepare("SELECT job_id FROM coverage_sessions WHERE site_origin = ''");
const updateSessionOrigin = database.prepare('UPDATE coverage_sessions SET site_origin = ? WHERE job_id = ?');

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

function createSession({ jobId, testName, testDescription, testSuite = 'Manual', environment = 'Unspecified', buildVersion = '', siteOrigin, startedAt }) {
  insertSession.run(jobId, testName, testDescription, testSuite || 'Manual', environment || 'Unspecified', buildVersion || '', siteOrigin || '', startedAt);
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

function listCoverageSessions(siteOrigin) {
  return listSessions.all(siteOrigin).map((session) => toCoverageSession(session, false));
}

function removeCoverageSession(jobId) {
  return deleteSession.run(jobId).changes > 0;
}

function removeCoverageSessionsForOrigin(siteOrigin) {
  return deleteSessionsForOrigin.run(siteOrigin).changes;
}

module.exports = {
  DATABASE_PATH,
  createSession,
  completeCoverageSession,
  getCoverageSession,
  listCoverageSessions,
  removeCoverageSession,
  removeCoverageSessionsForOrigin,
};
