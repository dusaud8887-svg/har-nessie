import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { MEMORY_DIR, RUNS_DIR } from '../app/harness-paths.mjs';
import { parseCronExpression, cronMatchesNow, findNextCronOccurrence } from '../app/cron-utils.mjs';
import { createMemoryResolver } from '../app/memory-resolver.mjs';
import { createSupervisorRuntimeStore } from '../app/supervisor-runtime-store.mjs';
import { createRuntimeObservability } from '../app/runtime-observability.mjs';
import { appendArtifactMemory, buildPropagatedGraphInsights, scoreArtifactRecord } from '../app/memory-store.mjs';
import { calculateExecutionEdgeRiskScore, calculateExecutionSymbolRiskScore } from '../app/task-action-runtime.mjs';
import { resolveAdaptiveParallelLimit, tasksCollide } from '../app/orchestrator.mjs';

test('parseCronExpression accepts ranges and rejects invalid cron strings', () => {
  const parsed = parseCronExpression('*/15 9-17 * * 1-5');
  assert.deepEqual(parsed?.minute, [0, 15, 30, 45]);
  assert.deepEqual(parsed?.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(parsed?.dayOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(parseCronExpression('bad cron'), null);
  assert.equal(parseCronExpression('0 9 * * 1-9'), null);
});

test('cron helpers match the current minute and compute the next occurrence', () => {
  const at = new Date(2026, 3, 6, 9, 30, 0, 0);
  assert.equal(cronMatchesNow('30 9 6 4 *', at), true);
  assert.equal(cronMatchesNow('0 9 6 4 *', at), false);
  assert.equal(findNextCronOccurrence('30 9 6 4 *', new Date(2026, 3, 6, 9, 0, 0, 0)), at.toISOString());
});

test('scoreArtifactRecord boosts recent symbol-grounded and variant-grounded evidence', () => {
  const baseContext = {
    queryTokens: ['session', 'retry'],
    filesLikely: ['src/auth/session-service.ts'],
    relatedFiles: ['src/auth/session-service.ts'],
    symbolHints: ['buildAuthSession']
  };
  const staleRecord = {
    title: 'generic note',
    summary: 'retry note',
    graphSummary: '',
    rootCause: '',
    keywords: ['retry'],
    symbolHints: ['otherSymbol'],
    graphSymbols: [],
    graphEdges: [],
    filesLikely: ['src/other/file.ts'],
    changedFiles: [],
    outOfScopeFiles: [],
    acceptanceFailures: [],
    createdAt: '2025-01-01T00:00:00.000Z'
  };
  const focusedRecord = {
    ...staleRecord,
    title: 'auth session retry',
    summary: 'buildAuthSession keeps regressing',
    rootCause: 'session drift',
    rootCauseVariants: ['session drift', 'auth session drift'],
    rootCauseVariantCounts: { 'session drift': 1, 'auth session drift': 3 },
    summaryVariants: ['buildAuthSession keeps regressing'],
    summaryVariantCounts: { 'buildAuthSession keeps regressing': 2 },
    symbolHints: ['buildAuthSession'],
    filesLikely: ['src/auth/session-service.ts'],
    changedFiles: ['src/auth/session-service.ts'],
    createdAt: '2026-04-05T00:00:00.000Z'
  };

  const baseScore = scoreArtifactRecord(staleRecord, baseContext);
  const focusedScore = scoreArtifactRecord(focusedRecord, baseContext);
  assert.ok(focusedScore > baseScore, `expected focused score ${focusedScore} to exceed stale score ${baseScore}`);
});

test('buildPropagatedGraphInsights follows weighted chains into downstream files and symbols', () => {
  const edgeCounts = new Map([
    ['src/auth/index.ts -> src/auth/session-service.ts', { weight: 6 }],
    ['src/auth/session-service.ts -> src/auth/token-store.ts', { weight: 4 }],
    ['src/auth/token-store.ts -> src/platform/cache.ts', { weight: 2 }]
  ]);
  const propagated = buildPropagatedGraphInsights(edgeCounts);
  assert.ok((propagated.topPaths || []).some((item) => String(item?.path || '').includes('src/auth/index.ts -> src/auth/session-service.ts -> src/auth/token-store.ts')));
  assert.ok((propagated.propagatedFiles || []).some((item) => item?.filePath === 'src/auth/token-store.ts'));
});

test('tasksCollide detects import relationships and shared config collisions', () => {
  const left = { filesLikely: ['package.json'], title: 'left' };
  const right = { filesLikely: ['tsconfig.json'], title: 'right' };
  assert.equal(tasksCollide(left, right, '', new Map()), true);
});

test('resolveAdaptiveParallelLimit keeps width on clean runs and collapses on recovery signals', () => {
  const readyTasks = [
    { id: 'T001', status: 'ready', attempts: 0 },
    { id: 'T002', status: 'ready', attempts: 0 },
    { id: 'T003', status: 'ready', attempts: 0 }
  ];
  const cleanRun = {
    memory: { failureAnalytics: { scopeDriftCount: 0, verificationFailures: 0, retryCount: 0 } },
    metrics: { replanHighDriftCount: 0 }
  };
  assert.deepEqual(
    resolveAdaptiveParallelLimit(cleanRun, readyTasks, 3, { parallelMode: 'parallel' }),
    { limit: 3, reason: 'full-width-safe' }
  );

  const unstableRun = {
    memory: { failureAnalytics: { scopeDriftCount: 1, verificationFailures: 0, retryCount: 0 } },
    metrics: { replanHighDriftCount: 0 }
  };
  assert.deepEqual(
    resolveAdaptiveParallelLimit(unstableRun, readyTasks, 3, { parallelMode: 'parallel' }),
    { limit: 1, reason: 'stability-recovery' }
  );
});

test('graph execution risk scoring weights memory and call pressure into the final score', () => {
  const baselineSymbol = calculateExecutionSymbolRiskScore({
    importerCount: 2,
    callerCount: 1,
    callCount: 1,
    memoryCount: 0,
    memoryWeight: 0
  });
  const hotSymbol = calculateExecutionSymbolRiskScore({
    importerCount: 2,
    callerCount: 1,
    callCount: 1,
    memoryCount: 3,
    memoryWeight: 2
  });
  const hotEdge = calculateExecutionEdgeRiskScore({
    importerCount: 2,
    callerCount: 2,
    callCount: 1,
    memoryCount: 2,
    memoryWeight: 1.5
  });
  assert.ok(hotSymbol > baselineSymbol, `expected memory-heavy symbol score ${hotSymbol} to exceed baseline ${baselineSymbol}`);
  assert.ok(hotEdge > baselineSymbol, `expected edge score ${hotEdge} to exceed the baseline symbol score ${baselineSymbol}`);
});

test('appendArtifactMemory serializes concurrent writes for the same project memory', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'har-memory-lock-'));
  try {
    const run = {
      id: 'run-concurrent-memory',
      title: 'concurrent-memory',
      status: 'completed',
      updatedAt: '2026-04-05T10:00:00.000Z',
      projectPath: tempRoot,
      input: { objective: 'record both artifacts' },
      clarify: {},
      memory: { projectKey: 'proj-concurrent' },
      tasks: []
    };
    const tasks = [
      {
        id: 'T001',
        title: 'first artifact',
        goal: 'write first artifact',
        status: 'done',
        filesLikely: ['README.md'],
        reviewSummary: 'first ok',
        findings: [],
        lastExecution: { changedFiles: ['README.md'], outOfScopeFiles: [] }
      },
      {
        id: 'T002',
        title: 'second artifact',
        goal: 'write second artifact',
        status: 'done',
        filesLikely: ['docs/spec.md'],
        reviewSummary: 'second ok',
        findings: [],
        lastExecution: { changedFiles: ['docs/spec.md'], outOfScopeFiles: [] }
      }
    ];
    run.tasks = tasks;

    for (const task of tasks) {
      const taskDir = path.join(RUNS_DIR, run.id, 'tasks', task.id);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(path.join(taskDir, 'agent-output.md'), `${task.title} output`, 'utf8');
      await fs.writeFile(path.join(taskDir, 'agent-review.json'), JSON.stringify({
        decision: 'done',
        verificationOk: true,
        changedFiles: task.lastExecution.changedFiles
      }, null, 2), 'utf8');
    }

    await Promise.all(tasks.map((task) => appendArtifactMemory(tempRoot, run, task)));

    const indexPath = path.join(MEMORY_DIR, run.memory.projectKey, 'memory-artifacts.ndjson');
    const rows = (await fs.readFile(indexPath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const taskIds = new Set(rows.map((row) => row.taskId));
    assert.ok(taskIds.has('T001'));
    assert.ok(taskIds.has('T002'));
  } finally {
    await fs.rm(path.join(RUNS_DIR, 'run-concurrent-memory'), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(MEMORY_DIR, 'proj-concurrent'), { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('supervisor runtime store persists and restores paused runtime state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'har-supervisor-store-'));
  try {
    const filePath = path.join(tempRoot, 'supervisors.json');
    const store = createSupervisorRuntimeStore({ filePath, now: () => '2026-04-05T10:00:00.000Z' });
    const runtimeMap = new Map([
      ['project-alpha', {
        running: false,
        pausedReason: 'auto-paused after repeated failures',
        lastAction: 'paused-repeated-failures',
        history: [{ kind: 'action', detail: 'paused-repeated-failures', at: '2026-04-05T09:59:00.000Z' }]
      }]
    ]);
    await store.schedulePersist(runtimeMap);

    const restored = new Map();
    await store.restore(restored);
    assert.equal(restored.get('project-alpha')?.running, false);
    assert.match(String(restored.get('project-alpha')?.pausedReason || ''), /repeated failures/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('createMemoryResolver resolves, applies, and refreshes a run memory snapshot', async () => {
  const states = new Map([
    ['run-1', {
      id: 'run-1',
      title: 'memory resolver run',
      projectPath: 'D:/repo',
      input: { objective: 'fix auth retry' },
      clarify: {},
      memory: { projectKey: 'proj-1', existing: 'keep-me' }
    }]
  ]);
  const saved = [];
  const searchCalls = [];
  const lockCalls = [];
  const snapshot = {
    baseDir: 'D:/memory/proj-1',
    memoryFile: 'memory.md',
    dailyDir: 'daily',
    dailyFile: 'daily.md',
    indexFile: 'index.ndjson',
    recentSummary: 'recent summary',
    searchQuery: 'fix auth retry',
    searchResults: [{ id: 'artifact-1' }],
    retrievedContext: 'retrieved context',
    searchBackend: 'fts5',
    failureAnalytics: { retryCount: 2 },
    traceSummary: { latest: 'run.failed' },
    graphInsights: { topEdges: ['a -> b'], topSymbols: ['buildAuthSession'] },
    temporalInsights: { activeDecisions: ['retry'], activeFiles: ['src/auth/session.ts'], activeRootCauses: ['scope drift'], recentShare: 0.8 }
  };

  const resolver = createMemoryResolver({
    ROOT_DIR: 'D:/root',
    async loadState(runId) {
      return structuredClone(states.get(runId));
    },
    async saveState(state) {
      states.set(state.id, structuredClone(state));
      saved.push(structuredClone(state));
    },
    async searchProjectMemory(rootDir, projectKey, query, limit, searchContext) {
      searchCalls.push({ rootDir, projectKey, query, limit, searchContext });
      return structuredClone(snapshot);
    },
    async withLock(runId, work) {
      lockCalls.push(runId);
      return work();
    }
  });

  const resolved = await resolver.resolvePromptMemory(states.get('run-1'), 'fix auth retry');
  assert.equal(resolved.retrievedContext, 'retrieved context');
  assert.deepEqual(searchCalls[0], {
    rootDir: 'D:/root',
    projectKey: 'proj-1',
    query: 'fix auth retry',
    limit: 4,
    searchContext: { projectPath: 'D:/repo' }
  });

  await resolver.applyMemorySnapshot('run-1', snapshot);
  assert.deepEqual(lockCalls, ['run-1']);
  assert.equal(states.get('run-1').memory.existing, 'keep-me');
  assert.equal(states.get('run-1').memory.searchBackend, 'fts5');
  assert.deepEqual(states.get('run-1').memory.graphInsights.topSymbols, ['buildAuthSession']);

  states.get('run-1').clarify = { clarifiedObjective: 'clarified objective' };
  await resolver.refreshRunMemory('run-1');
  assert.equal(searchCalls.at(-1)?.query, 'clarified objective');
  assert.equal(saved.length >= 2, true);
});

test('createMemoryResolver returns an empty memory snapshot when a run has no project memory key', async () => {
  const resolver = createMemoryResolver({
    ROOT_DIR: 'D:/root',
    async loadState() {
      return {};
    },
    async saveState() {},
    async searchProjectMemory() {
      throw new Error('searchProjectMemory should not be called');
    },
    async withLock(_runId, work) {
      return work();
    }
  });

  const snapshot = await resolver.resolvePromptMemory({
    title: 'no project memory',
    projectPath: 'D:/repo',
    memory: {}
  }, 'query');
  assert.equal(snapshot.searchBackend, 'none');
  assert.equal(snapshot.retrievedContext, 'No relevant project memory found.');
  assert.deepEqual(snapshot.graphInsights, { topEdges: [], topSymbols: [] });
});

test('runtime observability records fallback warnings and errors to disk', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'har-observability-'));
  const events = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => events.push({ level: 'warn', args });
  console.error = (...args) => events.push({ level: 'error', args });
  try {
    const observability = createRuntimeObservability({
      metaDir: tempRoot,
      now: () => '2026-04-05T10:00:00.000Z'
    });

    const fallbackValue = await observability.withObservedFallback(
      async () => {
        throw Object.assign(new Error('fallback-hit'), { code: 'E_FALLBACK' });
      },
      {
        scope: 'unit.test',
        context: { runId: 'run-1' },
        fallback: 'ok',
        level: 'warn'
      }
    );
    assert.equal(fallbackValue, 'ok');

    const entry = await observability.recordHarnessError(
      'unit.test',
      Object.assign(new Error('boom'), { code: 'E_BOOM' }),
      { taskId: 'T001' }
    );
    assert.equal(entry.level, 'error');

    const body = await fs.readFile(path.join(tempRoot, 'runtime-events.ndjson'), 'utf8');
    const rows = body.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].level, 'warn');
    assert.equal(rows[0].context.runId, 'run-1');
    assert.equal(rows[0].runId, 'run-1');
    assert.equal(rows[0].correlationId, 'run:run-1');
    assert.equal(rows[1].context.errorCode, 'E_BOOM');
    assert.equal(rows[1].context.taskId, 'T001');
    assert.equal(rows[1].taskId, 'T001');
    assert.equal(rows[1].correlationId, 'task:T001');
    assert.ok(events.some((item) => item.level === 'warn'));
    assert.ok(events.some((item) => item.level === 'error'));
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
