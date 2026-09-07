const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coveragecapture-merged-session-test-'));
process.env.COVERAGECAPTURE_DB_PATH = path.join(directory, 'coverage.db');

const database = require('../coverage-database');
const origin = 'http://localhost:3000';
const startedAt = '2026-01-01T00:00:00.000Z';
const stoppedAt = '2026-01-01T00:00:02.000Z';

const frontendFile = {
  layer: 'frontend',
  url: 'http://localhost:3000/js/script.js',
  totalFunctions: 2,
  coveredFunctions: 1,
  functions: [
    { name: 'submitLogin', covered: true, location: '10' },
    { name: 'showLoginError', covered: false, location: '20' },
  ],
};
const backendFile = {
  layer: 'backend',
  url: 'file:///C:/project/travel-trust-insurance/server.js',
  totalFunctions: 2,
  coveredFunctions: 2,
  functions: [
    { name: 'userLoginHandler', covered: true, location: '191' },
    { name: 'respondLoginError', covered: true, location: '120' },
  ],
};

database.createSession({
  jobId: 'valid-user-login',
  testName: 'Valid User Login',
  testDescription: 'One manual action with browser and server coverage',
  testSuite: 'Manual',
  environment: 'Development',
  buildVersion: '1.0.0',
  siteOrigin: origin,
  startedAt,
});

database.completeCoverageSession({
  jobId: 'valid-user-login',
  coverage: { browser: [], backend: [] },
  files: [frontendFile, backendFile],
  interactions: [
    { text: 'Clicked Log in as User', timestamp: startedAt },
  ],
  startTimestamp: startedAt,
  stopTimestamp: stoppedAt,
});

const [session] = database.listCoverageSessions(origin, 'Development');
assert.equal(session.testName, 'Valid User Login');
assert.deepEqual(session.result.interactions.map((item) => item.text), ['Clicked Log in as User']);
assert.deepEqual(session.result.files.map((file) => file.layer), ['frontend', 'backend']);
assert.equal(session.result.files.find((file) => file.layer === 'backend').functions[0].name, 'userLoginHandler');
assert.equal(session.result.files.find((file) => file.layer === 'frontend').coveredFunctions, 1);
assert.equal(session.result.files.find((file) => file.layer === 'backend').coveredFunctions, 2);

console.log('Merged frontend/backend action session verified.');
