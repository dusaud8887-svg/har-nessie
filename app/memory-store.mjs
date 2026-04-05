import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HARNESS_META_DIR, MEMORY_DIR, RUNS_DIR } from './harness-paths.mjs';
import { GRAPH_INTELLIGENCE_DEFAULTS } from './run-config.mjs';
import { createRuntimeObservability } from './runtime-observability.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {}

const indexStateCache = new Map();
const rootObservabilityCache = new Map();
const projectWriteLocks = new Map();
const MEMORY_RECENCY_HALF_LIFE_DAYS = 21;
const GRAPH_RECENCY_HALF_LIFE_DAYS = 14;
const MEMORY_RECENCY_FLOOR = 0.18;
const MEMORY_WRITE_LOCK_TIMEOUT_MS = 30_000;

function now() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDir(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.mkdir(target, { recursive: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT' || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target) {
  return fs.readFile(target, 'utf8');
}

async function writeTextIfMissing(target, content) {
  if (!(await fileExists(target))) {
    await fs.writeFile(target, content, 'utf8');
  }
}

async function appendSection(target, lines) {
  const prefix = (await fileExists(target)) ? '\n' : '';
  await fs.appendFile(target, `${prefix}${lines.join('\n')}\n`, 'utf8');
}

function tailText(text, maxChars = 2400) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function cleanup(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function timestampMs(value) {
  return Date.parse(String(value || '').trim()) || 0;
}

function recencyWeight(timestamp, options = {}) {
  const resolvedTimestamp = Number(timestamp || 0);
  const halfLifeDays = Math.max(1, Number(options.halfLifeDays || MEMORY_RECENCY_HALF_LIFE_DAYS));
  const floor = Math.min(0.95, Math.max(0, Number(options.floor ?? MEMORY_RECENCY_FLOOR)));
  if (!resolvedTimestamp) return floor;
  const ageDays = Math.max(0, (Date.now() - resolvedTimestamp) / (24 * 60 * 60 * 1000));
  const decayed = Math.pow(0.5, ageDays / halfLifeDays);
  return Number((floor + ((1 - floor) * decayed)).toFixed(4));
}

function recencyWeightForRecord(record, options = {}) {
  return recencyWeight(timestampMs(record?.createdAt || record?.updatedAt || ''), options);
}

function normalizePath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function excerpt(text, maxChars = 240) {
  const value = cleanup(text);
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function openQuestionText(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      return String(item?.question || '').trim();
    })
    .filter(Boolean);
}

function tokenizeQuery(text) {
  return [...new Set((String(text || '').match(/[\p{L}\p{N}_]+/gu) || []).map((token) => token.toLowerCase()))].slice(0, 8);
}

function toFtsQuery(text) {
  const tokens = tokenizeQuery(text).map((token) => `${token.replace(/"/g, '')}*`);
  return tokens.join(' OR ');
}

function projectPaths(rootDir, projectKey) {
  const baseDir = path.join(MEMORY_DIR, projectKey);
  return {
    projectKey,
    baseDir,
    memoryFile: path.join(baseDir, 'MEMORY.md'),
    dailyDir: path.join(baseDir, 'daily'),
    dailyFile: path.join(baseDir, 'daily', `${today()}.md`),
    runMemoryDir: path.join(baseDir, 'runs'),
    taskMemoryDir: path.join(baseDir, 'tasks'),
    artifactIndexFile: path.join(baseDir, 'memory-artifacts.ndjson'),
    indexFile: path.join(baseDir, 'memory.sqlite'),
    legacyFile: path.join(MEMORY_DIR, `${projectKey}.md`)
  };
}

function rootObservability(rootDir) {
  const normalizedRoot = path.resolve(String(rootDir || '.'));
  const existing = rootObservabilityCache.get(normalizedRoot);
  if (existing) return existing;
  const observability = createRuntimeObservability({
    metaDir: HARNESS_META_DIR,
    now
  });
  rootObservabilityCache.set(normalizedRoot, observability);
  return observability;
}

async function withProjectWriteLock(projectKey, action) {
  const lockKey = String(projectKey || '').trim() || 'memory';
  const previous = projectWriteLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current);
  projectWriteLocks.set(lockKey, next);
  let timeoutHandle = null;
  try {
    await Promise.race([
      previous,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Timed out waiting for memory write lock: ${lockKey}`)), MEMORY_WRITE_LOCK_TIMEOUT_MS);
      })
    ]);
    return await action();
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    release();
    if (projectWriteLocks.get(lockKey) === next) {
      projectWriteLocks.delete(lockKey);
    }
  }
}

async function writeProjectMemory(rootDir, projectKey, scope, action) {
  return withProjectWriteLock(projectKey, async () => {
    try {
      return await action();
    } catch (error) {
      await rootObservability(rootDir).recordHarnessError(scope, error, { projectKey });
      throw error;
    }
  });
}

async function migrateLegacyMemory(paths, meta) {
  if (!(await fileExists(paths.legacyFile)) || (await fileExists(paths.memoryFile))) {
    return;
  }

  const legacy = (await readText(paths.legacyFile)).trim();
  if (!legacy) return;

  const lines = [
    '# Project Memory',
    '',
    'Migrated from the legacy flat memory file.',
    '',
    '## Project',
    '',
    `- Key: ${paths.projectKey}`,
    `- Path: ${meta.projectPath || '-'}`,
    `- Created: ${now()}`,
    '',
    '## Imported History',
    '',
    legacy
  ];
  await fs.writeFile(paths.memoryFile, `${lines.join('\n')}\n`, 'utf8');
}

async function ensureMemoryFiles(paths, meta = {}) {
  await ensureDir(paths.baseDir);
  await ensureDir(paths.dailyDir);
  await ensureDir(paths.runMemoryDir);
  await ensureDir(paths.taskMemoryDir);
  await migrateLegacyMemory(paths, meta);
  await writeTextIfMissing(paths.memoryFile, [
    '# Project Memory',
    '',
    'Long-lived decisions, constraints, preferences, and recurring failure patterns.',
    '',
    '## Project',
    '',
    `- Key: ${paths.projectKey}`,
    `- Path: ${meta.projectPath || '-'}`,
    `- Created: ${now()}`,
    ''
  ].join('\n'));
  await writeTextIfMissing(paths.dailyFile, [
    `# Daily Memory ${today()}`,
    '',
    'Time-ordered snapshots from clarify, review, goal-judge, and completion events.',
    ''
  ].join('\n'));
  await writeTextIfMissing(paths.artifactIndexFile, '');
}

async function listMemoryDocs(paths) {
  const docs = [];
  if (await fileExists(paths.memoryFile)) {
    docs.push({
      docKey: 'memory',
      kind: 'long-term',
      title: 'Project Memory',
      filePath: paths.memoryFile,
      updatedAt: (await fs.stat(paths.memoryFile)).mtime.toISOString(),
      body: await readText(paths.memoryFile)
    });
  }

  if (await fileExists(paths.dailyDir)) {
    const entries = await fs.readdir(paths.dailyDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files) {
      const filePath = path.join(paths.dailyDir, name);
      docs.push({
        docKey: `daily:${name}`,
        kind: 'daily',
        title: `Daily ${name.replace(/\.md$/, '')}`,
        filePath,
        updatedAt: (await fs.stat(filePath)).mtime.toISOString(),
        body: await readText(filePath)
      });
    }
  }

  if (await fileExists(paths.runMemoryDir)) {
    const entries = await fs.readdir(paths.runMemoryDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files) {
      const filePath = path.join(paths.runMemoryDir, name);
      docs.push({
        docKey: `run:${name}`,
        kind: 'run-memory',
        title: `Run ${name.replace(/\.md$/, '')}`,
        filePath,
        updatedAt: (await fs.stat(filePath)).mtime.toISOString(),
        body: await readText(filePath)
      });
    }
  }

  if (await fileExists(paths.taskMemoryDir)) {
    const entries = await fs.readdir(paths.taskMemoryDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files) {
      const filePath = path.join(paths.taskMemoryDir, name);
      docs.push({
        docKey: `task:${name}`,
        kind: 'task-memory',
        title: `Task ${name.replace(/\.md$/, '')}`,
        filePath,
        updatedAt: (await fs.stat(filePath)).mtime.toISOString(),
        body: await readText(filePath)
      });
    }
  }

  if (await fileExists(paths.artifactIndexFile)) {
    const body = await readText(paths.artifactIndexFile).catch(() => '');
    if (body.trim()) {
      docs.push({
        docKey: 'artifact-index',
        kind: 'artifact-memory',
        title: 'Artifact Memory Index',
        filePath: paths.artifactIndexFile,
        updatedAt: (await fs.stat(paths.artifactIndexFile)).mtime.toISOString(),
        body
      });
    }
  }

  return docs;
}

function buildDocSignature(docs) {
  return (Array.isArray(docs) ? docs : [])
    .map((doc) => [
      doc.docKey,
      doc.kind,
      doc.title,
      doc.filePath,
      doc.updatedAt,
      String(doc.body || '').length
    ].join('::'))
    .join('\n');
}

async function readJsonLines(filePath) {
  const text = await readText(filePath).catch(() => '');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function writeJsonLines(filePath, rows) {
  const body = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, body, 'utf8');
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readText(filePath));
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function addWeightedCount(map, key, weight) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  const safeWeight = Math.max(0, Number(weight || 0));
  const previous = map.get(normalizedKey) || { count: 0, weight: 0 };
  map.set(normalizedKey, {
    count: previous.count + 1,
    weight: Number((previous.weight + safeWeight).toFixed(4))
  });
}

function topWeightedEntries(map, fieldName, limit) {
  return [...map.entries()]
    .sort((left, right) => {
      if (right[1].weight !== left[1].weight) return right[1].weight - left[1].weight;
      if (right[1].count !== left[1].count) return right[1].count - left[1].count;
      return String(left[0]).localeCompare(String(right[0]));
    })
    .slice(0, Math.max(1, Number(limit || 4)))
    .map(([key, stats]) => ({
      [fieldName]: key,
      count: stats.count,
      weight: Number(stats.weight.toFixed(3))
    }));
}

function normalizeSearchPaths(values) {
  return uniqueStrings(
    (Array.isArray(values) ? values : []).map((item) => typeof item === 'string' ? item : item?.path || '')
  ).map(normalizePath);
}

function buildSearchContext(query, options = {}) {
  const symbolHints = uniqueStrings(
    (Array.isArray(options.symbolHints) ? options.symbolHints : []).map((item) => String(item || '').toLowerCase())
  );
  const filesLikely = normalizeSearchPaths(options.filesLikely);
  const relatedFiles = uniqueStrings([
    ...filesLikely,
    ...normalizeSearchPaths(options.relatedFiles)
  ]);
  const queryTokens = uniqueStrings([
    ...tokenizeQuery(query),
    ...symbolHints
  ]).slice(0, 16);
  return {
    queryTokens,
    symbolHints,
    filesLikely,
    relatedFiles
  };
}

function normalizeAcceptanceFailures(results) {
  if (!Array.isArray(results)) return [];
  return uniqueStrings(
    results
      .filter((item) => String(item?.status || '').trim().toLowerCase() === 'fail')
      .map((item) => String(item?.check || '').trim())
  );
}

function artifactTaskRoot(rootDir, runId, taskId) {
  return path.join(RUNS_DIR, runId, 'tasks', taskId);
}

function taskCodeContextArtifactPath(rootDir, runId, taskId) {
  return path.join(RUNS_DIR, runId, 'context', 'code-context', `${taskId}.json`);
}

function artifactManifestPath(rootDir, runId) {
  return path.join(RUNS_DIR, runId, 'artifact-manifest.json');
}

function artifactSummary(kind, body, json = null) {
  if (kind === 'verification' && json) {
    return `verification ${json.ok === false ? 'failed' : 'passed'} | commands: ${(json.selectedCommands || []).join(' | ') || 'none'}`;
  }
  if (kind === 'review-verdict' && json) {
    return excerpt([json.summary, ...(json.findings || [])].filter(Boolean).join(' | '), 320);
  }
  if (kind === 'execution-summary' && json) {
    return excerpt([
      `decision ${json.reviewDecision || 'unknown'}`,
      `verification ${json.verificationOk === false ? 'failed' : 'passed'}`,
      `files ${(json.changedFiles || []).join(', ') || '-'}`,
      `scope ${(json.outOfScopeFiles || []).join(', ') || '-'}`
    ].join(' | '), 320);
  }
  if (kind === 'retry-plan' && json) {
    return excerpt([json.reason, json.rootCause, ...(json.changedApproach || [])].filter(Boolean).join(' | '), 320);
  }
  if (kind === 'handoff' && json) {
    return excerpt([json.goal, ...(json.filesLikely || []), ...(json.notes || [])].filter(Boolean).join(' | '), 320);
  }
  return excerpt(body, 320);
}

async function buildArtifactEntries(rootDir, run, task) {
  const taskRoot = artifactTaskRoot(rootDir, run.id, task.id);
  const definitions = [
    { kind: 'prompt', stage: 'execute', fileNames: ['agent-prompt.md', 'codex-prompt.md'], title: `Task ${task.id} Agent Prompt` },
    { kind: 'output', stage: 'execute', fileNames: ['agent-output.md', 'codex-output.md'], title: `Task ${task.id} Agent Output` },
    { kind: 'review', stage: 'review', fileNames: ['agent-review.json', 'codex-review.json'], title: `Task ${task.id} Agent Review Raw` },
    { kind: 'verification', stage: 'review', fileNames: ['verification.json'], title: `Task ${task.id} Verification` },
    { kind: 'handoff', stage: 'execute', fileNames: ['handoff.json'], title: `Task ${task.id} Handoff` },
    { kind: 'review-verdict', stage: 'review', fileNames: ['review-verdict.json'], title: `Task ${task.id} Review Verdict` },
    { kind: 'execution-summary', stage: 'review', fileNames: ['execution-summary.json'], title: `Task ${task.id} Execution Summary` },
    { kind: 'retry-plan', stage: 'review', fileNames: ['retry-plan.json'], title: `Task ${task.id} Retry Plan` }
  ];

  const entries = [];
  for (const definition of definitions) {
    let filePath = '';
    for (const fileName of definition.fileNames) {
      const candidate = path.join(taskRoot, fileName);
      if (await fileExists(candidate)) {
        filePath = candidate;
        break;
      }
    }
    if (!(await fileExists(filePath))) continue;
    const body = await readText(filePath).catch(() => '');
    const json = filePath.endsWith('.json') ? await readOptionalJson(filePath) : null;
    const verdict = json && typeof json === 'object' ? json : {};
    entries.push({
      artifactId: `${run.id}:${task.id}:${definition.kind}`,
      kind: definition.kind,
      scope: 'task',
      taskId: task.id,
      stage: definition.stage,
      title: definition.title,
      filePath,
      filesLikely: uniqueStrings(task.filesLikely),
      status: 'indexed',
      note: artifactSummary(definition.kind, body, json),
      projectKey: run.memory.projectKey,
      runId: run.id,
      summary: artifactSummary(definition.kind, body, json),
      keywords: uniqueStrings([
        task.id,
        task.title,
        task.status,
        definition.kind,
        definition.stage,
        ...(task.filesLikely || [])
      ]),
      decision: String(
        verdict.decision
        || verdict.reviewDecision
        || task.lastExecution?.reviewDecision
        || task.status
        || 'unknown'
      ).trim().toLowerCase(),
      verificationOk: verdict.verificationOk !== undefined ? Boolean(verdict.verificationOk) : (definition.kind === 'verification' ? verdict.ok !== false : undefined),
      rootCause: String(verdict.retryDiagnosis || verdict.rootCause || '').trim(),
      taskTitle: String(task.title || '').trim(),
      taskStatus: String(task.status || '').trim(),
      changedFiles: uniqueStrings([
        ...(verdict.changedFiles || []),
        ...(verdict.repoChangedFiles || []),
        ...(task.lastExecution?.changedFiles || [])
      ]),
      outOfScopeFiles: uniqueStrings([
        ...(verdict.outOfScopeFiles || []),
        ...(task.lastExecution?.outOfScopeFiles || [])
      ]),
      acceptanceFailures: normalizeAcceptanceFailures(verdict.acceptanceCheckResults),
      sourcePath: filePath,
      createdAt: now()
    });
  }
  return entries;
}

async function writeTaskMemoryDoc(paths, run, task, artifactEntries) {
  const target = path.join(paths.taskMemoryDir, `${run.id}-${task.id}.md`);
  const lines = [
    `# Task Memory ${run.id} ${task.id}`,
    '',
    `- Title: ${task.title}`,
    `- Goal: ${task.goal || '-'}`,
    `- Status: ${task.status}`,
    `- Attempts: ${task.attempts || 0}`,
    `- Review: ${task.reviewSummary || '-'}`,
    `- Workspace: ${task.lastExecution?.workspaceMode || '-'}`,
    `- Changed files: ${(task.lastExecution?.changedFiles || []).join(', ') || '-'}`,
    `- Out-of-scope files: ${(task.lastExecution?.outOfScopeFiles || []).join(', ') || '-'}`,
    ''
  ];
  if (Array.isArray(task.findings) && task.findings.length) {
    lines.push('## Findings', '');
    for (const item of task.findings) lines.push(`- ${item}`);
    lines.push('');
  }
  if (artifactEntries.length) {
    lines.push('## Artifacts', '');
    for (const entry of artifactEntries) {
      lines.push(`- [${entry.kind}] ${entry.summary || entry.note || '-'}`);
    }
    lines.push('');
  }
  await fs.writeFile(target, `${lines.join('\n')}\n`, 'utf8');
}

async function writeRunMemoryDoc(paths, run) {
  const target = path.join(paths.runMemoryDir, `${run.id}.md`);
  const lines = [
    `# Run Memory ${run.id}`,
    '',
    `- Title: ${run.title}`,
    `- Status: ${run.status}`,
    `- Objective: ${run.clarify?.clarifiedObjective || run.input?.objective || '-'}`,
    `- Summary: ${run.result?.summary || run.planSummary || '-'}`,
    ''
  ];
  if (Array.isArray(run.tasks) && run.tasks.length) {
    lines.push('## Tasks', '');
    for (const task of run.tasks) {
      lines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.reviewSummary || task.goal || '-'}`);
    }
    lines.push('');
  }
  await fs.writeFile(target, `${lines.join('\n')}\n`, 'utf8');
}

function openDb(indexFile) {
  if (!DatabaseSync) return null;
  const db = new DatabaseSync(indexFile);
  db.exec(`
    DROP TABLE IF EXISTS memory_docs;
    DROP TABLE IF EXISTS memory_fts;
    CREATE TABLE memory_docs (
      rowid INTEGER PRIMARY KEY,
      doc_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      doc_key UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

function isSqliteLockError(error) {
  return Boolean(error && (error.code === 'ERR_SQLITE_ERROR' || error.errcode === 5 || /database is locked/i.test(String(error.message || ''))));
}

async function reindexMemory(paths, docs = null) {
  if (!DatabaseSync) return;
  const resolvedDocs = Array.isArray(docs) ? docs : await listMemoryDocs(paths);
  const signature = buildDocSignature(resolvedDocs);
  const cached = indexStateCache.get(paths.indexFile);
  if (cached?.signature === signature && (await fileExists(paths.indexFile))) {
    return {
      docs: resolvedDocs,
      reindexed: false,
      signature
    };
  }
  let db = null;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      db = openDb(paths.indexFile);
      break;
    } catch (error) {
      lastError = error;
      if (!isSqliteLockError(error) || attempt === 4) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  if (!db) {
    if (lastError && !isSqliteLockError(lastError)) throw lastError;
    return {
      docs: resolvedDocs,
      reindexed: false,
      signature
    };
  }
  const insertDoc = db.prepare(`
    INSERT INTO memory_docs (rowid, doc_key, kind, title, file_path, updated_at, body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO memory_fts (rowid, doc_key, title, body)
    VALUES (?, ?, ?, ?)
  `);

  let rowid = 1;
  for (const doc of resolvedDocs) {
    insertDoc.run(rowid, doc.docKey, doc.kind, doc.title, doc.filePath, doc.updatedAt, doc.body);
    insertFts.run(rowid, doc.docKey, doc.title, doc.body);
    rowid += 1;
  }
  db.close();
  indexStateCache.set(paths.indexFile, {
    signature,
    updatedAt: now()
  });
  return {
    docs: resolvedDocs,
    reindexed: true,
    signature
  };
}

async function prepareProjectMemory(rootDir, projectKey, meta = {}, options = {}) {
  const paths = projectPaths(rootDir, projectKey);
  await ensureMemoryFiles(paths, meta);
  const docs = await listMemoryDocs(paths);
  let indexMeta = {
    docs,
    reindexed: false,
    signature: buildDocSignature(docs)
  };
  if (options.reindex !== false) {
    indexMeta = await reindexMemory(paths, docs);
  }
  return {
    ...paths,
    docs: indexMeta.docs || docs,
    indexSignature: indexMeta.signature,
    reindexed: Boolean(indexMeta.reindexed)
  };
}

async function buildRecentSummary(paths) {
  const sections = [];
  if (await fileExists(paths.memoryFile)) {
    sections.push(`## MEMORY.md\n${tailText(await readText(paths.memoryFile), 1500)}`);
  }
  if (await fileExists(paths.dailyFile)) {
    sections.push(`## ${path.basename(paths.dailyFile)}\n${tailText(await readText(paths.dailyFile), 1500)}`);
  }
  return sections.join('\n\n').trim();
}

function fallbackSearch(docs, query, limit) {
  const lowered = String(query || '').toLowerCase().trim();
  const scored = docs
    .map((doc) => {
      const haystack = `${doc.title}\n${doc.body}`.toLowerCase();
      const index = lowered ? haystack.indexOf(lowered) : -1;
      const score = index >= 0 ? index : Number.MAX_SAFE_INTEGER;
      return { doc, score };
    })
    .filter((item) => !lowered || item.score !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.doc.updatedAt < b.doc.updatedAt ? 1 : -1;
    })
    .slice(0, limit);

  return scored.map(({ doc }) => ({
    title: doc.title,
    kind: doc.kind,
    filePath: doc.filePath,
    updatedAt: doc.updatedAt,
    snippet: excerpt(doc.body, 260),
    rankingMeta: {
      source: 'doc',
      match: 'fallback'
    }
  }));
}

export function scoreArtifactRecord(record, searchContext, options = {}) {
  const queryTokens = Array.isArray(searchContext?.queryTokens) ? searchContext.queryTokens : [];
  const filesLikely = Array.isArray(searchContext?.filesLikely) ? searchContext.filesLikely : [];
  const relatedFiles = Array.isArray(searchContext?.relatedFiles) ? searchContext.relatedFiles : [];
  const symbolHints = Array.isArray(searchContext?.symbolHints) ? searchContext.symbolHints : [];
  const keywords = uniqueStrings(record.keywords).map((token) => token.toLowerCase());
  const recordSymbols = uniqueStrings(record.symbolHints).map((token) => token.toLowerCase());
  const graphSymbols = uniqueStrings(record.graphSymbols).map((token) => token.toLowerCase());
  const rootCauseVariants = variantEntriesFromRecord(record, 'rootCause', 'rootCauseVariants', 'rootCauseVariantCounts')
    .map((entry) => ({ ...entry, valueLower: String(entry.value || '').toLowerCase() }));
  const summaryVariants = variantEntriesFromRecord(record, 'summary', 'summaryVariants', 'summaryVariantCounts')
    .map((entry) => ({ ...entry, valueLower: String(entry.value || '').toLowerCase() }));
  const recordFiles = uniqueStrings([
    ...(record.filesLikely || []),
    ...(record.changedFiles || []),
    ...(record.outOfScopeFiles || [])
  ]).map(normalizePath);
  const haystack = [
    record.title,
    record.summary,
    record.graphSummary,
    record.rootCause,
    ...(record.summaryVariants || []),
    ...(record.rootCauseVariants || []),
    ...(record.acceptanceFailures || []),
    ...keywords,
    ...recordSymbols,
    ...graphSymbols,
    ...record.graphEdges || [],
    ...recordFiles
  ].join('\n').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (keywords.includes(token)) score += 18;
    if (haystack.includes(token)) score += 8;
    const rootCauseMatch = rootCauseVariants.find((entry) => entry.valueLower.includes(token));
    if (rootCauseMatch) score += Math.min(14, 6 + (rootCauseMatch.count * 2));
    const summaryMatch = summaryVariants.find((entry) => entry.valueLower.includes(token));
    if (summaryMatch) score += Math.min(10, 4 + (summaryMatch.count * 2));
  }
  if (options.taskId && String(record.taskId || '') === String(options.taskId || '')) score += 18;
  if (options.stage && String(record.stage || '') === String(options.stage || '')) score += 10;
  if (filesLikely.length && recordFiles.some((item) => filesLikely.includes(item))) score += 24;
  if (relatedFiles.length && recordFiles.some((item) => relatedFiles.includes(item))) score += 18;
  if (symbolHints.length && recordSymbols.some((item) => symbolHints.includes(item))) score += 16;
  if (symbolHints.length && graphSymbols.some((item) => symbolHints.includes(item))) score += 18;
  if (record.verificationOk === false) score += 12;
  if ((record.outOfScopeFiles || []).length) score += 10;
  if (String(record.decision || '') === 'retry') score += 8;
  if (String(record.decision || '') === 'failed') score += 10;
  score += Math.min(12, (recordOccurrenceCount(record) - 1) * 3);
  score += Math.round(recencyWeightForRecord(record, {
    halfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
    floor: MEMORY_RECENCY_FLOOR
  }) * 18);
  return score;
}

function scoreDocResult(result, searchContext, query) {
  const queryTokens = Array.isArray(searchContext?.queryTokens) ? searchContext.queryTokens : [];
  const relatedFiles = Array.isArray(searchContext?.relatedFiles) ? searchContext.relatedFiles : [];
  const symbolHints = Array.isArray(searchContext?.symbolHints) ? searchContext.symbolHints : [];
  const normalizedFilePath = normalizePath(result.filePath || '');
  const haystack = [
    result.title,
    result.kind,
    result.snippet,
    result.filePath
  ].join('\n').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (normalizedFilePath.includes(token)) score += 12;
    if (haystack.includes(token)) score += 6;
  }
  if (!queryTokens.length && !String(query || '').trim()) score += 6;
  if (relatedFiles.length && relatedFiles.includes(normalizedFilePath)) score += 20;
  if (symbolHints.length && symbolHints.some((token) => haystack.includes(token))) score += 10;
  if (result.kind === 'task-memory') score += 10;
  if (result.kind === 'run-memory') score += 6;
  if (result.rankingMeta?.match === 'fts') {
    score += Math.max(0, 24 - Math.round(Number(result.rankingMeta.score || 0) * 4));
  }
  score += Math.round(recencyWeight(timestampMs(result.updatedAt || ''), {
    halfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
    floor: MEMORY_RECENCY_FLOOR
  }) * 14);
  return score;
}

function artifactSemanticKey(record) {
  const normalizedFiles = uniqueStrings([
    ...(record.filesLikely || []),
    ...(record.changedFiles || []),
    ...(record.outOfScopeFiles || [])
  ]).map(normalizePath).sort().join('|');
  const acceptance = uniqueStrings(record.acceptanceFailures).map((item) => item.toLowerCase()).sort().join('|');
  const rootCause = cleanup(record.rootCause || '').toLowerCase();
  const summary = cleanup(record.summary || '').toLowerCase().slice(0, 120);
  return [
    record.taskId || '',
    record.kind || '',
    record.stage || '',
    record.decision || '',
    rootCause || summary,
    normalizedFiles,
    acceptance,
    uniqueStrings(record.graphEdges).slice(0, 3).join('|'),
    uniqueStrings(record.graphSymbols).slice(0, 4).join('|')
  ].join('::');
}

function recordOccurrenceCount(record) {
  return Math.max(1, Number(record?.occurrenceCount || 1));
}

function normalizeVariantText(value) {
  return cleanup(value || '');
}

function variantCountMapFromRecord(record, singleKey, listKey, countKey) {
  const counts = new Map();
  const rawCounts = record?.[countKey];
  const hasExplicitCounts = rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts);
  if (hasExplicitCounts) {
    for (const [key, value] of Object.entries(rawCounts)) {
      const normalizedKey = normalizeVariantText(key);
      const numericValue = Math.max(0, Number(value || 0));
      if (normalizedKey && numericValue > 0) counts.set(normalizedKey, numericValue);
    }
  }
  const primary = normalizeVariantText(record?.[singleKey] || '');
  if (primary) {
    counts.set(primary, Math.max(counts.get(primary) || 0, hasExplicitCounts ? 1 : recordOccurrenceCount(record)));
  }
  for (const value of Array.isArray(record?.[listKey]) ? record[listKey] : []) {
    const normalized = normalizeVariantText(value);
    if (!normalized) continue;
    counts.set(normalized, Math.max(counts.get(normalized) || 0, 1));
  }
  return counts;
}

