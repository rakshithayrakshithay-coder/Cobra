// Coverage is collected directly through Chrome DevTools Protocol.

let session = null; // { tabId, jobId, testName, testDescription, startedAt, interactions }

function getSiteOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startCoverage') {
    startCoverage(message.tabId, message.jobId, message.testName, message.testDescription, message.testSuite, message.environment, message.buildVersion, message.startedAt, message.siteOrigin)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.action === 'stopCoverage') {
    stopCoverage()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'getStatus') {
    sendResponse(
      session
        ? { recording: true, jobId: session.jobId, testName: session.testName, testDescription: session.testDescription, testSuite: session.testSuite, environment: session.environment, buildVersion: session.buildVersion }
        : { recording: false }
    );
    return true;
  }

  if (message.action === 'recordInteraction' && session && sender.tab?.id === session.tabId) {
    addInteraction(message.interaction);
    sendResponse({ success: true });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!session || tabId !== session.tabId) return;
  if (changeInfo.url) addInteraction(`Navigated to ${formatPage(changeInfo.url)}`);
  if (changeInfo.status === 'complete') installInteractionRecorder(tabId).catch(() => {});
});

function formatPage(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || '/'}${parsed.search}`;
  } catch {
    return 'a new page';
  }
}

function addInteraction(interaction) {
  const text = String(interaction || '').trim();
  if (!text || !session) return;
  const last = session.interactions.at(-1);
  if (last?.text === text) return;
  session.interactions.push({ text, timestamp: new Date().toISOString() });
  if (session.interactions.length > 100) session.interactions.shift();
}

async function startCoverage(tabId, jobId, testName, testDescription, testSuite, environment, buildVersion, startedAt, siteOrigin) {
  if (session) {
    throw new Error('A coverage session is already running. Stop it first.');
  }

  if (!Number.isInteger(tabId)) throw new Error('No active tab is available for coverage capture.');
  if (!jobId) throw new Error('A bridge-server job ID is required.');
  if (!siteOrigin) {
    const tab = await chrome.tabs.get(tabId);
    siteOrigin = getSiteOrigin(tab.url);
  }
  const tab = await chrome.tabs.get(tabId);
  const debuggee = { tabId };

  // Attach the DevTools protocol to the tab selected by the user.
  await chrome.debugger.attach(debuggee, '1.3');

  // Enable the Profiler domain, then start precise coverage collection.
  await chrome.debugger.sendCommand(debuggee, 'Profiler.enable');
  await chrome.debugger.sendCommand(debuggee, 'Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });

  session = { tabId, jobId, testName, testDescription, testSuite: testSuite || 'Manual', environment: environment || 'Unspecified', buildVersion: buildVersion || '', startedAt: startedAt || new Date().toISOString(), siteOrigin, interactions: [] };
  addInteraction(`Started on ${formatPage(tab.url)}`);
  await installInteractionRecorder(tabId);
}

async function stopCoverage() {
  if (!session) {
    throw new Error('No coverage session is currently running.');
  }

  const { tabId, jobId, testName, testDescription, testSuite, environment, buildVersion, startedAt, siteOrigin, interactions } = session;
  const debuggee = { tabId };

  const coverageResult = await chrome.debugger.sendCommand(debuggee, 'Profiler.takePreciseCoverage');
  await chrome.debugger.sendCommand(debuggee, 'Profiler.stopPreciseCoverage');
  await chrome.debugger.sendCommand(debuggee, 'Profiler.disable');
  await chrome.debugger.detach(debuggee);

  const stoppedAt = new Date().toISOString();
  const durationMs = Date.parse(stoppedAt) - Date.parse(startedAt);
  const processed = processCoverage(coverageResult.result);

  const record = {
    testName,
    testDescription,
    testSuite,
    environment,
    buildVersion,
    durationMs,
    capturedAt: stoppedAt,
    jobId,
    startedAt,
    stoppedAt,
    siteOrigin,
    interactions,
    files: processed,
  };

  await saveRecord(record);

  session = null;
  // Raw CDP data is sent to the bridge server but deliberately omitted from
  // chrome.storage.local so the existing history record remains compact.
  return { ...record, rawCoverage: coverageResult.result };
}

async function installInteractionRecorder(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (globalThis.__coverageCaptureInteractionRecorder) return;
      globalThis.__coverageCaptureInteractionRecorder = true;

      const labelFor = (element) => {
        const id = element.id ? `#${element.id}` : '';
        const explicit = element.getAttribute('aria-label') || element.getAttribute('name') || element.getAttribute('placeholder');
        const label = element.labels?.[0]?.innerText || document.querySelector(`label[for="${CSS.escape(element.id || '')}"]`)?.innerText;
        return (label || explicit || element.innerText || element.value || id || element.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      const send = (interaction) => chrome.runtime.sendMessage({ action: 'recordInteraction', interaction }).catch(() => {});

      document.addEventListener('change', (event) => {
        const element = event.target;
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
        const field = labelFor(element);
        if (element instanceof HTMLSelectElement) {
          send(`Selected "${element.options[element.selectedIndex]?.text || element.value}" in ${field}`);
        } else if (element.type === 'checkbox' || element.type === 'radio') {
          send(`${element.checked ? 'Selected' : 'Cleared'} ${field}`);
        } else if (element.type === 'password') {
          send(`Entered a password in ${field}`);
        } else if (element.value.trim()) {
          send(`Entered "${element.value.trim().slice(0, 80)}" in ${field}`);
        }
      }, true);

      document.addEventListener('click', (event) => {
        const element = event.target.closest('button, a, input[type="submit"], input[type="button"]');
        if (element) send(`Clicked ${labelFor(element)}`);
      }, true);
    },
  });
}

