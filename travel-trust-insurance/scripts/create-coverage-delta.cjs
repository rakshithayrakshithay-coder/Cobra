const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'coverage-artifacts');
const report = JSON.parse(fs.readFileSync(path.join(artifacts, 'ci-coverage.json'), 'utf8'));
const baseRef = process.env.BASE_REF || 'HEAD~1';
const getNames = (source) => new Set([...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
const currentSource = fs.readFileSync(path.join(root, 'public', 'js', 'script.js'), 'utf8');
let baseSource = '';
try { baseSource = execFileSync('git', ['show', `${baseRef}:travel-trust-insurance/public/js/script.js`], { cwd: path.resolve(root, '..'), encoding: 'utf8' }); } catch { console.warn(`Unable to read ${baseRef}; using an empty baseline.`); }
const added = [...getNames(currentSource)].filter((name) => !getNames(baseSource).has(name));
const covered = new Set(report.files.flatMap((file) => file.functions.filter((fn) => fn.covered).map((fn) => fn.name)));
const delta = { baselineRef: baseRef, comparisonRef: process.env.GITHUB_SHA || 'local', functionsAdded: added, newFunctionsExecuted: added.filter((name) => covered.has(name)), newFunctionsUntested: added.filter((name) => !covered.has(name)), report };
fs.writeFileSync(path.join(artifacts, 'coverage-delta.json'), JSON.stringify(delta, null, 2));
console.log(`Coverage Delta: ${added.length} added; ${delta.newFunctionsExecuted.length} executed; ${delta.newFunctionsUntested.length} untested.`);