function serializeVariantCountMap(countMap) {
  return Object.fromEntries(
    [...countMap.entries()]
      .filter(([key, value]) => key && Number(value || 0) > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function mergeVariantCounts(base, incoming, singleKey, listKey, countKey) {
  const merged = variantCountMapFromRecord(base, singleKey, listKey, countKey);
  for (const [key, value] of variantCountMapFromRecord(incoming, singleKey, listKey, countKey).entries()) {
    merged.set(key, (merged.get(key) || 0) + Number(value || 0));
  }
  return serializeVariantCountMap(merged);
}

function variantEntriesFromRecord(record, singleKey, listKey, countKey) {
  return Object.entries(serializeVariantCountMap(variantCountMapFromRecord(record, singleKey, listKey, countKey)))
    .map(([value, count]) => ({
      value,
      count: Math.max(1, Number(count || 0))
    }));
}

function mergeCompactedArtifactRecord(base, incoming) {
  const rootCauseVariantCounts = mergeVariantCounts(base, incoming, 'rootCause', 'rootCauseVariants', 'rootCauseVariantCounts');
  const summaryVariantCounts = mergeVariantCounts(base, incoming, 'summary', 'summaryVariants', 'summaryVariantCounts');
  return {
    ...base,
    filesLikely: uniqueStrings([...(base.filesLikely || []), ...(incoming.filesLikely || [])]),
    changedFiles: uniqueStrings([...(base.changedFiles || []), ...(incoming.changedFiles || [])]),
    outOfScopeFiles: uniqueStrings([...(base.outOfScopeFiles || []), ...(incoming.outOfScopeFiles || [])]),
    acceptanceFailures: uniqueStrings([...(base.acceptanceFailures || []), ...(incoming.acceptanceFailures || [])]),
    symbolHints: uniqueStrings([...(base.symbolHints || []), ...(incoming.symbolHints || [])]),
    graphEdges: uniqueStrings([...(base.graphEdges || []), ...(incoming.graphEdges || [])]),
    graphSymbols: uniqueStrings([...(base.graphSymbols || []), ...(incoming.graphSymbols || [])]),
    keywords: uniqueStrings([...(base.keywords || []), ...(incoming.keywords || [])]),
    occurrenceCount: recordOccurrenceCount(base) + recordOccurrenceCount(incoming),
    rootCauseVariants: Object.keys(rootCauseVariantCounts),
    rootCauseVariantCounts,
    summaryVariants: Object.keys(summaryVariantCounts),
    summaryVariantCounts,
    createdAtHistory: uniqueStrings([...(base.createdAtHistory || []), base.createdAt || '', ...(incoming.createdAtHistory || []), incoming.createdAt || '']).sort()
  };
}

function buildGraphMemory(taskCodeContext = null) {
  const relatedFiles = Array.isArray(taskCodeContext?.relatedFiles) ? taskCodeContext.relatedFiles : [];
  const graphEdges = uniqueStrings(
    relatedFiles.flatMap((entry) => (Array.isArray(entry?.codeGraph?.imports) ? entry.codeGraph.imports : []).map((link) => {
      const source = String(entry?.path || '').trim();
      const target = String(link?.target || '').trim();
      const imported = Array.isArray(link?.importedSymbols) && link.importedSymbols.length
        ? `#${link.importedSymbols.join(',')}`
        : '';
      return source && target ? `${source}->${target}${imported}` : '';
    }))
  ).filter(Boolean).slice(0, 12);
  const graphSymbols = uniqueStrings([
    ...(Array.isArray(taskCodeContext?.symbolHints) ? taskCodeContext.symbolHints : []),
    ...relatedFiles.flatMap((entry) => entry?.codeGraph?.exports || []),
    ...relatedFiles.flatMap((entry) => entry?.codeGraph?.declarations || []),
    ...relatedFiles.flatMap((entry) => entry?.codeGraph?.importedSymbols || [])
  ]).filter(Boolean).slice(0, 24);
  return {
    graphSummary: String(taskCodeContext?.summary || '').trim(),
    graphEdges,
    graphSymbols
  };
}

function parseGraphEdgeToken(edge = '') {
  const raw = String(edge || '').trim();
  if (!raw.includes('->')) return null;
  const [sourcePart, restPart] = raw.split('->');
  const [targetPart, symbolPart = ''] = String(restPart || '').split('#');
  const source = String(sourcePart || '').trim();
  const target = String(targetPart || '').trim();
  if (!source || !target) return null;
  const importedSymbols = String(symbolPart || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    source,
    target,
    importedSymbols
  };
}

export function buildPropagatedGraphInsights(edgeCounts = new Map()) {
  const adjacency = new Map();
  const nodeWeights = new Map();
  for (const [edge, stats] of edgeCounts.entries()) {
    const parsed = parseGraphEdgeToken(edge);
    if (!parsed) continue;
    const edgeWeight = Number(stats?.weight || 0);
    if (!adjacency.has(parsed.source)) adjacency.set(parsed.source, []);
    adjacency.get(parsed.source).push({
      ...parsed,
      weight: edgeWeight
    });
    addWeightedCount(nodeWeights, parsed.source, edgeWeight);
    addWeightedCount(nodeWeights, parsed.target, edgeWeight);
  }
  const propagatedPathCounts = new Map();
  const propagatedSymbolCounts = new Map();
  const propagatedNodeCounts = new Map();
  const damping = Number(GRAPH_INTELLIGENCE_DEFAULTS?.propagation?.damping || 0.62);
  const maxDepth = Math.max(1, Number(GRAPH_INTELLIGENCE_DEFAULTS?.propagation?.maxDepth || 3) || 3);

  for (const [startNode, edges] of adjacency.entries()) {
    for (const edge of edges) {
      const stack = [{
        current: edge.target,
        score: Number(edge.weight || 0),
        path: [startNode, edge.target],
        importedSymbols: edge.importedSymbols || [],
        depth: 1
      }];
      while (stack.length) {
        const current = stack.pop();
        if (!current || current.score <= 0) continue;
        const pathKey = current.path.join(' -> ');
        addWeightedCount(propagatedPathCounts, pathKey, current.score);
        addWeightedCount(propagatedNodeCounts, current.current, current.score);
        for (const symbol of current.importedSymbols || []) {
          addWeightedCount(propagatedSymbolCounts, symbol, current.score);
        }
        if (current.depth >= maxDepth) continue;
        const nextEdges = adjacency.get(current.current) || [];
        for (const nextEdge of nextEdges) {
          if (current.path.includes(nextEdge.target)) continue;
          stack.push({
            current: nextEdge.target,
            score: current.score * Number(nextEdge.weight || 0) * damping,
            path: [...current.path, nextEdge.target],
            importedSymbols: nextEdge.importedSymbols || [],
            depth: current.depth + 1
          });
        }
      }
    }
  }

  return {
    nodeCount: nodeWeights.size,
    edgeCount: edgeCounts.size,
    propagation: { damping, maxDepth },
    topPaths: topWeightedEntries(propagatedPathCounts, 'path', 4),
    propagatedFiles: topWeightedEntries(propagatedNodeCounts, 'filePath', 4),
    propagatedSymbols: topWeightedEntries(propagatedSymbolCounts, 'symbol', 6)
  };
}

function buildGraphInsights(records = []) {
  const recent = [...(Array.isArray(records) ? records : [])]
    .sort((left, right) => timestampMs(right.createdAt || right.updatedAt || '') - timestampMs(left.createdAt || left.updatedAt || ''))
    .slice(0, 40);
  const edgeCounts = new Map();
  const symbolCounts = new Map();
  for (const record of recent) {
    const weight = recencyWeightForRecord(record, {
      halfLifeDays: GRAPH_RECENCY_HALF_LIFE_DAYS,
      floor: 0.12
    });
    const weightedOccurrence = weight * recordOccurrenceCount(record);
    for (const edge of record.graphEdges || []) {
      addWeightedCount(edgeCounts, edge, weightedOccurrence);
    }
    for (const symbol of record.graphSymbols || []) {
      addWeightedCount(symbolCounts, symbol, weightedOccurrence);
    }
  }
  const propagated = buildPropagatedGraphInsights(edgeCounts);
  return {
    decayHalfLifeDays: GRAPH_RECENCY_HALF_LIFE_DAYS,
    propagation: propagated.propagation,
    topEdges: topWeightedEntries(edgeCounts, 'edge', 6),
    topSymbols: topWeightedEntries(symbolCounts, 'symbol', 8),
    nodeCount: propagated.nodeCount,
    edgeCount: propagated.edgeCount,
    topPaths: propagated.topPaths,
    propagatedFiles: propagated.propagatedFiles,
    propagatedSymbols: propagated.propagatedSymbols
  };
}

function rootCauseAnalyticsEntries(record) {
  const entries = variantEntriesFromRecord(record, 'rootCause', 'rootCauseVariants', 'rootCauseVariantCounts');
  const hasExplicitRootCauseCounts = record?.rootCauseVariantCounts && typeof record.rootCauseVariantCounts === 'object' && !Array.isArray(record.rootCauseVariantCounts);
  return entries.map((entry) => ({
    ...entry,
    boostedCount: !hasExplicitRootCauseCounts && entries.length > 1
      ? Math.max(entry.count, recordOccurrenceCount(record))
      : entry.count
  }));
}

function buildTemporalInsights(records = []) {
  const source = Array.isArray(records) ? records : [];
  const decisionCounts = new Map();
  const fileCounts = new Map();
  const rootCauseCounts = new Map();
  const recentWindowDays = 14;
  const recentCutoff = Date.now() - (recentWindowDays * 24 * 60 * 60 * 1000);
  let recentWeight = 0;
  let totalWeight = 0;
  let newestArtifactAt = '';

  for (const record of source) {
    const createdAtMs = timestampMs(record.createdAt || record.updatedAt || '');
    const weight = recencyWeight(createdAtMs, {
      halfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
      floor: MEMORY_RECENCY_FLOOR
    });
    const weightedOccurrence = weight * recordOccurrenceCount(record);
    totalWeight += weightedOccurrence;
    if (createdAtMs >= recentCutoff) recentWeight += weightedOccurrence;
    if (!newestArtifactAt || createdAtMs > timestampMs(newestArtifactAt)) {
      newestArtifactAt = record.createdAt || record.updatedAt || newestArtifactAt;
    }
    addWeightedCount(decisionCounts, record.decision || 'unknown', weightedOccurrence);
    for (const filePath of [...(record.changedFiles || []), ...(record.outOfScopeFiles || []), ...(record.filesLikely || [])]) {
      addWeightedCount(fileCounts, filePath, weightedOccurrence);
    }
    for (const entry of rootCauseAnalyticsEntries(record)) {
      addWeightedCount(rootCauseCounts, entry.value, weightedOccurrence * entry.boostedCount);
    }
  }

  return {
    decayHalfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
    recentWindowDays,
    recentShare: totalWeight ? Number((recentWeight / totalWeight).toFixed(3)) : 0,
    newestArtifactAt,
    activeDecisions: topWeightedEntries(decisionCounts, 'decision', 4),
    activeFiles: topWeightedEntries(fileCounts, 'filePath', 4),
    activeRootCauses: topWeightedEntries(rootCauseCounts, 'reason', 4)
  };
}

function compactArtifactRecords(records) {
  const sorted = [...records].sort((left, right) => (Date.parse(right.createdAt || right.updatedAt || '') || 0) - (Date.parse(left.createdAt || left.updatedAt || '') || 0));
  const deduped = [];
  const seen = new Map();
  for (const record of sorted) {
    const semanticKey = artifactSemanticKey(record);
    if (!semanticKey) continue;
    const existingIndex = seen.get(semanticKey);
    if (existingIndex != null) {
      deduped[existingIndex] = mergeCompactedArtifactRecord(deduped[existingIndex], record);
      continue;
    }
    const compacted = {
      ...record,
      schemaVersion: String(record.schemaVersion || '2'),
      compactionKey: semanticKey,
      occurrenceCount: recordOccurrenceCount(record),
      rootCauseVariants: uniqueStrings([
        record.rootCause || '',
        ...variantEntriesFromRecord(record, 'rootCause', 'rootCauseVariants', 'rootCauseVariantCounts').map((entry) => entry.value)
      ]),
      rootCauseVariantCounts: serializeVariantCountMap(variantCountMapFromRecord(record, 'rootCause', 'rootCauseVariants', 'rootCauseVariantCounts')),
      summaryVariants: uniqueStrings([record.summary || '']),
      summaryVariantCounts: serializeVariantCountMap(variantCountMapFromRecord(record, 'summary', 'summaryVariants', 'summaryVariantCounts')),
      createdAtHistory: uniqueStrings([record.createdAt || '']).sort()
    };
    seen.set(semanticKey, deduped.length);
    deduped.push(compacted);
  }
  deduped.sort((left, right) => (Date.parse(left.createdAt || left.updatedAt || '') || 0) - (Date.parse(right.createdAt || right.updatedAt || '') || 0));
  return {
    records: deduped,
    originalCount: records.length,
    compactedCount: deduped.length,
    removedCount: Math.max(0, records.length - deduped.length)
  };
}

async function searchArtifactRecords(paths, query, limit, options = {}, records = null) {
  const sourceRecords = Array.isArray(records) ? records : await readJsonLines(paths.artifactIndexFile);
  const searchContext = buildSearchContext(query, options);
  const normalizedLimit = Math.max(1, Number(limit || 5));
  const filtered = sourceRecords
    .map((record) => ({
      record,
      score: scoreArtifactRecord(record, searchContext, options)
    }))
    .filter(({ record, score }) => {
      if (!searchContext.queryTokens.length) return true;
      if (score > 0) return true;
      const haystack = [
        record.title,
        record.summary,
        record.graphSummary,
        record.rootCause,
        ...(record.rootCauseVariants || []),
        ...(record.summaryVariants || []),
        ...(record.acceptanceFailures || []),
        ...(record.symbolHints || []),
        ...(record.graphSymbols || []),
        ...(record.graphEdges || [])
      ].join('\n').toLowerCase();
      return searchContext.queryTokens.some((token) => haystack.includes(token));
    })
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const leftAt = Date.parse(left.record.createdAt || '') || 0;
      const rightAt = Date.parse(right.record.createdAt || '') || 0;
      return rightAt - leftAt;
    })
    .slice(0, normalizedLimit);

  return filtered.map(({ record, score }) => ({
    title: record.title || `Artifact ${record.artifactId}`,
    kind: 'artifact-record',
    filePath: record.sourcePath || paths.artifactIndexFile,
    updatedAt: record.createdAt || now(),
    snippet: excerpt([
      record.summary,
      record.graphSummary,
      record.rootCause,
      ...(record.rootCauseVariants || []).slice(1, 3),
      ...(record.summaryVariants || []).slice(1, 2),
      ...(record.acceptanceFailures || []),
      ...(record.outOfScopeFiles || []),
      ...(record.graphEdges || []).slice(0, 2)
    ].filter(Boolean).join(' | '), 260),
    taskId: record.taskId,
    stage: record.stage,
    decision: record.decision,
    filesLikely: uniqueStrings(record.filesLikely),
    rankingMeta: {
      source: 'artifact-record',
      score,
      recencyWeight: recencyWeightForRecord(record),
      occurrenceCount: recordOccurrenceCount(record),
      verificationOk: record.verificationOk !== false,
      matchedFiles: uniqueStrings(record.filesLikely).slice(0, 4),
      matchedSymbols: uniqueStrings([...(record.symbolHints || []), ...(record.graphSymbols || [])]).slice(0, 4),
      graphEdges: uniqueStrings(record.graphEdges).slice(0, 3)
    }
  }));
}

function buildFailureAnalytics(records) {
  const retryRecords = records.filter((record) => String(record.decision || '') === 'retry');
  const failedVerification = records.filter((record) => record.verificationOk === false);
  const scopeDrift = records.filter((record) => Array.isArray(record.outOfScopeFiles) && record.outOfScopeFiles.length > 0);
  const acceptanceCounts = new Map();
  const fileCounts = new Map();
  const rootCauseCounts = new Map();
  const stageCounts = new Map();
  const recentCutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const recentRecords = records.filter((record) => (Date.parse(record.createdAt || record.updatedAt || '') || 0) >= recentCutoff);

  for (const record of records) {
    const weight = recencyWeightForRecord(record, {
      halfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
      floor: MEMORY_RECENCY_FLOOR
    });
    const weightedOccurrence = weight * recordOccurrenceCount(record);
    for (const check of record.acceptanceFailures || []) {
      addWeightedCount(acceptanceCounts, check, weightedOccurrence);
    }
    for (const filePath of [...(record.outOfScopeFiles || []), ...(record.changedFiles || [])]) {
      addWeightedCount(fileCounts, filePath, weightedOccurrence);
    }
    for (const entry of rootCauseAnalyticsEntries(record)) {
      addWeightedCount(rootCauseCounts, entry.value, weightedOccurrence * entry.boostedCount);
    }
    addWeightedCount(stageCounts, record.stage || 'unknown', weightedOccurrence);
  }

  const recentFailure = [...records]
    .filter((record) => String(record.decision || '') === 'retry' || record.verificationOk === false || (record.outOfScopeFiles || []).length)
    .sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0))[0] || null;
  const totalArtifacts = records.reduce((sum, record) => sum + recordOccurrenceCount(record), 0);
  const retryCount = retryRecords.reduce((sum, record) => sum + recordOccurrenceCount(record), 0);
  const verificationFailures = failedVerification.reduce((sum, record) => sum + recordOccurrenceCount(record), 0);
  const scopeDriftCount = scopeDrift.reduce((sum, record) => sum + recordOccurrenceCount(record), 0);

  return {
    totalArtifacts,
    retryCount,
    verificationFailures,
    scopeDriftCount,
    decayHalfLifeDays: MEMORY_RECENCY_HALF_LIFE_DAYS,
    retryPressure: Number(retryRecords.reduce((sum, record) => sum + (recencyWeightForRecord(record) * recordOccurrenceCount(record)), 0).toFixed(3)),
    verificationPressure: Number(failedVerification.reduce((sum, record) => sum + (recencyWeightForRecord(record) * recordOccurrenceCount(record)), 0).toFixed(3)),
    scopeDriftPressure: Number(scopeDrift.reduce((sum, record) => sum + (recencyWeightForRecord(record) * recordOccurrenceCount(record)), 0).toFixed(3)),
    topAcceptanceFailures: topWeightedEntries(acceptanceCounts, 'check', 4),
    topFailureFiles: topWeightedEntries(fileCounts, 'filePath', 4),
    topRootCauses: topWeightedEntries(rootCauseCounts, 'reason', 4),
    stageFailures: topWeightedEntries(stageCounts, 'stage', 4),
    longHorizon: {
      windowDays: 14,
      totalFailures: retryCount + verificationFailures + scopeDriftCount,
      retryRate: totalArtifacts ? Number((retryCount / totalArtifacts).toFixed(3)) : 0,
      recentFailures: recentRecords
        .filter((record) => String(record.decision || '') === 'retry' || record.verificationOk === false || (record.outOfScopeFiles || []).length)
        .reduce((sum, record) => sum + recordOccurrenceCount(record), 0),
      recentFailurePressure: Number(recentRecords
        .filter((record) => String(record.decision || '') === 'retry' || record.verificationOk === false || (record.outOfScopeFiles || []).length)
        .reduce((sum, record) => sum + (recencyWeightForRecord(record) * recordOccurrenceCount(record)), 0)
        .toFixed(3))
    },
    recentFailure: recentFailure
      ? {
          taskId: recentFailure.taskId || '',
          decision: recentFailure.decision || '',
          rootCause: recentFailure.rootCause || '',
          createdAt: recentFailure.createdAt || ''
        }
      : null
  };
}

