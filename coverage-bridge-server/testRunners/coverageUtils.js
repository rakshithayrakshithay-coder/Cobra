async function createCoverageCollector(page) {
  const client = await page.context().newCDPSession(page);
  const coverageChunks = [];
  const scriptSources = {};
  let snapshotQueue = Promise.resolve();

  await client.send('Debugger.enable');
  await client.send('Profiler.enable');
  await client.send('Profiler.startPreciseCoverage', {
    callCount: true,
    detailed: true,
  });

  async function getScriptSource(scriptId) {
    if (!scriptId) {
      return '';
    }

    if (Object.prototype.hasOwnProperty.call(scriptSources, scriptId)) {
      return scriptSources[scriptId];
    }

    try {
      const source = await client.send('Debugger.getScriptSource', { scriptId });
      scriptSources[scriptId] = source.scriptSource || '';
    } catch (err) {
      scriptSources[scriptId] = '';
    }

    return scriptSources[scriptId];
  }

  function takeSnapshot() {
    snapshotQueue = snapshotQueue.then(async () => {
      try {
        const coverage = await client.send('Profiler.takePreciseCoverage');
        const coverageWithSources = await Promise.all(
          coverage.result.map(async (entry) => ({
            ...entry,
            text: await getScriptSource(entry.scriptId),
          }))
        );

        coverageChunks.push(...coverageWithSources);
      } catch (err) {
        if (!/Target page, context or browser has been closed/i.test(err.message || '')) {
          throw err;
        }
      }
    });

    return snapshotQueue;
  }

  async function stop() {
    await snapshotQueue;
    await takeSnapshot();
    try {
      await client.send('Profiler.stopPreciseCoverage');
      await client.send('Profiler.disable');
      await client.send('Debugger.disable');
    } catch (err) {
      if (!/Target page, context or browser has been closed/i.test(err.message || '')) {
        throw err;
      }
    }

    return processCoverage(coverageChunks);
  }

  return {
    takeSnapshot,
    stop,
  };
}

function processCoverage(rawCoverage) {
  const fileMap = {};

  rawCoverage
    .filter((entry) => entry.url.startsWith('http://localhost:3000'))
    .forEach((entry) => {
      if (!fileMap[entry.url]) {
        fileMap[entry.url] = {
          url: entry.url,
          totalFunctions: 0,
          coveredFunctions: 0,
          functions: [],
          namedFunctionIndexes: {},
        };
      }

      const file = fileMap[entry.url];
      const sourceText = getCoverageSource(entry);

      entry.functions.forEach((fn) => {
        const startOffset = getFunctionStartOffset(fn);
        const name = fn.functionName || inferAnonymousFunctionName(entry, fn);
        const covered = fn.ranges.some((range) => range.count > 0);
        const location = getSourceLocation(sourceText, startOffset);

        if (!name) {
          return;
        }

        if (Object.prototype.hasOwnProperty.call(file.namedFunctionIndexes, name)) {
          const index = file.namedFunctionIndexes[name];
          file.functions[index].covered = file.functions[index].covered || covered;
          return;
        }

        file.namedFunctionIndexes[name] = file.functions.length;
        file.functions.push({ name, covered, location });
      });
    });

  return {
    files: Object.values(fileMap).map((file) => {
      const { namedFunctionIndexes, functions, ...summary } = file;
      return {
        ...summary,
        totalFunctions: functions.length,
        coveredFunctions: functions.filter((fn) => fn.covered).length,
        functions,
      };
    }),
  };
}

function getCoverageSource(entry) {
  if (typeof entry.text === 'string' && entry.text) {
    return entry.text;
  }

  if (typeof entry.source === 'string' && entry.source) {
    return entry.source;
  }

  return '';
}

function inferAnonymousFunctionName(entry, fn) {
  const text = getCoverageSource(entry);
  const startOffset = getFunctionStartOffset(fn);

  if (!text || startOffset === 0) {
    return null;
  }

  const location = getSourceLocation(text, startOffset);
  const before = text.slice(Math.max(0, startOffset - 160), startOffset);
  const after = text.slice(startOffset, Math.min(text.length, startOffset + 220));
  const locationSuffix = location ? ` at ${location}` : '';

  const assignmentMatch = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (assignmentMatch) {
    return assignmentMatch[1];
  }

  const propertyMatch = before.match(/([A-Za-z_$][\w$]*)\s*:\s*$/);
  if (propertyMatch) {
    return propertyMatch[1];
  }

  const eventMatch = before.match(/addEventListener\(\s*['"]([^'"]+)['"]\s*,\s*$/);
  if (eventMatch) {
    const calledFunction = getFirstCalledFunctionName(after);
    if (calledFunction) {
      return `${calledFunction} ${eventMatch[1]} handler${locationSuffix}`;
    }

    return `${eventMatch[1]} event handler${locationSuffix}`;
  }

  const iteratorMatch = before.match(/\.([A-Za-z_$][\w$]*)\(\s*$/);
  if (iteratorMatch) {
    const calledFunction = getFirstCalledFunctionName(after);
    if (calledFunction) {
      return `${calledFunction} callback${locationSuffix}`;
    }

    return `${iteratorMatch[1]} callback${locationSuffix}`;
  }

  const inlineFunctionMatch = after.match(/^function\s*\(/);
  if (inlineFunctionMatch) {
    return `inline function${locationSuffix}`;
  }

  const inlineArrowMatch = after.match(/^\(?[\w\s,{}[\].$]*\)?\s*=>/);
  if (inlineArrowMatch) {
    return `inline arrow function${locationSuffix}`;
  }

  return `anonymous function${locationSuffix}`;
}

function getFirstCalledFunctionName(text) {
  const match = text.match(/=>\s*{?\s*([A-Za-z_$][\w$]*)\s*\(/);

  return match ? match[1] : '';
}

function getFunctionStartOffset(fn) {
  if (!Array.isArray(fn.ranges) || fn.ranges.length === 0) {
    return 0;
  }

  return fn.ranges.reduce((smallest, range) =>
    Math.min(smallest, Number(range.startOffset || 0)),
    Number(fn.ranges[0].startOffset || 0)
  );
}

function getSourceLocation(text, offset) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  const safeOffset = Math.max(0, Math.min(Number(offset || 0), text.length));
  const lines = text.slice(0, safeOffset).split('\n');
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;

  return `${line}:${column}`;
}

module.exports = {
  createCoverageCollector,
  processCoverage,
};
