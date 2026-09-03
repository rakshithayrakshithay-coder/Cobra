const STORAGE_KEY = 'coverageHistory';
const QUALITY_GATE_PERCENT = 70;
const BRIDGE_SERVER_URL = 'http://localhost:4000';

const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const testSuiteFilter = document.getElementById('testSuiteFilter');
const environmentFilter = document.getElementById('environmentFilter');
const buildVersionFilter = document.getElementById('buildVersionFilter');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const summaryText = document.getElementById('summaryText');
const historyBody = document.getElementById('historyBody');
const emptyState = document.getElementById('emptyState');
const dashboardCards = document.getElementById('dashboardCards');
const overallFiles = document.getElementById('overallFiles');
const viewOverallBtn = document.getElementById('viewOverallBtn');
const deltaResults = document.getElementById('deltaResults');
const deltaIntro = document.getElementById('deltaIntro');
const automaticDeltaBtn = document.getElementById('automaticDeltaBtn');
const manualDeltaBtn = document.getElementById('manualDeltaBtn');
const baselineBuildSelect = document.getElementById('baselineBuildSelect');
const comparisonBuildSelect = document.getElementById('comparisonBuildSelect');

let coverageHistory = [];
let selectedSort = 'date-desc';
let selectedBaselineBuild = '';
let selectedComparisonBuild = '';
let deltaViewMode = 'automatic';
const historyParameters = new URLSearchParams(window.location.search);
const historySiteOrigin = historyParameters.get('origin');
const historyEnvironment = normalizeEnvironment(historyParameters.get('environment'));
let selectedFilters = { testSuite: '', environment: historyEnvironment || '', buildVersion: '' };
const deltaOnlyView = historyParameters.get('view') === 'delta';
let focusCoverageDelta = deltaOnlyView;

if (deltaOnlyView) {
  document.body.classList.add('delta-only');
}

function normalizeEnvironment(value) {
  const aliases = { dev: 'Development', development: 'Development', qa: 'QA', test: 'QA', uat: 'UAT', staging: 'UAT', prod: 'Production', production: 'Production' };
  const environment = String(value || '').trim();
  return aliases[environment.toLowerCase()] || environment;
}

function getSiteHistory() {
  return historySiteOrigin && historyEnvironment
    ? coverageHistory.filter((record) => record.siteOrigin === historySiteOrigin && getRecordMetadata(record).environment === historyEnvironment)
    : [];
}

function getRecordMetadata(record) {
  return {
    testSuite: record.testSuite || 'Manual',
    environment: record.environment || 'Unspecified',
    buildVersion: record.buildVersion || 'Not provided',
  };
}

function populateFilterOptions(records) {
  const filters = [
    { element: testSuiteFilter, key: 'testSuite', allLabel: 'All test suites' },
    { element: environmentFilter, key: 'environment', allLabel: 'All environments' },
    { element: buildVersionFilter, key: 'buildVersion', allLabel: 'All builds' },
  ];

  filters.forEach(({ element, key, allLabel }) => {
    const values = [...new Set(records.map((record) => getRecordMetadata(record)[key]))].sort((first, second) => first.localeCompare(second));
    const selected = selectedFilters[key];
    element.replaceChildren(new Option(allLabel, ''));
    values.forEach((value) => element.add(new Option(value, value)));
    selectedFilters[key] = values.includes(selected) ? selected : '';
    element.value = selectedFilters[key];
  });
}

function getFilteredHistory(records = getSiteHistory()) {
  const query = searchInput.value.trim().toLowerCase();
  return records.filter((record) => {
    const metadata = getRecordMetadata(record);
    return (!query || (record.testName || '').toLowerCase().includes(query))
      && (!selectedFilters.testSuite || metadata.testSuite === selectedFilters.testSuite)
      && (!selectedFilters.environment || metadata.environment === selectedFilters.environment)
      && (!selectedFilters.buildVersion || metadata.buildVersion === selectedFilters.buildVersion);
  });
}

function getDeltaScopeHistory(records = getSiteHistory()) {
  const query = searchInput.value.trim().toLowerCase();
  return records.filter((record) => {
    const metadata = getRecordMetadata(record);
    return (!query || (record.testName || '').toLowerCase().includes(query))
      && (!selectedFilters.testSuite || metadata.testSuite === selectedFilters.testSuite)
      && (!selectedFilters.environment || metadata.environment === selectedFilters.environment);
  });
}

