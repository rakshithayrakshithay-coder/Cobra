const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const cors = require('cors');
const {
  DATABASE_PATH,
  createSession,
  completeCoverageSession,
  getCoverageSession,
  listCoverageSessions,
  removeCoverageSession,
  removeCoverageSessionsForOrigin,
  saveDeltaCoverage,
  getDeltaCoverage,
} = require('./coverage-database');
const { requireEnvironment } = require('./environment');

const app = express();
const port = 4000;
const travelTrustRoot = path.resolve(__dirname, '..', 'travel-trust-insurance');
let deltaCheckInProgress = false;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

function isLocalOrigin(value) {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); }
  catch { return false; }
}

function runProjectScript(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('scripts', script)], {
      cwd: travelTrustRoot,
      env: { ...process.env, COVERAGE_PORT: '3101', COVERAGE_HISTORY_ORIGIN: environment.siteOrigin, COVERAGE_ENVIRONMENT: environment.name },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${script} failed (exit ${code}). ${output.trim()}`)));
  });
}

app.post('/run-delta-check', async (req, res) => {
  const siteOrigin = String(req.body?.siteOrigin || '');
  let environment;
  try { environment = requireEnvironment(req.body?.environment); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!isLocalOrigin(siteOrigin)) return res.status(400).json({ error: 'Run Delta Check is available only for localhost applications.' });
  if (deltaCheckInProgress) return res.status(409).json({ error: 'A delta check is already running.' });

  deltaCheckInProgress = true;
  try {
    await runProjectScript('ci-coverage.cjs', { siteOrigin, name: environment });
    await runProjectScript('create-coverage-delta.cjs', { siteOrigin, name: environment });
    return res.json({ analysis: getDeltaCoverage(siteOrigin, environment) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  } finally {
    deltaCheckInProgress = false;
  }
});

app.post('/delta-analysis', (req, res) => {
  const { siteOrigin = '', environment, buildVersion = '', baselineRef = '', delta } = req.body || {};
  if (!siteOrigin || !delta || typeof delta !== 'object') return res.status(400).json({ error: 'siteOrigin, environment, and delta are required.' });
  let saved;
  try { saved = saveDeltaCoverage({ siteOrigin, environment, buildVersion, baselineRef, delta }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  return res.status(201).json(saved);
});

app.get('/delta-analysis', (req, res) => {
  const siteOrigin = String(req.query.origin || '');
  const environment = String(req.query.environment || '');
  if (!siteOrigin || !environment) return res.status(400).json({ error: 'origin and environment are required.' });
  let analysis;
  try { analysis = getDeltaCoverage(siteOrigin, environment); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!analysis) return res.status(404).json({ error: 'No delta analysis found.' });
  return res.json(analysis);
});

app.post('/manual-sessions', (req, res) => {
  const { testName = '', testDescription = '', testSuite = 'Manual', environment, buildVersion = '', siteOrigin = '' } = req.body || {};
  let normalizedEnvironment;
  try { normalizedEnvironment = requireEnvironment(environment); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const job = createSession({ jobId, testName, testDescription, testSuite, environment: normalizedEnvironment, buildVersion, siteOrigin, startedAt });
  console.log(`Manual coverage recording started: jobId=${jobId}`);
  res.status(201).json({ jobId, status: job.status, startedAt });
});

app.post('/manual-sessions/:jobId/coverage', (req, res) => {
  const job = getCoverageSession(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'recording') return res.status(409).json({ error: `Job is already ${job.status}` });
  const { coverage, files, interactions = [], startTimestamp, stopTimestamp } = req.body || {};
  if (!Array.isArray(coverage) || !Array.isArray(files) || !startTimestamp || !stopTimestamp) return res.status(400).json({ error: 'coverage, files, startTimestamp, and stopTimestamp are required.' });
  const savedJob = completeCoverageSession({
    jobId: job.jobId,
    coverage,
    files,
    interactions,
    startTimestamp,
    stopTimestamp,
  });
  if (!savedJob) return res.status(409).json({ error: `Job is already ${job.status}` });
  console.log(`Manual coverage recording finished: jobId=${job.jobId}`);
  return res.json({ jobId: savedJob.jobId, status: savedJob.status, startedAt: savedJob.startedAt, stoppedAt: savedJob.stoppedAt });
});

app.get('/job-status/:jobId', (req, res) => {
  const job = getCoverageSession(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

app.get('/coverage-sessions', (req, res) => {
  const siteOrigin = String(req.query.origin || '');
  const environment = String(req.query.environment || '');
  if (!siteOrigin || !environment) return res.status(400).json({ error: 'origin and environment are required.' });
  try { return res.json({ sessions: listCoverageSessions(siteOrigin, environment) }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
});

app.delete('/coverage-sessions/:jobId', (req, res) => {
  const environment = String(req.query.environment || '');
  if (!environment) return res.status(400).json({ error: 'environment is required.' });
  try {
    if (!removeCoverageSession(req.params.jobId, environment)) return res.status(404).json({ error: 'Session not found' });
  } catch (error) { return res.status(400).json({ error: error.message }); }
  return res.status(204).end();
});

app.delete('/coverage-sessions', (req, res) => {
  const siteOrigin = String(req.query.origin || '');
  const environment = String(req.query.environment || '');
  if (!siteOrigin || !environment) return res.status(400).json({ error: 'origin and environment are required.' });
  let deleted;
  try { deleted = removeCoverageSessionsForOrigin(siteOrigin, environment); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  return res.json({ deleted });
});

app.listen(port, '127.0.0.1', () => console.log(`Coverage bridge server listening on port ${port} using SQLite database ${DATABASE_PATH}`));
