const crypto = require('crypto');
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

const app = express();
const port = 4000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.post('/delta-analysis', (req, res) => {
  const { siteOrigin = '', buildVersion = '', baselineRef = '', delta } = req.body || {};
  if (!siteOrigin || !delta || typeof delta !== 'object') return res.status(400).json({ error: 'siteOrigin and delta are required.' });
  const saved = saveDeltaCoverage({ siteOrigin, buildVersion, baselineRef, delta });
  return res.status(201).json(saved);
});

app.get('/delta-analysis', (req, res) => {
  const siteOrigin = String(req.query.origin || '');
  if (!siteOrigin) return res.status(400).json({ error: 'origin is required.' });
  const analysis = getDeltaCoverage(siteOrigin);
  if (!analysis) return res.status(404).json({ error: 'No delta analysis found.' });
  return res.json(analysis);
});

app.post('/manual-sessions', (req, res) => {
  const { testName = '', testDescription = '', testSuite = 'Manual', environment = 'Unspecified', buildVersion = '', siteOrigin = '' } = req.body || {};
  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const job = createSession({ jobId, testName, testDescription, testSuite, environment, buildVersion, siteOrigin, startedAt });
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
  if (!siteOrigin) return res.status(400).json({ error: 'origin is required.' });
  return res.json({ sessions: listCoverageSessions(siteOrigin) });
});

app.delete('/coverage-sessions/:jobId', (req, res) => {
  if (!removeCoverageSession(req.params.jobId)) return res.status(404).json({ error: 'Session not found' });
  return res.status(204).end();
});

app.delete('/coverage-sessions', (req, res) => {
  const siteOrigin = String(req.query.origin || '');
  if (!siteOrigin) return res.status(400).json({ error: 'origin is required.' });
  const deleted = removeCoverageSessionsForOrigin(siteOrigin);
  return res.json({ deleted });
});

app.listen(port, () => console.log(`Coverage bridge server listening on port ${port} using SQLite database ${DATABASE_PATH}`));