function buildTraceSummary(records) {
  const taskIds = new Set(records.map((record) => String(record.taskId || '')).filter(Boolean));
  const stageCounts = new Map();
  const decisionCounts = new Map();
  for (const record of records) {
    const occurrenceCount = recordOccurrenceCount(record);
    stageCounts.set(record.stage || 'unknown', (stageCounts.get(record.stage || 'unknown') || 0) + occurrenceCount);
    decisionCounts.set(record.decision || 'unknown', (decisionCounts.get(record.decision || 'unknown') || 0) + occurrenceCount);
  }
  const latest = [...records]
    .sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0))[0] || null;
  return {
    artifactCount: records.reduce((sum, record) => sum + recordOccurrenceCount(record), 0),
    taskCount: taskIds.size,
    stageCounts: [...stageCounts.entries()].map(([stage, count]) => ({ stage, count })),
    decisionCounts: [...decisionCounts.entries()].map(([decision, count]) => ({ decision, count })),
    lastDecision: latest?.decision || '',
    lastTaskId: latest?.taskId || '',
    lastUpdatedAt: latest?.createdAt || ''
  };
}

export async function ensureProjectMemory(rootDir, projectKey, meta = {}) {
  const paths = await prepareProjectMemory(rootDir, projectKey, meta, { reindex: true });
  return {
    ...paths,
    recentSummary: await buildRecentSummary(paths),
    searchResults: [],
    searchQuery: '',
    retrievedContext: '',
    searchBackend: DatabaseSync ? 'sqlite-fts' : 'file-scan',
    failureAnalytics: buildFailureAnalytics([]),
    traceSummary: buildTraceSummary([]),
    graphInsights: buildGraphInsights([]),
    temporalInsights: buildTemporalInsights([]),
    compaction: {
      originalCount: 0,
      compactedCount: 0,
      removedCount: 0
    }
  };
}