// Turns raw CDP coverage data into a per-file summary with function details.
// Raw shape: array of { scriptId, url, functions: [{ functionName, ranges, isBlockCoverage }] }
function getCoverageFunctionName(fn) {
  if (fn.functionName) return fn.functionName;

  // V8 represents the code that runs as a script first loads as an unnamed
  // function whose range starts at the beginning of that script.
  if (fn.ranges?.some((range) => Number(range.startOffset) === 0)) {
    return 'Top-level script initialization';
  }

  return 'Anonymous callback';
}

function processCoverage(rawResult) {
  const fileMap = {};

  for (const script of rawResult) {
    // Skip extension/browser-internal scripts, keep only real page scripts
    if (!script.url || script.url.startsWith('chrome-extension://')) continue;

    if (!fileMap[script.url]) {
      fileMap[script.url] = {
        url: script.url,
        functions: [],
        namedFunctionIndexes: {},
      };
    }

    for (const fn of script.functions) {
      const name = getCoverageFunctionName(fn);
      const wasCovered = fn.ranges.some((r) => r.count > 0);
      const file = fileMap[script.url];

      if (fn.functionName && Object.prototype.hasOwnProperty.call(file.namedFunctionIndexes, name)) {
        const index = file.namedFunctionIndexes[name];
        file.functions[index].covered = file.functions[index].covered || wasCovered;
        continue;
      }

      if (fn.functionName) {
        file.namedFunctionIndexes[name] = file.functions.length;
      }

      file.functions.push({
        name,
        covered: wasCovered
      });
    }
  }

  return Object.values(fileMap).map((file) => {
    const { namedFunctionIndexes, functions, ...summary } = file;

    return {
      ...summary,
      totalFunctions: functions.length,
      coveredFunctions: functions.filter((fn) => fn.covered).length,
      functions,
    };
  });
}

async function saveRecord(record) {
  const { coverageHistory = [] } = await chrome.storage.local.get('coverageHistory');
  coverageHistory.push(record);
  await chrome.storage.local.set({
    coverageHistory,
    latestCoverageResult: record,
  });
}