function inferSiteOrigin(record) {
  for (const file of record.files || []) {
    try {
      const origin = new URL(file.url).origin;
      if (origin !== 'null') return origin;
    } catch {
      // Ignore non-URL and browser-internal script entries.
    }
  }
  return '';
}

const formatDate = (value) => Number.isNaN(new Date(value).getTime()) ? value || 'Unknown' : new Date(value).toLocaleString();
const formatDuration = (durationMs) => `${(Number(durationMs || 0) / 1000).toFixed(2)}s`;
const percentNumber = (covered, total) => total ? Math.round((covered / total) * 100) : 0;
const getCoveragePercent = (covered, total) => `${percentNumber(covered, total)}%`;
const getLineNumber = (location) => String(location).split(':')[0];
const sortNewestFirst = (records) => [...records].sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());

function getRecordCoverage(record) {
  const files = record.files || [];
  const total = files.reduce((sum, file) => sum + Number(file.totalFunctions || (file.functions || []).length), 0);
  const covered = files.reduce((sum, file) => sum + Number(file.coveredFunctions || 0), 0);
  return { covered, total, percent: percentNumber(covered, total) };
}

function sortHistoryRecords(records) {
  const sorted = [...records];
  sorted.sort((first, second) => {
    let firstValue;
    let secondValue;
    let direction = -1;

    switch (selectedSort) {
      case 'date-asc':
        direction = 1;
        // Falls through to use the same date values as the default option.
      case 'date-desc':
        firstValue = Date.parse(first.capturedAt || first.stoppedAt || first.startedAt) || 0;
        secondValue = Date.parse(second.capturedAt || second.stoppedAt || second.startedAt) || 0;
        break;
      case 'duration-asc':
        direction = 1;
        // Falls through to use the same duration values as the descending option.
      case 'duration-desc':
        firstValue = Number(first.durationMs || 0);
        secondValue = Number(second.durationMs || 0);
        break;
      case 'coverage-asc':
        direction = 1;
        // Falls through to use the same coverage values as the descending option.
      case 'coverage-desc':
        firstValue = getRecordCoverage(first).percent;
        secondValue = getRecordCoverage(second).percent;
        break;
      default:
        firstValue = Date.parse(first.capturedAt || first.stoppedAt || first.startedAt) || 0;
        secondValue = Date.parse(second.capturedAt || second.stoppedAt || second.startedAt) || 0;
    }

    if (firstValue === secondValue) {
      return new Date(second.capturedAt || 0).getTime() - new Date(first.capturedAt || 0).getTime();
    }
    return (firstValue - secondValue) * direction;
  });
  return sorted;
}