export async function searchProjectMemory(rootDir, projectKey, query, limit = 5, meta = {}, options = {}) {
  const paths = await prepareProjectMemory(rootDir, projectKey, meta, {
    reindex: options.reindex !== false
  });
  const docs = Array.isArray(paths.docs) ? paths.docs : await listMemoryDocs(paths);
  const normalizedLimit = Math.max(1, Number(limit || 5));
  const ftsQuery = toFtsQuery(query);

  let docResults;
  if (DatabaseSync && ftsQuery) {
    try {
      const db = new DatabaseSync(paths.indexFile);
      const rows = db.prepare(`
        SELECT
          memory_docs.title AS title,
          memory_docs.kind AS kind,
          memory_docs.file_path AS file_path,
          memory_docs.updated_at AS updated_at,
          snippet(memory_fts, 2, '<<', '>>', ' ... ', 18) AS snippet,
          bm25(memory_fts, 8.0, 2.0, 1.0) AS score
        FROM memory_fts
        JOIN memory_docs ON memory_docs.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
        ORDER BY score ASC, memory_docs.updated_at DESC
        LIMIT ?
      `).all(ftsQuery, normalizedLimit);
      db.close();
      docResults = rows.map((row) => ({
        title: row.title,
        kind: row.kind,
        filePath: row.file_path,
        updatedAt: row.updated_at,
        snippet: cleanup(String(row.snippet || '')).replace(/<<|>>/g, ''),
        rankingMeta: {
          source: 'doc',
          match: 'fts',
          score: Number(row.score || 0)
        }
      }));
    } catch {
      docResults = fallbackSearch(docs, query, normalizedLimit);
    }
  } else {
    docResults = fallbackSearch(docs, query, normalizedLimit);
  }

  if (!query && docResults.length === 0) {
    docResults = docs
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, normalizedLimit)
      .map((doc) => ({
        title: doc.title,
        kind: doc.kind,
        filePath: doc.filePath,
        updatedAt: doc.updatedAt,
        snippet: excerpt(doc.body, 260),
        rankingMeta: {
          source: 'doc',
          match: 'recent'
        }
      }));
  }

  const rawArtifactRecords = await readJsonLines(paths.artifactIndexFile);
  const compaction = compactArtifactRecords(rawArtifactRecords);
  const artifactResults = await searchArtifactRecords(paths, query, normalizedLimit * 3, options, compaction.records);
  const searchContext = buildSearchContext(query, options);
  const results = [...artifactResults, ...docResults
    .map((result) => ({
      ...result,
      rankingMeta: {
        ...result.rankingMeta,
        score: scoreDocResult(result, searchContext, query)
      }
    }))]
    .filter((result) => Number(result.rankingMeta?.score || 0) > 0 || !String(query || '').trim())
    .sort((left, right) => {
      const leftScore = Number(left.rankingMeta?.score || 0);
      const rightScore = Number(right.rankingMeta?.score || 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return (Date.parse(right.updatedAt || '') || 0) - (Date.parse(left.updatedAt || '') || 0);
    })
    .filter((result, index, items) => index === items.findIndex((candidate) =>
      candidate.kind === result.kind && candidate.title === result.title && candidate.filePath === result.filePath
    ))
    .slice(0, normalizedLimit);

  const retrievedContext = results.length
    ? results.map((result) => `- [${result.kind}] ${result.title}\n  source: ${result.filePath}\n  note: ${result.snippet}`).join('\n')
    : 'No relevant project memory found.';

  return {
    ...paths,
    recentSummary: await buildRecentSummary(paths),
    searchQuery: String(query || '').trim(),
    searchResults: results,
    retrievedContext,
    searchBackend: DatabaseSync ? 'sqlite-fts+artifact-index' : 'file-scan+artifact-index',
    failureAnalytics: buildFailureAnalytics(compaction.records),
    traceSummary: buildTraceSummary(compaction.records),
    graphInsights: buildGraphInsights(compaction.records),
    temporalInsights: buildTemporalInsights(compaction.records),
    compaction
  };
}

