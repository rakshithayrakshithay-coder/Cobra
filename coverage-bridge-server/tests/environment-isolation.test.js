const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coveragecapture-environment-test-'));
process.env.COVERAGECAPTURE_DB_PATH = path.join(directory, 'coverage.db');

const database = require('../coverage-database');
const origin = 'https://traveltrust.example';

database.createSession({ jobId: 'development-job', testName: 'development', environment: 'Development', siteOrigin: origin, startedAt: '2026-01-01T00:00:00.000Z' });
database.createSession({ jobId: 'qa-job', testName: 'qa', environment: 'QA', siteOrigin: origin, startedAt: '2026-01-02T00:00:00.000Z' });

assert.deepEqual(database.listCoverageSessions(origin, 'Development').map((session) => session.jobId), ['development-job']);
assert.deepEqual(database.listCoverageSessions(origin, 'QA').map((session) => session.jobId), ['qa-job']);
assert.equal(database.removeCoverageSession('development-job', 'QA'), false);
assert.equal(database.removeCoverageSession('development-job', 'Development'), true);
assert.deepEqual(database.listCoverageSessions(origin, 'QA').map((session) => session.jobId), ['qa-job']);
assert.throws(() => database.createSession({ jobId: 'invalid-job', testName: 'invalid', environment: 'Unspecified', siteOrigin: origin, startedAt: '2026-01-03T00:00:00.000Z' }), /environment is required/);

database.saveDeltaCoverage({ siteOrigin: origin, environment: 'Development', buildVersion: '1.0.1', delta: { functionsAdded: [] } });
assert.equal(database.getDeltaCoverage(origin, 'Development').environment, 'Development');
assert.equal(database.getDeltaCoverage(origin, 'QA'), null);

console.log('Environment coverage isolation verified.');
