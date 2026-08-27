const testNameInput = document.getElementById('testName');
const testDescInput = document.getElementById('testDescription');
const testSuiteInput = document.getElementById('testSuite');
const environmentInput = document.getElementById('environment');
const buildVersionInput = document.getElementById('buildVersion');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const resultsDiv = document.getElementById('results');
const bridgeServerUrl = 'http://localhost:4000';

let activeJobId = null;

function setStatus(text, kind) {
  statusDiv.textContent = text;
  statusDiv.className = kind || '';
}

function getCoveragePercent(coveredFunctions, totalFunctions) {
  return totalFunctions ? `${Math.round((coveredFunctions / totalFunctions) * 100)}%` : '0%';
}

function getExecutedFunctions(functions) {
  return Array.isArray(functions) ? functions.filter((fn) => fn && fn.covered !== false) : [];
}

function formatFileUrl(url) {
  if (!url) return 'Unknown file';
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

function getSiteOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

async function clearLatestRecord() {
  await chrome.storage.local.remove('latestCoverageResult');
  resultsDiv.replaceChildren();
  resultsDiv.classList.remove('show');
}

function renderResults(record) {
  const files = Array.isArray(record?.files) ? record.files : [];
  resultsDiv.replaceChildren();
  const header = document.createElement('div');
  header.className = 'result-header';
  const heading = document.createElement('h3');
  heading.className = 'result-heading';
  heading.textContent = `Latest Coverage Breakdown — ${record?.testName || 'Untitled scenario'}`;
  const closeButton = document.createElement('button');
  closeButton.className = 'close-results';
  closeButton.type = 'button';
  closeButton.title = 'Close latest coverage result';
  closeButton.setAttribute('aria-label', 'Close latest coverage result');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', () => clearLatestRecord().catch((error) => setStatus(`Failed to clear latest coverage: ${error.message}`, 'error')));
  header.append(heading, closeButton);
  resultsDiv.appendChild(header);

  const interactions = Array.isArray(record?.interactions) ? record.interactions : [];
  if (interactions.length) {
    const actionRow = document.createElement('div');
    actionRow.className = 'result-item action-row';
    const actionHeading = document.createElement('div');
    actionHeading.className = 'action-heading';
    actionHeading.textContent = 'Recorded test steps';
    const actionList = document.createElement('ol');
    actionList.className = 'action-list';
    interactions.forEach((interaction) => {
      const item = document.createElement('li');
      item.textContent = interaction?.text || String(interaction);
      actionList.appendChild(item);
    });
    actionRow.append(actionHeading, actionList);
    resultsDiv.appendChild(actionRow);
  }

  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'result-item';
    empty.textContent = 'No JS files with coverage found.';
    resultsDiv.appendChild(empty);
  } else {
    files.forEach((file) => {
      const executedFunctions = getExecutedFunctions(file.functions);
      const coveredFunctions = Number(file.coveredFunctions ?? executedFunctions.length);
      const totalFunctions = Number(file.totalFunctions ?? executedFunctions.length);
      const fileRow = document.createElement('div');
      fileRow.className = 'result-item file-row';
      const fileUrl = document.createElement('div');
      fileUrl.className = 'file-url';
      fileUrl.textContent = formatFileUrl(file.url);
      const metrics = document.createElement('div');
      metrics.className = 'coverage-metrics';
      metrics.textContent = `${coveredFunctions} executed functions · ${getCoveragePercent(coveredFunctions, totalFunctions)} coverage`;
      fileRow.append(fileUrl, metrics);
      if (executedFunctions.length) {
        const functionList = document.createElement('div');
        functionList.className = 'function-list';
        executedFunctions.sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((fn) => {
          const item = document.createElement('div');
          item.className = 'function-item function-covered';
          const name = document.createElement('span');
          name.className = 'function-name';
          name.textContent = `✓ ${fn.name || '(anonymous)'}`;
          item.appendChild(name);
          functionList.appendChild(item);
        });
        fileRow.appendChild(functionList);
      }
      resultsDiv.appendChild(fileRow);
    });
  }
  resultsDiv.classList.add('show');
}