export async function appendClarifyMemory(rootDir, run) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-clarify', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
    const lines = [
      `## ${run.updatedAt} | Clarify | ${run.id}`,
      '',
      `- Title: ${run.title}`,
      `- Preset: ${run.preset?.name || 'Auto'}`,
      `- Objective: ${run.input.objective || '-'}`,
      `- Clarified objective: ${run.clarify?.clarifiedObjective || '-'}`,
      `- Scope: ${run.clarify?.scopeSummary || '-'}`,
      `- Pattern: ${run.clarify?.architecturePattern || '-'}`,
      ''
    ];

    if (Array.isArray(run.clarify?.assumptions) && run.clarify.assumptions.length) {
      lines.push('### Assumptions', '');
      for (const item of run.clarify.assumptions) lines.push(`- ${item}`);
      lines.push('');
    }
    const openQuestions = openQuestionText(run.clarify?.openQuestions);
    if (openQuestions.length) {
      lines.push('### Open Questions', '');
      for (const item of openQuestions) lines.push(`- ${item}`);
      lines.push('');
    }

    await appendSection(paths.dailyFile, lines);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, run.clarify?.clarifiedObjective || run.input.objective || '', 5, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendGoalJudgeMemory(rootDir, run) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-goal-judge', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
    const lines = [
      `## ${run.updatedAt} | Goal Judge | ${run.id}`,
      '',
      `- Goal achieved: ${run.result?.goalAchieved ? 'yes' : 'no'}`,
      `- Summary: ${run.result?.summary || '-'}`,
      `- Goal loops: ${run.goalLoops || 0}`,
      ''
    ];
    if (Array.isArray(run.result?.findings) && run.result.findings.length) {
      lines.push('### Findings', '');
      for (const item of run.result.findings) lines.push(`- ${item}`);
      lines.push('');
    }
    const pending = (run.tasks || []).filter((task) => task.status !== 'done');
    if (pending.length) {
      lines.push('### Pending Tasks', '');
      for (const task of pending) {
        lines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.goal}`);
      }
      lines.push('');
    }

    await appendSection(paths.dailyFile, lines);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, run.result?.summary || run.clarify?.clarifiedObjective || '', 5, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendCheckpointMemory(rootDir, run, checkpoint) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-checkpoint', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
    const lines = [
      `## ${run.updatedAt} | Run Checkpoint | ${run.id}`,
      '',
      `- Trigger: ${checkpoint.trigger || '-'}`,
      `- Status: ${checkpoint.status || '-'}`,
      `- Objective: ${checkpoint.objective || '-'}`,
      `- Next action: ${checkpoint.nextAction || '-'}`,
      `- Result summary: ${checkpoint.resultSummary || checkpoint.planSummary || '-'}`,
      ''
    ];
    if (Array.isArray(checkpoint.pendingTasks) && checkpoint.pendingTasks.length) {
      lines.push('### Pending Tasks', '');
      for (const task of checkpoint.pendingTasks) {
        lines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.reviewSummary || task.goal || '-'}`);
      }
      lines.push('');
    }
    if (Array.isArray(checkpoint.suggestedBacklogChanges) && checkpoint.suggestedBacklogChanges.length) {
      lines.push('### Suggested Backlog Changes', '');
      for (const item of checkpoint.suggestedBacklogChanges) {
        lines.push(`- ${item.kind}: ${item.summary}`);
      }
      lines.push('');
    }
    if (Array.isArray(checkpoint.openQuestions) && checkpoint.openQuestions.length) {
      lines.push('### Open Questions', '');
      for (const item of checkpoint.openQuestions) lines.push(`- ${item}`);
      lines.push('');
    }
    await appendSection(paths.dailyFile, lines);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, checkpoint.nextAction || checkpoint.objective || run.title || '', 5, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendCompletionMemory(rootDir, run) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-completion', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });

    const dailyLines = [
      `## ${run.updatedAt} | Run Complete | ${run.id}`,
      '',
      `- Title: ${run.title}`,
      `- Status: ${run.status}`,
      `- Pattern: ${run.clarify?.architecturePattern || '-'}`,
      `- Summary: ${run.result?.summary || run.planSummary || '-'}`,
      ''
    ];
    if (Array.isArray(run.tasks) && run.tasks.length) {
      dailyLines.push('### Task Ledger', '');
      for (const task of run.tasks) {
        dailyLines.push(`- ${task.id} [${task.status}] ${task.title}: ${task.reviewSummary || task.goal}`);
      }
      dailyLines.push('');
    }
    await appendSection(paths.dailyFile, dailyLines);

    const memoryLines = [
      `## ${run.updatedAt} | ${run.title}`,
      '',
      `- Status: ${run.status}`,
      `- Objective: ${run.clarify?.clarifiedObjective || run.input.objective || '-'}`,
      `- Pattern: ${run.clarify?.architecturePattern || '-'}`,
      `- Goal summary: ${run.result?.summary || run.planSummary || '-'}`,
      ''
    ];
    if (Array.isArray(run.result?.findings) && run.result.findings.length) {
      memoryLines.push('### Durable Findings', '');
      for (const item of run.result.findings) memoryLines.push(`- ${item}`);
      memoryLines.push('');
    }
    if (Array.isArray(run.clarify?.assumptions) && run.clarify.assumptions.length) {
      memoryLines.push('### Stable Assumptions', '');
      for (const item of run.clarify.assumptions) memoryLines.push(`- ${item}`);
      memoryLines.push('');
    }

    await appendSection(paths.memoryFile, memoryLines);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, run.result?.summary || run.clarify?.clarifiedObjective || '', 5, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendTaskReviewMemory(rootDir, run, task) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-task-review', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
    const lines = [
      `## ${run.updatedAt} | Task Review | ${run.id} | ${task.id}`,
      '',
      `- Task: ${task.title}`,
      `- Status: ${task.status}`,
      `- Review: ${task.reviewSummary || '-'}`,
      `- Workspace: ${task.lastExecution?.workspaceMode || '-'}`,
      `- Changed files: ${(task.lastExecution?.changedFiles || []).join(', ') || '-'}`,
      `- Repo changed files: ${(task.lastExecution?.repoChangedFiles || []).join(', ') || '-'}`,
      `- Out-of-scope files: ${(task.lastExecution?.outOfScopeFiles || []).join(', ') || '-'}`,
      ''
    ];
    if (Array.isArray(task.findings) && task.findings.length) {
      lines.push('### Findings', '');
      for (const item of task.findings) lines.push(`- ${item}`);
      lines.push('');
    }
    await appendSection(paths.dailyFile, lines);

    if (task.status === 'failed' || (task.lastExecution?.outOfScopeFiles || []).length) {
      const durable = [
        `## ${run.updatedAt} | Task Risk | ${task.id}`,
        '',
        `- Title: ${task.title}`,
        `- Review: ${task.reviewSummary || '-'}`,
        `- Out-of-scope files: ${(task.lastExecution?.outOfScopeFiles || []).join(', ') || '-'}`,
        ''
      ];
      if (Array.isArray(task.findings) && task.findings.length) {
        durable.push('### Findings', '');
        for (const item of task.findings) durable.push(`- ${item}`);
        durable.push('');
      }
      await appendSection(paths.memoryFile, durable);
    }

    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, task.reviewSummary || task.goal || '', 5, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendArtifactMemory(rootDir, run, task) {
  return writeProjectMemory(rootDir, run.memory.projectKey, 'memory.append-artifact', async () => {
    const paths = await prepareProjectMemory(rootDir, run.memory.projectKey, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });

    const artifactEntries = await buildArtifactEntries(rootDir, run, task);
    const taskCodeContext = await readOptionalJson(taskCodeContextArtifactPath(rootDir, run.id, task.id)) || null;
    const graphMemory = buildGraphMemory(taskCodeContext);
    const symbolHints = uniqueStrings([
      ...(Array.isArray(taskCodeContext?.symbolHints) ? taskCodeContext.symbolHints : []),
      ...((Array.isArray(taskCodeContext?.relatedFiles) ? taskCodeContext.relatedFiles : []).flatMap((entry) => Array.isArray(entry?.symbols) ? entry.symbols : []))
    ]).slice(0, 12);
    const manifestFile = artifactManifestPath(rootDir, run.id);
    await ensureDir(path.dirname(manifestFile));
    const existingManifest = await readOptionalJson(manifestFile) || {
      schemaVersion: '1',
      runId: run.id,
      projectKey: run.memory.projectKey,
      generatedAt: now(),
      entries: []
    };
    const manifestMap = new Map(
      (Array.isArray(existingManifest.entries) ? existingManifest.entries : [])
        .map((entry) => [String(entry.artifactId || ''), entry])
        .filter(([key]) => key)
    );
    for (const entry of artifactEntries) {
      manifestMap.set(entry.artifactId, {
        artifactId: entry.artifactId,
        kind: entry.kind,
        scope: entry.scope,
        taskId: entry.taskId,
        stage: entry.stage,
        filePath: entry.filePath,
        filesLikely: entry.filesLikely,
        status: entry.status,
        note: entry.note
      });
    }
    await fs.writeFile(manifestFile, JSON.stringify({
      schemaVersion: '1',
      runId: run.id,
      projectKey: run.memory.projectKey,
      generatedAt: now(),
      entries: [...manifestMap.values()]
    }, null, 2), 'utf8');

    const existingRecords = await readJsonLines(paths.artifactIndexFile);
    const recordMap = new Map(existingRecords.map((record) => [String(record.artifactId || ''), record]));
    for (const entry of artifactEntries) {
      recordMap.set(entry.artifactId, {
        schemaVersion: '2',
        artifactId: entry.artifactId,
        projectKey: entry.projectKey,
        runId: entry.runId,
        taskId: entry.taskId,
        kind: entry.kind,
        stage: entry.stage,
        title: entry.title,
        summary: entry.summary,
        keywords: entry.keywords,
        filesLikely: entry.filesLikely,
        decision: entry.decision,
        verificationOk: entry.verificationOk,
        rootCause: entry.rootCause,
        taskTitle: entry.taskTitle,
        taskStatus: entry.taskStatus,
        changedFiles: entry.changedFiles,
        outOfScopeFiles: entry.outOfScopeFiles,
        acceptanceFailures: entry.acceptanceFailures,
        sourcePath: entry.sourcePath,
        createdAt: entry.createdAt,
        symbolHints,
        graphSummary: graphMemory.graphSummary,
        graphEdges: graphMemory.graphEdges,
        graphSymbols: graphMemory.graphSymbols
      });
    }
    const compaction = compactArtifactRecords([...recordMap.values()]);
    await writeJsonLines(paths.artifactIndexFile, compaction.records);
    await writeRunMemoryDoc(paths, run);
    await writeTaskMemoryDoc(paths, run, task, artifactEntries);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, run.memory.projectKey, task.reviewSummary || task.goal || task.title || '', 6, {
      projectPath: run.projectPath
    }, {
      reindex: false
    });
  });
}

