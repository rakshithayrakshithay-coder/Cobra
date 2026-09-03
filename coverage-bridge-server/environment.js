const ENVIRONMENT_ALIASES = new Map([
  ['dev', 'Development'], ['development', 'Development'],
  ['qa', 'QA'], ['test', 'QA'],
  ['uat', 'UAT'], ['staging', 'UAT'],
  ['prod', 'Production'], ['production', 'Production'],
]);

function normalizeEnvironment(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || /^unspecified$/i.test(trimmed) || /^github actions$/i.test(trimmed)) return '';
  return ENVIRONMENT_ALIASES.get(trimmed.toLowerCase()) || trimmed;
}

function requireEnvironment(value) {
  const environment = normalizeEnvironment(value);
  if (!environment) throw new Error('environment is required. Set COVERAGE_ENVIRONMENT at deployment time or add meta[name="coveragecapture-environment"] to the application.');
  return environment;
}

module.exports = { normalizeEnvironment, requireEnvironment };