function formatFileUrl(url) {
  if (!url) return 'Unknown file';
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

function isAnonymous(name) {
  return !name || /^\(?anonymous\)?$/i.test(String(name).trim()) || /anonymous/i.test(String(name));
}

function buildCoverage(records) {
  const files = new Map();
  let anonymousId = 0;
  records.forEach((record) => (record.files || []).forEach((file) => {
    // Older history may contain both localhost URLs and path-only URLs for one file.
    const url = formatFileUrl(file.url);
    if (!files.has(url)) files.set(url, { url, functions: new Map() });
    const target = files.get(url);
    (file.functions || []).forEach((fn) => {
      if (!fn) return;
      const name = fn.name || '(anonymous)';
      // Anonymous functions intentionally receive a new key per observation.
      const key = isAnonymous(name) ? `anonymous:${anonymousId++}` : `name:${name}`;
      const existing = target.functions.get(key);
      target.functions.set(key, {
        name,
        covered: Boolean(existing?.covered || fn.covered),
        location: existing?.location || fn.location || '',
      });
    });
  }));
  return [...files.values()].map((file) => {
    const functions = [...file.functions.values()];
    const covered = functions.filter((fn) => fn.covered).length;
    return { ...file, functions, covered, total: functions.length, percent: percentNumber(covered, functions.length) };
  }).sort((a, b) => a.url.localeCompare(b.url));
}

function getBuildVersions(records) {
  const latestByBuild = new Map();
  records.forEach((record) => {
    const build = getRecordMetadata(record).buildVersion;
    const timestamp = Date.parse(record.capturedAt || record.stoppedAt || record.startedAt) || 0;
    latestByBuild.set(build, Math.max(latestByBuild.get(build) || 0, timestamp));
  });
  return [...latestByBuild.keys()].sort((first, second) => (latestByBuild.get(second) - latestByBuild.get(first)) || first.localeCompare(second));
}

function selectLatestBuildPair(records) {
  const builds = getBuildVersions(records);
  selectedComparisonBuild = builds[0] || '';
  selectedBaselineBuild = builds[1] || '';
}

function populateDeltaBuildOptions(records) {
  const builds = getBuildVersions(records);
  [baselineBuildSelect, comparisonBuildSelect].forEach((select) => {
    select.replaceChildren(new Option('Select a build', ''));
    builds.forEach((build) => select.add(new Option(build, build)));
    select.disabled = builds.length < 2;
  });
  if (!builds.includes(selectedComparisonBuild)) selectedComparisonBuild = builds[0] || '';
  if (!builds.includes(selectedBaselineBuild) || selectedBaselineBuild === selectedComparisonBuild) {
    selectedBaselineBuild = builds.find((build) => build !== selectedComparisonBuild) || '';
  }
  baselineBuildSelect.value = selectedBaselineBuild;
  comparisonBuildSelect.value = selectedComparisonBuild;
}

function functionIdentity(file, fn, index) {
  const name = String(fn?.name || '(anonymous)').trim();
  const location = String(fn?.location || '').trim();
  const fileUrl = formatFileUrl(file.url);

  // A named function remains the same function when code is inserted above
  // it, even when V8's offsets move. Anonymous callbacks have no stable name,
  // so retain their location/index as the fallback identity.
  if (!isAnonymous(name)) return `${fileUrl}\u0000name:${name}`;
  return `${fileUrl}\u0000anonymous:${location || index}`;
}

function buildSnapshot(records) {
  const functions = new Map();
  records.forEach((record) => (record.files || []).forEach((file) => {
    (file.functions || []).forEach((fn, index) => {
      if (!fn) return;
      const key = functionIdentity(file, fn, index);
      const existing = functions.get(key);
      functions.set(key, {
        key,
        file: formatFileUrl(file.url),
        name: fn.name || '(anonymous)',
        location: fn.location || '',
        covered: Boolean(existing?.covered || fn.covered),
      });
    });
  }));
  const entries = [...functions.values()];
  return { functions, total: entries.length, covered: entries.filter((fn) => fn.covered).length };
}

function getCoverageDelta(records) {
  const baselineRecords = records.filter((record) => getRecordMetadata(record).buildVersion === selectedBaselineBuild);
  const comparisonRecords = records.filter((record) => getRecordMetadata(record).buildVersion === selectedComparisonBuild);
  const baseline = buildSnapshot(baselineRecords);
  const comparison = buildSnapshot(comparisonRecords);
  const added = [...comparison.functions.values()].filter((fn) => !baseline.functions.has(fn.key));
  const removed = [...baseline.functions.values()].filter((fn) => !comparison.functions.has(fn.key));
  const newlyCoveredExisting = [...comparison.functions.values()].filter((fn) => baseline.functions.has(fn.key) && fn.covered && !baseline.functions.get(fn.key).covered);
  return {
    baseline, comparison, added, removed, newlyCoveredExisting,
    addedCovered: added.filter((fn) => fn.covered),
    addedUntested: added.filter((fn) => !fn.covered),
  };
}

function renderDeltaFunctionList(functions) {
  const list = document.createElement('div');
  list.className = 'delta-files';
  const byFile = new Map();
  (Array.isArray(functions) ? functions : []).forEach((fn) => {
    const file = String(fn?.file || 'Unknown file');
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(fn || {});
  });
  [...byFile.entries()].sort(([first], [second]) => first.localeCompare(second)).forEach(([file, entries]) => {
    const details = document.createElement('details'); details.className = 'delta-file';
    const summary = document.createElement('summary'); summary.textContent = `${file} (${entries.length})`;
    const content = document.createElement('div');
    entries.sort((first, second) => String(first.name || '').localeCompare(String(second.name || ''))).forEach((fn) => {
      const item = document.createElement('div'); item.className = 'delta-function';
      item.textContent = `${fn.covered ? 'Executed' : 'Untested'} — ${fn.name}${fn.location ? ` (${fn.location})` : ''}`;
      item.textContent = '';
      const status = document.createElement('span');
      status.className = `delta-function-status ${fn.covered ? 'executed' : 'untested'}`;
      status.textContent = fn.covered ? 'Executed' : 'Untested';
      const name = document.createElement('span');
      name.className = 'delta-function-name';
      name.textContent = fn.name;
      item.append(status, name);
      content.appendChild(item);
    });
    details.append(summary, content); list.appendChild(details);
  });
  return list;
}

function renderBuildFunctionSnapshot(label, buildVersion, snapshot) {
  const functions = snapshot?.functions instanceof Map
    ? [...snapshot.functions.values()]
    : Array.isArray(snapshot?.functions) ? snapshot.functions : [];
  const executedFunctions = functions.filter((fn) => fn?.covered);
  const section = document.createElement('section');
  section.className = 'delta-build';
  const heading = document.createElement('h3');
  heading.className = 'delta-build-heading';
  heading.textContent = label;
  const build = document.createElement('p');
  build.className = 'delta-build-version';
  build.textContent = buildVersion;
  const summary = document.createElement('p');
  summary.className = 'delta-note';
  summary.textContent = `${executedFunctions.length} executed functions.`;
  section.append(heading, build, summary, renderDeltaFunctionList(executedFunctions));
  return section;
}

function renderCoverageDelta(records = getDeltaScopeHistory()) {
  deltaResults.replaceChildren();
  const automatic = deltaViewMode === 'automatic';
  document.body.classList.toggle('delta-automatic', automatic);
  automaticDeltaBtn.setAttribute('aria-pressed', String(automatic));
  manualDeltaBtn.setAttribute('aria-pressed', String(!automatic));
  deltaIntro.textContent = automatic
    ? 'Automatically compares the newest detected build with the build immediately before it. Only functions introduced by the newest build are shown.'
    : 'Choose two recorded build versions to compare their observed function coverage.';
  if (!selectedBaselineBuild || !selectedComparisonBuild || selectedBaselineBuild === selectedComparisonBuild) {
    deltaResults.textContent = 'Coverage Delta will appear after coverage is captured for two detected builds.';
    deltaResults.className = 'delta-note';
    return;
  }
  const delta = getCoverageDelta(records);
  const metrics = [
    [delta.added.length, 'Functions added', 'added'],
    [delta.addedCovered.length, 'New functions executed', 'executed'],
    [delta.addedUntested.length, 'New functions untested', 'untested'],
  ];
  const summary = document.createElement('div'); summary.className = 'delta-summary';
  metrics.forEach(([value, label, tone]) => {
    const metric = document.createElement('div'); metric.className = `delta-metric ${tone}`;
    const big = document.createElement('div'); big.className = 'delta-value'; big.textContent = value;
    const title = document.createElement('div'); title.className = 'delta-label'; title.textContent = label;
    metric.append(big, title); summary.appendChild(metric);
  });
  const note = document.createElement('p'); note.className = 'delta-note';
  note.textContent = `New build ${selectedComparisonBuild} is compared with ${selectedBaselineBuild}. ${delta.addedCovered.length} of ${delta.added.length} newly added functions were executed.`;
  deltaResults.className = '';
  deltaResults.append(summary, note);
  const buildSnapshots = document.createElement('div');
  buildSnapshots.className = 'delta-builds';
  buildSnapshots.append(
    renderBuildFunctionSnapshot('Previous build · executed functions', selectedBaselineBuild, delta.baseline),
    renderBuildFunctionSnapshot('New build · executed functions', selectedComparisonBuild, delta.comparison)
  );
  deltaResults.append(buildSnapshots);
  if (delta.added.length) {
    const heading = document.createElement('p'); heading.className = 'delta-note'; heading.textContent = 'Functions added in the new build';
    deltaResults.append(heading, renderDeltaFunctionList(delta.added));
  }
}

function createCell(text, className) {
  const cell = document.createElement('td'); cell.textContent = text; if (className) cell.className = className; return cell;
}

function createBar(covered, total) {
  const wrap = document.createElement('div');
  const bar = document.createElement('span');
  const value = percentNumber(covered, total);
  wrap.className = 'coverage-bar'; bar.className = `coverage-fill ${value >= QUALITY_GATE_PERCENT ? 'good' : value >= 40 ? 'warning' : 'poor'}`;
  bar.style.width = `${value}%`; wrap.appendChild(bar); return wrap;
}

function createFunctionList(functions, uncoveredOnly = false, coveredOnly = false) {
  const list = document.createElement('div'); list.className = 'function-list';
  const shown = functions.filter((fn) => (!uncoveredOnly || !fn.covered) && (!coveredOnly || fn.covered)).sort((a, b) => a.name.localeCompare(b.name));
  if (!shown.length) { list.textContent = uncoveredOnly ? 'No observed untested functions.' : coveredOnly ? 'No observed executed functions.' : 'No functions recorded.'; return list; }
  shown.forEach((fn) => {
    const item = document.createElement('div'); item.className = `function-item ${fn.covered ? 'function-covered' : 'function-uncovered'}`;
    const icon = document.createElement('span'); icon.textContent = fn.covered ? '✓' : '○';
    const name = document.createElement('span'); name.className = 'function-name'; name.textContent = fn.name;
    const location = document.createElement('span'); location.className = 'function-location'; location.textContent = fn.location ? `line ${getLineNumber(fn.location)}` : '';
    item.append(icon, name, location); list.appendChild(item);
  });
  return list;
}

function createFunctionColumns(functions) {
  const list = document.createElement('div');
  list.className = 'function-list function-columns';
  const groups = [
    { title: 'Executed', functions: functions.filter((fn) => fn.covered), covered: true },
  ];

  groups.forEach((group) => {
    const column = document.createElement('div');
    column.className = `function-column ${group.covered ? 'function-covered' : 'function-uncovered'}`;
    const heading = document.createElement('div');
    heading.className = 'function-column-heading';
    heading.textContent = `${group.title} (${group.functions.length})`;
    const entries = document.createElement('div');
    entries.className = 'function-column-entries';
    const sorted = group.functions.sort((a, b) => a.name.localeCompare(b.name));
    if (!sorted.length) {
      entries.textContent = `No ${group.title.toLowerCase()} functions.`;
    } else {
      sorted.forEach((fn) => {
        const item = document.createElement('div'); item.className = `function-item ${group.covered ? 'function-covered' : 'function-uncovered'}`;
        const icon = document.createElement('span'); icon.textContent = group.covered ? '✓' : '○';
        const name = document.createElement('span'); name.className = 'function-name'; name.textContent = fn.name;
        const location = document.createElement('span'); location.className = 'function-location'; location.textContent = fn.location ? `line ${getLineNumber(fn.location)}` : '';
        item.append(icon, name, location); entries.appendChild(item);
      });
    }
    column.append(heading, entries); list.appendChild(column);
  });
  return list;
}

function renderFilePanel(container, files, untestedOnly = false) {
  container.replaceChildren();
  if (!files.length) { container.textContent = 'No observed functions yet.'; return; }
  files.forEach((file) => {
    const details = document.createElement('details'); details.className = `overall-file${untestedOnly ? ' untested-file' : ''}`;
    const summary = document.createElement('summary');
    const untested = file.total - file.covered;
    if (untestedOnly) {
      summary.textContent = `${formatFileUrl(file.url)} (${untested} untested)`;
      details.append(summary, createFunctionList(file.functions, true));
      container.appendChild(details);
      return;
    }
    const title = document.createElement('span'); title.textContent = formatFileUrl(file.url);
    const metric = document.createElement('span');
    metric.textContent = `${file.covered} / ${file.total} functions (${file.percent}%)`;
    summary.append(title, metric);
    const badge = document.createElement('span'); badge.className = `badge ${file.percent >= QUALITY_GATE_PERCENT ? 'passing' : 'failing'}`;
    badge.textContent = file.percent >= QUALITY_GATE_PERCENT ? 'Passing' : 'Failing'; summary.appendChild(badge);
    details.append(summary, createFunctionList(file.functions, false, true)); container.appendChild(details);
  });
}

function renderDashboard(records = getFilteredHistory()) {
  const files = buildCoverage(records);
  const total = files.reduce((sum, file) => sum + file.total, 0);
  const covered = files.reduce((sum, file) => sum + file.covered, 0);
  const pct = percentNumber(covered, total);
  const cardData = [
    ['Overall Coverage', `${pct}%`, `${covered} / ${total} functions`],
    ['Total Functions', total, 'Unique observed functions'],
    ['Quality Gate', pct >= QUALITY_GATE_PERCENT ? 'Passing' : 'Failing', `${QUALITY_GATE_PERCENT}% threshold`],
    ['Recorded Tests', records.length, 'Tests in selected scope'],
  ];
  dashboardCards.replaceChildren();
  cardData.forEach(([label, value, note], index) => {
    const card = document.createElement('div'); card.className = 'dashboard-card';
    const big = document.createElement('div'); big.className = label === 'Quality Gate' ? `gate-value ${pct >= QUALITY_GATE_PERCENT ? 'passing' : 'failing'}` : 'card-value'; big.textContent = value;
    const title = document.createElement('div'); title.className = 'card-label'; title.textContent = label;
    const detail = document.createElement('div'); detail.className = 'card-note'; detail.textContent = note;
    card.append(big, title, detail);
    dashboardCards.appendChild(card);
  });
  renderFilePanel(overallFiles, files);
  viewOverallBtn.setAttribute('aria-selected', 'true');
}

function createDetailsRow(record) {
  const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 10; cell.className = 'details-cell';
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = `File Coverage Breakdown (${(record.files || []).length})`;
  const list = document.createElement('div'); list.className = 'file-list';
  const interactions = Array.isArray(record.interactions) ? record.interactions : [];
  if (interactions.length) {
    const steps = document.createElement('div'); steps.className = 'recorded-steps';
    const title = document.createElement('strong'); title.textContent = 'Recorded test steps';
    const entries = document.createElement('ol');
    interactions.forEach((interaction) => { const item = document.createElement('li'); item.textContent = interaction?.text || String(interaction); entries.appendChild(item); });
    steps.append(title, entries); list.appendChild(steps);
  }
  (record.files || []).forEach((file) => {
    const functions = file.functions || []; const rowEl = document.createElement('div'); rowEl.className = 'file-row';
    const url = document.createElement('div'); url.className = 'file-url'; url.textContent = formatFileUrl(file.url);
    const count = document.createElement('div'); count.className = 'coverage-count'; count.textContent = `${Number(file.coveredFunctions || 0)} executed functions`;
    const pct = document.createElement('div'); pct.className = 'coverage-percent'; pct.textContent = getCoveragePercent(Number(file.coveredFunctions || 0), Number(file.totalFunctions || functions.length));
    rowEl.append(url, count, pct, createFunctionColumns(functions)); list.appendChild(rowEl);
  });
  if (!(record.files || []).length) list.textContent = 'No file coverage details saved for this test.';
  details.append(summary, list); cell.appendChild(details); row.appendChild(cell); return row;
}

function renderHistory() {
  const siteHistory = getSiteHistory();
  populateFilterOptions(siteHistory);
  const deltaRecords = getDeltaScopeHistory(siteHistory);
  if (deltaViewMode === 'automatic') selectLatestBuildPair(deltaRecords);
  else populateDeltaBuildOptions(deltaRecords);
  const filtered = getFilteredHistory(siteHistory);
  const sorted = sortHistoryRecords(filtered);
  historyBody.replaceChildren(); emptyState.style.display = sorted.length ? 'none' : 'block'; exportBtn.disabled = !siteHistory.length; clearBtn.disabled = !siteHistory.length;
  summaryText.textContent = historySiteOrigin && historyEnvironment
    ? `${filtered.length} of ${siteHistory.length} tests shown for ${historyEnvironment} at ${historySiteOrigin}.`
    : 'Open History from a website tab to view its environment-scoped coverage history.';
  sorted.forEach((record) => {
    const { covered, total } = getRecordCoverage(record);
    const row = document.createElement('tr'); const coverage = document.createElement('td'); coverage.className = 'row-coverage'; coverage.append(createBar(covered, total), document.createTextNode(getCoveragePercent(covered, total)));
    const testName = record.testName || 'Untitled test';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button'; deleteButton.className = 'delete-test-btn';
    deleteButton.title = `Remove ${testName}`; deleteButton.setAttribute('aria-label', `Remove ${testName}`);
    const trashIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trashIcon.setAttribute('viewBox', '0 0 24 24'); trashIcon.setAttribute('aria-hidden', 'true');
    const trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5');
    trashIcon.appendChild(trashPath); deleteButton.appendChild(trashIcon);
    deleteButton.addEventListener('click', () => deleteHistoryRecord(record));
    const actionsCell = createCell('', 'row-actions'); actionsCell.append(deleteButton);
    const startedAt = record.startedAt || record.capturedAt;
    const stoppedAt = record.stoppedAt || record.capturedAt;
    row.append(
      createCell(testName, 'test-name'),
      createCell(record.testDescription || '', 'description'),
      createCell(record.testSuite || 'Manual'),
      createCell(record.environment || 'Unspecified'),
      createCell(record.buildVersion || 'Not provided'),
      createCell(formatDate(startedAt), 'date'),
      createCell(formatDate(stoppedAt), 'date'),
      createCell(formatDuration(record.durationMs), 'duration'),
      coverage,
      actionsCell
    );
    historyBody.append(row, createDetailsRow(record));
  });
  renderDashboard(filtered);
  renderCoverageDelta(deltaRecords);
  if (focusCoverageDelta) {
    focusCoverageDelta = false;
    if (!deltaOnlyView) {
      requestAnimationFrame(() => {
        document.getElementById('deltaHeading')?.closest('.delta-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }
}

function showOverall() { renderDashboard(getFilteredHistory()); }
async function loadHistory() {
  if (historySiteOrigin) {
    try {
      if (!historyEnvironment) throw new Error('An environment is required to load coverage history.');
      const response = await fetch(`${BRIDGE_SERVER_URL}/coverage-sessions?origin=${encodeURIComponent(historySiteOrigin)}&environment=${encodeURIComponent(historyEnvironment)}`);
      if (!response.ok) throw new Error(`Bridge server returned ${response.status}`);
      const { sessions } = await response.json();
      coverageHistory = Array.isArray(sessions) ? sessions.map((session) => ({
        ...session,
        files: session.result?.files || [],
        interactions: session.result?.interactions || [],
        durationMs: Date.parse(session.stoppedAt) - Date.parse(session.startedAt),
        capturedAt: session.stoppedAt || session.startedAt,
      })) : [];
      renderHistory();
      return;
    } catch (error) {
      console.warn('Could not load SQLite coverage history; using local history instead.', error);
    }
  }
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const savedHistory = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  let migrated = false;
  coverageHistory = savedHistory.map((record) => {
    if (record.siteOrigin) return record;
    const siteOrigin = inferSiteOrigin(record);
    if (!siteOrigin) return record;
    migrated = true;
    return { ...record, siteOrigin };
  });
  if (migrated) await chrome.storage.local.set({ [STORAGE_KEY]: coverageHistory });
  renderHistory();
}
async function deleteHistoryRecord(record) {
  const testName = record.testName || 'Untitled test';
  if (!window.confirm(`Remove "${testName}" from CoverageCapture history? This cannot be undone.`)) return;
  const recordIndex = coverageHistory.indexOf(record);
  if (recordIndex === -1) return;
  if (record.jobId) {
    const response = await fetch(`${BRIDGE_SERVER_URL}/coverage-sessions/${encodeURIComponent(record.jobId)}?environment=${encodeURIComponent(historyEnvironment)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Could not remove saved session (${response.status}).`);
  }
  coverageHistory = coverageHistory.filter((_, index) => index !== recordIndex);
  await chrome.storage.local.set({ [STORAGE_KEY]: coverageHistory });
  renderHistory();
}

function pdfSafeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/[\\()]/g, '\\$&');
}

function wrapPdfText(value, maxLength = 88) {
  const words = pdfSafeText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    if (`${line} ${word}`.trim().length > maxLength && line) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  });
  if (line || !lines.length) lines.push(line || '-');
  return lines;
}

function buildPdfDocument(pages) {
  const pageCount = pages.length;
  const pageObjectStart = 3;
  const contentObjectStart = pageObjectStart + pageCount;
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, index) => `${pageObjectStart + index} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  pages.forEach((content, index) => {
    const pageObject = pageObjectStart + index;
    const contentObject = contentObjectStart + index;
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${contentObjectStart + pageCount} 0 R /F2 ${contentObjectStart + pageCount + 1} 0 R >> >> /Contents ${contentObject} 0 R >>`;
    objects[contentObject] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[contentObjectStart + pageCount] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[contentObjectStart + pageCount + 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  let pdf = '%PDF-1.4\n%----\n';
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

function exportHistory() {
  const siteHistory = getFilteredHistory();
  const files = buildCoverage(siteHistory);
  const totalFunctions = files.reduce((sum, file) => sum + file.total, 0);
  const coveredFunctions = files.reduce((sum, file) => sum + file.covered, 0);
  const coveragePercent = percentNumber(coveredFunctions, totalFunctions);
  const reportLines = [
    { text: 'CoverageCapture Coverage History Report', size: 18, bold: true, gap: 26 },
    { text: `Generated: ${new Date().toLocaleString()}`, size: 9, gap: 18 },
    { text: 'Dashboard Summary', size: 14, bold: true, gap: 18 },
    { text: `Overall Coverage: ${coveragePercent}% (${coveredFunctions} / ${totalFunctions} functions)`, size: 11, gap: 15 },
    { text: `Total Functions: ${totalFunctions}`, size: 11, gap: 15 },
    { text: `Quality Gate Status: ${coveragePercent >= QUALITY_GATE_PERCENT ? 'Passing' : 'Failing'} (${QUALITY_GATE_PERCENT}% threshold)`, size: 11, gap: 24 },
    { text: `Website: ${historySiteOrigin || 'Unknown'}`, size: 9, gap: 18 },
    { text: `Selected Tests (${siteHistory.length})`, size: 14, bold: true, gap: 18 },
  ];
  sortNewestFirst(siteHistory).forEach((record, index) => {
    const recordFiles = record.files || [];
    const total = recordFiles.reduce((sum, file) => sum + Number(file.totalFunctions || (file.functions || []).length), 0);
    const covered = recordFiles.reduce((sum, file) => sum + Number(file.coveredFunctions || 0), 0);
    reportLines.push({ text: `${index + 1}. ${record.testName || 'Untitled test'} - ${getCoveragePercent(covered, total)} (${covered} / ${total} functions)`, size: 11, bold: true, gap: 15 });
    reportLines.push({ text: `   Suite: ${record.testSuite || 'Manual'} | Environment: ${record.environment || 'Unspecified'} | Build: ${record.buildVersion || 'Not provided'}`, size: 9, gap: 13 });
    if (record.testDescription) reportLines.push({ text: `   ${record.testDescription}`, size: 9, gap: 13 });
  });

  const pages = [];
  let commands = [];
  let y = 748;
  const startPage = () => { commands = ['0.04 0.12 0.27 rg']; y = 748; };
  const finishPage = () => { pages.push(commands.join('\n')); };
  startPage();
  reportLines.forEach((entry) => {
    const lines = wrapPdfText(entry.text);
    const lineHeight = entry.size + 4;
    if (y - (lines.length * lineHeight) - entry.gap < 42) { finishPage(); startPage(); }
    lines.forEach((line) => { commands.push(`BT /F${entry.bold ? 2 : 1} ${entry.size} Tf 48 ${y} Td (${line}) Tj ET`); y -= lineHeight; });
    y -= entry.gap - lineHeight;
  });
  finishPage();

  const url = URL.createObjectURL(buildPdfDocument(pages));
  const link = document.createElement('a');
  link.href = url;
  link.download = `coveragecapture-history-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function clearHistory() {
  const siteHistory = getSiteHistory();
  if (!siteHistory.length || !window.confirm(`Clear CoverageCapture history for ${historySiteOrigin}? This cannot be undone.`)) return;
  const response = await fetch(`${BRIDGE_SERVER_URL}/coverage-sessions?origin=${encodeURIComponent(historySiteOrigin)}&environment=${encodeURIComponent(historyEnvironment)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Could not clear saved sessions (${response.status}).`);
  coverageHistory = coverageHistory.filter((record) => record.siteOrigin !== historySiteOrigin || getRecordMetadata(record).environment !== historyEnvironment);
  await chrome.storage.local.set({ [STORAGE_KEY]: coverageHistory });
  renderHistory();
}
searchInput.addEventListener('input', renderHistory);
sortSelect.addEventListener('change', () => { selectedSort = sortSelect.value; renderHistory(); });
testSuiteFilter.addEventListener('change', () => { selectedFilters.testSuite = testSuiteFilter.value; renderHistory(); });
environmentFilter.addEventListener('change', () => { selectedFilters.environment = environmentFilter.value; renderHistory(); });
buildVersionFilter.addEventListener('change', () => { selectedFilters.buildVersion = buildVersionFilter.value; renderHistory(); });
baselineBuildSelect.addEventListener('change', () => { selectedBaselineBuild = baselineBuildSelect.value; renderCoverageDelta(getDeltaScopeHistory()); });
comparisonBuildSelect.addEventListener('change', () => { selectedComparisonBuild = comparisonBuildSelect.value; renderCoverageDelta(getDeltaScopeHistory()); });
automaticDeltaBtn.addEventListener('click', () => { deltaViewMode = 'automatic'; renderHistory(); });
manualDeltaBtn.addEventListener('click', () => { deltaViewMode = 'manual'; renderHistory(); });
exportBtn.addEventListener('click', exportHistory); clearBtn.addEventListener('click', clearHistory); viewOverallBtn.addEventListener('click', showOverall); loadHistory();