export async function appendProjectQualitySweepMemory(rootDir, project, sweep) {
  return writeProjectMemory(rootDir, project.sharedMemoryKey, 'memory.append-project-quality-sweep', async () => {
    const paths = await prepareProjectMemory(rootDir, project.sharedMemoryKey, {
      projectPath: project.rootPath
    }, {
      reindex: false
    });

    const dailyLines = [
      `## ${sweep.createdAt} | Quality Sweep | ${project.id}`,
      '',
      `- Phase: ${sweep.phaseTitle || sweep.phaseId || '-'}`,
      `- Grade: ${sweep.grade || '-'}`,
      `- Summary: ${sweep.summary || '-'}`,
      `- Artifact: ${sweep.artifactPath || '-'}`,
      ''
    ];
    if (Array.isArray(sweep.findings) && sweep.findings.length) {
      dailyLines.push('### Findings', '');
      for (const finding of sweep.findings) {
        dailyLines.push(`- ${finding.category} [${finding.severity}]: ${finding.summary}`);
      }
      dailyLines.push('');
    }
    await appendSection(paths.dailyFile, dailyLines);

    const durableLines = [
      `## ${sweep.createdAt} | Quality Sweep`,
      '',
      `- Project: ${project.title || project.id}`,
      `- Phase: ${sweep.phaseTitle || sweep.phaseId || '-'}`,
      `- Grade: ${sweep.grade || '-'}`,
      `- Summary: ${sweep.summary || '-'}`,
      ''
    ];
    if (Array.isArray(sweep.recommendedActions) && sweep.recommendedActions.length) {
      durableLines.push('### Recommended Actions', '');
      for (const item of sweep.recommendedActions) durableLines.push(`- ${item}`);
      durableLines.push('');
    }
    if (Array.isArray(sweep.findings) && sweep.findings.length) {
      durableLines.push('### Finding Classes', '');
      for (const finding of sweep.findings) {
        durableLines.push(`- ${finding.category} [${finding.severity}]`);
      }
      durableLines.push('');
    }
    await appendSection(paths.memoryFile, durableLines);
    await reindexMemory(paths);
    return searchProjectMemory(rootDir, project.sharedMemoryKey, sweep.summary || 'quality sweep', 5, {
      projectPath: project.rootPath
    }, {
      reindex: false
    });
  });
}
