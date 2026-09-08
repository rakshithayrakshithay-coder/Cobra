const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coveragecapture-history-test-'));
process.env.COVERAGECAPTURE_DB_PATH = path.join(directory, 'coverage.db');

const database = require('../coverage-database');
const origin = 'http://localhost:3000';

function saveAction(jobId, testName, functionName, startedAt) {
  database.createSession({ jobId, testName, environment: 'Development', siteOrigin: origin, startedAt });
  database.completeCoverageSession({
    jobId,
    coverage: [],
    files: [{
      layer: 'frontend',
      url: 'http://localhost:3000/js/script.js',
      totalFunctions: 1,
      coveredFunctions: 1,
      functions: [{ name: functionName, covered: true, location: '10' }],
    }],
    interactions: [{ text: `Performed ${testName}` }],
    startTimestamp: startedAt,
    stopTimestamp: new Date(Date.parse(startedAt) + 1000).toISOString(),
  });
}

saveAction('admin-login-job', 'Admin Login', 'submitAdminLogin', '2026-01-01T00:00:00.000Z');
saveAction('contact-us-job', 'Contact Us', 'submitContactForm', '2026-01-01T00:01:00.000Z');
saveAction('admin-login-repeat-job', 'Admin Login', 'submitAdminLogin', '2026-01-01T00:02:00.000Z');

const sessions = database.listCoverageSessions(origin, 'Development');
assert.equal(sessions.length, 3);
assert.deepEqual(sessions.map((session) => session.testName), ['Admin Login', 'Contact Us', 'Admin Login']);
assert.equal(sessions.filter((session) => session.testName === 'Admin Login').length, 2);
assert.equal(sessions.find((session) => session.testName === 'Admin Login').result.files[0].functions[0].name, 'submitAdminLogin');
assert.equal(sessions.find((session) => session.testName === 'Contact Us').result.files[0].functions[0].name, 'submitContactForm');

console.log('Multiple action history entries remain separate and cumulative.');