function setRecordingControls(recording) {
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
  testNameInput.disabled = recording;
  testDescInput.disabled = recording;
  testSuiteInput.disabled = recording;
  environmentInput.disabled = recording;
  buildVersionInput.disabled = recording;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.success) return reject(new Error(response?.error || 'Coverage command failed.'));
      resolve(response);
    });
  });
}

async function createManualJob(sessionDetails) {
  const response = await fetch(`${bridgeServerUrl}/manual-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionDetails) });
  if (!response.ok) throw new Error(`Start request failed with ${response.status}`);
  const job = await response.json();
  if (!job.jobId) throw new Error('Bridge server did not return a jobId.');
  return job;
}

async function restoreActiveSession() {
  const status = await new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getStatus' }, resolve));
  if (!status?.recording) return;
  activeJobId = status.jobId;
  setRecordingControls(true);
  testNameInput.value = status.testName || '';
  testDescInput.value = status.testDescription || '';
  testSuiteInput.value = status.testSuite || 'Manual';
  environmentInput.value = status.environment || 'Unspecified';
  buildVersionInput.value = status.buildVersion || '';
  setStatus('Recording coverage — perform your test actions, then click Stop.', 'recording');
}

(async () => {
  const { latestCoverageResult } = await chrome.storage.local.get('latestCoverageResult');
  if (latestCoverageResult) renderResults(latestCoverageResult);
  try { await restoreActiveSession(); } catch (error) { setStatus(`Could not restore recording state: ${error.message}`, 'error'); }
})();

startBtn.addEventListener('click', async () => {
  const testName = testNameInput.value.trim();
  const testDescription = testDescInput.value.trim();
  const testSuite = testSuiteInput.value;
  const environment = environmentInput.value;
  const buildVersion = buildVersionInput.value.trim();
  if (!testName && !testDescription) return setStatus('Please enter a test scenario or description first.', 'error');
  setRecordingControls(true);
  setStatus('Creating manual recording session...', 'recording');
  try {
    await clearLatestRecord();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const siteOrigin = getSiteOrigin(tab?.url);
    const job = await createManualJob({ testName, testDescription, testSuite, environment, buildVersion, siteOrigin });
    await sendRuntimeMessage({ action: 'startCoverage', tabId: tab?.id, jobId: job.jobId, testName: testName || testDescription, testDescription, testSuite, environment, buildVersion, startedAt: job.startedAt, siteOrigin });
    activeJobId = job.jobId;
    setStatus('Recording coverage — perform your test actions, then click Stop.', 'recording');
  } catch (error) {
    setRecordingControls(false);
    setStatus(`Could not start manual recording: ${error.message}`, 'error');
  }
});

stopBtn.addEventListener('click', async () => {
  setStatus('Processing coverage...', 'recording');
  stopBtn.disabled = true;
  try {
    const record = await sendRuntimeMessage({ action: 'stopCoverage' });
    const response = await fetch(`${bridgeServerUrl}/manual-sessions/${encodeURIComponent(record.jobId)}/coverage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: record.rawCoverage, files: record.files, interactions: record.interactions, startTimestamp: record.startedAt, stopTimestamp: record.stoppedAt }),
    });
    if (!response.ok) throw new Error(`Upload failed with ${response.status}`);
    activeJobId = null;
    setRecordingControls(false);
    setStatus(`Done. Captured coverage for "${record.testName}".`, 'done');
    renderResults(record);
  } catch (error) {
    setRecordingControls(false);
    setStatus(`Coverage saved locally, but the bridge server was not updated: ${error.message}`, 'error');
  }
});

document.getElementById('historyBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const siteOrigin = getSiteOrigin(tab?.url);
  const query = siteOrigin ? `?origin=${encodeURIComponent(siteOrigin)}` : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${query}`) });
});
