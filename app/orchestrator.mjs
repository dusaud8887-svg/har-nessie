import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  GLOBAL_AGENTS_FILE,
  HARNESS_META_DIR,
  HARNESS_SETTINGS_FILE,
  KARPATHY_SKILL_FILE,
  MEMORY_DIR,
  PROJECTS_DIR,
  ROOT_DIR,
  RUNS_DIR
} from './harness-paths.mjs';
import {
  appendArtifactMemory,
  appendCheckpointMemory,
  appendClarifyMemory,
  appendCompletionMemory,
  appendGoalJudgeMemory,
  appendProjectQualitySweepMemory,
  appendTaskReviewMemory,
  searchProjectMemory
} from './memory-store.mjs';
import {
  TASK_CAPABILITY_REGISTRY,
  buildAcceptanceMetadata,
  buildTaskActionPolicy,
  buildTaskCodeContext,
  extractStaticCodeGraphFacts,
  inferTaskVerificationTypes,
  normalizeToolProfile,
  summarizeActionOutput
} from './task-action-runtime.mjs';
import {
  CODEX_RUNTIME_PROFILES,
  DEFAULT_HARNESS_SETTINGS,
  DEFAULT_SETTINGS,
  HARNESS_PATTERNS,
  normalizeCodexRuntimeProfile,
  RUN_OPERATION_DEFAULTS,
  RUN_PRESETS,
  RUN_PROFILE_DEFAULTS,
  SUPPORTED_AGENT_PROVIDERS
} from './run-config.mjs';
import {
  buildProjectSummary,
  detectProjectValidationCommands
} from './project-intel.mjs';
import { createProjectWorkflow } from './project-workflow.mjs';
import { createProjectHealth } from './project-health.mjs';

const bus = new EventEmitter();
const activeRuns = new Map();
const writeLocks = new Map();
const appendLocks = new Map();

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java',
  '.cs', '.go', '.rs', '.rb', '.php', '.html', '.css', '.scss', '.sql',
  '.sh', '.ps1', '.bat', '.cmd', '.xml'
]);

const CODEX_TIMEOUT_MS = 12 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 12 * 60 * 1000;
const GEMINI_TIMEOUT_MS = 12 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURED_PROCESS_OUTPUT_BYTES = 256 * 1024;
const CODE_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php']);
const CODE_DOMAIN_ROOTS = new Set(['src', 'app', 'server', 'lib', 'components', 'features', 'packages', 'tests']);
const SHARED_FIXTURE_SEGMENTS = new Set(['__fixtures__', 'fixtures', '__mocks__', 'mocks', 'testdata']);
const SHARED_CONFIG_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'tsconfig.base.json',
  'jsconfig.json',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  'vite.config.ts',
  'vite.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'playwright.config.ts',
  'playwright.config.js',
  'jest.config.js',
  'jest.config.ts',
  'webpack.config.js',
  'webpack.config.ts'
]);
const REPO_IMPORT_PATTERN = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g;
const PYTHON_IMPORT_PATTERN = /^\s*(?:from\s+([.\w/]+)\s+import\s+|import\s+([.\w/.]+))/gm;
const DECLARED_SYMBOL_PATTERN = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_]\w*)/g;
const TASK_ARTIFACT_FILES = {
  prompt: { primary: 'agent-prompt.md', legacy: 'codex-prompt.md' },
  output: { primary: 'agent-output.md', legacy: 'codex-output.md' },
  review: { primary: 'agent-review.json', legacy: 'codex-review.json' }
};
let playwrightAvailabilityPromise = null;

/**
 * @typedef {Object} RunSummary
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} updatedAt
 * @property {string} createdAt
 * @property {string} projectPath
 * @property {{id:string,name?:string,title?:string,description?:string}|null} preset
 * @property {{ready:number,in_progress:number,done:number,failed:number,skipped:number,total:number}} taskCounts
 * @property {string} planSummary
 * @property {{summary:string,goalAchieved:boolean}|null} result
 */

function now() {
  return new Date().toISOString();
}

function runDir(runId) {
  return path.join(RUNS_DIR, runId);
}

function statePath(runId) {
  return path.join(runDir(runId), 'state.json');
}

function logPath(runId) {
  return path.join(runDir(runId), 'logs.ndjson');
}

function recentLogPath(runId) {
  return path.join(runDir(runId), 'recent-logs.json');
}

function tracePath(runId) {
  return path.join(runDir(runId), 'trace.ndjson');
}

function harnessGuidancePath(runId) {
  return path.join(runDir(runId), 'context', 'harness-guidance.md');
}

function taskDir(runId, taskId) {
  return path.join(runDir(runId), 'tasks', taskId);
}

function taskSnapshotDir(runId, taskId) {
  return path.join(taskDir(runId, taskId), 'snapshot-before');
}

function taskWorkspaceDir(runId, taskId) {
  return path.join(taskDir(runId, taskId), 'workspace');
}

function taskArtifactPath(runId, taskId, fileName) {
  return path.join(taskDir(runId, taskId), fileName);
}

function taskArtifactFileNames(kind) {
  const definition = TASK_ARTIFACT_FILES[kind];
  return definition ? [definition.primary, definition.legacy].filter(Boolean) : [];
}

function taskPrimaryArtifactPath(runId, taskId, kind) {
  const [primary] = taskArtifactFileNames(kind);
  return primary ? taskArtifactPath(runId, taskId, primary) : '';
}

function taskTrajectoryPath(runId, taskId) {
  return path.join(taskDir(runId, taskId), 'trajectory.jsonl');
}

function taskActionPath(runId, taskId) {
  return path.join(taskDir(runId, taskId), 'actions.jsonl');
}

function taskCodeContextPath(runId, taskId) {
  return path.join(runDir(runId), 'context', 'code-context', `${taskId}.json`);
}

function runActionPath(runId) {
  return path.join(runDir(runId), 'run-actions.jsonl');
}

function runCheckpointPath(runId) {
  return path.join(runDir(runId), 'run-checkpoint.json');
}

function projectDir(projectId) {
  return path.join(PROJECTS_DIR, projectId);
}

function projectStatePath(projectId) {
  return path.join(projectDir(projectId), 'project.json');
}

function projectCharterPath(projectId) {
  return path.join(projectDir(projectId), 'PROJECT.md');
}

function projectPhaseDir(projectId, phaseId) {
  return path.join(projectDir(projectId), 'phases', phaseId);
}

function projectPhaseContractPath(projectId, phaseId) {
  return path.join(projectPhaseDir(projectId, phaseId), 'phase-contract.md');
}

function projectQualitySweepDir(projectId) {
  return path.join(projectDir(projectId), 'quality-sweeps');
}

function projectQualitySweepArtifactPath(projectId, sweepId, extension = 'json') {
  return path.join(projectQualitySweepDir(projectId), `${sweepId}.${extension}`);
}

function projectKey(projectPath, title) {
  const source = projectPath || title || 'project';
  const digest = createHash('sha1').update(source).digest('hex').slice(0, 10);
  return `${slugify(path.basename(source))}-${digest}`;
}

function projectId(title, rootPath = '') {
  const base = String(title || path.basename(rootPath) || 'project').trim();
  const digest = createHash('sha1').update(`${rootPath}\n${base}`).digest('hex').slice(0, 10);
  return `${slugify(base)}-${digest}`;
}

function slugify(value) {
  return (value || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';
}

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_AGENT_PROVIDERS.has(normalized) ? normalized : fallback;
}

function normalizeLanguage(value, fallback = 'en') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'en' || normalized === 'ko') return normalized;
  return fallback;
}

function localizedText(language, ko, en) {
  return normalizeLanguage(language, 'en') === 'en' ? String(en || ko || '') : String(ko || en || '');
}

function providerDisplayName(provider) {
  switch (normalizeAgentProvider(provider, 'codex')) {
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Codex';
  }
}

function resolveProviderNotes(harnessConfig, provider) {
  const normalized = normalizeAgentProvider(provider, 'codex');
  if (normalized === 'claude') return String(harnessConfig?.claudeNotes || '').trim();
  if (normalized === 'gemini') return String(harnessConfig?.geminiNotes || '').trim();
  return String(harnessConfig?.codexNotes || '').trim();
}

function resolveRunProviderProfile(run) {
  return {
    coordinationProvider: normalizeAgentProvider(run?.harnessConfig?.coordinationProvider, 'codex'),
    workerProvider: normalizeAgentProvider(run?.harnessConfig?.workerProvider, 'codex')
  };
}

function normalizeProviderProfile(value, fallback = DEFAULT_HARNESS_SETTINGS) {
  if (!value || typeof value !== 'object') return null;
  return {
    coordinationProvider: normalizeAgentProvider(value.coordinationProvider, fallback?.coordinationProvider || 'codex'),
    workerProvider: normalizeAgentProvider(value.workerProvider, fallback?.workerProvider || 'codex')
  };
}

function normalizeContinuationPolicy(value, fallback = null) {
  const source = value && typeof value === 'object' ? value : {};
  const fallbackValue = fallback && typeof fallback === 'object' ? fallback : {};
  const modeCandidate = String(source.mode || fallbackValue.mode || 'guided').trim().toLowerCase();
  return {
    mode: ['manual', 'guided'].includes(modeCandidate) ? modeCandidate : 'guided',
    autoQualitySweepOnPhaseComplete: source.autoQualitySweepOnPhaseComplete === true
      || (source.autoQualitySweepOnPhaseComplete == null && fallbackValue.autoQualitySweepOnPhaseComplete === true),
    keepDocsInSync: source.keepDocsInSync !== false
      && (source.keepDocsInSync != null || fallbackValue.keepDocsInSync !== false)
  };
}

function defaultExecutionModelHint(run) {
  const profile = resolveRunProviderProfile(run);
  return `${providerDisplayName(profile.coordinationProvider)} coordinates planning/review and ${providerDisplayName(profile.workerProvider)} executes coding tasks.`;
}

function codexRuntimeProfileSettings(value) {
  const profileId = normalizeCodexRuntimeProfile(value, DEFAULT_SETTINGS.codexRuntimeProfile);
  return CODEX_RUNTIME_PROFILES[profileId] || CODEX_RUNTIME_PROFILES[DEFAULT_SETTINGS.codexRuntimeProfile];
}

export function buildCodexExecArgs(settings = {}, outputFileName = '') {
  const runtimeProfileId = normalizeCodexRuntimeProfile(
    settings.codexRuntimeProfile,
    DEFAULT_SETTINGS.codexRuntimeProfile
  );
  const runtimeProfile = codexRuntimeProfileSettings(runtimeProfileId);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--model',
    settings.codexModel || DEFAULT_SETTINGS.codexModel,
    '-c',
    `model_reasoning_effort="${settings.codexReasoningEffort || DEFAULT_SETTINGS.codexReasoningEffort}"`,
    '-c',
    `service_tier="${settings.codexServiceTier || DEFAULT_SETTINGS.codexServiceTier}"`,
    '-c',
    `approval_policy="${runtimeProfile.approvalPolicy}"`,
    '-c',
    `sandbox_mode="${runtimeProfile.sandboxMode}"`
  ];
  if (runtimeProfile.id === 'yolo') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-a', runtimeProfile.approvalPolicy, '-s', runtimeProfile.sandboxMode);
  }
  if (outputFileName) {
    args.push('-o', outputFileName);
  }
  args.push('-');
  return args;
}

export function parseJsonReply(text) {
  const trimmed = String(text || '').trim();
  const candidates = [];
  if (!trimmed) {
    throw new Error('JSON parse failed.\n(empty reply)');
  }
  candidates.push(trimmed);
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const candidate = String(match[1] || '').trim();
    if (candidate) candidates.push(candidate);
  }
  const startIndex = trimmed.search(/[\[{]/);
  if (startIndex >= 0) {
    const balanced = extractBalancedJson(trimmed, startIndex);
    if (balanced) candidates.push(balanced);
  }
  const failures = [];
  for (const candidate of uniqueBy(candidates, (item) => item)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      failures.push(String(error?.message || error || 'unknown parse error'));
    }
  }
  const failureSummary = failures.length ? `\nAttempts: ${failures.join(' | ')}` : '';
  throw new Error(`JSON parse failed.${failureSummary}\n${trimmed.slice(0, 1000)}`);
}

function extractBalancedJson(text, startIndex) {
  const opening = text[startIndex];
  const closing = opening === '{' ? '}' : (opening === '[' ? ']' : '');
  if (!closing) return '';
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return '';
}

function normalizeBrowserVerificationConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const selector = String(value.selector || '').trim();
  const waitUntil = String(value.waitUntil || 'domcontentloaded').trim() || 'domcontentloaded';
  const timeoutMs = Math.max(1000, Number(value.timeoutMs || value.timeout || 15000));
  if (!url && !selector) return null;
  return {
    url,
    selector,
    waitUntil,
    timeoutMs
  };
}

async function getPlaywrightAvailability() {
  if (!playwrightAvailabilityPromise) {
    playwrightAvailabilityPromise = (async () => {
      try {
        const playwright = await import('playwright');
        const version = String(playwright?.chromium?.version?.() || '').trim();
        return { ok: true, version: version || 'installed', error: '' };
      } catch (error) {
        return { ok: false, version: '', error: String(error?.message || error || 'Playwright is not installed.') };
      }
    })();
  }
  return playwrightAvailabilityPromise;
}

function normalizeDevServerConfig(value, projectPath = '') {
  if (!value || typeof value !== 'object') return null;
  const command = String(value.command || '').trim();
  const url = String(value.url || '').trim();
  const cwd = value.cwd ? resolveInputPath(String(value.cwd || '').trim(), projectPath) : projectPath;
  const timeoutMs = Math.max(1000, Number(value.timeoutMs || value.timeout || 30000));
  if (!command && !url) return null;
  return {
    command,
    url,
    cwd,
    timeoutMs
  };
}

function firstUrlFromTask(task) {
  const haystack = [
    ...(Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks : []),
    ...(Array.isArray(task?.constraints) ? task.constraints : [])
  ].join('\n');
  return (haystack.match(/https?:\/\/[^\s)]+/i) || [])[0] || '';
}

function normalizeFilesLikely(value) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list
    .map((item) => {
      const normalizedPath = String(item || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
      return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    })
    .filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : ['*'];
}

function filesLikelyOverlap(leftPath, rightPath) {
  if (!leftPath || !rightPath) return false;
  if (leftPath === rightPath) return true;
  return rightPath.startsWith(`${leftPath}/`) || leftPath.startsWith(`${rightPath}/`);
}

function pathExtension(value) {
  return path.posix.extname(String(value || '').trim().replace(/\\/g, '/')).toLowerCase();
}

function isCodeLikePath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (CODE_DOMAIN_ROOTS.has(parts[0] || '')) return true;
  return CODE_LIKE_EXTENSIONS.has(pathExtension(normalized));
}

function collisionDomainRoot(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized || !isCodeLikePath(normalized)) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts.length >= 2 && CODE_DOMAIN_ROOTS.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function basenameTokens(filePath) {
  return String(path.posix.basename(String(filePath || '').trim(), pathExtension(filePath)) || '')
    .split(/[^A-Za-z0-9_]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3);
}

function taskTextTokens(task) {
  return String([
    task?.title,
    task?.goal,
    ...(Array.isArray(task?.constraints) ? task.constraints : []),
    ...(Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks : [])
  ].filter(Boolean).join(' '))
    .toLowerCase()
    .match(/[a-z_][a-z0-9_]{2,}/g) || [];
}

function sharedFixtureKey(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  const fixtureIndex = parts.findIndex((part) => SHARED_FIXTURE_SEGMENTS.has(part.toLowerCase()));
  if (fixtureIndex < 0) return '';
  return parts.slice(0, Math.min(parts.length, fixtureIndex + 2)).join('/').toLowerCase();
}

function sharedConfigKey(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) return '';
  const base = path.posix.basename(normalized).toLowerCase();
  if (SHARED_CONFIG_BASENAMES.has(base)) return 'config:repo-root';
  if (base.endsWith('.config.js') || base.endsWith('.config.ts') || base.endsWith('.config.mjs') || base.endsWith('.config.cjs')) {
    return 'config:repo-root';
  }
  return '';
}

function resolveRelativeImport(projectPath, fromFile, specifier) {
  const root = String(projectPath || '').trim();
  const from = String(fromFile || '').trim().replace(/\\/g, '/');
  const raw = String(specifier || '').trim();
  if (!root || !from || !raw.startsWith('.')) return '';
  const fromDir = path.posix.dirname(from);
  const basePath = path.posix.normalize(path.posix.join(fromDir, raw));
  const candidates = [
    basePath,
    ...[...CODE_LIKE_EXTENSIONS].map((ext) => `${basePath}${ext}`),
    ...[...CODE_LIKE_EXTENSIONS].map((ext) => path.posix.join(basePath, `index${ext}`))
  ];
  for (const candidate of candidates) {
    const absolutePath = path.join(root, ...candidate.split('/'));
    if (existsSync(absolutePath)) return candidate;
  }
  return basePath;
}

function readTaskParallelSignals(task, projectPath, cache = null) {
  const cacheKey = `${String(projectPath || '').trim()}::${task?.id || JSON.stringify(task?.filesLikely || [])}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const files = normalizeFilesLikely(task?.filesLikely);
  const signals = {
    files,
    domains: new Set(),
    configKeys: new Set(),
    fixtureKeys: new Set(),
    importTargets: new Set(),
    importedDomains: new Set(),
    symbols: new Set(),
    exportedSymbols: new Set(),
    importedSymbols: new Set()
  };
  for (const filePath of files) {
    if (!filePath || filePath === '*') continue;
    const normalized = filePath.toLowerCase();
    const domain = collisionDomainRoot(normalized);
    if (domain) signals.domains.add(domain);
    const configKey = sharedConfigKey(normalized);
    if (configKey) signals.configKeys.add(configKey);
    const fixtureKey = sharedFixtureKey(normalized);
    if (fixtureKey) signals.fixtureKeys.add(fixtureKey);
    for (const token of basenameTokens(normalized)) {
      signals.symbols.add(token);
    }
    const absolutePath = String(projectPath || '').trim()
      ? path.join(String(projectPath || '').trim(), ...normalized.split('/'))
      : '';
    if (!absolutePath || !existsSync(absolutePath) || !isCodeLikePath(normalized)) continue;
    let sourceText = '';
    try {
      sourceText = readFileSync(absolutePath, 'utf8');
    } catch {
      sourceText = '';
    }
    if (!sourceText) continue;
    const graphFacts = extractStaticCodeGraphFacts(sourceText);
    for (const symbol of graphFacts.exports || []) {
      signals.exportedSymbols.add(String(symbol || '').trim().toLowerCase());
    }
    for (const symbol of graphFacts.declarations || []) {
      signals.symbols.add(String(symbol || '').trim().toLowerCase());
    }
    for (const symbol of graphFacts.importedSymbols || []) {
      signals.importedSymbols.add(String(symbol || '').trim().toLowerCase());
      signals.symbols.add(String(symbol || '').trim().toLowerCase());
    }
    for (const importEntry of graphFacts.imports || []) {
      const importTarget = resolveRelativeImport(projectPath, normalized, importEntry.specifier);
      if (!importTarget) continue;
      signals.importTargets.add(importTarget);
      const importedDomain = collisionDomainRoot(importTarget);
      if (importedDomain) signals.importedDomains.add(importedDomain);
      const importedConfigKey = sharedConfigKey(importTarget);
      if (importedConfigKey) signals.configKeys.add(importedConfigKey);
      const importedFixtureKey = sharedFixtureKey(importTarget);
      if (importedFixtureKey) signals.fixtureKeys.add(importedFixtureKey);
    }
  }
  for (const token of taskTextTokens(task)) {
    signals.symbols.add(token);
  }
  const finalized = {
    files,
    domains: [...signals.domains],
    configKeys: [...signals.configKeys],
    fixtureKeys: [...signals.fixtureKeys],
    importTargets: [...signals.importTargets],
    importedDomains: [...signals.importedDomains],
    symbols: [...signals.symbols],
    exportedSymbols: [...signals.exportedSymbols],
    importedSymbols: [...signals.importedSymbols]
  };
  cache?.set(cacheKey, finalized);
  return finalized;
}

function sameSetIntersection(left, right) {
  return left.some((item) => right.includes(item));
}

export function tasksCollide(left, right, projectPath = '', cache = null) {
  const a = normalizeFilesLikely(left.filesLikely);
  const b = normalizeFilesLikely(right.filesLikely);
  if (a.includes('*') || b.includes('*')) return true;
  if (a.some((item) => b.some((candidate) => filesLikelyOverlap(item, candidate)))) return true;
  const leftSignals = readTaskParallelSignals(left, projectPath, cache);
  const rightSignals = readTaskParallelSignals(right, projectPath, cache);
  if (sameSetIntersection(leftSignals.domains, rightSignals.domains)) return true;
  if (sameSetIntersection(leftSignals.configKeys, rightSignals.configKeys)) return true;
  if (sameSetIntersection(leftSignals.fixtureKeys, rightSignals.fixtureKeys)) return true;
  if (leftSignals.importTargets.some((item) => b.includes(item) || rightSignals.importTargets.includes(item))) return true;
  if (rightSignals.importTargets.some((item) => a.includes(item) || leftSignals.importTargets.includes(item))) return true;
  if (sameSetIntersection(leftSignals.importedDomains, rightSignals.domains) || sameSetIntersection(rightSignals.importedDomains, leftSignals.domains)) return true;
  if (leftSignals.importTargets.some((item) => b.includes(item)) && sameSetIntersection(leftSignals.importedSymbols, rightSignals.exportedSymbols)) return true;
  if (rightSignals.importTargets.some((item) => a.includes(item)) && sameSetIntersection(rightSignals.importedSymbols, leftSignals.exportedSymbols)) return true;
  return sameSetIntersection(leftSignals.symbols, rightSignals.symbols)
    && (sameSetIntersection(leftSignals.domains, rightSignals.importedDomains)
      || sameSetIntersection(rightSignals.domains, leftSignals.importedDomains)
      || sameSetIntersection(leftSignals.domains, rightSignals.domains));
}

function nextTaskId(tasks) {
  const numbers = tasks
    .map((task) => Number(String(task.id || '').replace(/^T/i, '')))
    .filter((value) => Number.isFinite(value));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `T${String(next).padStart(3, '0')}`;
}

function isTaskSatisfiedStatus(status) {
  return status === 'done' || status === 'skipped';
}

function isTaskTerminalStatus(status) {
  return isTaskSatisfiedStatus(status) || status === 'failed';
}

function defaultTaskExecution() {
  return {
    workspaceMode: '',
    changedFiles: [],
    repoChangedFiles: [],
    outOfScopeFiles: [],
    scopeEnforcement: '',
    applyResult: '',
    lastExitCode: null,
    lastRunAt: '',
    reviewDecision: '',
    reviewRoute: '',
    acceptanceCheckResults: [],
    verificationTypes: [],
    allowedActionClasses: [],
    actionCounts: {},
    lastAction: null,
    codeContextSummary: '',
    recoveryHint: ''
  };
}

function normalizeAgent(raw) {
  return {
    name: String(raw?.name || '').trim() || 'agent',
    role: String(raw?.role || '').trim() || 'Assigned role',
    model: normalizeAgentProvider(raw?.model, 'codex'),
    responsibility: String(raw?.responsibility || '').trim() || String(raw?.role || '').trim() || 'Assigned responsibility'
  };
}

function normalizeAcceptanceCheckResults(results) {
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => ({
      check: String(item?.check || '').trim(),
      status: String(item?.status || '').trim().toLowerCase(),
      note: String(item?.note || '').trim(),
      verificationTypes: Array.isArray(item?.verificationTypes) ? item.verificationTypes.map((entry) => String(entry || '').trim().toUpperCase()).filter(Boolean) : []
    }))
    .filter((item) => item.check);
}

function memoryHints(memory, limit = 3) {
  return (Array.isArray(memory?.searchResults) ? memory.searchResults : [])
    .slice(0, limit)
    .map((item) => `${item.kind}: ${item.title}`)
    .filter(Boolean);
}

function buildTaskHandoff(run, task, executionCtx, expectedScope, memory, actionPolicy, codeContext) {
  return {
    schemaVersion: '1',
    runId: run.id,
    taskId: task.id,
    stage: 'planner-to-executor',
    objective: String(run.clarify?.clarifiedObjective || run.input?.objective || run.title || '').trim(),
    goal: String(task.goal || '').trim(),
    filesLikely: Array.isArray(task.filesLikely) ? task.filesLikely.map(String) : [],
    constraints: Array.isArray(task.constraints) ? task.constraints.map(String) : [],
    acceptanceChecks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks.map(String) : [],
    acceptanceMetadata: Array.isArray(task.acceptanceMetadata) ? task.acceptanceMetadata : buildAcceptanceMetadata(task.acceptanceChecks || []),
    checkpointNotes: Array.isArray(task.checkpointNotes) ? task.checkpointNotes.map(String) : [],
    workspaceMode: executionCtx.mode === 'shared' ? 'shared' : (executionCtx.mode || 'read-only'),
    expectedScope,
    memoryHints: memoryHints(memory),
    allowedActionClasses: Array.isArray(actionPolicy?.allowedActionClasses) ? actionPolicy.allowedActionClasses.map(String) : [],
    codeContextSummary: String(codeContext?.summary || '').trim(),
    notes: [
      `Task title: ${task.title}`,
      `Checkpoint notes: ${(task.checkpointNotes || []).join(' | ') || 'None'}`,
      `Review route defaults to Codex unless prescreen can decide mechanically.`
    ],
    createdAt: now()
  };
}

const REVIEW_FINDING_GROUPS = [
  { key: 'functionalFindings', taskLabel: 'Functional' },
  { key: 'structuralFindings', taskLabel: 'Structure' },
  { key: 'codeFindings', taskLabel: 'Code' },
  { key: 'staticVerificationFindings', taskLabel: 'Static verification' },
  { key: 'browserUxFindings', taskLabel: 'Browser UX' }
];

function normalizeReviewFindingGroups(review) {
  const source = review && typeof review === 'object' ? review : {};
  return REVIEW_FINDING_GROUPS.reduce((acc, group) => {
    acc[group.key] = Array.isArray(source[group.key]) ? source[group.key].map(String).filter(Boolean) : [];
    return acc;
  }, {});
}

function flattenReviewFindingGroups(groups) {
  return REVIEW_FINDING_GROUPS.flatMap((group) => (groups[group.key] || []).map((item) => `${group.taskLabel}: ${item}`));
}

function buildReviewVerdict(task, review) {
  const normalizedAcceptanceChecks = Array.isArray(review?.updatedTask?.acceptanceChecks) ? review.updatedTask.acceptanceChecks.map(String) : [];
  const findingGroups = normalizeReviewFindingGroups(review);
  return {
    schemaVersion: '1',
    taskId: task.id,
    decision: String(review?.decision || '').trim().toLowerCase(),
    route: String(review?.route || 'agent-review').trim(),
    summary: String(review?.summary || '').trim(),
    findings: Array.isArray(review?.findings) ? review.findings.map(String) : [],
    functionalFindings: findingGroups.functionalFindings,
    structuralFindings: findingGroups.structuralFindings,
    codeFindings: findingGroups.codeFindings,
    staticVerificationFindings: findingGroups.staticVerificationFindings,
    browserUxFindings: findingGroups.browserUxFindings,
    retryDiagnosis: String(review?.retryDiagnosis || '').trim(),
    acceptanceCheckResults: normalizeAcceptanceCheckResults(review?.acceptanceCheckResults),
    updatedTask: review?.updatedTask && typeof review.updatedTask === 'object'
      ? {
          goal: String(review.updatedTask.goal || '').trim(),
          filesLikely: Array.isArray(review.updatedTask.filesLikely) ? review.updatedTask.filesLikely.map(String) : [],
          constraints: Array.isArray(review.updatedTask.constraints) ? review.updatedTask.constraints.map(String) : [],
          acceptanceChecks: normalizedAcceptanceChecks,
          acceptanceMetadata: buildAcceptanceMetadata(normalizedAcceptanceChecks)
        }
      : {},
    createdAt: now()
  };
}

function incrementRunMetric(metrics, genericKey, legacyKey = '') {
  if (!metrics || typeof metrics !== 'object') return;
  metrics[genericKey] = Number(metrics[genericKey] || 0) + 1;
  if (legacyKey && Object.hasOwn(metrics, legacyKey)) {
    metrics[legacyKey] = Number(metrics[legacyKey] || 0) + 1;
  }
}

function normalizePublicRunMetrics(metrics) {
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  return {
    planningRuns: Number(source.planningRuns || 0),
    executionRuns: Number(source.executionRuns || 0),
    reviews: Number(source.reviews || 0),
    goalChecks: Number(source.goalChecks || 0),
    replanRuns: Number(source.replanRuns || 0),
    replanPauseCount: Number(source.replanPauseCount || 0),
    replanHighDriftCount: Number(source.replanHighDriftCount || 0)
  };
}

function buildRetryPlan(task, review, scopeSummary, verification) {
  if (String(review?.decision || '').trim().toLowerCase() !== 'retry') return null;
  const findingGroups = normalizeReviewFindingGroups(review);
  const scopeTightening = [];
  if (Array.isArray(scopeSummary?.outOfScopeFiles) && scopeSummary.outOfScopeFiles.length) {
    scopeTightening.push(`Keep edits inside filesLikely. Out-of-scope files: ${scopeSummary.outOfScopeFiles.join(', ')}`);
  }
  if (verification?.ok === false) {
    scopeTightening.push('Do not claim success before the selected verification commands pass.');
  }
  return {
    schemaVersion: '1',
    taskId: task.id,
    reason: String(review?.summary || '').trim(),
    rootCause: String(review?.retryDiagnosis || '').trim() || String(review?.summary || '').trim(),
    changedApproach: uniqueBy([
      ...(Array.isArray(review?.findings) ? review.findings.map(String).filter(Boolean) : []),
      ...flattenReviewFindingGroups(findingGroups)
    ], (item) => item).slice(0, 6),
    extraChecks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks.map(String) : [],
    scopeTightening,
    createdAt: now()
  };
}

function buildExecutionSummary(task, executionCtx, expectedScope, changedFiles, scopeSummary, verification, reviewDecision, reviewRoute, applyResult, execution) {
  return {
    schemaVersion: '1',
    taskId: task.id,
    workspaceMode: executionCtx.mode === 'shared' ? 'shared' : (executionCtx.mode || 'read-only'),
    expectedScope,
    changedFiles: Array.isArray(changedFiles) ? changedFiles.map((item) => item.path) : [],
    repoChangedFiles: Array.isArray(scopeSummary?.repoChangedFiles) ? scopeSummary.repoChangedFiles.map(String) : [],
    outOfScopeFiles: Array.isArray(scopeSummary?.outOfScopeFiles) ? scopeSummary.outOfScopeFiles.map(String) : [],
    verificationOk: verification?.ok !== false,
    verificationCommands: Array.isArray(verification?.selectedCommands) ? verification.selectedCommands.map(String) : [],
    verificationTypes: Array.isArray(verification?.verificationTypes) ? verification.verificationTypes.map(String) : [],
    acceptanceMetadata: Array.isArray(task.acceptanceMetadata) ? task.acceptanceMetadata : buildAcceptanceMetadata(task.acceptanceChecks || []),
    reviewDecision: String(reviewDecision || '').trim().toLowerCase(),
    reviewRoute: String(reviewRoute || '').trim(),
    applyResult: String(applyResult?.message || '').trim(),
    lastExitCode: Number.isFinite(execution?.code) ? execution.code : null,
    attempt: Number(task.attempts || 0) + 1,
    allowedActionClasses: Array.isArray(task.lastExecution?.allowedActionClasses) ? task.lastExecution.allowedActionClasses.map(String) : [],
    actionCounts: task.lastExecution?.actionCounts && typeof task.lastExecution.actionCounts === 'object' ? task.lastExecution.actionCounts : {},
    lastAction: task.lastExecution?.lastAction || null,
    completedAt: now()
  };
}

async function writeTaskStructuredArtifacts(runId, taskId, payload = {}) {
  const writes = [];
  if (payload.handoff) {
    writes.push(writeJson(taskArtifactPath(runId, taskId, 'handoff.json'), payload.handoff));
  }
  if (payload.reviewVerdict) {
    writes.push(writeJson(taskArtifactPath(runId, taskId, 'review-verdict.json'), payload.reviewVerdict));
  }
  if (payload.executionSummary) {
    writes.push(writeJson(taskArtifactPath(runId, taskId, 'execution-summary.json'), payload.executionSummary));
  }
  if (payload.retryPlan) {
    writes.push(writeJson(taskArtifactPath(runId, taskId, 'retry-plan.json'), payload.retryPlan));
  } else if (payload.clearRetryPlan) {
    writes.push(fs.rm(taskArtifactPath(runId, taskId, 'retry-plan.json'), { force: true }).catch(() => {}));
  }
  await Promise.all(writes);
}

function normalizeTask(raw, existingTasks) {
  const acceptanceChecks = Array.isArray(raw.acceptanceChecks) ? raw.acceptanceChecks.map(String) : [];
  return {
    id: raw.id || nextTaskId(existingTasks),
    title: String(raw.title || 'Untitled task'),
    goal: String(raw.goal || '').trim(),
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    filesLikely: Array.isArray(raw.filesLikely) ? raw.filesLikely.map(String) : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String) : [],
    acceptanceChecks,
    acceptanceMetadata: Array.isArray(raw.acceptanceMetadata) ? raw.acceptanceMetadata : buildAcceptanceMetadata(acceptanceChecks),
    status: 'ready',
    attempts: 0,
    reviewSummary: '',
    findings: [],
    checkpointNotes: Array.isArray(raw.checkpointNotes) ? raw.checkpointNotes.map(String).filter(Boolean) : [],
    lastExecution: {
      ...defaultTaskExecution(),
      ...(raw.lastExecution && typeof raw.lastExecution === 'object' ? raw.lastExecution : {})
    },
    allowedActionClasses: Array.isArray(raw.allowedActionClasses) ? raw.allowedActionClasses.map(String) : []
  };
}

function nextPhaseId(existingPhases = []) {
  const highest = (Array.isArray(existingPhases) ? existingPhases : [])
    .map((phase) => Number(String(phase?.id || '').replace(/^P/i, '')) || 0)
    .reduce((max, value) => Math.max(max, value), 0);
  return `P${String(highest + 1).padStart(3, '0')}`;
}

function normalizeContractList(values, fallback = []) {
  const items = Array.isArray(values) ? values.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return items.length ? uniqueBy(items, (item) => item) : fallback;
}

function normalizePhaseContract(raw, phase, language = DEFAULT_HARNESS_SETTINGS.uiLanguage) {
  const title = String(phase?.title || 'Current phase').trim() || 'Current phase';
  return {
    goal: String(raw?.goal || phase?.goal || '').trim(),
    deliverables: normalizeContractList(raw?.deliverables, [
      localizedText(language, `${title} 범위의 실행 가능한 backlog와 핵심 산출물을 현재 저장소에 고정한다.`, `Lock the executable backlog and core deliverables for ${title} in the current repository.`)
    ]),
    verification: normalizeContractList(raw?.verification, [
      localizedText(language, '이 phase의 acceptance를 확인할 검증 명령 또는 evidence를 남긴다.', 'Leave the verification commands or evidence needed to confirm acceptance for this phase.')
    ]),
    nonNegotiables: normalizeContractList(raw?.nonNegotiables, [
      localizedText(language, '현재 phase 범위를 넘는 구현으로 확장하지 않는다.', 'Do not expand implementation beyond the current phase boundary.'),
      localizedText(language, '기존 docs와 저장소 상태를 source of truth로 본다.', 'Treat the existing docs and repository state as the source of truth.')
    ]),
    outOfScope: normalizeContractList(raw?.outOfScope, [
      localizedText(language, '다음 phase에 속한 기능 구현', 'Features that belong to the next phase')
    ]),
    carryOverRules: normalizeContractList(raw?.carryOverRules, [
      localizedText(language, '미완료 태스크는 carry-over backlog로 남기고 contract 항목과 연결한다.', 'Leave unfinished tasks in the carry-over backlog and link them back to the contract.')
    ])
  };
}

function buildPhaseContractMarkdown(project, phase) {
  const contract = phase?.phaseContract || normalizePhaseContract(null, phase);
  const sections = [
    '# Phase Contract',
    '',
    `- Project: ${project?.title || project?.id || '-'}`,
    `- Phase: ${phase?.title || phase?.id || '-'}`,
    phase?.id ? `- Phase ID: ${phase.id}` : '',
    '',
    '## Goal',
    '',
    contract.goal || '-',
    '',
    '## Deliverables',
    '',
    ...contract.deliverables.map((item) => `- ${item}`),
    '',
    '## Verification',
    '',
    ...contract.verification.map((item) => `- ${item}`),
    '',
    '## Non-Negotiables',
    '',
    ...contract.nonNegotiables.map((item) => `- ${item}`),
    '',
    '## Out Of Scope',
    '',
    ...contract.outOfScope.map((item) => `- ${item}`),
    '',
    '## Carry-Over Rules',
    '',
    ...contract.carryOverRules.map((item) => `- ${item}`),
    ''
  ].filter(Boolean);
  return `${sections.join('\n')}\n`;
}

function normalizeProjectPhase(raw, existingPhases = [], index = 0, language = DEFAULT_HARNESS_SETTINGS.uiLanguage) {
  const normalizedStatus = ['pending', 'active', 'done'].includes(String(raw?.status || '').trim())
    ? String(raw.status).trim()
    : (index === 0 ? 'active' : 'pending');
  const id = String(raw?.id || nextPhaseId(existingPhases)).trim();
  const title = String(raw?.title || `Phase ${index + 1}`).trim();
  const goal = String(raw?.goal || '').trim();
  return {
    id,
    title,
    goal,
    status: normalizedStatus,
    phaseContract: normalizePhaseContract(raw?.phaseContract, { id, title, goal }, language)
  };
}

function materializePlannedTasks(rawTasks) {
  const tasks = [];
  const rawIndexToTaskId = new Map();
  for (const [index, rawTask] of rawTasks.entries()) {
    const task = normalizeTask(rawTask, tasks);
    tasks.push(task);
    rawIndexToTaskId.set(index, task.id);
  }

  for (const task of tasks) {
    task.dependsOn = (task.dependsOn || []).map((dep) => {
      const rawIndexMatch = String(dep || '').match(/^__RAW_(\d+)$/);
      if (!rawIndexMatch) return String(dep);
      return rawIndexToTaskId.get(Number(rawIndexMatch[1])) || String(dep);
    });
  }
  return tasks;
}

function mergeEditableBacklogTasks(existingTasks, rawTasks) {
  const updates = new Map();
  const newTasks = [];
  const existingById = new Map((Array.isArray(existingTasks) ? existingTasks : []).map((task) => [task.id, task]));

  for (const rawTask of Array.isArray(rawTasks) ? rawTasks : []) {
    const rawId = String(rawTask?.id || '').trim();
    const existing = rawId ? existingById.get(rawId) : null;
    if (!existing) {
      newTasks.push(rawTask);
      continue;
    }
    if (existing.status !== 'ready') continue;
    updates.set(existing.id, {
      ...existing,
      title: String(rawTask.title || existing.title || 'Untitled task'),
      goal: String(rawTask.goal || existing.goal || '').trim(),
      dependsOn: Array.isArray(rawTask.dependsOn) ? rawTask.dependsOn.map(String) : (existing.dependsOn || []),
      filesLikely: Array.isArray(rawTask.filesLikely) ? rawTask.filesLikely.map(String) : (existing.filesLikely || []),
      constraints: Array.isArray(rawTask.constraints) ? rawTask.constraints.map(String) : (existing.constraints || []),
      acceptanceChecks: Array.isArray(rawTask.acceptanceChecks) ? rawTask.acceptanceChecks.map(String) : (existing.acceptanceChecks || []),
      acceptanceMetadata: Array.isArray(rawTask.acceptanceChecks)
        ? buildAcceptanceMetadata(rawTask.acceptanceChecks.map(String))
        : (Array.isArray(existing.acceptanceMetadata) ? existing.acceptanceMetadata : buildAcceptanceMetadata(existing.acceptanceChecks || [])),
      checkpointNotes: uniqueBy([
        ...(existing.checkpointNotes || []),
        ...(Array.isArray(rawTask.checkpointNotes) ? rawTask.checkpointNotes.map(String) : [])
      ], (item) => item)
    });
  }

  const merged = (Array.isArray(existingTasks) ? existingTasks : []).map((task) => updates.get(task.id) || task);
  for (const rawTask of newTasks) {
    merged.push(normalizeTask(rawTask, merged));
  }
  return merged;
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let index = 2; index < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1] ?? 0;
      swapped[index - 1] = buffer[index] ?? 0;
    }
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function decodeProcessOutput(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    return decodeTextBuffer(buffer);
  }
  let nulCount = 0;
  for (const byte of buffer) {
    if (byte === 0) nulCount += 1;
  }
  if (nulCount > 0 && nulCount >= Math.floor(buffer.length / 4)) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function readJson(filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return JSON.parse(decodeTextBuffer(await fs.readFile(filePath)));
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function serializeState(state) {
  const { logs, ...persisted } = state || {};
  return persisted;
}

function summarizeRunState(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    updatedAt: state.updatedAt,
    createdAt: state.createdAt,
    projectPath: state.projectPath || '',
    preset: state.preset || null,
    taskCounts: {
      ready: tasks.filter((task) => task.status === 'ready').length,
      in_progress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      skipped: tasks.filter((task) => task.status === 'skipped').length,
      total: tasks.length
    },
    project: state?.project
      ? {
          id: state.project.id,
          title: state.project.title,
          phaseId: state.project.phaseId || '',
          phaseTitle: state.project.phaseTitle || ''
        }
      : null,
    planSummary: state.planSummary || '',
    result: state.result
      ? {
          summary: String(state.result.summary || '').trim(),
          goalAchieved: Boolean(state.result.goalAchieved)
        }
      : null
  };
}

async function readRecentLogs(runId) {
  const logs = await readJson(recentLogPath(runId)).catch(() => []);
  return Array.isArray(logs) ? logs : [];
}

async function loadPersistedState(runId) {
  return readJson(statePath(runId));
}

async function loadState(runId) {
  const state = await loadPersistedState(runId);
  state.logs = await readRecentLogs(runId);
  return state;
}

async function writeProjectRecord(project) {
  await ensureDir(projectDir(project.id));
  await writeJson(projectStatePath(project.id), project);
  const lines = [
    '# Project Charter',
    '',
    `- Title: ${project.title}`,
    `- Root: ${project.rootPath || '-'}`,
    `- Shared memory key: ${project.sharedMemoryKey}`,
    `- Default preset: ${project.defaultPresetId || 'auto'}`,
    ''
  ];
  if (project.bootstrap?.enabled) {
    lines.push('## Repo Bootstrap', '');
    lines.push(`- Requested: yes`);
    lines.push(`- Generated: ${(project.bootstrap.generated || []).join(', ') || 'None'}`);
    lines.push(`- Preserved existing: ${(project.bootstrap.preservedExisting || []).join(', ') || 'None'}`);
    lines.push('');
  }
  if (project.maintenance?.latestQualitySweep) {
    lines.push('## Maintenance', '');
    lines.push(`- Latest quality sweep: ${project.maintenance.latestQualitySweep.createdAt || '-'}`);
    lines.push(`- Grade: ${project.maintenance.latestQualitySweep.grade || '-'}`);
    lines.push(`- Findings: ${project.maintenance.latestQualitySweep.findingCount || 0}`);
    lines.push(`- Phase: ${project.maintenance.latestQualitySweep.phaseTitle || project.maintenance.latestQualitySweep.phaseId || '-'}`);
    lines.push('');
  }
  if (project.charterText) {
    lines.push('## Charter', '', project.charterText, '');
  }
  if (Array.isArray(project.phases) && project.phases.length > 0) {
    lines.push('## Phases', '');
    for (const phase of project.phases) {
      lines.push(`- ${phase.id} ${phase.title} [${phase.status}]${phase.goal ? ` | ${phase.goal}` : ''}`);
      if (phase.phaseContract) lines.push(`  - Contract: ${projectPhaseContractPath(project.id, phase.id)}`);
    }
    lines.push('');
  }
  await fs.writeFile(projectCharterPath(project.id), `${lines.join('\n')}\n`, 'utf8');
  for (const phase of Array.isArray(project.phases) ? project.phases : []) {
    await ensureDir(projectPhaseDir(project.id, phase.id));
    await fs.writeFile(projectPhaseContractPath(project.id, phase.id), buildPhaseContractMarkdown(project, phase), 'utf8');
  }
}

function buildRepoBootstrapTargets(project) {
  return [
    {
      relativePath: 'AGENTS.md',
      body: [
        '# AGENTS',
        '',
        'This file holds only the short table-of-contents and hard rules for this repository.',
        '',
        '## Hard Rules',
        '',
        '- docs-first: treat existing docs and repo state as the source of record.',
        '- Do not design or implement beyond the current phase scope.',
        '- A task is not complete unless its verification contract is satisfied.',
        '',
        '## Deeper Docs',
        '',
        '- [ARCHITECTURE.md](./ARCHITECTURE.md)',
        '- [docs/exec-plans/active/README.md](./docs/exec-plans/active/README.md)',
        '- [docs/exec-plans/completed/README.md](./docs/exec-plans/completed/README.md)',
        '- [docs/product-specs/README.md](./docs/product-specs/README.md)',
        '- [docs/references/README.md](./docs/references/README.md)',
        '- [docs/tech-debt-tracker.md](./docs/tech-debt-tracker.md)',
        '',
        '## Verification Contract',
        '',
        '- Verify acceptance checks mechanically wherever possible.',
        '- Leave shell/browser/manual verification results in an artifact or plan document.',
        ''
      ].join('\n')
    },
    {
      relativePath: 'ARCHITECTURE.md',
      body: [
        '# Architecture',
        '',
        `Project: ${project.title}`,
        '',
        '## Subsystem Map',
        '',
        '- Fill in the major subsystems and their responsibilities.',
        '',
        '## Boundaries',
        '',
        '- Document the seams between subsystems and integration contracts.',
        '',
        '## Sensitive Surfaces',
        '',
        '- Record auth, billing, schema, filesystem, and external API risk here.',
        ''
      ].join('\n')
    },
    {
      relativePath: 'docs/exec-plans/active/README.md',
      body: '# Active Execution Plans\n\n- Keep in-progress phase/run plans in this directory.\n- Always write the current phase goal, out-of-scope, acceptance criteria, and next action first.\n'
    },
    {
      relativePath: 'docs/exec-plans/completed/README.md',
      body: '# Completed Execution Plans\n\n- Move completed phase/run records here.\n- Leave final results, verification outcomes, and follow-up debt.\n'
    },
    {
      relativePath: 'docs/product-specs/README.md',
      body: '# Product Specs\n\n- Store product requirements, acceptance criteria, and excluded scope here.\n- Split specs into separate documents rather than one large file.\n'
    },
    {
      relativePath: 'docs/references/README.md',
      body: '# References\n\n- Store external references, papers, benchmarks, and link notes here.\n- Leave a summary and applicability note alongside each entry.\n'
    },
    {
      relativePath: 'docs/tech-debt-tracker.md',
      body: '# Tech Debt Tracker\n\n| Date | Area | Debt | Risk | Cleanup Plan |\n|---|---|---|---|---|\n'
    }
  ];
}

async function bootstrapProjectRepoDocs(project) {
  if (!project?.rootPath) {
    return {
      enabled: false,
      generated: [],
      preservedExisting: [],
      skipped: ['root path unavailable'],
      generatedAt: now()
    };
  }
  const generated = [];
  const preservedExisting = [];
  for (const target of buildRepoBootstrapTargets(project)) {
    const absolutePath = path.join(project.rootPath, ...target.relativePath.split('/'));
    if (await fileExists(absolutePath)) {
      preservedExisting.push(target.relativePath);
      continue;
    }
    await ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, `${String(target.body || '').trim()}\n`, 'utf8');
    generated.push(target.relativePath);
  }
  return {
    enabled: true,
    generated,
    preservedExisting,
    generatedAt: now()
  };
}

async function loadProjectState(projectIdValue) {
  return readJson(projectStatePath(projectIdValue));
}

async function withLock(runId, action) {
  const previous = writeLocks.get(runId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  writeLocks.set(runId, previous.then(() => current));
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(runId) === current) {
      writeLocks.delete(runId);
    }
  }
}

async function saveState(state) {
  state.updatedAt = now();
  await writeJson(statePath(state.id), serializeState(state));
  bus.emit('run', { runId: state.id, type: 'state', state });
  return state;
}

async function appendFileLocked(targetPath, text) {
  const previous = appendLocks.get(targetPath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  appendLocks.set(targetPath, previous.then(() => current));
  await previous;
  try {
    await fs.appendFile(targetPath, text, 'utf8');
  } finally {
    release();
    if (appendLocks.get(targetPath) === current) {
      appendLocks.delete(targetPath);
    }
  }
}

function createBoundedOutputCollector(maxBytes = MAX_CAPTURED_PROCESS_OUTPUT_BYTES) {
  const chunks = [];
  let totalBytes = 0;
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk);
      if (!buffer.length) return;
      chunks.push(buffer);
      totalBytes += buffer.length;
      while (totalBytes > maxBytes && chunks.length > 1) {
        totalBytes -= chunks.shift().length;
      }
      if (totalBytes > maxBytes && chunks.length === 1) {
        const sliced = chunks[0].subarray(Math.max(0, chunks[0].length - maxBytes));
        chunks[0] = sliced;
        totalBytes = sliced.length;
      }
    },
    read() {
      return decodeProcessOutput(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
    }
  };
}

async function appendLog(runId, level, message, meta = {}) {
  const entry = { at: now(), level, message, meta };
  await withLock(runId, async () => {
    const recentLogs = [...(await readRecentLogs(runId)), entry].slice(-300);
    await writeJson(recentLogPath(runId), recentLogs);
    await fs.appendFile(logPath(runId), `${JSON.stringify(entry)}\n`, 'utf8');
  });
  bus.emit('run', { runId, type: 'log', entry });
}

async function appendTrace(runId, event, meta = {}) {
  const taskId = String(meta?.taskId || '').trim();
  const entry = {
    schemaVersion: '2',
    kind: 'trace',
    at: now(),
    runId,
    taskId,
    phase: String(event || '').split('.')[0] || '',
    event,
    meta
  };
  await appendFileLocked(tracePath(runId), `${JSON.stringify(entry)}\n`).catch(() => {});
}

async function appendTaskTrajectory(runId, taskId, kind, payload = {}) {
  if (!runId || !taskId) return;
  const entry = {
    schemaVersion: '1',
    at: now(),
    runId,
    taskId,
    kind,
    ...payload
  };
  await appendFileLocked(taskTrajectoryPath(runId, taskId), `${JSON.stringify(entry)}\n`).catch(() => {});
}

async function updateTask(runId, taskId, callback) {
  return withLock(runId, async () => {
    const state = await loadState(runId);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await callback(task, state);
    await saveState(state);
    return task;
  });
}

function resolveInputPath(inputPath, projectPath) {
  if (!inputPath) return '';
  const normalized = String(inputPath || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (path.isAbsolute(normalized)) return normalized;
  return path.resolve(projectPath || ROOT_DIR, normalized);
}

async function extractPdfText(filePath) {
  const script = [
    'import sys',
    'try:',
    '  from pypdf import PdfReader',
    'except Exception as exc:',
    '  print(f"ERROR:{exc}")',
    '  raise SystemExit(2)',
    'reader = PdfReader(sys.argv[1])',
    'parts = []',
    'for page in reader.pages[:50]:',
    '  parts.append(page.extract_text() or "")',
    'text = "\\n".join(parts).strip()',
    'if len(text) < 40:',
    '  print("ERROR:PDF extraction returned too little text")',
    '  raise SystemExit(3)',
    'print(text[:50000])'
  ].join('\n');
  const result = await runProcess('python', ['-c', script, filePath], ROOT_DIR, null, false);
  if (result.code !== 0 || String(result.stdout).startsWith('ERROR:')) {
    throw new Error(`PDF extraction failed for ${filePath}`);
  }
  return result.stdout.trim();
}

async function readSpecFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return extractPdfText(filePath);
  }

  const raw = await fs.readFile(filePath);
  if (!TEXT_EXTENSIONS.has(ext) && raw.includes(0)) {
    throw new Error('Binary file is not supported for direct ingestion');
  }
  return decodeTextBuffer(raw);
}

function clipLine(text, maxChars = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function clipBlock(text, maxChars = 1200) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

async function probeHttpUrl(targetUrl, timeoutMs = 1500) {
  if (!targetUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, { method: 'GET', signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpUrl(targetUrl, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await probeHttpUrl(targetUrl, 1500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startBackgroundCommand(commandLine, cwd, controller) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      : spawn('/bin/sh', ['-lc', commandLine], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });
    const stdoutCollector = createBoundedOutputCollector();
    const stderrCollector = createBoundedOutputCollector();
    if (controller) controller.children.add(child);
    child.stdout.on('data', (chunk) => stdoutCollector.push(chunk));
    child.stderr.on('data', (chunk) => stderrCollector.push(chunk));
    child.on('error', (error) => {
      if (controller) controller.children.delete(child);
      reject(error);
    });
    const closeListener = () => {
      if (controller) controller.children.delete(child);
    };
    child.on('close', closeListener);
    setTimeout(() => {
      resolve({
        child,
        readOutput() {
          return {
            stdout: stdoutCollector.read(),
            stderr: stderrCollector.read()
          };
        }
      });
    }, 250);
  });
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeActionPaths(values) {
  return uniqueBy(
    (Array.isArray(values) ? values : [])
      .map((item) => typeof item === 'string' ? item.trim() : String(item?.path || '').trim())
      .filter(Boolean),
    (item) => item.toLowerCase()
  ).slice(0, 8);
}

function normalizeActionTokens(values) {
  return uniqueBy(
    (Array.isArray(values) ? values : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
    (item) => item.toLowerCase()
  ).slice(0, 8);
}

export function buildActionReplayEnvelope(capabilityId, input, scope = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  return {
    schemaVersion: '2',
    kind: 'capability-input',
    replayable: ['memory-search', 'code-context', 'verification'].includes(capabilityId),
    capabilityId,
    phase: String(scope.phase || payload.stage || '').trim(),
    taskId: String(scope.taskId || payload.taskId || '').trim(),
    query: String(payload.query || '').trim(),
    command: String(payload.command || '').trim(),
    cwd: String(payload.cwd || '').trim(),
    filesLikely: normalizeActionPaths(payload.filesLikely),
    relatedFiles: normalizeActionPaths(payload.relatedFiles),
    symbolHints: normalizeActionTokens(payload.symbolHints)
  };
}

async function appendTaskActionRecord(runId, taskId, record) {
  await appendFileLocked(taskActionPath(runId, taskId), `${JSON.stringify(record)}\n`).catch(() => {});
}

async function appendRunActionRecord(runId, record) {
  await appendFileLocked(runActionPath(runId), `${JSON.stringify(record)}\n`).catch(() => {});
}

async function runTaskAction(runId, taskId, actionPolicy, capabilityId, input, executor, actionState = null) {
  const capability = TASK_CAPABILITY_REGISTRY[capabilityId];
  if (!capability) {
    throw new Error(`Unknown capability: ${capabilityId}`);
  }
  if (!actionPolicy.allowedActionClasses.includes(capability.actionClass)) {
    throw new Error(`Action class not allowed for task: ${capability.actionClass}`);
  }
  const actionId = `${Date.now()}-${capabilityId}-${Math.random().toString(16).slice(2, 8)}`;
  const replay = buildActionReplayEnvelope(capabilityId, input, { taskId });
  const baseRecord = {
    schemaVersion: '2',
    actionId,
    at: now(),
    runId,
    taskId,
    capabilityId,
    actionClass: capability.actionClass,
    provider: capability.provider,
    input: replay,
    replay
  };
  await appendTaskActionRecord(runId, taskId, {
    ...baseRecord,
    status: 'started'
  });
  await appendTrace(runId, 'task.action-started', {
    taskId,
    actionId,
    capabilityId,
    actionClass: capability.actionClass
  });
  await appendTaskTrajectory(runId, taskId, 'action-started', {
    actionId,
    capabilityId,
    actionClass: capability.actionClass,
    provider: capability.provider
  });
  try {
    const result = await executor();
    const output = summarizeActionOutput(capabilityId, result);
    await appendTaskActionRecord(runId, taskId, {
      ...baseRecord,
      status: 'completed',
      output
    });
    await appendTrace(runId, 'task.action-completed', {
      taskId,
      actionId,
      capabilityId,
      actionClass: capability.actionClass
    });
    await appendTaskTrajectory(runId, taskId, 'action-completed', {
      actionId,
      capabilityId,
      actionClass: capability.actionClass,
      output
    });
    if (actionState) {
      actionState.counts[capability.actionClass] = (actionState.counts[capability.actionClass] || 0) + 1;
      actionState.lastAction = {
        capabilityId,
        actionClass: capability.actionClass,
        provider: capability.provider,
        at: now(),
        summary: output.summary || output.message || output.stdout || output.query || capability.description
      };
    }
    return result;
  } catch (error) {
    await appendTaskActionRecord(runId, taskId, {
      ...baseRecord,
      status: 'failed',
      error: clipText(error?.message || 'Unknown action error', 220)
    });
    await appendTrace(runId, 'task.action-failed', {
      taskId,
      actionId,
      capabilityId,
      actionClass: capability.actionClass,
      error: clipText(error?.message || 'Unknown action error', 220)
    });
    await appendTaskTrajectory(runId, taskId, 'action-failed', {
      actionId,
      capabilityId,
      actionClass: capability.actionClass,
      error: clipText(error?.message || 'Unknown action error', 220)
    });
    throw error;
  }
}

async function runPhaseAction(runId, phase, capabilityId, input, executor, actionState = null) {
  const capability = TASK_CAPABILITY_REGISTRY[capabilityId];
  if (!capability) {
    throw new Error(`Unknown capability: ${capabilityId}`);
  }
  const actionId = `${Date.now()}-${phase}-${capabilityId}-${Math.random().toString(16).slice(2, 8)}`;
  const replay = buildActionReplayEnvelope(capabilityId, input, { phase });
  const baseRecord = {
    schemaVersion: '2',
    actionId,
    at: now(),
    runId,
    phase,
    capabilityId,
    actionClass: capability.actionClass,
    provider: capability.provider,
    input: replay,
    replay
  };
  await appendRunActionRecord(runId, {
    ...baseRecord,
    status: 'started'
  });
  await appendTrace(runId, 'run.action-started', {
    phase,
    actionId,
    capabilityId,
    actionClass: capability.actionClass
  });
  try {
    const result = await executor();
    const output = summarizeActionOutput(capabilityId, result);
    await appendRunActionRecord(runId, {
      ...baseRecord,
      status: 'completed',
      output
    });
    await appendTrace(runId, 'run.action-completed', {
      phase,
      actionId,
      capabilityId,
      actionClass: capability.actionClass
    });
    if (actionState) {
      actionState.counts[capability.actionClass] = (actionState.counts[capability.actionClass] || 0) + 1;
      actionState.lastAction = {
        capabilityId,
        actionClass: capability.actionClass,
        provider: capability.provider,
        at: now(),
        summary: output.summary || output.message || output.stdout || output.query || capability.description
      };
    }
    return result;
  } catch (error) {
    await appendRunActionRecord(runId, {
      ...baseRecord,
      status: 'failed',
      error: clipText(error?.message || 'Unknown action error', 220)
    });
    await appendTrace(runId, 'run.action-failed', {
      phase,
      actionId,
      capabilityId,
      actionClass: capability.actionClass,
      error: clipText(error?.message || 'Unknown action error', 220)
    });
    throw error;
  }
}

function normalizeClarifyQuestions(value) {
  const list = Array.isArray(value) ? value : [];
  return uniqueBy(
    list
      .map((item, index) => {
        if (typeof item === 'string') {
          const question = item.trim();
          if (!question) return null;
          return {
            id: `q_${slugify(question).slice(0, 24) || String(index + 1)}`,
            question,
            helpText: '',
            exampleAnswer: ''
          };
        }
        const question = String(item?.question || item?.prompt || '').trim();
        if (!question) return null;
        const rawId = String(item?.id || '').trim();
        return {
          id: rawId || `q_${slugify(question).slice(0, 24) || String(index + 1)}`,
          question,
          helpText: String(item?.helpText || item?.hint || '').trim(),
          exampleAnswer: String(item?.exampleAnswer || item?.example || '').trim()
        };
      })
      .filter(Boolean),
    (item) => item.id
  );
}

function normalizeClarifyAnswers(value, knownQuestions = []) {
  if (!value || typeof value !== 'object') return {};
  const questions = normalizeClarifyQuestions(knownQuestions);
  const byQuestionText = new Map(questions.map((item) => [item.question, item.id]));
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || '').trim();
    const answer = String(rawValue || '').trim();
    if (!key || !answer) continue;
    const matchedId = byQuestionText.get(key) || key;
    result[matchedId] = answer;
  }
  return result;
}

function questionLabel(questionId, questions = []) {
  const match = normalizeClarifyQuestions(questions).find((item) => item.id === questionId);
  return match?.question || questionId;
}

function openQuestionText(value) {
  return normalizeClarifyQuestions(value).map((item) => item.question);
}

async function probeCommand(command, args = [], cwd = ROOT_DIR) {
  try {
    const isCmdScript = process.platform === 'win32' && /\.cmd$/i.test(command);
    const result = process.platform === 'win32' && isCmdScript
      ? await runProcess('cmd.exe', ['/d', '/s', '/c', command, ...args], cwd, null, false)
      : await runProcess(command, args, cwd, null, false);
    const output = clipLine(result.stdout || result.stderr || `exit ${result.code}`);
    return {
      ok: result.code === 0,
      version: result.code === 0 ? output : '',
      error: result.code === 0 ? '' : output
    };
  } catch (error) {
    return {
      ok: false,
      version: '',
      error: clipLine(error.message || 'Command probe failed.')
    };
  }
}

async function buildEnvironmentDiagnostics() {
  const [codex, claude, gemini, git, node, python, playwright] = await Promise.all([
    probeCommand(process.platform === 'win32' ? 'codex.cmd' : 'codex', ['--version']),
    probeCommand(process.platform === 'win32' ? 'claude.cmd' : 'claude', ['--version']),
    probeCommand(process.platform === 'win32' ? 'gemini.cmd' : 'gemini', ['--version']),
    probeCommand('git', ['--version']),
    probeCommand('node', ['--version']),
    probeCommand('python', ['--version']),
    getPlaywrightAvailability()
  ]);
  return {
    codex,
    claude,
    gemini,
    git,
    node,
    python,
    playwright,
    geminiProject: String(process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '').trim()
  };
}

let analyzeProjectIntake;
let buildPreflight;
let buildProjectBrowserReadiness;
let buildProjectDiagnostics;
let diagnoseRunInputShape;

export { analyzeProjectIntake };

async function buildSpecBundle(input, resolvedSpecFiles, clarifyAnswers = {}, clarifyQuestions = []) {
  const sections = ['# Harness Objective', '', input.objective?.trim() || 'No objective provided.', ''];

  if (input.projectContext?.title || input.projectContext?.charterText || input.projectContext?.phaseTitle) {
    sections.push('# Project Context', '');
    if (input.projectContext?.title) sections.push(`- Project: ${input.projectContext.title}`);
    if (input.projectContext?.rootPath) sections.push(`- Root: ${input.projectContext.rootPath}`);
    if (input.projectContext?.phaseTitle) sections.push(`- Current phase: ${input.projectContext.phaseTitle}`);
    if (input.projectContext?.phaseGoal) sections.push(`- Phase goal: ${input.projectContext.phaseGoal}`);
    sections.push('');
    if (input.projectContext?.phaseContract) {
      sections.push('## Phase Contract', '');
      if (input.projectContext.phaseContract.goal) sections.push(input.projectContext.phaseContract.goal, '');
      sections.push('### Deliverables', '', ...(input.projectContext.phaseContract.deliverables || []).map((item) => `- ${item}`), '');
      sections.push('### Verification', '', ...(input.projectContext.phaseContract.verification || []).map((item) => `- ${item}`), '');
      sections.push('### Non-Negotiables', '', ...(input.projectContext.phaseContract.nonNegotiables || []).map((item) => `- ${item}`), '');
      sections.push('### Out Of Scope', '', ...(input.projectContext.phaseContract.outOfScope || []).map((item) => `- ${item}`), '');
    }
    if (input.projectContext?.charterText?.trim()) {
      sections.push('## Project Charter', '', input.projectContext.charterText.trim(), '');
    }
    if (input.projectContext?.continuationContext) {
      const continuation = input.projectContext.continuationContext;
      sections.push('## Continuation Pack', '');
      sections.push(`- Continuation mode: ${continuation.policyLabel || '-'}`);
      sections.push(`- Carry-over count: ${continuation.carryOverCount || 0}`);
      sections.push(`- Recent run count in phase: ${continuation.recentRunCount || 0}`);
      if (continuation.docsSyncExpectation) {
        sections.push(`- Docs sync rule: ${continuation.docsSyncExpectation}`);
      }
      if (Array.isArray(continuation.carryOverFocus) && continuation.carryOverFocus.length) {
        sections.push('', '### Carry-Over Focus', '');
        for (const item of continuation.carryOverFocus) {
          sections.push(`- ${item.taskId || '-'} ${item.title || ''}: ${item.summary || item.goal || '-'}`);
        }
      }
      if (Array.isArray(continuation.recentDocUpdates) && continuation.recentDocUpdates.length) {
        sections.push('', '### Recent Doc Updates', '');
        for (const item of continuation.recentDocUpdates) {
          sections.push(`- ${item.path}: ${item.note || item.runTitle || '-'}`);
        }
      }
      if (Array.isArray(continuation.recentRunSummaries) && continuation.recentRunSummaries.length) {
        sections.push('', '### Recent Run Outcomes', '');
        for (const item of continuation.recentRunSummaries) {
          sections.push(`- ${item.runTitle || item.runId || '-'} [${item.status || '-'}]: ${item.summary || '-'}`);
        }
      }
      if (continuation.latestQualitySweep?.summary) {
        sections.push('', '### Latest Quality Sweep', '', `- ${continuation.latestQualitySweep.summary}`);
      }
      sections.push('');
    }
  }

  if (input.executionProfile) {
    sections.push('# Execution Profile', '', ...executionProfileLines(input.executionProfile), '');
  }

  if (input.specText?.trim()) {
    sections.push('# Additional Notes', '', input.specText.trim(), '');
  }

  const answers = normalizeClarifyAnswers(clarifyAnswers, clarifyQuestions);
  if (Object.keys(answers).length > 0) {
    sections.push('# Clarification Answers', '');
    for (const [questionId, answer] of Object.entries(answers)) {
      sections.push(`## ${questionLabel(questionId, clarifyQuestions)}`, '', answer, '');
    }
  }

  for (const filePath of resolvedSpecFiles) {
    sections.push(`## Source: ${filePath}`, '');
    try {
      const content = (await readSpecFile(filePath)).trim();
      if (!content) {
        throw new Error('Spec file is empty after extraction.');
      }
      sections.push(content);
    } catch (error) {
      sections.push(`[Skipped] ${error.message}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

async function readSnippetIfExists(filePath, maxChars = 1400) {
  try {
    return clipBlock(await readSpecFile(filePath), maxChars);
  } catch {
    return '';
  }
}

const PROJECT_INTEL_HELPERS = {
  clipLargeContext,
  clipLine,
  fileExists,
  readJson,
  readSnippetIfExists,
  readSpecFile,
  runProcess,
  uniqueBy
};

({
  analyzeProjectIntake,
  buildPreflight,
  buildProjectBrowserReadiness,
  buildProjectDiagnostics,
  diagnoseRunInputShape
} = createProjectWorkflow({
  DEFAULT_HARNESS_SETTINGS,
  buildEnvironmentDiagnostics,
  clipLargeContext,
  getHarnessSettings,
  localizedText,
  normalizeAgentProvider,
  normalizeBrowserVerificationConfig,
  normalizeDevServerConfig,
  normalizeLanguage,
  now,
  parsePorcelain,
  projectIntelHelpers: PROJECT_INTEL_HELPERS,
  providerDisplayName,
  resolveGitProject,
  resolveInputPath,
  runGit,
  uniqueBy
}));

function clipLargeContext(text, maxChars = 2200) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.max(800, Math.floor(maxChars * 0.65)));
  const tail = value.slice(-Math.max(300, Math.floor(maxChars * 0.2)));
  return `${head}\n\n... [truncated] ...\n\n${tail}`;
}

function categorizeValidationCommand(commandLine) {
  const value = String(commandLine || '').toLowerCase();
  if (/\btest\b|pytest|cargo test|go test/.test(value)) return 'test';
  if (value.includes('typecheck')) return 'typecheck';
  if (/\blint\b/.test(value)) return 'lint';
  if (/\bbuild\b/.test(value)) return 'build';
  if (/\bcheck\b/.test(value)) return 'check';
  return 'other';
}

function selectVerificationCommands(run, task) {
  const commands = Array.isArray(run.projectContext?.validationCommands) ? run.projectContext.validationCommands : [];
  if (!commands.length) return [];

  const text = [
    task.title,
    task.goal,
    ...(task.acceptanceChecks || []),
    ...(task.constraints || [])
  ].join('\n').toLowerCase();

  const preferredCategories = [];
  if (/(bug|regression|reproduce|failing|test)/.test(text) || (run.preset?.id || '') === 'existing-repo-bugfix') {
    preferredCategories.push('test');
  }
  if (/(type|tsc|compile type)/.test(text)) preferredCategories.push('typecheck');
  if (/(lint|format|style)/.test(text)) preferredCategories.push('lint');
  if (/(build|bundle|compile)/.test(text)) preferredCategories.push('build');
  preferredCategories.push('check');

  const selected = [];
  for (const category of preferredCategories) {
    const match = commands.find((commandLine) => categorizeValidationCommand(commandLine) === category && !selected.includes(commandLine));
    if (match) selected.push(match);
    if (selected.length >= 2) break;
  }

  if (!selected.length) {
    const fallback = commands.find((commandLine) => ['test', 'check', 'lint'].includes(categorizeValidationCommand(commandLine)));
    if (fallback) selected.push(fallback);
  }

  return selected.slice(0, 2);
}

function getPreset(presetId) {
  return RUN_PRESETS.find((preset) => preset.id === presetId) || RUN_PRESETS[0];
}

function presetSummary(presetId) {
  const preset = getPreset(presetId);
  return `${preset.name}: ${preset.description}`;
}

function normalizeFlowProfile(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return ['sequential', 'hierarchical', 'hybrid'].includes(candidate) ? candidate : 'sequential';
}

function hasOwnSetting(settings, key) {
  return Boolean(settings) && Object.prototype.hasOwnProperty.call(settings, key);
}

function getProfileDefaults(presetId) {
  return RUN_PROFILE_DEFAULTS[presetId] || RUN_PROFILE_DEFAULTS.auto;
}

function getRunOperationDefaults(presetId) {
  return RUN_OPERATION_DEFAULTS[presetId] || RUN_OPERATION_DEFAULTS.auto;
}

function buildRunProfile(preset, settings = {}) {
  const defaults = getProfileDefaults(preset?.id || 'auto');
  return {
    flowProfile: normalizeFlowProfile(hasOwnSetting(settings, 'flowProfile') ? settings.flowProfile : defaults.flowProfile),
    maxParallel: Math.max(1, Number(hasOwnSetting(settings, 'maxParallel') ? settings.maxParallel : defaults.maxParallel) || defaults.maxParallel),
    taskBudget: Math.max(1, Number(hasOwnSetting(settings, 'taskBudget') ? settings.taskBudget : defaults.taskBudget) || defaults.taskBudget),
    fileBudget: Math.max(1, Number(hasOwnSetting(settings, 'fileBudget') ? settings.fileBudget : defaults.fileBudget) || defaults.fileBudget),
    diagnosisFirst: hasOwnSetting(settings, 'diagnosisFirst') ? settings.diagnosisFirst !== false : defaults.diagnosisFirst !== false,
    replanThreshold: String(hasOwnSetting(settings, 'replanThreshold') ? settings.replanThreshold : defaults.replanThreshold).trim() || defaults.replanThreshold,
    freshSessionThreshold: String(hasOwnSetting(settings, 'freshSessionThreshold') ? settings.freshSessionThreshold : defaults.freshSessionThreshold).trim() || defaults.freshSessionThreshold
  };
}

function executionProfileLines(profile) {
  if (!profile) return [];
  return [
    `- Flow profile: ${profile.flowProfile || 'sequential'}`,
    `- Max parallel: ${profile.maxParallel ?? '-'}`,
    `- Task budget: ${profile.taskBudget ?? '-'}`,
    `- File budget: ${profile.fileBudget ?? '-'}`,
    `- Diagnosis-first: ${profile.diagnosisFirst === false ? 'optional' : 'required'}`,
    `- Replan threshold: ${profile.replanThreshold || '-'}`,
    `- Fresh session threshold: ${profile.freshSessionThreshold || '-'}`
  ];
}

function defaultExecutionPolicy(profile = null) {
  return {
    pattern: 'pipeline',
    parallelMode: profile?.flowProfile || 'sequential',
    policyNotes: profile ? [
      `Task budget: ${profile.taskBudget}`,
      `File budget: ${profile.fileBudget}`,
      `Diagnosis-first: ${profile.diagnosisFirst === false ? 'optional' : 'required'}`,
      `Fresh session threshold: ${profile.freshSessionThreshold}`
    ] : [],
    syntheticTasks: [],
    verificationNudgeNeeded: false
  };
}

function taskContainsText(task, patterns) {
  const haystack = [
    task.title,
    task.goal,
    ...(task.constraints || []),
    ...(task.acceptanceChecks || [])
  ].join('\n').toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

function injectSyntheticTask(rawTasks, taskShape, position = 'prepend') {
  return position === 'prepend' ? [taskShape, ...rawTasks] : [...rawTasks, taskShape];
}

function injectLeadingGateTask(rawTasks, taskShape) {
  return injectSyntheticTask(
    rawTasks.map((task) => ({
      ...task,
      dependsOn: Array.isArray(task?.dependsOn) && task.dependsOn.length
        ? task.dependsOn.map(String)
        : ['__RAW_0']
    })),
    {
      ...taskShape,
      dependsOn: Array.isArray(taskShape?.dependsOn) ? taskShape.dependsOn.map(String) : []
    },
    'prepend'
  );
}

function hasMultiDependencyTask(tasks) {
  return tasks.some((task) => Array.isArray(task.dependsOn) && task.dependsOn.length >= 2);
}

function taskHasFailedAcceptanceCheck(task) {
  return normalizeAcceptanceCheckResults(task?.lastExecution?.acceptanceCheckResults)
    .some((item) => item.status === 'fail');
}

function taskHistoryRank(task) {
  const lastRunAt = Date.parse(task?.lastExecution?.lastRunAt || '') || 0;
  const statusWeight = task?.status === 'failed'
    ? 3
    : (task?.status === 'in_progress' ? 2 : (task?.status === 'ready' ? 1 : 0));
  return lastRunAt + (Number(task?.attempts || 0) * 1000) + statusWeight;
}

function compactTaskLedgerLine(task, focusTaskId = '') {
  const bits = [`${task.id} ${task.status || 'unknown'}`];
  if (focusTaskId && task.id === focusTaskId) bits.push('FOCUS');
  if (task.attempts) bits.push(`attempts=${task.attempts}`);
  if (taskHasFailedAcceptanceCheck(task)) bits.push('acceptance=failed');
  if (task.reviewSummary) {
    bits.push(clipText(task.reviewSummary, 120));
  } else if (task.goal) {
    bits.push(clipText(task.goal, 120));
  }
  return bits.join(' | ');
}

export function buildContinuationPromptLines(run, focusTaskId = '') {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const activeTask = tasks.find((task) => task.id === focusTaskId)
    || tasks.find((task) => task.status === 'in_progress')
    || tasks.find((task) => task.status === 'ready')
    || tasks.find((task) => task.status === 'failed')
    || null;
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    ready: tasks.filter((task) => task.status === 'ready').length,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length
  };
  const recentTasks = tasks
    .filter((task) => task.attempts || isTaskTerminalStatus(task.status) || task.status === 'in_progress' || task.id === focusTaskId)
    .sort((left, right) => taskHistoryRank(right) - taskHistoryRank(left))
    .slice(0, 5)
    .map((task) => compactTaskLedgerLine(task, focusTaskId));

  const summaryParts = [];
  if (!counts.total) {
    summaryParts.push('No prior task execution is recorded yet.');
  } else {
    summaryParts.push(`tasks=${counts.total}`);
    summaryParts.push(`done=${counts.done}`);
    summaryParts.push(`failed=${counts.failed}`);
    if (counts.inProgress) summaryParts.push(`in_progress=${counts.inProgress}`);
    if (counts.ready) summaryParts.push(`ready=${counts.ready}`);
  }
  if (run?.goalLoops) summaryParts.push(`goalLoops=${run.goalLoops}`);
  if (run?.result?.summary) summaryParts.push(`latestResult=${clipText(run.result.summary, 140)}`);
  if (run?.autoReplan?.latest?.summary) summaryParts.push(`latestReplan=${clipText(run.autoReplan.latest.summary, 140)}`);

  const lines = [
    'Continuation context:',
    `- Summary: ${summaryParts.join(' | ')}`,
    activeTask ? `- Current focus: ${activeTask.id} ${activeTask.title}` : '- Current focus: none',
    run?.profile
      ? `- Active profile: flow=${run.profile.flowProfile || 'sequential'} | taskBudget=${run.profile.taskBudget ?? '-'} | fileBudget=${run.profile.fileBudget ?? '-'} | diagnosisFirst=${run.profile.diagnosisFirst === false ? 'optional' : 'required'}`
      : '- Active profile: default',
    run?.profile?.freshSessionThreshold
      ? `- Fresh session policy: ${run.profile.freshSessionThreshold}. If this threshold is crossed, stop and recommend a fresh session instead of forcing more replans.`
      : '- Fresh session policy: none',
    run?.project?.phaseTitle
      ? `- Current phase boundary: stay inside ${run.project.phaseTitle}${run.project.phaseGoal ? ` | ${run.project.phaseGoal}` : ''}`
      : '- Current phase boundary: current run objective only',
    '- Direct resume rule: Continue from the latest unresolved task, failed check, or review decision. Do not restate the entire run history unless it changes the next action.'
  ];
  if (recentTasks.length) {
    lines.push('- Compact task ledger:');
    for (const item of recentTasks) {
      lines.push(`  - ${item}`);
    }
  }
  return lines;
}

function isDocsOnlyPath(filePath) {
  return /^docs\//i.test(filePath) || /\.(md|mdx|txt)$/i.test(filePath);
}

function taskLooksDocsOnly(task) {
  const files = normalizeTaskFiles(task?.filesLikely);
  if (files.length > 0 && files.every((filePath) => isDocsOnlyPath(filePath))) return true;
  return taskContainsText(task, ['readme', 'docs', 'spec', 'acceptance', 'requirements', 'architecture'])
    && !taskContainsText(task, ['test', 'verify', 'verification', 'bug', 'fix', 'feature', 'refactor', 'api', 'schema', 'migration']);
}

function planLooksDocsOnly(rawTasks) {
  return rawTasks.length > 0 && rawTasks.every((task) => taskLooksDocsOnly(task));
}

function taskHasVerificationIntent(task) {
  return taskContainsText(task, [
    'verify',
    'verification',
    'validated',
    'test',
    'tests',
    'lint',
    'typecheck',
    'build',
    'smoke',
    'reproduce',
    'regression',
    'pytest',
    'npm run',
    'pnpm ',
    'cargo test',
    'go test',
    'curl ',
    'returns ',
    'exits '
  ]);
}

function planNeedsVerificationNudge(run, rawTasks) {
  const validationCommands = Array.isArray(run?.projectContext?.validationCommands) ? run.projectContext.validationCommands : [];
  if (!rawTasks.length) return false;
  if (planLooksDocsOnly(rawTasks)) return false;
  if (!validationCommands.length && (run?.preset?.id || '') !== 'existing-repo-bugfix') return false;
  return !rawTasks.some((task) => taskHasVerificationIntent(task));
}

function taskNeedsDiagnosis(task, fileBudget = 0) {
  const files = normalizeTaskFiles(task?.filesLikely);
  if (!files.length) return true;
  if (fileBudget && files.length > fileBudget) return true;
  return taskContainsText(task, ['foundation', 'architecture', 'wire', 'bootstrap', 'set up', 'scaffold'])
    && !taskContainsText(task, ['diagnose', 'analysis', 'inspect', 'map', 'audit', 'reproduce', 'verify']);
}

function planHasDiagnosisTask(rawTasks) {
  return rawTasks.some((task) => taskContainsText(task, ['diagnose', 'analysis', 'inspect', 'map', 'audit', 'reproduce', 'verify'])
    || /read-only|do not implement|do not edit/i.test((task?.constraints || []).join('\n')));
}

export function applyPlanPolicy(run, parsed) {
  let rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((item) => ({ ...item })) : [];
  const pattern = String(run.clarify?.architecturePattern || 'pipeline').trim() || 'pipeline';
  const worktreeEligible = run?.preflight?.project?.worktreeEligible !== false;
  const policy = {
    ...defaultExecutionPolicy(run.profile),
    pattern
  };

  if (pattern === 'fan-out/fan-in' || pattern === 'expert-pool') {
    policy.parallelMode = 'parallel';
  }
  if (pattern === 'pipeline' || pattern === 'producer-reviewer' || pattern === 'supervisor') {
    policy.parallelMode = 'sequential';
  }
  if ((run?.profile?.flowProfile || 'sequential') === 'hybrid') {
    policy.parallelMode = 'parallel';
    policy.policyNotes.push('Hybrid flow profile keeps parallel execution available when filesLikely are clearly disjoint.');
  } else {
    policy.parallelMode = 'sequential';
  }
  if (policy.parallelMode === 'parallel' && !worktreeEligible) {
    policy.parallelMode = 'sequential';
    policy.policyNotes.push('Parallel execution was downgraded because isolated worktrees are unavailable for this repo state.');
  }

  if (run?.profile?.diagnosisFirst && !planLooksDocsOnly(rawTasks) && !planHasDiagnosisTask(rawTasks)) {
    const fileBudget = Number(run?.profile?.fileBudget || 0);
    const needsDiagnosis = (run?.preset?.id || '') === 'greenfield-app'
      || rawTasks.some((task) => taskNeedsDiagnosis(task, fileBudget));
    if (needsDiagnosis) {
      rawTasks = injectLeadingGateTask(rawTasks, {
        title: 'Diagnose current phase scope and lock implementation boundaries',
        goal: 'Narrow down the current phase goal, excluded scope, and concrete filesLikely before handing off to implementation tasks.',
        dependsOn: [],
        filesLikely: [],
        constraints: [
          'Read-only diagnosis.',
          'Do not implement changes yet.',
          'Do not expand scope beyond the current project phase.'
        ],
        acceptanceChecks: [
          `filesLikely for follow-on tasks is narrowed to within file budget ${fileBudget || '-'}.`,
          'Current phase goal and excluded scope are written back into the backlog.'
        ]
      });
      policy.syntheticTasks.push('diagnosis-first');
      policy.policyNotes.push('Diagnosis-first profile injected a read-only scoping task before implementation.');
    }
  }

  if (run?.profile?.taskBudget && rawTasks.length > Number(run.profile.taskBudget)) {
    policy.policyNotes.push(`Planned task count (${rawTasks.length}) exceeds the active task budget (${run.profile.taskBudget}). Keep this run scoped to the current phase slice.`);
  }

  if ((run.preset?.id || 'auto') === 'existing-repo-bugfix') {
    policy.parallelMode = 'sequential';
    if (!rawTasks.some((task) => taskContainsText(task, ['reproduce', 'regression', 'failing', 'test']))) {
      rawTasks = injectLeadingGateTask(rawTasks, {
        title: 'Reproduce the bug before implementation',
        goal: 'Identify a failing check, reproduction path, or precise before-state for the reported bug before changing behavior.',
        dependsOn: [],
        filesLikely: [],
        constraints: ['Do not implement the fix yet.', 'Capture a reproducible failing check or exact reproduction steps first.'],
        acceptanceChecks: ['A failing test, command, or explicit reproduction path is documented for later validation.']
      });
      policy.syntheticTasks.push('bugfix-repro');
      policy.policyNotes.push('Bugfix preset injected a reproduction task before implementation.');
    }
  }

  if ((run.preset?.id || 'auto') === 'docs-spec-first') {
    if (!rawTasks.some((task) => taskContainsText(task, ['spec', 'acceptance', 'doc', 'docs', 'requirements']))) {
      rawTasks = injectLeadingGateTask(rawTasks, {
        title: 'Lock the spec and acceptance criteria',
        goal: 'Clarify the spec, acceptance criteria, and excluded scope before implementation begins.',
        dependsOn: [],
        filesLikely: ['README.md', 'docs/'],
        constraints: ['Do not start implementation until the spec task is complete.'],
        acceptanceChecks: ['Acceptance criteria and exclusions are written down in repo docs or the task handoff.']
      });
      policy.syntheticTasks.push('docs-spec');
      policy.policyNotes.push('Docs-first preset injected a spec-alignment task before implementation.');
    }
  }

  if (pattern === 'fan-out/fan-in' && rawTasks.length >= 2 && !hasMultiDependencyTask(rawTasks)) {
    const fanOutCandidates = rawTasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => !Array.isArray(task.dependsOn) || task.dependsOn.length === 0)
      .slice(0, 4);
    if (fanOutCandidates.length >= 2) {
      rawTasks = injectSyntheticTask(rawTasks, {
        title: 'Integrate fan-out task results',
        goal: 'Combine and validate the outputs of the parallel implementation tasks into one coherent result.',
        dependsOn: fanOutCandidates.map(({ index }) => `__RAW_${index}`),
        filesLikely: [],
        constraints: ['Review the outputs of parallel tasks together before finalizing.'],
        acceptanceChecks: ['Integration changes are validated against the combined acceptance criteria.']
      }, 'append');
      policy.syntheticTasks.push('fan-in');
      policy.policyNotes.push('Fan-out/fan-in pattern injected an explicit integration task.');
    }
  }

  if (planNeedsVerificationNudge(run, rawTasks)) {
    rawTasks = injectSyntheticTask(rawTasks, {
      title: 'Verify the integrated changes mechanically',
      goal: 'Inspect the changed workspace without editing files, run the smallest applicable verification commands, and record evidence for every acceptance check.',
      dependsOn: rawTasks.map((_, index) => `__RAW_${index}`),
      filesLikely: [],
      constraints: ['Read-only verification.', 'Do not edit any files.', 'Use the harness-selected verification commands when they apply.'],
      acceptanceChecks: [
        'The selected verification commands exit 0 or each failure is captured precisely.',
        'Each acceptance check is marked PASS, FAIL, or UNABLE-TO-VERIFY with evidence.'
      ]
    }, 'append');
    policy.syntheticTasks.push('verification-nudge');
    policy.policyNotes.push('A read-only verification task was injected because the original plan lacked an explicit mechanical verification step.');
    policy.verificationNudgeNeeded = true;
  }

  return { rawTasks, policy };
}

function clipText(text, maxChars = 1200) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function summarizeGlobalAgents(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const picked = lines.filter((line) => /^\d+\./.test(line) || line.startsWith('- ') || line.startsWith('## 행동 원칙')).slice(0, 10);
  return clipBlock(picked.join('\n'), 1200);
}

function summarizeKarpathyGuidelines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const picked = lines.filter((line) => /^##\s+\d+\./.test(line) || line.startsWith('- ') || line.includes('Think Before Coding') || line.includes('Simplicity First')).slice(0, 12);
  return clipBlock(picked.join('\n'), 1200);
}

async function loadGlobalPromptSources() {
  const [agentsText, karpathyText] = await Promise.all([
    readSnippetIfExists(GLOBAL_AGENTS_FILE, 2200),
    readSnippetIfExists(KARPATHY_SKILL_FILE, 2200)
  ]);
  return {
    agentsSummary: summarizeGlobalAgents(agentsText),
    karpathySummary: summarizeKarpathyGuidelines(karpathyText)
  };
}

async function loadProjectPromptSource(projectPath) {
  if (!projectPath) return null;
  for (const relativePath of ['.codex/AGENTS.md', 'AGENTS.md', '.harness-web/AGENTS.md']) {
    const absolutePath = path.join(projectPath, ...relativePath.split('/'));
    const summary = await readSnippetIfExists(absolutePath, 2200);
    if (!summary) continue;
    return {
      path: relativePath,
      summary
    };
  }
  return null;
}

function buildPromptSourceReport(settings, projectPromptSource) {
  const language = normalizeLanguage(settings?.uiLanguage || settings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage);
  const activeSources = [];
  if (projectPromptSource?.summary) {
    activeSources.push({
      scope: 'project-local',
      label: projectPromptSource.path,
      summary: clipText(projectPromptSource.summary, 240)
    });
  }
  if (settings?.customConstitution) {
    activeSources.push({
      scope: 'machine-local',
      label: '.harness-web/settings.json#customConstitution',
      summary: clipText(settings.customConstitution, 240)
    });
  }
  if (settings?.includeGlobalAgents && settings?.globalAgentsSummary) {
    activeSources.push({
      scope: 'user-global',
      label: GLOBAL_AGENTS_FILE,
      summary: clipText(settings.globalAgentsSummary, 240)
    });
  }
  if (settings?.includeKarpathyGuidelines && settings?.karpathySummary) {
    activeSources.push({
      scope: 'user-global',
      label: KARPATHY_SKILL_FILE,
      summary: clipText(settings.karpathySummary, 240)
    });
  }
  const shadowedSources = activeSources.length > 1 ? activeSources.slice(1) : [];
  return {
    precedence: localizedText(language, 'project-local > machine-local > user-global > repo-docs fallback', 'project-local > machine-local > user-global > repo-docs fallback'),
    activeSources,
    shadowedSources,
    shadowingNote: shadowedSources.length
      ? localizedText(language, `${activeSources[0].label}가 현재 최우선이며, 나머지 ${shadowedSources.length}개 source는 더 낮은 우선순위 안내로만 적용됩니다.`, `${activeSources[0].label} currently wins and the remaining ${shadowedSources.length} source(s) only apply as lower-priority guidance.`)
      : localizedText(language, '더 높은 우선순위 source가 다른 source를 가리고 있지 않습니다.', 'No higher-priority prompt source is shadowing another source.')
  };
}

export async function getHarnessSettings(projectPath = '') {
  await ensureDir(HARNESS_META_DIR);
  const saved = await readJson(HARNESS_SETTINGS_FILE).catch(() => ({}));
  const globalSources = await loadGlobalPromptSources();
  const projectPromptSource = await loadProjectPromptSource(projectPath);
  const normalizeLanguage = (value, fallback = 'en') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'en' || normalized === 'ko') return normalized;
    return fallback;
  };
  const resolved = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...saved,
    codexRuntimeProfile: normalizeCodexRuntimeProfile(saved.codexRuntimeProfile, DEFAULT_HARNESS_SETTINGS.codexRuntimeProfile),
    coordinationProvider: normalizeAgentProvider(saved.coordinationProvider, DEFAULT_HARNESS_SETTINGS.coordinationProvider),
    workerProvider: normalizeAgentProvider(saved.workerProvider, DEFAULT_HARNESS_SETTINGS.workerProvider),
    uiLanguage: normalizeLanguage(saved.uiLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage),
    agentLanguage: normalizeLanguage(saved.agentLanguage, DEFAULT_HARNESS_SETTINGS.agentLanguage),
    codexNotes: String(saved.codexNotes || '').trim(),
    claudeNotes: String(saved.claudeNotes || '').trim(),
    geminiNotes: String(saved.geminiNotes || '').trim(),
    claudeModel: String(saved.claudeModel || '').trim(),
    geminiModel: String(saved.geminiModel || DEFAULT_HARNESS_SETTINGS.geminiModel).trim() || DEFAULT_HARNESS_SETTINGS.geminiModel,
    geminiProjectId: String(saved.geminiProjectId || '').trim(),
    globalAgentsSummary: globalSources.agentsSummary,
    karpathySummary: globalSources.karpathySummary
  };
  return {
    ...resolved,
    projectLocalPromptPath: projectPromptSource?.path || '',
    projectLocalPromptSummary: projectPromptSource?.summary || '',
    promptSourceReport: buildPromptSourceReport(resolved, projectPromptSource)
  };
}

export async function updateHarnessSettings(input = {}) {
  await ensureDir(HARNESS_META_DIR);
  const current = await getHarnessSettings();
  const normalizeLanguage = (value, fallback = 'en') => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'en' || normalized === 'ko') return normalized;
    return fallback;
  };
  const next = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...current,
    includeGlobalAgents: input.includeGlobalAgents !== false,
    includeKarpathyGuidelines: input.includeKarpathyGuidelines !== false,
    customConstitution: String(input.customConstitution || '').trim(),
    plannerStrategy: String(input.plannerStrategy || '').trim(),
    teamStrategy: String(input.teamStrategy || '').trim(),
    codexRuntimeProfile: normalizeCodexRuntimeProfile(input.codexRuntimeProfile, current.codexRuntimeProfile || DEFAULT_HARNESS_SETTINGS.codexRuntimeProfile),
    uiLanguage: normalizeLanguage(input.uiLanguage, current.uiLanguage || DEFAULT_HARNESS_SETTINGS.uiLanguage),
    agentLanguage: normalizeLanguage(input.agentLanguage, current.agentLanguage || DEFAULT_HARNESS_SETTINGS.agentLanguage),
    codexNotes: String(input.codexNotes || '').trim(),
    coordinationProvider: normalizeAgentProvider(input.coordinationProvider, current.coordinationProvider || DEFAULT_HARNESS_SETTINGS.coordinationProvider),
    workerProvider: normalizeAgentProvider(input.workerProvider, current.workerProvider || DEFAULT_HARNESS_SETTINGS.workerProvider),
    claudeNotes: String(input.claudeNotes || '').trim(),
    geminiNotes: String(input.geminiNotes || '').trim(),
    claudeModel: String(input.claudeModel || '').trim(),
    geminiModel: String(input.geminiModel || DEFAULT_HARNESS_SETTINGS.geminiModel).trim() || DEFAULT_HARNESS_SETTINGS.geminiModel,
    geminiProjectId: String(input.geminiProjectId || '').trim()
  };
  await writeJson(HARNESS_SETTINGS_FILE, {
    includeGlobalAgents: next.includeGlobalAgents,
    includeKarpathyGuidelines: next.includeKarpathyGuidelines,
    customConstitution: next.customConstitution,
    plannerStrategy: next.plannerStrategy,
    teamStrategy: next.teamStrategy,
    codexRuntimeProfile: next.codexRuntimeProfile,
    uiLanguage: next.uiLanguage,
    agentLanguage: next.agentLanguage,
    codexNotes: next.codexNotes,
    coordinationProvider: next.coordinationProvider,
    workerProvider: next.workerProvider,
    claudeNotes: next.claudeNotes,
    geminiNotes: next.geminiNotes,
    claudeModel: next.claudeModel,
    geminiModel: next.geminiModel,
    geminiProjectId: next.geminiProjectId
  });
  return getHarnessSettings();
}

function buildHarnessGuidanceLines(harnessConfig, target, provider = 'codex') {
  const lines = [];
  const preferredLanguage = String(harnessConfig?.agentLanguage || DEFAULT_HARNESS_SETTINGS.agentLanguage).trim().toLowerCase() === 'en' ? 'English' : 'Korean';
  lines.push(`Preferred user-facing language: ${preferredLanguage}.`);
  lines.push(`Write clarification questions, plan summaries, review summaries, and operator-facing explanations in ${preferredLanguage} unless the repo context clearly requires another language.`);
  if (harnessConfig?.promptSourceReport?.precedence) {
    lines.push(`Instruction precedence: ${harnessConfig.promptSourceReport.precedence}`);
  }
  if (harnessConfig?.projectLocalPromptSummary) {
    lines.push(`Project-local instruction (${harnessConfig.projectLocalPromptPath || 'AGENTS.md'}): ${clipText(harnessConfig.projectLocalPromptSummary, 1200)}`);
  }
  if (harnessConfig?.customConstitution) {
    lines.push(`Local harness constitution: ${clipText(harnessConfig.customConstitution, 1200)}`);
  }
  if (harnessConfig?.includeGlobalAgents && harnessConfig?.globalAgentsSummary) {
    lines.push(`Global AGENTS summary: ${clipText(harnessConfig.globalAgentsSummary, 1000)}`);
  }
  if (harnessConfig?.includeKarpathyGuidelines && harnessConfig?.karpathySummary) {
    lines.push(`Karpathy guidelines summary: ${clipText(harnessConfig.karpathySummary, 1000)}`);
  }
  if (target === 'planner' && harnessConfig?.plannerStrategy) {
    lines.push(`Planner strategy notes: ${clipText(harnessConfig.plannerStrategy, 1200)}`);
  }
  if (target === 'planner' && harnessConfig?.teamStrategy) {
    lines.push(`Team strategy notes: ${clipText(harnessConfig.teamStrategy, 1200)}`);
  }
  if (target === 'planner') {
    lines.push(`Default provider profile: coordination=${providerDisplayName(harnessConfig?.coordinationProvider || 'codex')} | worker=${providerDisplayName(harnessConfig?.workerProvider || 'codex')}`);
    if (provider === 'codex') {
      lines.push('Planner policy: prefer small, dependency-aware task graphs over wide speculative fan-out.');
    }
  }
  const providerNotes = resolveProviderNotes(harnessConfig, provider);
  if (providerNotes) {
    lines.push(`${providerDisplayName(provider)} notes: ${clipText(providerNotes, 1000)}`);
  }
  return lines;
}

function preferredUserFacingLanguage(harnessConfig) {
  return String(harnessConfig?.agentLanguage || DEFAULT_HARNESS_SETTINGS.agentLanguage).trim().toLowerCase() === 'en' ? 'English' : 'Korean';
}

function writeInPreferredLanguageRule(harnessConfig, fieldsDescription) {
  return `${fieldsDescription} in ${preferredUserFacingLanguage(harnessConfig)} unless the repository and user input clearly require another language.`;
}

function plannerTaskSizingRule(run) {
  const fileBudget = Number(run?.profile?.fileBudget || 0);
  if ((run?.preset?.id || '') === 'docs-spec-first') {
    return `- For docs/spec alignment tasks, keep each task inside the active file budget (${fileBudget || 4} filesLikely). Prefer 1-2 files, but allow up to the budget when the docs must move as one tightly related bundle.`;
  }
  return '- Each task should usually touch only 1 file, and at most 2-3 files when tightly related.';
}

function plannerParallelRule(run, policy) {
  const maxParallel = Number(run?.profile?.maxParallel || run?.settings?.maxParallel || 1);
  const worktreeEligible = run?.preflight?.project?.worktreeEligible !== false;
  if (!worktreeEligible) {
    return '- Shared-workspace fallback is active. Plan sequentially even if the preset normally allows limited parallelism.';
  }
  if ((policy?.parallelMode || 'sequential') === 'parallel') {
    return `- Parallelize only when filesLikely are clearly disjoint. Keep the runnable batch small (at most ${maxParallel} tasks at a time).`;
  }
  return '- Parallelize only when filesLikely are clearly disjoint.';
}

function presetPolicyBaseline(run) {
  switch (run?.preset?.id || 'auto') {
    case 'docs-spec-first':
      return {
        constitution: 'Keep docs and acceptance criteria as the source of record for the current phase. Prefer doc-bundle alignment before broad implementation, and only use limited parallelism on clean worktrees.',
        planner: 'Start with the smallest scope-locking or doc-alignment slice. Group tightly related docs when they must move together, but keep parallel batches small and disjoint.',
        team: 'Lean on spec-locker and verifier to lock scope and evidence before treating the phase as ready for implementation.'
      };
    case 'existing-repo-bugfix':
      return {
        constitution: 'Preserve current behavior until a failing path is reproduced. Favor the smallest safe diff that closes the bug and its regression check.',
        planner: 'Make reproduction or before-state capture explicit before the fix. Keep the graph sequential unless the validation path is clearly independent.',
        team: 'Use a strong bug reproducer and verifier pairing. Do not fan out implementation before the failing path is pinned down.'
      };
    case 'existing-repo-feature':
      return {
        constitution: 'Extend the current repo in bounded slices. Preserve adjacent behavior and docs contracts while landing only the requested feature scope.',
        planner: 'Split work by disjoint subsystems or filesLikely sets. Add explicit verification whenever behavior changes.',
        team: 'Keep planning and review on the coordination provider, with implementation parallelism only for truly disjoint slices.'
      };
    case 'refactor-stabilize':
      return {
        constitution: 'Preserve behavior while restructuring. Prefer reversible slices and keep verification close to each refactor step.',
        planner: 'Use smaller sequential tasks than feature work, and keep acceptance checks focused on unchanged observable behavior.',
        team: 'Bias toward verifier-heavy loops and avoid wide parallel refactors in the same subsystem.'
      };
    case 'greenfield-app':
      return {
        constitution: 'Lock architecture and boundaries before broad build-out. Grow the app in staged slices with explicit validation per slice.',
        planner: 'Insert diagnosis or scaffold-locking work before broad implementation when the subsystem map is still uncertain.',
        team: 'Use planner/integrator structure to keep greenfield fan-out coherent, but do not skip the initial scoping pass.'
      };
    default:
      return {
        constitution: 'Keep the run scoped to the current objective and phase slice, with the smallest safe diff and explicit verification.',
        planner: 'Prefer dependency-aware task graphs over speculative breadth. Only parallelize when the scope is clearly disjoint.',
        team: 'Keep planning and review conservative by default, and let implementation fan out only when the file boundaries are stable.'
      };
  }
}

function buildProjectPromptLines(run) {
  if (!run?.project) return [];
  const lines = [
    `Project container: ${run.project.title} (${run.project.id})`
  ];
  if (run.project.phaseTitle) {
    lines.push(`Current project phase: ${run.project.phaseTitle}${run.project.phaseGoal ? ` | ${run.project.phaseGoal}` : ''}`);
  }
  if (run.project.phaseContractPath) {
    lines.push(`Phase contract: ${run.project.phaseContractPath}`);
  }
  if (run.project.charterPath) {
    lines.push(`Project charter: ${run.project.charterPath}`);
  }
  if (run.project.continuationContext?.policyLabel) {
    lines.push(`Continuation mode: ${run.project.continuationContext.policyLabel}`);
  }
  if (Array.isArray(run.project.continuationContext?.carryOverFocus) && run.project.continuationContext.carryOverFocus.length) {
    lines.push(`Carry-over focus: ${run.project.continuationContext.carryOverFocus.map((item) => `${item.taskId} ${item.title}`.trim()).join(' | ')}`);
  }
  if (Array.isArray(run.project.continuationContext?.recentDocUpdates) && run.project.continuationContext.recentDocUpdates.length) {
    lines.push(`Recent doc updates: ${run.project.continuationContext.recentDocUpdates.map((item) => item.path).join(' | ')}`);
  }
  return lines;
}

function buildHarnessGuidanceDocument(run) {
  const teamBlueprint = run.harnessConfig?.teamBlueprint || deriveTeamBlueprint(run);
  const executionPolicy = run.executionPolicy || defaultExecutionPolicy(run.profile);
  const presetBaseline = presetPolicyBaseline(run);
  const planningPrior = buildProjectPlanningPriorLines(run.memory, run);
  const providerProfile = resolveRunProviderProfile(run);
  const lines = [
    '# Harness Guidance',
    '',
    'This file is generated per run from the local web settings and the current harness policy.',
    '',
    '## Objective',
    '',
    `- Title: ${run.title}`,
    `- Objective: ${run.clarify?.clarifiedObjective || run.input?.objective || '-'}`,
    `- Preset: ${presetSummary(run.preset?.id || 'auto')}`,
    `- Pattern: ${run.clarify?.architecturePattern || 'pipeline'}`,
    `- Execution model: ${run.executionModel || run.clarify?.executionModel || defaultExecutionModelHint(run)}`,
    '',
    '## Execution Profile',
    '',
    ...executionProfileLines(run.profile),
    '',
    '## Effective Policy',
    '',
    `- Parallel mode: ${executionPolicy.parallelMode || 'sequential'}`,
    `- Provider profile: coordination=${providerDisplayName(providerProfile.coordinationProvider)} | worker=${providerDisplayName(providerProfile.workerProvider)}`,
    `- Synthetic tasks: ${(executionPolicy.syntheticTasks || []).join(', ') || 'None'}`,
    `- Policy notes: ${(executionPolicy.policyNotes || []).join(' | ') || 'None'}`,
    '- Automatic replanning: refine only ready tasks, preserve the clarified objective/spec, and stop for human review when drift risk is high.',
    ''
  ];

  if (run.project) {
    lines.push('## Project Container', '');
    lines.push(`- Project: ${run.project.title} (${run.project.id})`);
    if (run.project.rootPath) lines.push(`- Root: ${run.project.rootPath}`);
    if (run.project.phaseTitle) lines.push(`- Current phase: ${run.project.phaseTitle}`);
    if (run.project.phaseGoal) lines.push(`- Phase goal: ${run.project.phaseGoal}`);
    if (run.project.phaseContractPath) lines.push(`- Phase contract file: ${run.project.phaseContractPath}`);
    if (run.project.charterPath) lines.push(`- Charter file: ${run.project.charterPath}`);
    if (run.project.phaseContract) {
      lines.push(`- Deliverables: ${(run.project.phaseContract.deliverables || []).join(' | ') || '-'}`);
      lines.push(`- Verification: ${(run.project.phaseContract.verification || []).join(' | ') || '-'}`);
    }
    if (run.project.continuationContext?.docsSyncExpectation) {
      lines.push(`- Docs sync rule: ${run.project.continuationContext.docsSyncExpectation}`);
    }
    if (Array.isArray(run.project.continuationContext?.recentRunSummaries) && run.project.continuationContext.recentRunSummaries.length) {
      lines.push(`- Recent runs: ${run.project.continuationContext.recentRunSummaries.map((item) => `${item.runTitle || item.runId} [${item.status}]`).join(' | ')}`);
    }
    lines.push('- Rule: plan and execute only the current phase slice. Do not expand to the whole product in one run.', '');
  }

  lines.push('## Local Constitution', '');
  if (run.harnessConfig?.customConstitution) {
    lines.push(run.harnessConfig.customConstitution, '');
  } else {
    lines.push('- No custom constitution set in local web settings.', '');
  }

  lines.push('## Preset Baseline', '');
  lines.push(`- Constitution: ${presetBaseline.constitution}`);
  lines.push(`- Planner: ${presetBaseline.planner}`);
  lines.push(`- Team: ${presetBaseline.team}`, '');

  lines.push('## Project-Specific Planning Prior', '');
  if (planningPrior.length) {
    lines.push(...planningPrior, '');
  } else {
    lines.push('- No project-specific prior has been learned yet.', '');
  }

  lines.push('## Effective Prompt Sources', '');
  if (run.harnessConfig?.promptSourceReport?.precedence) {
    lines.push(`- Precedence: ${run.harnessConfig.promptSourceReport.precedence}`);
  }
  if (Array.isArray(run.harnessConfig?.promptSourceReport?.activeSources) && run.harnessConfig.promptSourceReport.activeSources.length > 0) {
    for (const source of run.harnessConfig.promptSourceReport.activeSources) {
      lines.push(`- [${source.scope}] ${source.label}: ${clipText(source.summary, 180)}`);
    }
    if (run.harnessConfig.promptSourceReport.shadowingNote) {
      lines.push(`- Shadowing: ${run.harnessConfig.promptSourceReport.shadowingNote}`);
    }
    lines.push('');
  } else {
    lines.push('- No additional prompt sources were resolved.', '');
  }

  if (run.harnessConfig?.plannerStrategy || run.harnessConfig?.teamStrategy || run.harnessConfig?.codexNotes || run.harnessConfig?.claudeNotes || run.harnessConfig?.geminiNotes) {
    lines.push('## Model Notes', '');
    if (run.harnessConfig?.plannerStrategy) lines.push(`- Planner: ${run.harnessConfig.plannerStrategy}`);
    if (run.harnessConfig?.teamStrategy) lines.push(`- Team: ${run.harnessConfig.teamStrategy}`);
    if (run.harnessConfig?.codexNotes) lines.push(`- Codex: ${run.harnessConfig.codexNotes}`);
    if (run.harnessConfig?.claudeNotes) lines.push(`- Claude: ${run.harnessConfig.claudeNotes}`);
    if (run.harnessConfig?.geminiNotes) lines.push(`- Gemini: ${run.harnessConfig.geminiNotes}`);
    lines.push('');
  }

  lines.push('## Starter Team Blueprint', '');
  for (const agent of teamBlueprint) {
    lines.push(`- ${agent.name} (${agent.model}): ${agent.role} | ${agent.responsibility}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeHarnessGuidanceDoc(run) {
  await fs.writeFile(harnessGuidancePath(run.id), buildHarnessGuidanceDocument(run), 'utf8');
}

async function buildPromptContextExcerpts(run) {
  const specExcerpt = await readSnippetIfExists(path.join(runDir(run.id), 'input', 'spec-bundle.md'), 1800);
  const projectExcerpt = await readSnippetIfExists(path.join(runDir(run.id), 'context', 'project-summary.md'), 1800);
  const guidanceExcerpt = await readSnippetIfExists(harnessGuidancePath(run.id), 1400);
  return [
    specExcerpt ? `Spec excerpt:\n${specExcerpt}` : 'Spec excerpt: unavailable',
    projectExcerpt ? `Project summary excerpt:\n${projectExcerpt}` : 'Project summary excerpt: unavailable',
    guidanceExcerpt ? `Harness guidance excerpt:\n${guidanceExcerpt}` : 'Harness guidance excerpt: unavailable'
  ];
}

function deriveTeamBlueprint(run) {
  const presetId = run.preset?.id || 'auto';
  const flowProfile = run.profile?.flowProfile || 'sequential';
  const pattern = run.clarify?.architecturePattern || (flowProfile === 'hybrid' ? 'fan-out/fan-in' : 'pipeline');
  const providerProfile = resolveRunProviderProfile(run);
  const base = [
    { name: 'planner', model: providerProfile.coordinationProvider, role: 'Plans the run, task graph, and team responsibilities.' },
    { name: 'implementer', model: providerProfile.workerProvider, role: 'Executes coding tasks in the repo.' },
    { name: 'verifier', model: providerProfile.coordinationProvider, role: 'Reviews task artifacts, diffs, and verification results.' },
    { name: 'goal-judge', model: providerProfile.coordinationProvider, role: 'Decides if the objective is achieved or if new tasks are needed.' }
  ];
  if (presetId === 'existing-repo-bugfix') {
    base.splice(1, 0, { name: 'bug-reproducer', model: providerProfile.coordinationProvider, role: 'Pins down the failing path or regression before implementation.' });
  }
  if (presetId === 'docs-spec-first') {
    base.splice(1, 0, { name: 'spec-locker', model: providerProfile.coordinationProvider, role: 'Locks scope, acceptance, and exclusions before coding starts.' });
  }
  if (pattern === 'fan-out/fan-in' || pattern === 'expert-pool') {
    base.push({ name: 'integrator', model: providerProfile.coordinationProvider, role: 'Combines outputs from parallel tasks into one validated result.' });
  }
  if (pattern === 'producer-reviewer') {
    base.push({ name: 'producer-reviewer-loop', model: providerProfile.coordinationProvider, role: 'Keeps producer and reviewer tasks converging instead of drifting.' });
  }
  return base;
}

function resolveAgentModel(run, agentName, fallback) {
  const normalizedFallback = normalizeAgentProvider(fallback, 'codex');
  const candidates = [
    ...(Array.isArray(run?.agents) ? run.agents : []),
    ...(Array.isArray(run?.harnessConfig?.teamBlueprint) ? run.harnessConfig.teamBlueprint : [])
  ];
  const match = candidates.find((agent) => String(agent?.name || '').trim() === agentName);
  return normalizeAgentProvider(match?.model, normalizedFallback);
}

function resolveStageProvider(run, stage) {
  const profile = resolveRunProviderProfile(run);
  if (stage === 'implementer') return resolveAgentModel(run, 'implementer', profile.workerProvider);
  if (stage === 'verifier') return resolveAgentModel(run, 'verifier', profile.coordinationProvider);
  if (stage === 'goal-judge') return resolveAgentModel(run, 'goal-judge', profile.coordinationProvider);
  if (stage === 'planner') return resolveAgentModel(run, 'planner', profile.coordinationProvider);
  return profile.coordinationProvider;
}

async function rewriteSpecBundle(run) {
  await fs.writeFile(
    path.join(runDir(run.id), 'input', 'spec-bundle.md'),
    await buildSpecBundle(
      {
        ...run.input,
        projectContext: run.project
          ? {
              title: run.project.title,
              rootPath: run.project.rootPath,
              phaseTitle: run.project.phaseTitle,
              phaseGoal: run.project.phaseGoal,
              phaseContract: run.project.phaseContract || null,
              continuationContext: run.project.continuationContext || null,
              charterText: run.project.charterText || ''
            }
          : null,
        executionProfile: run.profile || null
      },
      run.input.specFiles || [],
      run.humanLoop?.clarifyAnswers,
      run.humanLoop?.clarifyQuestions || run.clarify?.openQuestions
    ),
    'utf8'
  );
}

function buildMemoryPromptLines(memory) {
  const lines = [
    memory?.memoryFile ? `Long-term memory file: ${memory.memoryFile}` : 'Long-term memory file: none',
    memory?.dailyDir ? `Daily memory directory: ${memory.dailyDir}` : 'Daily memory directory: none',
    memory?.searchBackend ? `Memory search backend: ${memory.searchBackend}` : 'Memory search backend: none',
    `Memory summary: ${clipText(memory?.recentSummary || 'None', 900)}`,
    `Retrieved memory context: ${clipText(memory?.retrievedContext || 'None', 1200)}`
  ];
  if (memory?.failureAnalytics) {
    lines.push(`Failure analytics: retries=${memory.failureAnalytics.retryCount || 0} | verificationFailures=${memory.failureAnalytics.verificationFailures || 0} | scopeDrift=${memory.failureAnalytics.scopeDriftCount || 0}`);
    if (Number(memory.failureAnalytics.retryPressure || 0) > 0 || Number(memory.failureAnalytics.verificationPressure || 0) > 0 || Number(memory.failureAnalytics.scopeDriftPressure || 0) > 0) {
      lines.push(`Failure pressure: retry=${memory.failureAnalytics.retryPressure || 0} | verification=${memory.failureAnalytics.verificationPressure || 0} | scopeDrift=${memory.failureAnalytics.scopeDriftPressure || 0}`);
    }
  }
  if (memory?.traceSummary) {
    lines.push(`Trace memory summary: artifacts=${memory.traceSummary.artifactCount || 0} | tasks=${memory.traceSummary.taskCount || 0} | lastDecision=${memory.traceSummary.lastDecision || 'none'}`);
  }
  if (Array.isArray(memory?.graphInsights?.topEdges) && memory.graphInsights.topEdges.length > 0) {
    lines.push(`Graph memory edges: ${memory.graphInsights.topEdges.slice(0, 4).map((item) => item.edge).join(' | ')}`);
  }
  if (Array.isArray(memory?.graphInsights?.topSymbols) && memory.graphInsights.topSymbols.length > 0) {
    lines.push(`Graph memory symbols: ${memory.graphInsights.topSymbols.slice(0, 6).map((item) => item.symbol).join(', ')}`);
  }
  if (memory?.temporalInsights) {
    const topDecision = memory.temporalInsights.activeDecisions?.[0];
    const hotFiles = (memory.temporalInsights.activeFiles || []).slice(0, 3).map((item) => item.filePath).join(', ');
    lines.push(`Temporal memory: recentShare=${memory.temporalInsights.recentShare || 0} | hottestDecision=${topDecision?.decision || 'none'} | hottestFiles=${hotFiles || 'none'}`);
  }

  if (Array.isArray(memory?.searchResults) && memory.searchResults.length > 0) {
    lines.push('Relevant memory hits:');
    for (const hit of memory.searchResults.slice(0, 4)) {
      const rankBits = [];
      if (hit?.taskId) rankBits.push(`task=${hit.taskId}`);
      if (hit?.stage) rankBits.push(`stage=${hit.stage}`);
      lines.push(`- [${hit.kind}] ${hit.title}: ${clipText(hit.snippet || '', 220)}${rankBits.length ? ` (${rankBits.join(', ')})` : ''}`);
    }
  } else {
    lines.push('Relevant memory hits: none');
  }

  return lines;
}

export function buildProjectPlanningPriorLines(memory, run = null) {
  const lines = [];
  const failures = memory?.failureAnalytics || {};
  const trace = memory?.traceSummary || {};
  const temporal = memory?.temporalInsights || {};
  if (Number(failures.scopeDriftCount || 0) > 0) {
    lines.push('- Project-specific prior: recent runs drifted scope. Lock excluded scope and filesLikely before widening the graph.');
  }
  if (Number(failures.verificationFailures || 0) > 0) {
    lines.push('- Project-specific prior: recent runs failed verification. Put explicit mechanical checks close to each code-changing task.');
  }
  if (Number(failures.retryCount || 0) > 1 || String(trace.lastDecision || '').trim().toLowerCase() === 'retry') {
    lines.push('- Project-specific prior: recent runs needed retries. Prefer smaller slices and a materially different approach when a path already failed.');
  }
  if (run?.project?.phaseTitle) {
    lines.push(`- Project-specific prior: keep the plan inside the active phase boundary (${run.project.phaseTitle}).`);
  }
  const memoryExamples = (Array.isArray(memory?.searchResults) ? memory.searchResults : [])
    .filter((item) => ['retry-plan', 'execution-summary', 'review-verdict', 'task-memory', 'artifact-memory'].includes(String(item?.kind || '').trim()))
    .slice(0, 2)
    .map((item) => {
      const bits = [item.title, clipText(item.snippet || '', 120)].filter(Boolean);
      return bits.join(' | ');
    });
  if (memoryExamples.length) {
    lines.push(`- Grounding examples from project memory: ${memoryExamples.join(' || ')}`);
  }
  if (Array.isArray(memory?.graphInsights?.topEdges) && memory.graphInsights.topEdges.length > 0) {
    lines.push(`- Project-specific prior: recent graph edges touched together: ${memory.graphInsights.topEdges.slice(0, 3).map((item) => item.edge).join(' | ')}`);
  }
  if (Number(temporal.recentShare || 0) >= 0.55 && Array.isArray(temporal.activeFiles) && temporal.activeFiles.length > 0) {
    lines.push(`- Project-specific prior: recent memory dominates. Start from these hot files before reopening older areas: ${temporal.activeFiles.slice(0, 3).map((item) => item.filePath).join(' | ')}`);
  }
  if (Array.isArray(temporal.activeRootCauses) && temporal.activeRootCauses.length > 0) {
    lines.push(`- Project-specific prior: recurring recent root causes: ${temporal.activeRootCauses.slice(0, 2).map((item) => item.reason).join(' | ')}`);
  }
  return lines;
}

async function resolvePromptMemory(run, query, limit = 4, options = {}) {
  if (!run.memory?.projectKey) {
    return {
      memoryFile: '',
      dailyDir: '',
      recentSummary: '',
      searchQuery: '',
      searchResults: [],
      retrievedContext: 'No relevant project memory found.',
      searchBackend: 'none',
      failureAnalytics: null,
      traceSummary: null,
      graphInsights: { topEdges: [], topSymbols: [] },
      temporalInsights: { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
    };
  }
  return searchProjectMemory(ROOT_DIR, run.memory.projectKey, query, limit, {
    projectPath: run.projectPath || ''
  }, options);
}

async function applyMemorySnapshot(runId, snapshot) {
  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    fresh.memory = {
      ...fresh.memory,
      dir: snapshot.baseDir,
      memoryFile: snapshot.memoryFile,
      dailyDir: snapshot.dailyDir,
      dailyFile: snapshot.dailyFile,
      indexFile: snapshot.indexFile,
      recentSummary: snapshot.recentSummary,
      searchQuery: snapshot.searchQuery,
      searchResults: snapshot.searchResults,
      retrievedContext: snapshot.retrievedContext,
      searchBackend: snapshot.searchBackend,
      failureAnalytics: snapshot.failureAnalytics || null,
      traceSummary: snapshot.traceSummary || null,
      graphInsights: snapshot.graphInsights || { topEdges: [], topSymbols: [] },
      temporalInsights: snapshot.temporalInsights || { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
    };
    await saveState(fresh);
  });
}

async function refreshRunMemory(runId, query) {
  const run = await loadState(runId);
  const snapshot = await resolvePromptMemory(
    run,
    query || run.clarify?.clarifiedObjective || run.input.objective || run.title,
    4
  );
  await applyMemorySnapshot(runId, snapshot);
  return snapshot;
}

function buildClarifyPrompt(run, memory, provider = 'codex') {
  const clarifyQuestions = normalizeClarifyQuestions(run.humanLoop?.clarifyQuestions || run.clarify?.openQuestions);
  const answers = normalizeClarifyAnswers(run.humanLoop?.clarifyAnswers, clarifyQuestions);
  const providerName = providerDisplayName(provider);
  return [
    `You are ${providerName} acting as the harness clarifier.`,
    'Read the spec bundle and project summary files from disk before answering.',
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    ...buildMemoryPromptLines(memory),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'clarifier', provider),
    run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
    ...buildProjectPromptLines(run),
    '',
    `User-selected preset: ${presetSummary(run.preset?.id || 'auto')}`,
    `Known clarify answers: ${Object.keys(answers).length ? JSON.stringify(
      Object.entries(answers).map(([id, answer]) => ({ id, question: questionLabel(id, clarifyQuestions), answer }))
    ) : 'None'}`,
    `Allowed harness patterns: ${HARNESS_PATTERNS.join(', ')}`,
    '',
    'Return JSON only with this shape:',
    '{',
    '  "clarifiedObjective":"string",',
    '  "scopeSummary":"string",',
    '  "assumptions":["string"],',
    '  "openQuestions":[{"id":"string","question":"string","helpText":"string","exampleAnswer":"string"}],',
    '  "recommendedPresetId":"string",',
    '  "architecturePattern":"string",',
    '  "executionModel":"string"',
    '}',
    'Rules:',
    '- Clarify the objective into a buildable engineering target.',
    writeInPreferredLanguageRule(run.harnessConfig, 'Write clarifiedObjective, scopeSummary, assumptions, executionModel, and open question text'),
    '- Keep openQuestions only for real ambiguities that may affect implementation.',
    '- Each open question must have a stable id. Reuse an existing id when the same question is being asked again.',
    '- Every open question must be easy for a non-technical operator to answer on first read.',
    '- Ask one decision per question. Prefer short either-or questions or a direct "what should happen?" question.',
    '- Avoid internal harness jargon such as backlog, verification contract, landed baseline, taxonomy, or execution model unless absolutely necessary. If unavoidable, explain it in plain language in the same sentence.',
    '- Add helpText as one short plain-language sentence that explains why the answer matters.',
    '- Add exampleAnswer as one short example the user can copy and edit.',
    '- Pick one harness pattern from the allowed list.',
    '- If the user selected a non-auto preset, keep it unless clearly wrong.',
    '- No markdown, no prose outside JSON.'
  ].join('\n');
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
      windowsHide: true
    }).on('error', () => {
      try { child.kill(); } catch {}
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function runProcess(command, args, cwd, controller, track = true, envOverrides = null, timeoutMs = 0, stdinText = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
      ...(process.platform !== 'win32' ? { detached: true } : {})
    });

    if (controller && track) {
      controller.children.add(child);
    }

    const stdoutCollector = createBoundedOutputCollector();
    const stderrCollector = createBoundedOutputCollector();

    child.stdout.on('data', (chunk) => {
      stdoutCollector.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrCollector.push(chunk);
    });
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs)
      : null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (controller && track) controller.children.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (controller && track) controller.children.delete(child);
      const stdout = stdoutCollector.read();
      const stderr = stderrCollector.read();
      resolve({
        code: timedOut ? -1 : code,
        stdout,
        stderr: timedOut
          ? [stderr, `Process timed out after ${Math.round(timeoutMs / 1000)}s.`].filter(Boolean).join('\n')
          : stderr,
        timedOut
      });
    });
    child.stdin.end(stdinText || undefined);
  });
}

async function runCodex(prompt, cwd, settings, controller) {
  const outputFileName = `.harness-agent-output-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`;
  const outputFilePath = path.join(cwd, outputFileName);
  const args = buildCodexExecArgs(settings, outputFileName);
  const result = process.platform === 'win32'
    ? await runProcess('cmd.exe', ['/d', '/s', '/c', 'codex.cmd', ...args], cwd, controller, true, null, CODEX_TIMEOUT_MS, prompt)
    : await runProcess('codex', args, cwd, controller, true, null, CODEX_TIMEOUT_MS, prompt);
  const lastMessage = await fs.readFile(outputFilePath, 'utf8').catch(() => '');
  await fs.rm(outputFilePath, { force: true }).catch(() => {});
  return {
    ...result,
    rawStdout: result.stdout,
    stdout: lastMessage.trim() || result.stdout
  };
}

async function runFileBackedAgentPrompt(providerCommand, prompt, cwd, controller, timeoutMs, argsBuilder, envOverrides = null) {
  const shouldStreamPromptViaStdin = Boolean(process.env.FAKE_HARNESS_PROVIDER_STATE || process.env.FAKE_CODEX_STATE);
  if (shouldStreamPromptViaStdin) {
    const args = argsBuilder('-');
    return process.platform === 'win32'
      ? runProcess('cmd.exe', ['/d', '/s', '/c', `${providerCommand}.cmd`, ...args], cwd, controller, true, envOverrides, timeoutMs, prompt)
      : runProcess(providerCommand, args, cwd, controller, true, envOverrides, timeoutMs, prompt);
  }
  const promptFileName = `.harness-${providerCommand}-prompt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.md`;
  const promptFilePath = path.join(cwd, promptFileName);
  const launcherPrompt = `Read and execute the task instructions in this file first: ${promptFilePath}`;
  await fs.writeFile(promptFilePath, prompt, 'utf8');
  try {
    const args = argsBuilder(launcherPrompt);
    return process.platform === 'win32'
      ? runProcess('cmd.exe', ['/d', '/s', '/c', `${providerCommand}.cmd`, ...args], cwd, controller, true, envOverrides, timeoutMs)
      : runProcess(providerCommand, args, cwd, controller, true, envOverrides, timeoutMs);
  } finally {
    await fs.rm(promptFilePath, { force: true }).catch(() => {});
  }
}

async function runClaude(prompt, cwd, settings, controller) {
  return runFileBackedAgentPrompt(
    'claude',
    prompt,
    cwd,
    controller,
    CLAUDE_TIMEOUT_MS,
    (launcherPrompt) => {
      const args = [
        '-p',
        launcherPrompt,
        '--output-format',
        'text',
        '--dangerously-skip-permissions'
      ];
      if (settings.claudeModel) {
        args.push('--model', settings.claudeModel);
      }
      return args;
    }
  );
}

async function runGemini(prompt, cwd, settings, controller) {
  const geminiProjectId = String(settings.geminiProjectId || '').trim();
  const envOverrides = geminiProjectId
    ? {
        GOOGLE_CLOUD_PROJECT: geminiProjectId,
        GOOGLE_CLOUD_PROJECT_ID: geminiProjectId
      }
    : null;
  return runFileBackedAgentPrompt(
    'gemini',
    prompt,
    cwd,
    controller,
    GEMINI_TIMEOUT_MS,
    (launcherPrompt) => {
      const args = [
        '-p',
        launcherPrompt,
        '--approval-mode',
        'yolo',
        '--output-format',
        'text'
      ];
      if (settings.geminiModel) {
        args.push('--model', settings.geminiModel);
      }
      return args;
    },
    envOverrides
  );
}

async function runAgentProvider(provider, prompt, cwd, settings, controller) {
  const normalized = normalizeAgentProvider(provider, 'codex');
  if (normalized === 'claude') return runClaude(prompt, cwd, settings, controller);
  if (normalized === 'gemini') return runGemini(prompt, cwd, settings, controller);
  return runCodex(prompt, cwd, settings, controller);
}

async function runCommandLine(commandLine, cwd, controller) {
  if (process.platform === 'win32') {
    return runProcess('cmd.exe', ['/d', '/s', '/c', commandLine], cwd, controller, true, null, COMMAND_TIMEOUT_MS);
  }
  return runProcess('/bin/sh', ['-lc', commandLine], cwd, controller, true, null, COMMAND_TIMEOUT_MS);
}

async function runGit(cwd, args, controller = null, track = false) {
  return runProcess('git', args, cwd, controller, track);
}

function normalizeTaskFiles(filesLikely) {
  return [...new Set(
    (Array.isArray(filesLikely) ? filesLikely : [])
      .map((item) => String(item || '').trim().replace(/\\/g, '/'))
      .filter((item) => item && item !== '*')
  )];
}

async function writeTaskDiffPlaceholder(currentTaskDir, message) {
  await fs.writeFile(path.join(currentTaskDir, 'diff.patch'), message.trim() + '\n', 'utf8');
  await fs.writeFile(path.join(currentTaskDir, 'changed-files.json'), JSON.stringify([], null, 2), 'utf8');
}

async function snapshotTaskFiles(run, task, snapshotDir) {
  const targets = normalizeTaskFiles(task.filesLikely);
  const manifest = [];
  await ensureDir(snapshotDir);

  for (const relativePath of targets) {
    const source = path.resolve(run.projectPath || runDir(run.id), relativePath);
    const stat = await fs.stat(source).catch(() => null);
    const snapshotPath = path.join(snapshotDir, relativePath);
    const entry = {
      relativePath,
      existedBefore: Boolean(stat?.isFile()),
      snapshotPath
    };
    if (stat?.isFile()) {
      await ensureDir(path.dirname(snapshotPath));
      await fs.copyFile(source, snapshotPath);
    }
    manifest.push(entry);
  }

  await fs.writeFile(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function restoreSharedTaskFiles(run, task) {
  const snapshotDir = taskSnapshotDir(run.id, task.id);
  const manifest = await readJson(path.join(snapshotDir, 'manifest.json')).catch(() => []);
  if (!manifest.length) {
    return {
      ok: false,
      message: 'Rollback unavailable because no scoped snapshot was recorded.'
    };
  }

  for (const entry of manifest) {
    const targetPath = path.resolve(run.projectPath || runDir(run.id), entry.relativePath);
    if (entry.existedBefore) {
      await ensureDir(path.dirname(targetPath));
      await fs.copyFile(entry.snapshotPath, targetPath);
      continue;
    }
    await fs.rm(targetPath, { force: true }).catch(() => {});
  }

  return {
    ok: true,
    message: `Shared workspace rollback restored ${manifest.length} scoped file(s).`
  };
}

async function buildTaskDiff(run, task, currentTaskDir) {
  const snapshotDir = taskSnapshotDir(run.id, task.id);
  const manifestPath = path.join(snapshotDir, 'manifest.json');
  const manifest = await readJson(manifestPath).catch(() => []);
  if (!manifest.length) {
    await writeTaskDiffPlaceholder(currentTaskDir, 'Diff unavailable: no scoped filesLikely were provided for this task.');
    return [];
  }

  const diffSections = [];
  const changedFiles = [];
  const emptyFile = path.join(snapshotDir, '.empty');
  await fs.writeFile(emptyFile, '', 'utf8');

  for (const entry of manifest) {
    const currentFile = path.resolve(run.projectPath || runDir(run.id), entry.relativePath);
    const currentStat = await fs.stat(currentFile).catch(() => null);
    const snapshotStat = await fs.stat(entry.snapshotPath).catch(() => null);
    const left = snapshotStat?.isFile() ? entry.snapshotPath : emptyFile;
    const right = currentStat?.isFile() ? currentFile : emptyFile;

    const beforeBuffer = snapshotStat?.isFile() ? await fs.readFile(entry.snapshotPath) : Buffer.alloc(0);
    const afterBuffer = currentStat?.isFile() ? await fs.readFile(currentFile) : Buffer.alloc(0);
    if (beforeBuffer.equals(afterBuffer)) {
      continue;
    }

    const diffArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'git', 'diff', '--no-index', '--no-ext-diff', '--', left, right]
      : ['diff', '--no-index', '--no-ext-diff', '--', left, right];
    const diffResult = await runProcess(
      process.platform === 'win32' ? 'cmd.exe' : 'git',
      diffArgs,
      run.projectPath || runDir(run.id),
      null,
      false
    );

    const output = String(diffResult.stdout || diffResult.stderr || '').trim();
    diffSections.push(output || `diff -- task ${entry.relativePath}\n(Binary or unsupported diff output)`);
    changedFiles.push({
      path: entry.relativePath,
      existedBefore: Boolean(snapshotStat?.isFile()),
      existsAfter: Boolean(currentStat?.isFile())
    });
  }

  const patchText = diffSections.length
    ? diffSections.join('\n\n')
    : 'No scoped file changes detected for this task.\n';
  await fs.writeFile(path.join(currentTaskDir, 'diff.patch'), patchText.endsWith('\n') ? patchText : patchText + '\n', 'utf8');
  await fs.writeFile(path.join(currentTaskDir, 'changed-files.json'), JSON.stringify(changedFiles, null, 2), 'utf8');
  return changedFiles;
}

async function resolveGitProject(projectPath) {
  if (!projectPath) return null;
  const result = await runGit(projectPath, ['rev-parse', '--show-toplevel'], null, false);
  if (result.code !== 0) return null;
  return String(result.stdout || '').trim();
}

async function isGitWorktreeClean(projectPath) {
  const result = await runGit(projectPath, ['status', '--porcelain'], null, false);
  if (result.code !== 0) return false;
  return !String(result.stdout || '').trim();
}

function parsePorcelain(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const pathValue = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return {
        status,
        path: pathValue.replace(/\\/g, '/')
      };
    });
}

function diffRepoStatus(before = [], after = []) {
  const beforeMap = new Map(before.map((item) => [item.path, item.status]));
  return after.filter((item) => beforeMap.get(item.path) !== item.status);
}

function fileMatchesScope(filePath, scopes) {
  const rawPath = String(filePath || '').replace(/\\/g, '/');
  const normalizedPath = process.platform === 'win32' ? rawPath.toLowerCase() : rawPath;
  const normalizedScopes = normalizeFilesLikely(scopes);
  if (!normalizedPath || normalizedScopes.includes('*')) return true;
  return normalizedScopes.some((scope) => {
    const rawScope = String(scope || '').replace(/\\/g, '/');
    const normalizedScope = process.platform === 'win32' ? rawScope.toLowerCase() : rawScope;
    return normalizedPath === normalizedScope
      || normalizedPath.startsWith(`${normalizedScope}/`)
      || normalizedScope.startsWith(`${normalizedPath}/`);
  });
}

async function prepareTaskExecution(run, task, currentTaskDir) {
  const gitRoot = await resolveGitProject(run.projectPath || '');
  const scopedFiles = normalizeTaskFiles(task.filesLikely);
  const repoStatusBefore = gitRoot
    ? parsePorcelain((await runGit(gitRoot, ['status', '--porcelain=v1'], null, false)).stdout)
    : [];
  if (!gitRoot || !scopedFiles.length) {
    return {
      mode: 'shared',
      cwd: run.projectPath || runDir(run.id),
      reviewCwd: run.projectPath || runDir(run.id),
      repoRoot: gitRoot || '',
      repoStatusBefore,
      cleanup: async () => {}
    };
  }

  if (!(await isGitWorktreeClean(gitRoot))) {
    await appendLog(run.id, 'warning', `Task ${task.id} is using shared workspace because the git worktree is dirty.`, {
      taskId: task.id
    });
    return {
      mode: 'shared',
      cwd: run.projectPath || runDir(run.id),
      reviewCwd: run.projectPath || runDir(run.id),
      repoRoot: gitRoot,
      repoStatusBefore,
      cleanup: async () => {}
    };
  }

  const workspaceDir = taskWorkspaceDir(run.id, task.id);
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  const addResult = await runGit(gitRoot, ['worktree', 'add', '--detach', workspaceDir, 'HEAD'], null, false);
  if (addResult.code !== 0) {
    await appendLog(run.id, 'warning', `Task ${task.id} failed to create git worktree and will use shared workspace.`, {
      taskId: task.id,
      error: (addResult.stderr || addResult.stdout || '').trim()
    });
    return {
      mode: 'shared',
      cwd: run.projectPath || runDir(run.id),
      reviewCwd: run.projectPath || runDir(run.id),
      repoRoot: gitRoot,
      repoStatusBefore,
      cleanup: async () => {}
    };
  }

  return {
    mode: 'git-worktree',
    cwd: workspaceDir,
    reviewCwd: workspaceDir,
    repoRoot: gitRoot,
    repoStatusBefore,
    workspaceDir,
    cleanup: async () => {
      await runGit(gitRoot, ['worktree', 'remove', '--force', workspaceDir], null, false).catch(() => {});
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function buildWorktreeDiff(executionCtx, task, currentTaskDir) {
  const statusResult = await runGit(executionCtx.workspaceDir, ['status', '--porcelain=v1'], null, false);
  const changedFiles = parsePorcelain(statusResult.stdout);
  if (!changedFiles.length) {
    await writeTaskDiffPlaceholder(currentTaskDir, 'No changes detected in isolated task workspace.');
    return [];
  }

  const paths = changedFiles.map((item) => item.path);
  const untracked = changedFiles.filter((item) => item.status === '??').map((item) => item.path);
  if (untracked.length) {
    await runGit(executionCtx.workspaceDir, ['add', '-N', '--', ...untracked], null, false);
  }

  const diffResult = await runGit(executionCtx.workspaceDir, ['diff', '--binary', '--relative', '--', ...paths], null, false);
  const patchText = String(diffResult.stdout || '').trim();
  await fs.writeFile(
    path.join(currentTaskDir, 'diff.patch'),
    patchText ? `${patchText}\n` : 'No isolated patch output was generated.\n',
    'utf8'
  );
  await fs.writeFile(path.join(currentTaskDir, 'changed-files.json'), JSON.stringify(changedFiles, null, 2), 'utf8');
  return changedFiles;
}

async function collectExecutionScope(run, task, executionCtx, changedFiles, currentTaskDir) {
  let repoChangedFiles = changedFiles.map((item) => item.path);
  let scopeEnforcement = 'strict';
  if (executionCtx.mode === 'shared' && executionCtx.repoRoot) {
    const afterStatus = parsePorcelain((await runGit(executionCtx.repoRoot, ['status', '--porcelain=v1'], null, false)).stdout);
    repoChangedFiles = diffRepoStatus(executionCtx.repoStatusBefore, afterStatus).map((item) => item.path);
    scopeEnforcement = 'repo-diff';
  } else if (executionCtx.mode === 'shared') {
    scopeEnforcement = normalizeTaskFiles(task.filesLikely).length ? 'best-effort' : 'unbounded';
  }
  repoChangedFiles = uniqueBy(repoChangedFiles, (item) => item);
  const outOfScopeFiles = repoChangedFiles.filter((filePath) => !fileMatchesScope(filePath, task.filesLikely));
  await fs.writeFile(
    path.join(currentTaskDir, 'scope-findings.json'),
    JSON.stringify({ repoChangedFiles, outOfScopeFiles, scopeEnforcement }, null, 2),
    'utf8'
  );
  return { repoChangedFiles, outOfScopeFiles, scopeEnforcement };
}

async function runTaskVerification(run, task, executionCtx, currentTaskDir, controller, actionPolicy, actionState) {
  const commands = selectVerificationCommands(run, task);
  const verificationTypes = inferTaskVerificationTypes(task, commands);
  const reportFile = path.join(currentTaskDir, 'verification.json');
  const results = [];
  let browser = null;
  await appendTrace(run.id, 'task.verification-started', {
    taskId: task.id,
    commandCount: commands.length,
    verificationTypes
  });
  await appendTaskTrajectory(run.id, task.id, 'verification-started', {
    commands,
    workspaceMode: executionCtx.mode,
    verificationTypes
  });
  for (const commandLine of commands) {
    const result = await runTaskAction(
      run.id,
      task.id,
      actionPolicy,
      'verification',
      { command: commandLine, cwd: executionCtx.reviewCwd },
      () => runCommandLine(commandLine, executionCtx.reviewCwd, controller),
      actionState
    );
    results.push({
      command: commandLine,
      code: result.code,
      stdout: clipBlock(result.stdout || '', 1800),
      stderr: clipBlock(result.stderr || '', 1200)
    });
    await appendTaskTrajectory(run.id, task.id, 'verification-command', {
      command: commandLine,
      code: result.code,
      ok: result.code === 0
    });
  }
  if (verificationTypes.includes('BROWSER')) {
    browser = await runBrowserVerification(run, task, executionCtx, currentTaskDir, controller);
    await appendTaskTrajectory(run.id, task.id, 'browser-verification', {
      status: browser.status,
      ok: browser.ok,
      targetUrl: browser.targetUrl || '',
      note: browser.note || ''
    });
  }
  const shellOk = results.every((item) => item.code === 0);
  const browserOk = browser ? browser.ok === true : true;
  const report = {
    selectedCommands: commands,
    results,
    ok: shellOk && browserOk,
    verificationTypes,
    browser,
    note: commands.length === 0
      ? (browser ? `Shell verification skipped; browser verification ${browser.status}.` : 'No automatic verification commands were selected for this task.')
      : ((shellOk && browserOk)
        ? 'All selected verification commands passed.'
        : [shellOk ? '' : 'One or more verification commands failed.', browser && browser.ok !== true ? `Browser verification ${browser.status}.` : ''].filter(Boolean).join(' '))
  };
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');
  await appendTrace(run.id, 'task.verification-completed', {
    taskId: task.id,
    commandCount: commands.length,
    verificationOk: report.ok,
    verificationTypes
  });
  await appendTaskTrajectory(run.id, task.id, 'verification-summary', {
    commandCount: commands.length,
    verificationOk: report.ok,
    note: report.note,
    verificationTypes
  });
  return report;
}

export async function runBrowserVerification(run, task, executionCtx, currentTaskDir, controller) {
  const browserConfig = normalizeBrowserVerificationConfig(run?.projectContext?.browserVerification) || {};
  const devServerConfig = normalizeDevServerConfig(run?.projectContext?.devServer, run?.projectPath || executionCtx?.reviewCwd || '') || null;
  const targetUrl = browserConfig.url || devServerConfig?.url || firstUrlFromTask(task);
  const selector = browserConfig.selector || '';
  const timeoutMs = Number(browserConfig.timeoutMs || devServerConfig?.timeoutMs || 15000);
  const result = {
    required: true,
    status: 'unverifiable',
    ok: false,
    targetUrl,
    selector,
    note: '',
    usedExistingServer: false,
    startedServer: false,
    screenshotPath: '',
    consoleSummary: [],
    stepLog: []
  };
  if (!targetUrl) {
    result.note = 'No browser target URL configured for this task.';
    return result;
  }

  let serverHandle = null;
  try {
    const alreadyHealthy = await probeHttpUrl(targetUrl, 1500);
    if (alreadyHealthy) {
      result.usedExistingServer = true;
      result.stepLog.push(`Attached to existing server at ${targetUrl}.`);
    } else if (devServerConfig?.command) {
      serverHandle = await startBackgroundCommand(devServerConfig.command, devServerConfig.cwd || run.projectPath || executionCtx.reviewCwd, controller);
      result.startedServer = true;
      result.stepLog.push(`Started dev server with command: ${devServerConfig.command}`);
      const healthy = await waitForHttpUrl(targetUrl, devServerConfig.timeoutMs || timeoutMs);
      if (!healthy) {
        const output = serverHandle.readOutput();
        await fs.writeFile(path.join(currentTaskDir, 'browser-dev-server.log'), `${output.stdout || ''}\n${output.stderr || ''}`.trim(), 'utf8').catch(() => {});
        result.note = `Dev server did not become healthy at ${targetUrl}.`;
        return result;
      }
    } else {
      result.note = `Target URL ${targetUrl} is not reachable and no dev server command was configured.`;
      return result;
    }

    let playwrightModule = null;
    try {
      playwrightModule = await import('playwright');
    } catch {
      result.note = 'Playwright is not installed, so browser verification was recorded as unverifiable.';
      return result;
    }

    const browser = await playwrightModule.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (message) => {
      if (result.consoleSummary.length >= 12) return;
      result.consoleSummary.push(`${message.type()}: ${clipLine(message.text(), 180)}`);
    });
    await page.goto(targetUrl, { waitUntil: browserConfig.waitUntil || 'domcontentloaded', timeout: timeoutMs });
    result.stepLog.push(`Navigated to ${targetUrl}.`);
    if (selector) {
      await page.waitForSelector(selector, { timeout: timeoutMs });
      result.stepLog.push(`Selector matched: ${selector}`);
    }
    const screenshotPath = path.join(currentTaskDir, 'browser-screenshot.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    result.screenshotPath = screenshotPath;
    result.status = 'passed';
    result.ok = true;
    result.note = selector ? `Browser verification passed for selector ${selector}.` : 'Browser verification passed.';
    await context.close();
    await browser.close();
    return result;
  } catch (error) {
    result.status = 'failed';
    result.ok = false;
    result.note = clipLine(error?.message || 'Browser verification failed.');
    return result;
  } finally {
    if (serverHandle?.child) {
      killProcessTree(serverHandle.child);
      if (controller) controller.children.delete(serverHandle.child);
    }
  }
}

async function applyTaskPatch(run, currentTaskDir) {
  return withLock(run.id, async () => {
    const gitRoot = await resolveGitProject(run.projectPath || '');
    if (!gitRoot) {
      return { ok: false, message: 'Main project is not a git repository.' };
    }
    if (!(await isGitWorktreeClean(gitRoot))) {
      return { ok: false, message: 'Main project changed while task was running. Patch was not applied.' };
    }

    const patchFile = path.join(currentTaskDir, 'diff.patch');
    const patchText = await fs.readFile(patchFile, 'utf8').catch(() => '');
    if (!patchText.trim() || patchText.startsWith('No ') || patchText.startsWith('Diff unavailable')) {
      return { ok: true, message: 'No patch application was needed.' };
    }

    const applyResult = await runGit(gitRoot, ['apply', '--reject', '--whitespace=nowarn', patchFile], null, false);
    if (applyResult.code !== 0) {
      return {
        ok: false,
        message: (applyResult.stderr || applyResult.stdout || 'Patch apply failed.').trim()
      };
    }
    return { ok: true, message: 'Patch applied to main project.' };
  });
}

function buildPlannerPrompt(run, memory, provider = 'codex') {
  const clarify = run.clarify || {};
  const policy = run.executionPolicy || defaultExecutionPolicy(run.profile);
  const presetBaseline = presetPolicyBaseline(run);
  const teamBlueprint = run.harnessConfig?.teamBlueprint || deriveTeamBlueprint(run);
  const providerName = providerDisplayName(provider);
  return [
    `You are the ${providerName} supervisor for a local engineering harness.`,
    'Read the spec bundle and project summary files from disk before answering.',
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    ...buildMemoryPromptLines(memory),
    ...buildProjectPlanningPriorLines(memory, run),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'planner', provider),
    run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
    ...buildProjectPromptLines(run),
    '',
    ...buildContinuationPromptLines(run),
    '',
    `Preset: ${presetSummary(run.preset?.id || 'auto')}`,
    `Clarified objective: ${clarify.clarifiedObjective || run.input.objective || 'None'}`,
    `Scope summary: ${clarify.scopeSummary || 'None'}`,
    `Assumptions: ${(clarify.assumptions || []).join(' | ') || 'None'}`,
    `Open questions to keep visible: ${openQuestionText(clarify.openQuestions).join(' | ') || 'None'}`,
    `Plan feedback from user: ${run.humanLoop?.planApproval?.feedback || 'None'}`,
    `Preferred harness pattern: ${clarify.architecturePattern || 'pipeline'}`,
    `Execution model hint: ${clarify.executionModel || defaultExecutionModelHint(run)}`,
    `Execution policy notes: ${(policy.policyNotes || []).join(' | ') || 'None'}`,
    `Flow profile: ${run.profile?.flowProfile || 'sequential'}`,
    `Task budget: ${run.profile?.taskBudget ?? '-'}`,
    `File budget per task: ${run.profile?.fileBudget ?? '-'}`,
    `Diagnosis-first: ${run.profile?.diagnosisFirst === false ? 'optional' : 'required'}`,
    `Fresh session threshold: ${run.profile?.freshSessionThreshold || '-'}`,
    `Preset baseline constitution: ${presetBaseline.constitution}`,
    `Preset baseline planner stance: ${presetBaseline.planner}`,
    `Preset baseline team stance: ${presetBaseline.team}`,
    `Suggested starter team blueprint: ${JSON.stringify(teamBlueprint)}`,
    '',
    'Return JSON only with this shape:',
    '{',
    '  "summary":"string",',
    '  "executionModel":"string",',
    '  "agents":[{"name":"string","role":"string","model":"codex|claude|gemini","responsibility":"string"}],',
    '  "tasks":[{',
    '    "title":"string",',
    '    "goal":"string",',
    '    "dependsOn":["T001"],',
    '    "filesLikely":["relative/path.ts"],',
    '    "constraints":["string"],',
    '    "acceptanceChecks":["string"]',
    '  }]',
    '}',
    'Rules:',
    `- Default coordination provider is ${providerDisplayName(resolveRunProviderProfile(run).coordinationProvider)} and default worker provider is ${providerDisplayName(resolveRunProviderProfile(run).workerProvider)}.`,
    '- Agent model must be one of codex, claude, gemini.',
    '- Keep planning/review/judgment roles on the coordination provider by default, and keep implementer on the worker provider unless there is a strong reason not to.',
    '- Prefer 2-8 initial tasks.',
    writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, executionModel, agent roles/responsibilities, task titles, goals, constraints, and acceptanceChecks'),
    plannerTaskSizingRule(run),
    '- If a task likely needs more than ~200 LOC of changes or spans multiple subsystems, split it into smaller sequential tasks.',
    '- When filesLikely are uncertain or the subsystem is unfamiliar, create a diagnosis/read-only task first before implementation.',
    '- Do not create a separate implementation task for pure read-only verification when the verifier can decide it directly.',
    '- acceptanceChecks must be mechanically verifiable commands or exact observable states, not directional descriptions.',
    '- Good acceptance check: "python -m pytest tests/test_auth.py exits 0" or "POST /login returns 401 on wrong password".',
    '- Bad acceptance check: "error handling works correctly" or "API behaves well".',
    '- If the plan changes executable code and the repository exposes validation commands, include an explicit mechanical verification step or a read-only verification task.',
    '- Follow the preferred harness pattern unless the task graph strongly requires another one.',
    plannerParallelRule(run, policy),
    '- Continue from the latest unresolved state instead of re-describing already completed work.',
    run.project ? '- This run is scoped to the current project phase only. Do not plan the whole product; create tasks only for this phase slice.' : '- Scope the tasks to the current run objective only.',
    '- No markdown, no prose outside JSON.'
  ].join('\n');
}

function predictTaskScopeEnforcement(task, executionCtx) {
  if (executionCtx.mode === 'git-worktree') return 'strict';
  if (executionCtx.repoRoot) return 'repo-diff';
  return normalizeTaskFiles(task.filesLikely).length ? 'best-effort' : 'unbounded';
}

async function readFilesLikelyContents(run, task, executionCtx, maxFiles = 3) {
  const files = normalizeTaskFiles(task.filesLikely).slice(0, maxFiles);
  const sections = [];
  for (const relativePath of files) {
    const absolutePath = path.join(executionCtx.cwd, ...relativePath.split('/'));
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) {
      sections.push(`Current content of ${relativePath}: (file does not exist yet)`);
      continue;
    }
    const text = await readSpecFile(absolutePath).catch(() => '');
    sections.push(`Current content of ${relativePath}:\n\`\`\`\n${clipLargeContext(text, 2200)}\n\`\`\``);
  }
  return sections;
}

function buildRetryContext(task) {
  if (!task.attempts) return [];
  const priorAcceptance = normalizeAcceptanceCheckResults(task.lastExecution?.acceptanceCheckResults)
    .slice(0, 5)
    .map((item) => `${item.check}: ${item.status || 'unknown'}${item.note ? ` (${item.note})` : ''}`);
  return [
    `Previous attempt count: ${task.attempts}`,
    `Previous reviewer summary: ${task.reviewSummary || 'None recorded.'}`,
    `Previous findings: ${(task.findings || []).join(' | ') || 'None recorded.'}`,
    ...(priorAcceptance.length ? [`Previous acceptance check results: ${priorAcceptance.join(' | ')}`] : []),
    'Do not repeat the same failed approach. Change the method if the prior attempt did not converge.'
  ];
}

function buildUpstreamContext(run, task) {
  const completed = (run.tasks || []).filter((candidate) =>
    task.dependsOn?.includes(candidate.id) && isTaskSatisfiedStatus(candidate.status)
  );
  if (!completed.length) return [];
  return completed.flatMap((upstream) => [
    `Upstream task ${upstream.id} completed.`,
    `- Title: ${upstream.title}`,
    `- Review summary: ${upstream.reviewSummary || 'None'}`,
    `- Changed files: ${(upstream.lastExecution?.changedFiles || []).join(', ') || 'Unknown'}`
  ]);
}

function buildScopeRules(expectedScope) {
  if (expectedScope === 'strict') {
    return [
      '- Scope enforcement is strict: do not touch files outside filesLikely.',
      '- If a required change falls outside filesLikely, stop and explain it in the handoff instead of editing it.'
    ];
  }
  if (expectedScope === 'repo-diff' || expectedScope === 'best-effort') {
    return [
      '- Scope enforcement is monitored: keep changes inside filesLikely unless a tiny adjacent edit is unavoidable.',
      '- If you must leave filesLikely, explain exactly why in Files changed and Risks or follow-ups.'
    ];
  }
  return [
    '- Scope enforcement is unbounded for this task.',
    '- Treat that as a warning, not permission: keep the smallest possible diff and avoid opportunistic edits.'
  ];
}

function isReadOnlyVerificationTask(task) {
  const constraintText = Array.isArray(task?.constraints) ? task.constraints.join('\n') : '';
  return /read-only review|do not edit any files|read-only|읽기 전용|파일을 수정하지 않는다|파일을 수정하지 않음|수정하지 않는다|코드를 수정하지 않는다/i.test(constraintText);
}

function taskCanSucceedWithoutRepoDiff(task) {
  if (isReadOnlyVerificationTask(task)) return true;
  return taskContainsText(task, [
    'spec',
    'acceptance',
    'scope',
    'requirements',
    'verify',
    'verification',
    'read-only',
    'do not implement',
    'inspect',
    'analysis',
    'confirm',
    'reproduce'
  ]);
}

function buildCodeContextPromptLines(codeContext) {
  if (!codeContext) return ['Code context: unavailable'];
  const lines = [`Code context summary: ${clipText(codeContext.summary || 'None', 400)}`];
  if (Array.isArray(codeContext.relatedFiles) && codeContext.relatedFiles.length > 0) {
    lines.push('Relevant code files and symbols:');
    for (const item of codeContext.relatedFiles.slice(0, 4)) {
      const symbolText = Array.isArray(item.symbols) ? item.symbols.join(' | ') : '';
      const exportText = Array.isArray(item.codeGraph?.exports) && item.codeGraph.exports.length ? ` exports=${item.codeGraph.exports.join(',')}` : '';
      const importText = Array.isArray(item.codeGraph?.imports) && item.codeGraph.imports.length ? ` imports=${item.codeGraph.imports.map((entry) => entry.target || entry.specifier).join(',')}` : '';
      lines.push(`- ${item.path}: ${clipText(`${symbolText || item.snippet || ''}${exportText}${importText}`, 220)}`);
    }
  } else {
    lines.push('Relevant code files and symbols: none');
  }
  return lines;
}

async function buildCodexPrompt(run, task, memory, executionCtx, codeContext = null, provider = 'codex') {
  const verificationCommands = selectVerificationCommands(run, task);
  const contextExcerpts = await buildPromptContextExcerpts(run);
  const expectedScope = predictTaskScopeEnforcement(task, executionCtx);
  const fileContexts = await readFilesLikelyContents(run, task, executionCtx);
  const upstreamContext = buildUpstreamContext(run, task);
  const retryContext = buildRetryContext(task);
  const providerName = providerDisplayName(provider);
  const riskMemory = await searchProjectMemory(ROOT_DIR, run.memory.projectKey, 'task risk failure out-of-scope retry', 3, {
    projectPath: run.projectPath || ''
  }, {
    reindex: false,
    stage: 'review',
    taskId: task.id,
    filesLikely: task.filesLikely,
    relatedFiles: codeContext?.relatedFiles || [],
    symbolHints: codeContext?.symbolHints || []
  }).catch(() => ({ searchResults: [] }));
  return [
    `You are the ${providerName} implementation executor inside a local engineering harness.`,
    'Read the spec bundle and project summary files first, then edit the current working directory directly.',
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    `Harness guidance: ${harnessGuidancePath(run.id)}`,
    ...buildMemoryPromptLines(memory),
    ...buildCodeContextPromptLines(codeContext),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'implementer', provider),
    '',
    ...buildContinuationPromptLines(run, task.id),
    '',
    ...contextExcerpts,
    ...(fileContexts.length ? ['', 'FilesLikely current contents:', ...fileContexts] : []),
    ...(upstreamContext.length ? ['', 'Completed upstream context:', ...upstreamContext] : []),
    ...(retryContext.length ? ['', 'Retry context:', ...retryContext] : []),
    ...(riskMemory.searchResults?.length ? ['', 'Known failure patterns from previous runs:', ...riskMemory.searchResults.map((hit) => `- ${clipText(hit.snippet || '', 260)}`)] : []),
    '',
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Goal: ${task.goal}`,
    `Files likely: ${(task.filesLikely || []).join(', ') || 'Unknown'}`,
    `Expected scope enforcement: ${expectedScope}`,
    `Constraints: ${(task.constraints || []).join(' | ') || 'None'}`,
    `Acceptance checks: ${(task.acceptanceChecks || []).join(' | ') || 'None'}`,
    `Checkpoint notes: ${(task.checkpointNotes || []).join(' | ') || 'None'}`,
    `Recommended verification commands: ${verificationCommands.join(' | ') || 'None selected by harness'}`,
    '',
    'Rules:',
    '- You are the implementation executor for the current task, not the planner for the entire run.',
    '- Read the three files above before editing.',
    '- Keep the diff inside filesLikely unless the spec clearly requires a small adjacent change.',
    ...buildScopeRules(expectedScope),
    '- The recommended verification commands are required unless they clearly do not apply to this task.',
    '- Resume directly from the current task state and prior findings instead of rewriting the whole history.',
    '- Keep the required output section headers in English exactly as written below.',
    writeInPreferredLanguageRule(run.harnessConfig, `Write the body content of Summary, Risks or follow-ups, ${providerName} handoff, and acceptance check notes`),
    '',
    'Required output sections:',
    'Context read',
    'Summary',
    'Files changed',
    'Checks run',
    'Acceptance check results',
    '- For each acceptance check, report PASS / FAIL / UNABLE-TO-VERIFY and why.',
    ...(task.acceptanceChecks || []).map((check, index) => `  ${index + 1}. ${check}`),
    'Risks or follow-ups',
    `${providerName} handoff`
  ].join('\n');
}

function buildReviewPrompt(run, task, outputFile, diffFile, verificationFile, scopeSummary, memory, provider = 'codex') {
  const providerName = providerDisplayName(provider);
  return [
    `You are the ${providerName} verifier for a local engineering harness.`,
    `Read the spec bundle, project summary, ${providerName} handoff, task diff, and inspect the current project before deciding.`,
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    ...buildMemoryPromptLines(memory),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'verifier', provider),
    ...buildContinuationPromptLines(run, task.id),
    `${providerName} handoff: ${outputFile}`,
    `Task diff: ${diffFile}`,
    `Verification report: ${verificationFile}`,
    `Repository changed files: ${(scopeSummary?.repoChangedFiles || []).join(', ') || 'None'}`,
    `Out-of-scope file changes: ${(scopeSummary?.outOfScopeFiles || []).join(', ') || 'None'}`,
    `Scope enforcement level: ${scopeSummary?.scopeEnforcement || 'unknown'}`,
    run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
    '',
    `Task ID: ${task.id}`,
    `Current goal: ${task.goal}`,
    `Acceptance checks: ${(task.acceptanceChecks || []).map((check, index) => `${index + 1}. ${check}`).join(' | ') || 'None defined'}`,
    `Previous attempts: ${task.attempts || 0}`,
    `Previous review summary: ${task.reviewSummary || 'None'}`,
    `Previous findings: ${(task.findings || []).join(' | ') || 'None'}`,
    ...(task.attempts >= 2 ? [
      'WARNING: This task has already failed multiple times.',
      'You must identify the repeated root cause and propose a materially different retry plan if you choose retry.'
    ] : []),
    '',
    'Return JSON only with this shape:',
    '{',
    '  "decision":"approve|retry",',
    '  "summary":"string",',
    '  "findings":["string"],',
    '  "functionalFindings":["string"],',
    '  "structuralFindings":["string"],',
    '  "codeFindings":["string"],',
    '  "staticVerificationFindings":["string"],',
    '  "browserUxFindings":["string"],',
    '  "acceptanceCheckResults":[{"check":"string","status":"pass|fail|unverifiable","note":"string"}],',
    '  "retryDiagnosis":"string",',
    '  "updatedTask": {',
    '    "goal":"string",',
    '    "filesLikely":["string"],',
    '    "constraints":["string"],',
    '    "acceptanceChecks":["string"]',
    '  }',
    '}',
    'Use updatedTask only when decision is retry.',
    writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, findings, retryDiagnosis, and updatedTask fields'),
    'Keep a single verdict, but place findings into the most specific categories you can.',
    'functionalFindings covers spec alignment, behavior, acceptance evidence, scope, integration, and operator-visible regressions.',
    'structuralFindings covers architecture boundaries, ownership, module fit, duplicated state, and layering concerns.',
    'codeFindings covers logic bugs, risky patterns, and newly introduced maintenance debt.',
    'staticVerificationFindings covers syntax/build/type/lint/test failures or high-confidence static breakage risks.',
    'browserUxFindings covers browser-visible UX, accessibility, loading/error states, and missing frontend wiring.',
    'If a category is clean, return an empty array for that category.',
    'Do not block approval on style-only remarks unless they imply a real defect, static failure risk, or clear maintenance regression.',
    'Prioritize the verification artifact and acceptance check evidence over the model handoff narrative.',
    'Resume directly from the latest task artifacts and do not recap unrelated run history.',
    'If this task has failed repeatedly, diagnose the root cause instead of repeating the same advice.'
  ].join('\n');
}

function normalizeChangedPaths(changedFiles = []) {
  return changedFiles
    .map((item) => String(item?.path || item || '').trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function isDocsOnlyReviewCandidate(paths) {
  if (!paths.length || paths.length > 3) return false;
  return paths.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath));
}

function isHighRiskReviewTask(run, task, changedPaths) {
  const haystack = [
    run.preset?.id || '',
    task.title,
    task.goal,
    ...(task.constraints || []),
    ...(task.acceptanceChecks || []),
    ...changedPaths
  ].join('\n').toLowerCase();
  const patterns = [
    'bugfix',
    'refactor',
    'auth',
    'security',
    'payment',
    'billing',
    'schema',
    'migration',
    'database',
    'public api',
    'breaking',
    'package.json',
    'pnpm-lock',
    'package-lock',
    'yarn.lock',
    '.env',
    'dockerfile'
  ];
  return patterns.some((pattern) => haystack.includes(pattern));
}

function buildPrescreenReview(decision, summary, findings, route) {
  return {
    decision,
    summary,
    findings,
    updatedTask: {},
    reviewer: 'rule-prescreen',
    route
  };
}

export function decideReviewRoute(run, task, changedFiles, scopeSummary, verification) {
  const changedPaths = normalizeChangedPaths(changedFiles);
  if (!changedPaths.length) {
    if (taskCanSucceedWithoutRepoDiff(task)) {
      return null;
    }
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because no file changes were detected.',
      ['No file changes were detected after Codex execution.'],
      'rule-blocked'
    );
  }
  if ((scopeSummary?.outOfScopeFiles || []).length > 0) {
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because out-of-scope files changed.',
      [`Out-of-scope files changed: ${scopeSummary.outOfScopeFiles.join(', ')}`],
      'rule-blocked'
    );
  }
  if (verification?.ok === false) {
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because automatic verification failed.',
      [`Automatic verification failed: ${(verification.selectedCommands || []).join(' | ') || 'No command recorded.'}`],
      'rule-blocked'
    );
  }
  if (!isHighRiskReviewTask(run, task, changedPaths) && isDocsOnlyReviewCandidate(changedPaths)) {
    return buildPrescreenReview(
      'approve',
      'Rule-based prescreen auto-approved this low-risk docs-only change.',
      [`Docs-only changed files: ${changedPaths.join(', ')}`],
      'rule-auto-approve'
    );
  }
  return null;
}

function buildGoalJudgePrompt(run, memory, provider = 'codex') {
  const ledger = run.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    goal: task.goal,
    attempts: task.attempts,
    reviewSummary: task.reviewSummary || ''
  }));

  const providerName = providerDisplayName(provider);
  return [
    `You are the ${providerName} goal judge for a local engineering harness.`,
    'Read the spec bundle, project summary, and inspect the current project before deciding.',
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    ...buildMemoryPromptLines(memory),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'goal-judge', provider),
    run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
    ...buildProjectPromptLines(run),
    '',
    ...buildContinuationPromptLines(run),
    '',
    'Current task ledger:',
    JSON.stringify(ledger, null, 2),
    '',
    'Return JSON only with this shape:',
    '{',
    '  "goalAchieved": true,',
    '  "summary":"string",',
    '  "findings":["string"],',
    '  "newTasks":[{',
    '    "title":"string",',
    '    "goal":"string",',
    '    "dependsOn":["T001"],',
    '    "filesLikely":["relative/path.ts"],',
    '    "constraints":["string"],',
    '    "acceptanceChecks":["string"]',
    '  }]',
    '}',
    writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, findings, and any new task fields'),
    'Resume from the latest ledger state instead of rewriting the full run history.',
    'If goalAchieved is true, newTasks must be empty.'
  ].join('\n');
}

function normalizeDriftRisk(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(normalized) ? normalized : 'medium';
}

function parseThresholdMinutes(text) {
  const match = String(text || '').match(/(\d+)\s*m/i);
  return match ? Number(match[1]) : 0;
}

function parseThresholdCount(text, keywordPattern) {
  const match = String(text || '').match(new RegExp(`(\\d+)\\s+${keywordPattern}`, 'i'));
  return match ? Number(match[1]) : 0;
}

export function evaluateFreshSessionState(run, prospective = {}) {
  const thresholdText = String(run?.profile?.freshSessionThreshold || '').trim();
  if (!thresholdText) {
    return { recommended: false, reason: '', elapsedMinutes: 0, pauseCount: 0, highDriftCount: 0 };
  }
  const createdAt = Date.parse(run?.createdAt || '') || Date.now();
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
  const pauseCount = Number(run?.metrics?.replanPauseCount || 0) + (prospective.pauseForHuman ? 1 : 0);
  const highDriftCount = Number(run?.metrics?.replanHighDriftCount || 0) + (String(prospective.driftRisk || '').trim() === 'high' ? 1 : 0);
  const minuteThreshold = parseThresholdMinutes(thresholdText);
  const failedCountThreshold = parseThresholdCount(thresholdText, 'failed replans?');
  const highDriftThreshold = parseThresholdCount(thresholdText, 'high-drift replans?');

  if (highDriftThreshold && highDriftCount >= highDriftThreshold) {
    return {
      recommended: true,
      reason: `fresh run recommended after ${highDriftCount} high-drift replans (${thresholdText})`,
      elapsedMinutes,
      pauseCount,
      highDriftCount
    };
  }
  if (failedCountThreshold && pauseCount >= failedCountThreshold) {
    return {
      recommended: true,
      reason: `fresh run recommended after ${pauseCount} paused replans (${thresholdText})`,
      elapsedMinutes,
      pauseCount,
      highDriftCount
    };
  }
  if (minuteThreshold && elapsedMinutes >= minuteThreshold) {
    return {
      recommended: true,
      reason: `fresh run recommended after ${elapsedMinutes}m elapsed (${thresholdText})`,
      elapsedMinutes,
      pauseCount,
      highDriftCount
    };
  }
  return { recommended: false, reason: '', elapsedMinutes, pauseCount, highDriftCount };
}

function buildAutomaticReplanPrompt(run, memory, checkpoint, provider = 'codex') {
  const ledger = run.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    goal: task.goal,
    dependsOn: task.dependsOn || [],
    filesLikely: task.filesLikely || [],
    constraints: task.constraints || [],
    acceptanceChecks: task.acceptanceChecks || [],
    checkpointNotes: task.checkpointNotes || [],
    reviewSummary: task.reviewSummary || '',
    attempts: task.attempts || 0
  }));

  const providerName = providerDisplayName(provider);
  return [
    `You are ${providerName} acting as the automatic replanner for a local engineering harness.`,
    'Read the spec bundle, project summary, harness guidance, and current checkpoint before deciding.',
    `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
    `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
    `Harness guidance: ${harnessGuidancePath(run.id)}`,
    `Current checkpoint: ${runCheckpointPath(run.id)}`,
    ...buildMemoryPromptLines(memory),
    ...buildProjectPlanningPriorLines(memory, run),
    ...buildHarnessGuidanceLines(run.harnessConfig, 'replanner', provider),
    run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
    ...buildProjectPromptLines(run),
    '',
    ...buildContinuationPromptLines(run),
    '',
    'Checkpoint summary:',
    JSON.stringify(checkpoint, null, 2),
    '',
    'Current task ledger:',
    JSON.stringify(ledger, null, 2),
    '',
    'Non-negotiable rules:',
    '- Preserve the clarified objective, spec bundle intent, and prompt-source precedence.',
    '- You may edit only tasks whose current status is "ready".',
    '- Never rewrite done, skipped, failed, or in_progress tasks.',
    '- Do not silently broaden scope or weaken acceptance checks.',
    '- Prefer the smallest backlog change that improves the next batch.',
    `- Keep the backlog inside the active task budget (${run.profile?.taskBudget ?? '-'}).`,
    `- Keep each task inside the active file budget (${run.profile?.fileBudget ?? '-'} filesLikely) unless you are explicitly inserting a read-only diagnosis task.`,
    `- Diagnosis-first is ${run.profile?.diagnosisFirst === false ? 'optional' : 'required'} for this run.`,
    `- Fresh session threshold: ${run.profile?.freshSessionThreshold || '-'}. If crossed, stop and recommend a fresh session instead of forcing more replans.`,
    '- If the current objective or scope no longer looks safe or valid, do not auto-apply changes. Request a human pause instead.',
    '',
    'Return JSON only with this shape:',
    '{',
    '  "shouldReplan": true,',
    '  "summary":"string",',
    '  "objectiveStillValid": true,',
    '  "driftRisk":"low",',
    '  "pauseForHuman": false,',
    '  "preserve":["string"],',
    '  "whyNow":["string"],',
    '  "edits":[{',
    '    "id":"T002",',
    '    "title":"string",',
    '    "goal":"string",',
    '    "dependsOn":["T001"],',
    '    "filesLikely":["relative/path.ts"],',
    '    "constraints":["string"],',
    '    "acceptanceChecks":["string"],',
    '    "checkpointNotes":["string"]',
    '  }],',
    '  "newTasks":[{',
    '    "title":"string",',
    '    "goal":"string",',
    '    "dependsOn":["T002"],',
    '    "filesLikely":["relative/path.ts"],',
    '    "constraints":["string"],',
    '    "acceptanceChecks":["string"],',
    '    "checkpointNotes":["string"]',
    '  }]',
    '}',
    'If shouldReplan is false, return empty edits and newTasks.',
    'If objectiveStillValid is false or driftRisk is high, set pauseForHuman to true.',
    writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, preserve, whyNow, and task fields')
  ].join('\n');
}

function buildCheckpointSuggestions(run, blockedTasks) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const suggestions = [];
  const retryable = tasks.filter((task) => task.status === 'failed' && String(task.lastExecution?.reviewDecision || '') === 'retry');
  const readyWithoutChecks = tasks.filter((task) => task.status === 'ready' && (!Array.isArray(task.acceptanceChecks) || task.acceptanceChecks.length === 0));

  if (retryable.length) {
    suggestions.push({
      kind: 'retry-candidate',
      summary: `Resolve retry-candidate tasks first: ${retryable.map((task) => task.id).join(', ')}`
    });
  }
  if (blockedTasks.length) {
    suggestions.push({
      kind: 'dependency-blocked',
      summary: `Tasks blocked by failed dependencies: ${blockedTasks.map((item) => item.taskId).join(', ')}`
    });
  }
  if (readyWithoutChecks.length) {
    suggestions.push({
      kind: 'missing-acceptance',
      summary: `Add acceptance checks to ready tasks that are missing them: ${readyWithoutChecks.map((task) => task.id).join(', ')}`
    });
  }
  return suggestions.slice(0, 5);
}

function buildRunCheckpoint(run, trigger = 'unknown') {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const blockedTasks = describeBlockedTasks(tasks);
  const failedTasks = tasks.filter((task) => task.status === 'failed');
  const readyTasks = tasks.filter((task) => task.status === 'ready');
  const activeTask = tasks.find((task) => task.status === 'in_progress') || null;
  const latestReplan = run?.autoReplan?.latest || null;
  const nextAction = run.status === 'needs_input'
    ? 'Answer the clarify question and restart.'
    : run.status === 'needs_approval'
      ? 'Review the plan and first task, then approve or request changes.'
      : run.status === 'stopped'
        ? (latestReplan?.freshSessionRecommended
          ? `Fresh session threshold reached. ${latestReplan.pauseReason || 'Continue in a new session or a new run.'}`
          : latestReplan?.pauseForHuman
          ? 'Automatic replanning detected objective drift risk. Review the checkpoint and preserve rules, adjust the backlog, then resume.'
          : (failedTasks.length
            ? 'Review failed tasks and checkpoint suggestions, then retry or adjust the backlog before resuming.'
            : 'Review the resume brief and restart.'))
        : failedTasks.length
          ? 'Resolve failed tasks first.'
          : activeTask
            ? `Check the status of ${activeTask.id} and continue.`
            : readyTasks[0]
              ? `Resume from ${readyTasks[0].id} ${readyTasks[0].title}.`
              : 'Re-evaluate the current ledger.';

  return {
    schemaVersion: '1',
    generatedAt: now(),
    trigger,
    runId: run.id,
    status: run.status,
    objective: String(run.clarify?.clarifiedObjective || run.input?.objective || run.title || '').trim(),
    planSummary: String(run.planSummary || '').trim(),
    resultSummary: String(run.result?.summary || '').trim(),
    nextAction,
    openQuestions: openQuestionText(run.humanLoop?.clarifyPending || run.clarify?.openQuestions),
    pendingTasks: tasks
      .filter((task) => !isTaskSatisfiedStatus(task.status))
      .map((task) => ({
        id: task.id,
        status: task.status,
        title: task.title,
        goal: task.goal,
        reviewSummary: task.reviewSummary || '',
        checkpointNotes: Array.isArray(task.checkpointNotes) ? task.checkpointNotes.map(String) : []
      }))
      .slice(0, 8),
    blockedTasks,
    retryCandidates: failedTasks
      .filter((task) => String(task.lastExecution?.reviewDecision || '') === 'retry')
      .map((task) => ({
        id: task.id,
        title: task.title,
        reviewSummary: task.reviewSummary || ''
      }))
      .slice(0, 5),
    suggestedBacklogChanges: buildCheckpointSuggestions(run, blockedTasks),
    autoReplan: latestReplan
      ? {
          at: latestReplan.at,
          applied: Boolean(latestReplan.applied),
          pauseForHuman: Boolean(latestReplan.pauseForHuman),
          driftRisk: latestReplan.driftRisk || 'medium',
          summary: latestReplan.summary || '',
          changedTaskIds: Array.isArray(latestReplan.changedTaskIds) ? latestReplan.changedTaskIds : [],
          newTaskIds: Array.isArray(latestReplan.newTaskIds) ? latestReplan.newTaskIds : [],
          preserve: Array.isArray(latestReplan.preserve) ? latestReplan.preserve : [],
          whyNow: Array.isArray(latestReplan.whyNow) ? latestReplan.whyNow : []
        }
      : null,
    recentFindings: uniqueBy(
      tasks.flatMap((task) => Array.isArray(task.findings) ? task.findings.map(String) : []),
      (item) => item
    ).slice(0, 8),
    resumeHint: 'Read this checkpoint first on resume. Adjust the backlog if needed, then call startRun.'
  };
}

function shouldPersistCheckpointMemory(checkpoint) {
  return ['needs_input', 'needs_approval', 'stopped', 'failed', 'partial_complete', 'completed'].includes(String(checkpoint?.status || ''))
    || (checkpoint?.blockedTasks || []).length > 0
    || (checkpoint?.retryCandidates || []).length > 0
    || (checkpoint?.suggestedBacklogChanges || []).length > 0;
}

async function writeRunCheckpoint(runId, trigger = 'unknown') {
  const run = await loadState(runId);
  const checkpoint = buildRunCheckpoint(run, trigger);
  await fs.writeFile(runCheckpointPath(runId), JSON.stringify(checkpoint, null, 2), 'utf8');
  if (run.memory?.projectKey && shouldPersistCheckpointMemory(checkpoint)) {
    const snapshot = await appendCheckpointMemory(ROOT_DIR, run, checkpoint).catch(() => null);
    if (snapshot) {
      await applyMemorySnapshot(runId, snapshot).catch(() => {});
    }
  }
  return checkpoint;
}

async function maybeAutomaticReplan(runId, controller, checkpoint = null) {
  const run = await loadState(runId);
  if (run.status !== 'running') return null;
  if (run.tasks.some((task) => task.status === 'in_progress')) return null;

  const unresolvedTasks = run.tasks.filter((task) => !isTaskTerminalStatus(task.status));
  if (!unresolvedTasks.length) return null;

  const readyTasks = run.tasks.filter((task) => task.status === 'ready');
  const failedTasks = run.tasks.filter((task) => task.status === 'failed');
  if (!readyTasks.length && !failedTasks.length) return null;

  const currentCheckpoint = checkpoint || buildRunCheckpoint(run, 'task-batch-completed');
  const phaseActions = { counts: {}, lastAction: null };
  const query = [
    currentCheckpoint.nextAction,
    currentCheckpoint.resultSummary,
    currentCheckpoint.objective
  ].filter(Boolean).join(' ');
  const memory = await runPhaseAction(
    runId,
    'replan',
    'memory-search',
    { query },
    () => resolvePromptMemory(run, query || run.input.objective || run.title, 4, {
      reindex: false
    }),
    phaseActions
  );
  const replanProvider = resolveStageProvider(run, 'planner');
  await appendLog(runId, 'info', `${providerDisplayName(replanProvider)} automatic replanning started.`, {
    readyTasks: readyTasks.length,
    failedTasks: failedTasks.length
  });
  await appendTrace(runId, 'replan.started', {
    readyTasks: readyTasks.length,
    failedTasks: failedTasks.length
  });
  const result = await runPhaseAction(
    runId,
    'replan',
    replanProvider,
    { cwd: run.projectPath || runDir(runId), objective: currentCheckpoint.objective },
    () => runAgentProvider(replanProvider, buildAutomaticReplanPrompt(run, memory, currentCheckpoint, replanProvider), run.projectPath || runDir(runId), run.settings, controller),
    phaseActions
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${providerDisplayName(replanProvider)} automatic replanning failed.`);
  }
  const parsed = parseJsonReply(result.stdout);

  let applied = false;
  let pauseForHuman = false;
  let changedTaskIds = [];
  let newTaskIds = [];
  const summary = String(parsed.summary || '').trim();
  const driftRisk = normalizeDriftRisk(parsed.driftRisk);
  const preserve = Array.isArray(parsed.preserve) ? parsed.preserve.map(String).filter(Boolean) : [];
  const whyNow = Array.isArray(parsed.whyNow) ? parsed.whyNow.map(String).filter(Boolean) : [];
  const basePauseForHuman = Boolean(parsed.pauseForHuman) || parsed.objectiveStillValid === false || driftRisk === 'high';
  const freshSession = evaluateFreshSessionState(run, { driftRisk, pauseForHuman: basePauseForHuman });
  let pauseReason = freshSession.recommended ? `stopped for fresh session: ${freshSession.reason}` : '';

  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    if (fresh.status !== 'running') return;
    if (fresh.tasks.some((task) => task.status === 'in_progress')) return;

    const shouldReplan = Boolean(parsed.shouldReplan);
    const objectiveStillValid = parsed.objectiveStillValid !== false;
    const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
    const rawNewTasks = Array.isArray(parsed.newTasks) ? parsed.newTasks : [];
    const latestAt = now();

    if (shouldReplan && objectiveStillValid && driftRisk !== 'high') {
      const editableIds = new Set(fresh.tasks.filter((task) => task.status === 'ready').map((task) => task.id));
      const safeEdits = rawEdits
        .filter((task) => editableIds.has(String(task?.id || '').trim()))
        .map((task) => ({
          ...task,
          checkpointNotes: uniqueBy([
            ...(Array.isArray(task?.checkpointNotes) ? task.checkpointNotes.map(String) : []),
            summary ? `automatic replanning: ${clipText(summary, 220)}` : '',
            ...whyNow.map((item) => `automatic replanning reason: ${clipText(item, 180)}`)
          ].filter(Boolean), (item) => item)
        }));
      const safeNewTasks = rawNewTasks.map((task) => ({
        ...task,
        checkpointNotes: uniqueBy([
          ...(Array.isArray(task?.checkpointNotes) ? task.checkpointNotes.map(String) : []),
          summary ? `automatic replanning: ${clipText(summary, 220)}` : ''
        ].filter(Boolean), (item) => item)
      }));

      if (safeEdits.length || safeNewTasks.length) {
        const beforeById = new Map(fresh.tasks.map((task) => [task.id, task]));
        const mergedTasks = mergeEditableBacklogTasks(fresh.tasks, [...safeEdits, ...safeNewTasks]);
        fresh.tasks = mergedTasks;
        applied = true;
        changedTaskIds = safeEdits
          .map((task) => String(task.id || '').trim())
          .filter((taskId) => {
            const before = beforeById.get(taskId);
            const after = mergedTasks.find((task) => task.id === taskId);
            return before && after && JSON.stringify(before) !== JSON.stringify(after);
          });
        newTaskIds = mergedTasks
          .filter((task) => !beforeById.has(task.id))
          .map((task) => task.id);
      }
    }

    pauseForHuman = basePauseForHuman || freshSession.recommended;
    if (pauseForHuman) {
      fresh.status = 'stopped';
      if (!pauseReason) {
        pauseReason = summary
          ? `automatic replanning paused for review: ${clipText(summary, 220)}`
          : 'automatic replanning paused for review because drift risk was high.';
      }
      const pauseNote = pauseReason;
      for (const task of fresh.tasks) {
        if (task.status !== 'ready') continue;
        task.checkpointNotes = uniqueBy([...(task.checkpointNotes || []), pauseNote], (item) => item);
      }
    }

    const latestEntry = {
      at: latestAt,
      summary,
      objectiveStillValid: parsed.objectiveStillValid !== false,
      driftRisk,
      pauseForHuman,
      freshSessionRecommended: freshSession.recommended,
      pauseReason,
      applied,
      changedTaskIds,
      newTaskIds,
      preserve,
      whyNow
    };
    fresh.metrics.replanRuns = Number(fresh.metrics.replanRuns || 0) + 1;
    if (pauseForHuman) {
      fresh.metrics.replanPauseCount = Number(fresh.metrics.replanPauseCount || 0) + 1;
    }
    if (driftRisk === 'high') {
      fresh.metrics.replanHighDriftCount = Number(fresh.metrics.replanHighDriftCount || 0) + 1;
    }
    fresh.autoReplan = {
      lastRunAt: latestAt,
      latest: applied || pauseForHuman || shouldReplan
        ? latestEntry
        : (fresh.autoReplan?.latest || latestEntry)
    };
    await saveState(fresh);
  });

  await applyMemorySnapshot(runId, memory);
  await appendLog(runId, pauseForHuman ? 'warning' : 'info', `${providerDisplayName(replanProvider)} automatic replanning completed.`, {
    applied,
    pauseForHuman,
    changedTaskIds,
    newTaskIds,
    driftRisk
  });
  await appendTrace(runId, 'replan.completed', {
    applied,
    pauseForHuman,
    changedTaskIds,
    newTaskIds,
    driftRisk
  });
  await writeRunCheckpoint(runId, pauseForHuman ? 'replan-paused' : (applied ? 'replan-applied' : 'replan-evaluated'));
  return {
    applied,
    pauseForHuman,
    changedTaskIds,
    newTaskIds,
    driftRisk,
    preserve,
    whyNow,
    summary
  };
}

async function planRun(runId, controller) {
  const state = await loadState(runId);
  const phaseActions = { counts: {}, lastAction: null };
  const memory = await runPhaseAction(
    runId,
    'plan',
    'memory-search',
    { query: state.clarify?.clarifiedObjective || state.input.objective || state.title },
    () => resolvePromptMemory(state, state.clarify?.clarifiedObjective || state.input.objective || state.title, 4, {
      reindex: false
    }),
    phaseActions
  );
  const planningProvider = resolveStageProvider(state, 'planner');
  await appendLog(runId, 'info', `${providerDisplayName(planningProvider)} planning started.`);
  await appendTrace(runId, 'plan.started', {
    objective: state.clarify?.clarifiedObjective || state.input.objective || state.title
  });
  const result = await runPhaseAction(
    runId,
    'plan',
    planningProvider,
    { cwd: runDir(runId), objective: state.clarify?.clarifiedObjective || state.input.objective || state.title },
    () => runAgentProvider(planningProvider, buildPlannerPrompt(state, memory, planningProvider), runDir(runId), state.settings, controller),
    phaseActions
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${providerDisplayName(planningProvider)} planning failed.`);
  }
  const parsed = parseJsonReply(result.stdout);
  const { rawTasks, policy } = applyPlanPolicy(state, parsed);
  const plannedTasks = materializePlannedTasks(rawTasks);
  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    fresh.planSummary = String(parsed.summary || '').trim();
    fresh.executionModel = String(parsed.executionModel || '').trim();
    fresh.agents = Array.isArray(parsed.agents) ? parsed.agents.map(normalizeAgent) : fresh.agents;
    fresh.executionPolicy = policy;
    fresh.tasks = plannedTasks;
    fresh.metrics.planningRuns += 1;
    fresh.humanLoop.planApproval = {
      ...fresh.humanLoop.planApproval,
      status: fresh.settings.requirePlanApproval ? 'pending' : 'approved',
      requestedAt: now(),
      approvedAt: fresh.settings.requirePlanApproval ? '' : now()
    };
    fresh.status = fresh.settings.requirePlanApproval ? 'needs_approval' : 'running';
    await saveState(fresh);
  });
  await writeHarnessGuidanceDoc(await loadState(runId));
  await applyMemorySnapshot(runId, memory);
  await appendLog(runId, 'info', `${providerDisplayName(planningProvider)} planning completed.`, {
    tasks: plannedTasks.length,
    policyNotes: policy.policyNotes
  });
  if (policy.verificationNudgeNeeded) {
    await appendLog(runId, 'warning', 'Planning injected a read-only verification task because the original task graph lacked an explicit mechanical verification step.', {
      tasks: plannedTasks.length
    });
    await appendTrace(runId, 'plan.verification-nudge', {
      tasks: plannedTasks.length
    });
  }
  await appendTrace(runId, 'plan.completed', {
    tasks: plannedTasks.length,
    policyNotes: policy.policyNotes,
    executionModel: parsed.executionModel || ''
  });
  await writeRunCheckpoint(runId, 'plan-completed');
}

async function clarifyRun(runId, controller) {
  const state = await loadState(runId);
  const phaseActions = { counts: {}, lastAction: null };
  const memory = await runPhaseAction(
    runId,
    'clarify',
    'memory-search',
    { query: state.input.objective || state.title },
    () => resolvePromptMemory(state, state.input.objective || state.title, 4, {
      reindex: false
    }),
    phaseActions
  );
  const clarifyProvider = resolveStageProvider(state, 'planner');
  await appendLog(runId, 'info', `${providerDisplayName(clarifyProvider)} clarify started.`);
  await appendTrace(runId, 'clarify.started', {
    objective: state.input.objective || state.title
  });
  const result = await runPhaseAction(
    runId,
    'clarify',
    clarifyProvider,
    { cwd: runDir(runId), objective: state.input.objective || state.title },
    () => runAgentProvider(clarifyProvider, buildClarifyPrompt(state, memory, clarifyProvider), runDir(runId), state.settings, controller),
    phaseActions
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${providerDisplayName(clarifyProvider)} clarify failed.`);
  }
  const parsed = parseJsonReply(result.stdout);
  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    const recommendedPresetId = String(parsed.recommendedPresetId || '').trim();
    const normalizedQuestions = normalizeClarifyQuestions(parsed.openQuestions);
    if ((fresh.preset?.id || 'auto') === 'auto' && recommendedPresetId) {
      fresh.preset = getPreset(recommendedPresetId);
    }
    fresh.clarify = {
      clarifiedObjective: String(parsed.clarifiedObjective || '').trim(),
      scopeSummary: String(parsed.scopeSummary || '').trim(),
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
      openQuestions: normalizedQuestions,
      architecturePattern: String(parsed.architecturePattern || '').trim(),
      executionModel: String(parsed.executionModel || '').trim()
    };
    fresh.harnessConfig = {
      ...(fresh.harnessConfig || {}),
      teamBlueprint: deriveTeamBlueprint(fresh)
    };
    fresh.humanLoop.clarifyQuestions = normalizedQuestions;
    const pendingQuestions = normalizedQuestions.filter((question) => !fresh.humanLoop?.clarifyAnswers?.[question.id]);
    fresh.humanLoop.clarifyPending = pendingQuestions;
    if (pendingQuestions.length > 0) {
      fresh.status = 'needs_input';
    }
    await saveState(fresh);
  });
  await appendLog(runId, 'info', `${providerDisplayName(clarifyProvider)} clarify completed.`, {
    recommendedPresetId: parsed.recommendedPresetId || '',
    architecturePattern: parsed.architecturePattern || ''
  });
  const clarifyQuestions = normalizeClarifyQuestions(parsed.openQuestions);
  await appendTrace(runId, 'clarify.completed', {
    recommendedPresetId: parsed.recommendedPresetId || '',
    architecturePattern: parsed.architecturePattern || '',
    openQuestions: clarifyQuestions.length
  });
  const fresh = await loadState(runId);
  await writeHarnessGuidanceDoc(fresh);
  const snapshot = await appendClarifyMemory(ROOT_DIR, fresh);
  await applyMemorySnapshot(runId, snapshot);
  await writeRunCheckpoint(runId, fresh.status === 'needs_input' ? 'clarify-paused' : 'clarify-completed');
}

async function persistProjectMemory(runId) {
  const run = await loadState(runId);
  if (!run.memory?.projectKey) {
    return;
  }
  const snapshot = await appendCompletionMemory(ROOT_DIR, run);
  await applyMemorySnapshot(runId, snapshot);
}

export function resolveAdaptiveParallelLimit(run, tasks, maxParallel, executionPolicy = defaultExecutionPolicy()) {
  const readyTasks = Array.isArray(tasks)
    ? tasks.filter((task) => task.status === 'ready')
    : [];
  const baseLimit = executionPolicy.parallelMode === 'parallel' ? Math.max(1, Number(maxParallel || 1)) : 1;
  if (baseLimit <= 1) {
    return { limit: 1, reason: 'sequential-policy' };
  }
  const failures = run?.memory?.failureAnalytics || {};
  const failedCount = Array.isArray(tasks) ? tasks.filter((task) => task.status === 'failed').length : 0;
  const retryReadyCount = readyTasks.filter((task) => Number(task.attempts || 0) > 0).length;
  const highDriftCount = Number(run?.metrics?.replanHighDriftCount || 0);
  if (failedCount > 0 || retryReadyCount > 0 || highDriftCount > 0 || Number(failures.scopeDriftCount || 0) > 0) {
    return { limit: 1, reason: 'stability-recovery' };
  }
  if (Number(failures.verificationFailures || 0) > 1 || Number(failures.retryCount || 0) > 2) {
    return { limit: Math.min(baseLimit, 1), reason: 'recent-failure-patterns' };
  }
  if (readyTasks.length >= baseLimit) {
    return { limit: baseLimit, reason: 'full-width-safe' };
  }
  return { limit: Math.max(1, readyTasks.length), reason: readyTasks.length > 1 ? 'limited-ready-width' : 'single-runnable-task' };
}

function pickBatch(run, tasks, maxParallel, executionPolicy = defaultExecutionPolicy()) {
  const doneIds = new Set(tasks.filter((task) => isTaskSatisfiedStatus(task.status)).map((task) => task.id));
  const ready = tasks.filter((task) => task.status === 'ready' && (task.dependsOn || []).every((dep) => doneIds.has(dep)));
  const adaptive = resolveAdaptiveParallelLimit(run, tasks, maxParallel, executionPolicy);
  const allowedParallel = adaptive.limit;
  if (allowedParallel <= 1) {
    return { batch: ready.slice(0, 1), adaptive };
  }
  const batch = [];
  const signalCache = new Map();
  for (const task of ready) {
    if (batch.length >= allowedParallel) break;
    if (batch.every((picked) => !tasksCollide(task, picked, run?.projectPath || '', signalCache))) {
      batch.push(task);
    }
  }
  return { batch: batch.length ? batch : ready.slice(0, 1), adaptive };
}

function summarizeExecutionFailure(execution) {
  const combined = String([execution?.stderr, execution?.stdout].filter(Boolean).join('\n')).trim();
  if (!combined) return '';
  const focused = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /error|failed|exception|required|unauthorized|forbidden/i.test(line));
  return clipLine((focused[0] || combined).replace(/\[stderr\]/gi, '').trim(), 320);
}

function classifyExecutionFailure(execution, errorSnippet = '') {
  const text = String([errorSnippet, execution?.stderr, execution?.stdout].filter(Boolean).join('\n')).toLowerCase();
  const permanentPatterns = [
    'projectidrequirederror',
    'google_cloud_project',
    'error authenticating',
    'loaded cached credentials',
    'unauthorized',
    'forbidden',
    'permission denied'
  ];
  const transientPatterns = [
    'timed out',
    'timeout',
    'rate limit',
    '429',
    'network',
    'temporarily unavailable',
    'econnreset',
    'socket hang up',
    '503'
  ];
  if (permanentPatterns.some((pattern) => text.includes(pattern))) {
    return {
      retryable: false,
      category: 'configuration',
      summary: `${providerDisplayName(resolveStageProvider(run, 'implementer'))} environment or authentication configuration issue — failing immediately.`
    };
  }
  if (execution?.timedOut || transientPatterns.some((pattern) => text.includes(pattern))) {
    return {
      retryable: true,
      category: 'transient',
      summary: 'Classified as a transient execution error — automatic retry allowed.'
    };
  }
  return {
    retryable: true,
    category: 'generic',
    summary: 'Classified as a generic execution failure — retry allowed.'
  };
}

function describeBlockedTasks(tasks) {
  const failedIds = new Set(tasks.filter((task) => task.status === 'failed').map((task) => task.id));
  return tasks
    .filter((task) => task.status === 'ready')
    .map((task) => {
      const blockedBy = (task.dependsOn || []).filter((dep) => failedIds.has(dep));
      if (!blockedBy.length) return null;
      return {
        taskId: task.id,
        blockedBy,
        message: `${task.id} blocked by failed dependency: ${blockedBy.join(', ')}`
      };
    })
    .filter(Boolean);
}

async function reviewTask(runId, task, outputFile, diffFile, verificationFile, scopeSummary, reviewCwd, controller) {
  const run = await loadState(runId);
  const phaseActions = { counts: {}, lastAction: null };
  const memory = await runPhaseAction(
    runId,
    'review',
    'memory-search',
    { query: `${task.title} ${task.goal}`, taskId: task.id, filesLikely: task.filesLikely },
    () => resolvePromptMemory(run, `${task.title} ${task.goal}`, 4, {
      stage: 'review',
      taskId: task.id,
      filesLikely: task.filesLikely,
      reindex: false
    }),
    phaseActions
  );
  const reviewProvider = resolveStageProvider(run, 'verifier');
  const result = await runPhaseAction(
    runId,
    'review',
    reviewProvider,
    { cwd: reviewCwd, taskId: task.id },
    () => runAgentProvider(reviewProvider, buildReviewPrompt(run, task, outputFile, diffFile, verificationFile, scopeSummary, memory, reviewProvider), reviewCwd, run.settings, controller),
    phaseActions
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${providerDisplayName(reviewProvider)} review failed.`);
  }
  const parsed = parseJsonReply(result.stdout);
  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    incrementRunMetric(fresh.metrics, 'reviews', 'codexReviews');
    await saveState(fresh);
  });
  return parsed;
}

async function judgeGoal(runId, controller) {
  const run = await loadState(runId);
  const phaseActions = { counts: {}, lastAction: null };
  const memory = await runPhaseAction(
    runId,
    'goal-judge',
    'memory-search',
    { query: run.result?.summary || run.clarify?.clarifiedObjective || run.input.objective || run.title },
    () => resolvePromptMemory(
      run,
      run.result?.summary || run.clarify?.clarifiedObjective || run.input.objective || run.title,
      4,
      { reindex: false }
    ),
    phaseActions
  );
  const judgeProvider = resolveStageProvider(run, 'goal-judge');
  await appendLog(runId, 'info', `${providerDisplayName(judgeProvider)} goal judge started.`);
  await appendTrace(runId, 'goal-judge.started', {
    objective: run.clarify?.clarifiedObjective || run.input.objective || run.title
  });
  const result = await runPhaseAction(
    runId,
    'goal-judge',
    judgeProvider,
    { cwd: run.projectPath || runDir(runId), objective: run.clarify?.clarifiedObjective || run.input.objective || run.title },
    () => runAgentProvider(judgeProvider, buildGoalJudgePrompt(run, memory, judgeProvider), run.projectPath || runDir(runId), run.settings, controller),
    phaseActions
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${providerDisplayName(judgeProvider)} goal judge failed.`);
  }
  const parsed = parseJsonReply(result.stdout);

  await withLock(runId, async () => {
    const fresh = await loadState(runId);
    fresh.metrics.goalChecks += 1;
    fresh.result = {
      goalAchieved: Boolean(parsed.goalAchieved),
      summary: String(parsed.summary || '').trim(),
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : []
    };

    if (parsed.goalAchieved) {
      const failedTasks = fresh.tasks.filter((task) => task.status === 'failed');
      if (failedTasks.length > 0) {
        fresh.status = 'partial_complete';
        fresh.result.goalAchieved = false;
        fresh.result.findings = uniqueBy([
          ...fresh.result.findings,
          `Failed tasks remain: ${failedTasks.map((task) => task.id).join(', ')}`
        ], (item) => item);
      } else {
        fresh.status = 'completed';
      }
    } else {
      fresh.goalLoops = (fresh.goalLoops || 0) + 1;
      for (const rawTask of Array.isArray(parsed.newTasks) ? parsed.newTasks : []) {
        fresh.tasks.push({
          ...normalizeTask(rawTask, fresh.tasks),
          id: nextTaskId(fresh.tasks)
        });
      }
      if ((parsed.newTasks || []).length === 0 || fresh.goalLoops >= fresh.settings.maxGoalLoops) {
        const doneCount = fresh.tasks.filter((task) => isTaskSatisfiedStatus(task.status)).length;
        fresh.status = doneCount > 0 ? 'partial_complete' : 'failed';
      } else {
        fresh.status = 'running';
      }
    }

    await saveState(fresh);
  });
  await applyMemorySnapshot(runId, memory);
  const fresh = await loadState(runId);
  const snapshot = await appendGoalJudgeMemory(ROOT_DIR, fresh);
  await applyMemorySnapshot(runId, snapshot);
  await appendTrace(runId, 'goal-judge.completed', {
    goalAchieved: Boolean(parsed.goalAchieved),
    newTasks: Array.isArray(parsed.newTasks) ? parsed.newTasks.length : 0,
    status: fresh.status
  });
  await writeRunCheckpoint(runId, 'goal-judge-completed');
}

async function executeTask(runId, taskId, controller) {
  const run = await loadState(runId);
  const task = run.tasks.find((item) => item.id === taskId);
  const currentTaskDir = taskDir(runId, taskId);
  await ensureDir(currentTaskDir);
  const executionCtx = await prepareTaskExecution(run, task, currentTaskDir);
  const cwd = executionCtx.cwd;
  const readOnlyVerification = isReadOnlyVerificationTask(task);
  if (executionCtx.mode === 'shared') {
    await snapshotTaskFiles(run, task, taskSnapshotDir(runId, taskId));
  }
  const expectedScope = predictTaskScopeEnforcement(task, executionCtx);
  const actionPolicy = buildTaskActionPolicy(run, task, executionCtx, readOnlyVerification);
  const actionState = { counts: {}, lastAction: null };
  const implementerProvider = resolveStageProvider(run, 'implementer');
  const implementerName = providerDisplayName(implementerProvider);
  if (expectedScope === 'unbounded') {
    await appendLog(runId, 'warning', `Task ${taskId} is running with unbounded scope enforcement.`, { taskId });
  }

  await updateTask(runId, taskId, async (current, state) => {
    current.status = 'in_progress';
    current.attempts += 1;
    current.lastExecution = {
      ...defaultTaskExecution(),
      lastRunAt: now(),
      workspaceMode: executionCtx.mode,
      allowedActionClasses: actionPolicy.allowedActionClasses
    };
    current.allowedActionClasses = actionPolicy.allowedActionClasses;
    if (!readOnlyVerification) {
      incrementRunMetric(state.metrics, 'executionRuns', 'codexRuns');
    }
  });
  await appendLog(runId, 'info', `${readOnlyVerification ? `${implementerName} verification` : `${implementerName} implementation`} started ${taskId}.`, {
    taskId,
    workspaceMode: executionCtx.mode
  });
  await appendTrace(runId, 'task.started', {
    taskId,
    title: task.title,
    workspaceMode: executionCtx.mode,
    expectedScope
  });
  await appendTaskTrajectory(runId, taskId, 'task-start', {
    title: task.title,
    workspaceMode: executionCtx.mode,
    expectedScope,
    attempt: Number(task.attempts || 0) + 1
  });

  const codeContext = actionPolicy.allowedActionClasses.includes('code-context')
    ? await runTaskAction(
        runId,
        taskId,
        actionPolicy,
        'code-context',
        { taskId: task.id, filesLikely: task.filesLikely },
        async () => {
          const built = await buildTaskCodeContext(run, task);
          await ensureDir(path.dirname(taskCodeContextPath(runId, taskId)));
          await writeJson(taskCodeContextPath(runId, taskId), built);
          return built;
        },
        actionState
      )
    : {
        schemaVersion: '1',
        runId,
        taskId,
        generatedAt: now(),
        summary: 'Code context was skipped because no project root is attached.',
        queryTokens: [],
        symbolHints: [],
        relatedFiles: [],
        diagnostics: ['Code context skipped.']
      };
  const memory = await runTaskAction(
    runId,
    taskId,
    actionPolicy,
    'memory-search',
    {
      query: `${task.title} ${task.goal}`,
      stage: 'execute',
      filesLikely: task.filesLikely,
      relatedFiles: codeContext.relatedFiles,
      symbolHints: codeContext.symbolHints
    },
    () => resolvePromptMemory(run, `${task.title} ${task.goal}`, 4, {
      stage: 'execute',
      taskId: task.id,
      filesLikely: task.filesLikely,
      relatedFiles: codeContext.relatedFiles,
      symbolHints: codeContext.symbolHints,
      reindex: false
    }),
    actionState
  );
  const prompt = await buildCodexPrompt(run, task, memory, executionCtx, codeContext, implementerProvider);
  const promptFile = taskPrimaryArtifactPath(runId, taskId, 'prompt');
  for (const fileName of taskArtifactFileNames('prompt')) {
    await fs.writeFile(path.join(currentTaskDir, fileName), prompt, 'utf8');
  }
  await writeTaskStructuredArtifacts(runId, taskId, {
    handoff: buildTaskHandoff(run, task, executionCtx, expectedScope, memory, actionPolicy, codeContext)
  });
  await appendTaskTrajectory(runId, taskId, 'prompt-prepared', {
    workspaceMode: executionCtx.mode,
    memoryHints: memoryHints(memory),
    acceptanceChecks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks.map(String) : [],
    allowedActionClasses: actionPolicy.allowedActionClasses,
    codeContextSummary: codeContext.summary || ''
  });
  const outputFile = taskPrimaryArtifactPath(runId, taskId, 'output');
  let execution = { code: 0, stdout: '', stderr: '', timedOut: false };
  let changedFiles = [];
  let scopeSummary = {
    repoChangedFiles: [],
    outOfScopeFiles: [],
    scopeEnforcement: expectedScope
  };
  let verification = {
    selectedCommands: [],
    results: [],
    ok: true,
    note: 'Read-only verification task; no implementation command was run.'
  };

    if (readOnlyVerification) {
      const readOnlyOutput = `Read-only verification task. ${implementerName} implementation was skipped and ${implementerName} will inspect the current workspace directly.\n`;
      for (const fileName of taskArtifactFileNames('output')) {
        await fs.writeFile(path.join(currentTaskDir, fileName), readOnlyOutput, 'utf8');
      }
    await writeTaskDiffPlaceholder(currentTaskDir, 'Read-only verification task; no code changes were expected.');
    await fs.writeFile(path.join(currentTaskDir, 'verification.json'), JSON.stringify(verification, null, 2), 'utf8');
    await fs.writeFile(path.join(currentTaskDir, 'scope-findings.json'), JSON.stringify(scopeSummary, null, 2), 'utf8');
    await appendTrace(runId, 'task.execution-skipped', {
      taskId,
      workspaceMode: executionCtx.mode,
      reason: 'read-only-verification'
    });
    await appendTaskTrajectory(runId, taskId, 'execution-skipped', {
      workspaceMode: executionCtx.mode,
      reason: 'read-only-verification'
    });
  } else {
    const workspacePromptFile = path.join(cwd, `.harness-task-${taskId}-prompt.md`);
    await fs.writeFile(workspacePromptFile, prompt, 'utf8');
    const launcherPrompt = `Read and execute the task instructions in this file first: ${workspacePromptFile}`;
    await appendTrace(runId, 'task.execution-started', {
      taskId,
      workspaceMode: executionCtx.mode
    });
    await appendTaskTrajectory(runId, taskId, 'execution-started', {
      workspaceMode: executionCtx.mode
    });
    try {
      execution = await runTaskAction(
        runId,
        taskId,
        actionPolicy,
        implementerProvider,
        { cwd, promptFile: workspacePromptFile },
        () => runAgentProvider(implementerProvider, launcherPrompt, cwd, run.settings, controller),
        actionState
      );
    } finally {
      await fs.rm(workspacePromptFile, { force: true }).catch(() => {});
    }
    const output = `${execution.stdout}${execution.stderr ? `\n[stderr]\n${execution.stderr}` : ''}`.trim();
    for (const fileName of taskArtifactFileNames('output')) {
      await fs.writeFile(path.join(currentTaskDir, fileName), output || '(no output)', 'utf8');
    }
    await appendTrace(runId, 'task.execution-completed', {
      taskId,
      workspaceMode: executionCtx.mode,
      code: execution.code,
      timedOut: execution.timedOut
    });
    await appendTaskTrajectory(runId, taskId, 'execution-completed', {
      workspaceMode: executionCtx.mode,
      code: execution.code,
      timedOut: execution.timedOut,
      outputSnippet: clipText(output || '(no output)', 400)
    });

    if (execution.code !== 0) {
      let rollbackMessage = '';
      const errorSnippet = summarizeExecutionFailure(execution);
      const failurePolicy = classifyExecutionFailure(execution, errorSnippet);
      if (executionCtx.mode === 'shared') {
        const rollback = await runTaskAction(
          runId,
          taskId,
          actionPolicy,
          'rollback',
          { workspaceMode: executionCtx.mode, reason: 'execution-failed' },
          () => restoreSharedTaskFiles(run, task),
          actionState
        );
        rollbackMessage = rollback.message || '';
        await appendTrace(runId, 'task.rollback-completed', {
          taskId,
          workspaceMode: executionCtx.mode,
          ok: rollback.ok,
          message: rollback.message || ''
        });
        await appendTaskTrajectory(runId, taskId, 'rollback', {
          workspaceMode: executionCtx.mode,
          ok: rollback.ok,
          message: rollback.message || ''
        });
      }
      await updateTask(runId, taskId, async (current, state) => {
        current.reviewSummary = `${implementerName} execution failed before review.`;
        current.findings = [`${implementerName} exited with code ${execution.code}.`];
        if (errorSnippet) current.findings.push(`Error: ${errorSnippet}`);
        if (failurePolicy.summary) current.findings.push(failurePolicy.summary);
        if (rollbackMessage) current.findings.push(rollbackMessage);
        current.lastExecution = {
          ...(current.lastExecution || defaultTaskExecution()),
          workspaceMode: executionCtx.mode,
          lastExitCode: execution.code,
          applyResult: [`Not applied because ${implementerName} execution failed.`, rollbackMessage].filter(Boolean).join(' '),
          allowedActionClasses: actionPolicy.allowedActionClasses,
          actionCounts: actionState.counts,
          lastAction: actionState.lastAction,
          codeContextSummary: codeContext.summary || '',
          recoveryHint: rollbackMessage || 'Retry after fixing the recorded execution failure.'
        };
        current.status = !failurePolicy.retryable || current.attempts >= state.settings.maxTaskAttempts ? 'failed' : 'ready';
      });
      await appendLog(runId, 'error', `${implementerName} failed on ${taskId}.`, {
        code: execution.code,
        error: errorSnippet,
        failureCategory: failurePolicy.category,
        retryable: failurePolicy.retryable
      });
      await appendTrace(runId, 'task.execution-failed', {
        taskId,
        code: execution.code,
        workspaceMode: executionCtx.mode,
        failureCategory: failurePolicy.category,
        retryable: failurePolicy.retryable
      });
      await writeTaskStructuredArtifacts(runId, taskId, {
        executionSummary: buildExecutionSummary(
          {
            ...task,
            lastExecution: {
              ...(task.lastExecution || defaultTaskExecution()),
              allowedActionClasses: actionPolicy.allowedActionClasses,
              actionCounts: actionState.counts,
              lastAction: actionState.lastAction
            }
          },
          executionCtx,
          expectedScope,
          [],
          scopeSummary,
          verification,
          failurePolicy.retryable ? 'retry' : 'failed',
          'execution-failed',
          { ok: false, message: [`Not applied because ${implementerName} execution failed.`, rollbackMessage].filter(Boolean).join(' ') },
          execution
        ),
        clearRetryPlan: true
      });
      const failedRun = await loadState(runId);
      const failedTask = failedRun.tasks.find((item) => item.id === taskId);
      if (failedTask) {
        const snapshot = await appendTaskReviewMemory(ROOT_DIR, failedRun, failedTask);
        await applyMemorySnapshot(runId, snapshot);
        const artifactSnapshot = await appendArtifactMemory(ROOT_DIR, failedRun, failedTask);
        await applyMemorySnapshot(runId, artifactSnapshot);
      }
      await executionCtx.cleanup();
      return;
    }

    changedFiles = executionCtx.mode === 'git-worktree'
      ? await buildWorktreeDiff(executionCtx, task, currentTaskDir)
      : await buildTaskDiff(run, task, currentTaskDir);
    scopeSummary = await collectExecutionScope(run, task, executionCtx, changedFiles, currentTaskDir);
    await appendTaskTrajectory(runId, taskId, 'scope-collected', {
      changedFiles: changedFiles.map((item) => item.path),
      repoChangedFiles: scopeSummary.repoChangedFiles,
      outOfScopeFiles: scopeSummary.outOfScopeFiles,
      scopeEnforcement: scopeSummary.scopeEnforcement
    });
    verification = await runTaskVerification(run, task, executionCtx, currentTaskDir, controller, actionPolicy, actionState);
  }
  const diffFile = path.join(currentTaskDir, 'diff.patch');
  const verificationFile = path.join(currentTaskDir, 'verification.json');
  await appendTrace(runId, 'task.review-started', {
    taskId,
    workspaceMode: executionCtx.mode,
    verificationOk: verification.ok
  });
  await appendTaskTrajectory(runId, taskId, 'review-started', {
    workspaceMode: executionCtx.mode,
    verificationOk: verification.ok
  });
  const prescreenReview = readOnlyVerification ? null : decideReviewRoute(run, task, changedFiles, scopeSummary, verification);
  const review = prescreenReview
    || await reviewTask(runId, task, outputFile, diffFile, verificationFile, scopeSummary, executionCtx.reviewCwd, controller);
  for (const fileName of taskArtifactFileNames('review')) {
    await fs.writeFile(path.join(currentTaskDir, fileName), JSON.stringify(review, null, 2), 'utf8');
  }

  const scopeViolation = scopeSummary.outOfScopeFiles.length > 0;
  const verificationFailed = verification.ok === false;
  let applyResult = { ok: true, message: '' };
  if (!scopeViolation && !verificationFailed && String(review.decision).toLowerCase() === 'approve' && executionCtx.mode === 'git-worktree') {
    applyResult = await runTaskAction(
      runId,
      taskId,
      actionPolicy,
      'git-apply',
      { taskId, patchFile: path.join(currentTaskDir, 'diff.patch') },
      () => applyTaskPatch(run, currentTaskDir),
      actionState
    );
  }
  if (scopeViolation) {
    applyResult = {
      ok: false,
      message: `Patch was not applied because out-of-scope files changed: ${scopeSummary.outOfScopeFiles.join(', ')}`
    };
  } else if (verificationFailed) {
    applyResult = {
      ok: false,
      message: 'Patch was not applied because automatic verification failed.'
    };
  }
  if (executionCtx.mode === 'shared' && (scopeViolation || verificationFailed || String(review.decision).toLowerCase() !== 'approve')) {
    const rollback = await runTaskAction(
      runId,
      taskId,
      actionPolicy,
      'rollback',
      { workspaceMode: executionCtx.mode, reason: 'post-review-recovery' },
      () => restoreSharedTaskFiles(run, task),
      actionState
    );
    applyResult = {
      ok: rollback.ok && applyResult.ok,
      message: [applyResult.message, rollback.message].filter(Boolean).join(' ')
    };
    await appendTrace(runId, 'task.rollback-completed', {
      taskId,
      workspaceMode: executionCtx.mode,
      ok: rollback.ok,
      message: rollback.message || ''
    });
    await appendTaskTrajectory(runId, taskId, 'rollback', {
      workspaceMode: executionCtx.mode,
      ok: rollback.ok,
      message: rollback.message || ''
    });
  }

  await writeTaskStructuredArtifacts(runId, taskId, {
    reviewVerdict: buildReviewVerdict(task, review),
    retryPlan: buildRetryPlan(task, review, scopeSummary, verification),
    clearRetryPlan: String(review.decision || '').toLowerCase() !== 'retry',
    executionSummary: buildExecutionSummary(
      {
        ...task,
        lastExecution: {
          ...(task.lastExecution || defaultTaskExecution()),
          allowedActionClasses: actionPolicy.allowedActionClasses,
          actionCounts: actionState.counts,
          lastAction: actionState.lastAction
        }
      },
      executionCtx,
      expectedScope,
      changedFiles,
      scopeSummary,
      verification,
      review.decision,
        review.route || 'agent-review',
      applyResult,
      execution
    )
  });

  await updateTask(runId, taskId, async (current, state) => {
    const reviewFindings = Array.isArray(review.findings) ? review.findings.map(String) : [];
    const findingGroups = normalizeReviewFindingGroups(review);
    const retryDiagnosis = String(review.retryDiagnosis || '').trim();
    const acceptanceCheckResults = normalizeAcceptanceCheckResults(review.acceptanceCheckResults);
    current.reviewSummary = String(review.summary || '').trim();
    const combinedFindings = [
      ...reviewFindings,
      ...flattenReviewFindingGroups(findingGroups)
    ];
    current.findings = retryDiagnosis ? [...combinedFindings, `Retry diagnosis: ${retryDiagnosis}`] : combinedFindings;
    current.lastExecution = {
      ...(current.lastExecution || defaultTaskExecution()),
      workspaceMode: executionCtx.mode,
      changedFiles: changedFiles.map((item) => item.path),
      repoChangedFiles: scopeSummary.repoChangedFiles,
      outOfScopeFiles: scopeSummary.outOfScopeFiles,
      scopeEnforcement: scopeSummary.scopeEnforcement,
      applyResult: applyResult.message || (executionCtx.mode === 'git-worktree'
        ? 'Patch applied to main project.'
        : 'Changes were made directly in the shared workspace.'),
      lastExitCode: execution.code,
      reviewDecision: String(review.decision || '').toLowerCase(),
        reviewRoute: String(review.route || 'agent-review'),
      acceptanceCheckResults,
      verificationTypes: Array.isArray(verification.verificationTypes) ? verification.verificationTypes.map(String) : [],
      allowedActionClasses: actionPolicy.allowedActionClasses,
      actionCounts: actionState.counts,
      lastAction: actionState.lastAction,
      codeContextSummary: codeContext.summary || '',
      recoveryHint: scopeViolation
        ? 'Inspect the out-of-scope change list before retrying.'
        : (verificationFailed
          ? 'Fix the failing verification command before requeueing.'
          : (!applyResult.ok ? 'Review the apply or rollback result before retrying.' : 'No recovery action required.'))
    };
    if (scopeViolation) {
      current.findings = [
        ...current.findings,
        `Out-of-scope files changed: ${scopeSummary.outOfScopeFiles.join(', ')}`
      ];
      current.status = current.attempts >= state.settings.maxTaskAttempts ? 'failed' : 'ready';
    } else if (verificationFailed) {
      current.findings = [
        ...current.findings,
        `Automatic verification failed: ${verification.selectedCommands.join(' | ')}`
      ];
      current.status = current.attempts >= state.settings.maxTaskAttempts ? 'failed' : 'ready';
    } else if (String(review.decision).toLowerCase() === 'approve' && applyResult.ok) {
      current.status = 'done';
    } else {
      if (review.updatedTask && typeof review.updatedTask === 'object') {
        current.goal = String(review.updatedTask.goal || current.goal);
        current.filesLikely = Array.isArray(review.updatedTask.filesLikely) ? review.updatedTask.filesLikely.map(String) : current.filesLikely;
        current.constraints = Array.isArray(review.updatedTask.constraints) ? review.updatedTask.constraints.map(String) : current.constraints;
        current.acceptanceChecks = Array.isArray(review.updatedTask.acceptanceChecks) ? review.updatedTask.acceptanceChecks.map(String) : current.acceptanceChecks;
        current.acceptanceMetadata = Array.isArray(review.updatedTask.acceptanceMetadata) ? review.updatedTask.acceptanceMetadata : buildAcceptanceMetadata(current.acceptanceChecks);
      }
      if (!applyResult.ok) {
        current.findings = [...current.findings, applyResult.message];
      }
      current.status = current.attempts >= state.settings.maxTaskAttempts ? 'failed' : 'ready';
    }
  });
  await appendLog(runId, 'info', `Task review completed for ${taskId}.`, {
    taskId,
    decision: review.decision,
      reviewRoute: review.route || 'agent-review',
    changedFiles: changedFiles.map((item) => item.path),
    repoChangedFiles: scopeSummary.repoChangedFiles,
    outOfScopeFiles: scopeSummary.outOfScopeFiles,
    scopeEnforcement: scopeSummary.scopeEnforcement,
    verificationOk: verification.ok,
    verificationCommands: verification.selectedCommands,
    workspaceMode: executionCtx.mode,
    applyResult: applyResult.message || (executionCtx.mode === 'git-worktree' ? 'Patch applied.' : 'Shared workspace.')
  });
  await appendTrace(runId, 'task.reviewed', {
    taskId,
    decision: review.decision,
      reviewRoute: review.route || 'agent-review',
    verificationOk: verification.ok,
    workspaceMode: executionCtx.mode,
    status: (await loadState(runId)).tasks.find((item) => item.id === taskId)?.status || ''
  });
  await appendTaskTrajectory(runId, taskId, 'review-completed', {
    decision: String(review.decision || '').toLowerCase(),
      reviewRoute: review.route || 'agent-review',
    verificationOk: verification.ok,
    applyOk: applyResult.ok,
    applyResult: applyResult.message || ''
  });
  await appendTrace(runId, 'task.apply-completed', {
    taskId,
    workspaceMode: executionCtx.mode,
    ok: applyResult.ok,
    message: applyResult.message || ''
  });
  await appendTaskTrajectory(runId, taskId, 'apply-completed', {
    workspaceMode: executionCtx.mode,
    ok: applyResult.ok,
    message: applyResult.message || ''
  });
  const refreshedRun = await loadState(runId);
  const refreshedTask = refreshedRun.tasks.find((item) => item.id === taskId);
  if (refreshedTask && (!isTaskSatisfiedStatus(refreshedTask.status) || refreshedTask.findings?.length)) {
    const snapshot = await appendTaskReviewMemory(ROOT_DIR, refreshedRun, refreshedTask);
    await applyMemorySnapshot(runId, snapshot);
  }
  if (refreshedTask) {
    const artifactSnapshot = await appendArtifactMemory(ROOT_DIR, refreshedRun, refreshedTask);
    await applyMemorySnapshot(runId, artifactSnapshot);
  }
  await executionCtx.cleanup();
}

async function loopRun(runId, controller) {
  try {
    let state = await loadState(runId);
    if (state.humanLoop?.clarifyPending?.length) {
      await appendLog(runId, 'warning', 'Run paused for clarify answers.', { questions: state.humanLoop.clarifyPending });
      await appendTrace(runId, 'run.paused-for-clarify', { questions: state.humanLoop.clarifyPending.length });
      return;
    }
    if (!state.clarify?.clarifiedObjective) {
      await clarifyRun(runId, controller);
    }
    state = await loadState(runId);
    if (state.status === 'needs_input') {
      await appendLog(runId, 'warning', 'Run paused for clarify answers.', { questions: state.humanLoop?.clarifyPending || [] });
      await appendTrace(runId, 'run.paused-for-clarify', { questions: state.humanLoop?.clarifyPending?.length || 0 });
      return;
    }
    if (!state.tasks.length) {
      await planRun(runId, controller);
    }
    state = await loadState(runId);
    if (state.status === 'needs_approval') {
      await appendLog(runId, 'warning', 'Run paused for plan approval.');
      await appendTrace(runId, 'run.paused-for-approval', {});
      return;
    }

    while (!controller.stopRequested) {
      state = await loadState(runId);
      if (state.status === 'needs_input' || state.status === 'needs_approval') {
        break;
      }
      const activeTasks = state.tasks.filter((task) => !isTaskTerminalStatus(task.status));
      if (activeTasks.length === 0) {
        await judgeGoal(runId, controller);
        state = await loadState(runId);
        if (state.status === 'completed' || state.status === 'failed' || state.status === 'partial_complete') {
          break;
        }
        continue;
      }

      const { batch, adaptive } = pickBatch(state, state.tasks, state.settings.maxParallel, state.executionPolicy);
      if (!batch.length) {
        const blockedTasks = describeBlockedTasks(state.tasks);
        await appendLog(runId, 'error', 'No runnable tasks remain. The graph is blocked.', {
          blockedTasks: blockedTasks.map((item) => item.message)
        });
        await appendTrace(runId, 'run.blocked', {
          blockedTasks
        });
        await withLock(runId, async () => {
          const fresh = await loadState(runId);
          for (const blocked of blockedTasks) {
            const task = fresh.tasks.find((item) => item.id === blocked.taskId);
            if (!task) continue;
            task.reviewSummary = task.reviewSummary || 'Blocked by a failed dependency.';
            task.findings = uniqueBy([...(task.findings || []), blocked.message], (item) => item);
          }
          fresh.status = 'failed';
          await saveState(fresh);
        });
        break;
      }

      if ((state.executionPolicy?.parallelMode || 'sequential') === 'parallel'
        && Number(adaptive?.limit || 1) < Math.max(1, Number(state.settings?.maxParallel || 1))
        && adaptive?.reason !== 'single-runnable-task') {
        await appendLog(runId, 'info', 'Adaptive parallelism reduced the current batch width.', {
          requestedParallel: Number(state.settings?.maxParallel || 1),
          appliedParallel: Number(adaptive?.limit || 1),
          reason: adaptive?.reason || 'adaptive'
        });
      }
      await Promise.all(batch.map((task) => executeTask(runId, task.id, controller)));
      const checkpoint = await writeRunCheckpoint(runId, 'task-batch-completed');
      const replan = await maybeAutomaticReplan(runId, controller, checkpoint);
      if (replan?.pauseForHuman) {
        break;
      }
    }

    if (controller.stopRequested) {
      await withLock(runId, async () => {
        const fresh = await loadState(runId);
        if (fresh.status !== 'completed') {
          fresh.status = 'stopped';
          await saveState(fresh);
        }
      });
      await appendLog(runId, 'warning', 'Run stopped by user.');
      await appendTrace(runId, 'run.stopped', {});
      await writeRunCheckpoint(runId, 'stop-requested');
    }
  } catch (error) {
    await appendLog(runId, 'error', 'Harness loop failed.', { error: error.message });
    await appendTrace(runId, 'run.failed', { error: error.message });
    await withLock(runId, async () => {
      const fresh = await loadState(runId);
      fresh.status = 'failed';
      fresh.result = {
        goalAchieved: false,
        summary: error.message,
        findings: [error.stack || error.message]
      };
      await saveState(fresh);
    });
    await writeRunCheckpoint(runId, 'loop-failed');
  } finally {
    try {
      const finalState = await loadState(runId);
      if (finalState.status === 'completed' || finalState.status === 'failed' || finalState.status === 'partial_complete') {
        await persistProjectMemory(runId);
        await appendTrace(runId, 'run.completed', {
          status: finalState.status,
          summary: finalState.result?.summary || ''
        });
      }
    } catch {}
    const entry = activeRuns.get(runId);
    if (entry) {
      for (const child of entry.children) {
        killProcessTree(child);
      }
      activeRuns.delete(runId);
    }
  }
}

export async function initHarness() {
  await ensureDir(RUNS_DIR);
  await ensureDir(PROJECTS_DIR);
  await ensureDir(MEMORY_DIR);
  await ensureDir(HARNESS_META_DIR);
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const state = await readJson(statePath(runId)).catch(() => null);
    if (!state) continue;

    let changed = false;
    if (state.status === 'running') {
      state.status = 'stopped';
      changed = true;
    }

    for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
      if (task.status === 'in_progress') {
        task.status = 'ready';
        task.reviewSummary = task.reviewSummary || 'Recovered after harness restart.';
        task.findings = uniqueBy([...(task.findings || []), 'Recovered after harness restart.'], (item) => item);
        changed = true;
      }
      if (task.lastExecution?.workspaceMode === 'git-worktree' || await fs.access(taskWorkspaceDir(runId, task.id)).then(() => true).catch(() => false)) {
        const gitRoot = await resolveGitProject(state.projectPath || '').catch(() => null);
        const workspaceDir = taskWorkspaceDir(runId, task.id);
        if (gitRoot) {
          await runGit(gitRoot, ['worktree', 'remove', '--force', workspaceDir], null, false).catch(() => {});
        }
        await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (changed) {
      await writeJson(statePath(runId), serializeState({ ...state, updatedAt: now() }));
      await writeRunCheckpoint(runId, 'recovered-after-restart').catch(() => {});
    }
  }
}

export function subscribe(listener) {
  bus.on('run', listener);
  return () => bus.off('run', listener);
}

export function summarizeRun(state) {
  return summarizeRunState(state);
}

export async function createProject(input = {}) {
  const rootPath = input.rootPath ? resolveInputPath(input.rootPath, '') : '';
  const harnessSettings = await getHarnessSettings(rootPath);
  const uiLanguage = normalizeLanguage(input.uiLanguage || harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage);
  const title = String(input.title || path.basename(rootPath) || 'Project').trim();
  const id = projectId(title, rootPath);
  const existing = await loadProjectState(id).catch(() => null);
  if (existing) {
    return existing;
  }
  if (rootPath) {
    const stat = await fs.stat(rootPath).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(localizedText(uiLanguage, '프로젝트 루트 경로가 없거나 폴더가 아닙니다.', 'Project root path does not exist or is not a directory.'));
    }
  }

  const validationCommands = await detectProjectValidationCommands(rootPath, PROJECT_INTEL_HELPERS);
  const phases = [];
  for (const [index, rawPhase] of (Array.isArray(input.phases) ? input.phases : []).entries()) {
    const phase = normalizeProjectPhase(rawPhase, phases, index, uiLanguage);
    if (!Array.isArray(rawPhase?.phaseContract?.verification) || rawPhase.phaseContract.verification.length === 0) {
      phase.phaseContract.verification = uniqueBy([
        ...validationCommands.slice(0, 3),
        ...phase.phaseContract.verification
      ], (item) => item).slice(0, 4);
    }
    phases.push(phase);
  }

  const defaultSettings = input.defaultSettings && typeof input.defaultSettings === 'object' ? { ...input.defaultSettings } : {};
  const providerProfile = normalizeProviderProfile(defaultSettings.providerProfile);
  if (providerProfile) defaultSettings.providerProfile = providerProfile;
  else delete defaultSettings.providerProfile;
  defaultSettings.continuationPolicy = normalizeContinuationPolicy(defaultSettings.continuationPolicy);

  const project = {
    id,
    title,
    rootPath,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    charterText: String(input.charterText || '').trim(),
    defaultPresetId: String(input.defaultPresetId || 'auto').trim() || 'auto',
    defaultSettings,
    sharedMemoryKey: String(input.sharedMemoryKey || projectKey(rootPath, title)).trim(),
    phases,
    currentPhaseId: String(input.currentPhaseId || phases.find((phase) => phase.status === 'active')?.id || phases[0]?.id || '').trim(),
    bootstrap: {
      enabled: input.bootstrapRepoDocs === true,
      generated: [],
      preservedExisting: [],
      generatedAt: ''
    },
    maintenance: {
      cleanupTasks: [],
      qualitySweeps: [],
      latestQualitySweep: null
    }
  };

  if (input.bootstrapRepoDocs === true) {
    project.bootstrap = await bootstrapProjectRepoDocs(project);
  }

  await writeProjectRecord(project);
  return project;
}

export async function listProjects() {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const projects = (await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await loadProjectState(entry.name);
        } catch {
          return null;
        }
      })
  )).filter(Boolean);
  return projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getProject(projectIdValue) {
  return loadProjectState(projectIdValue);
}

export async function updateProject(projectIdValue, input = {}) {
  const project = await loadProjectState(projectIdValue);
  const harnessSettings = await getHarnessSettings(project.rootPath || '');
  const uiLanguage = normalizeLanguage(input.uiLanguage || harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage);
  const updatedProject = {
    ...project,
    updatedAt: now(),
    charterText: Object.prototype.hasOwnProperty.call(input, 'charterText')
      ? String(input.charterText || '').trim()
      : project.charterText,
    defaultPresetId: Object.prototype.hasOwnProperty.call(input, 'defaultPresetId')
      ? (String(input.defaultPresetId || 'auto').trim() || 'auto')
      : project.defaultPresetId
  };
  const existingPhaseIds = new Set((Array.isArray(project.phases) ? project.phases : []).map((phase) => String(phase?.id || '').trim()).filter(Boolean));
  const inputPhases = Array.isArray(input.phases) ? input.phases : [];
  const phasePatchMap = new Map(
    inputPhases
      .map((phase) => {
        const id = String(phase?.id || '').trim();
        return id && existingPhaseIds.has(id) ? [id, phase] : null;
      })
      .filter(Boolean)
  );
  const appendedPhaseInputs = inputPhases.filter((phase) => {
    const id = String(phase?.id || '').trim();
    return !id || !existingPhaseIds.has(id);
  });

  const defaultSettings = { ...(project.defaultSettings || {}) };
  if (Object.prototype.hasOwnProperty.call(input, 'toolProfile')) {
    const toolProfile = normalizeToolProfile(input.toolProfile);
    if (toolProfile.id === 'default' && !toolProfile.allowedActionClasses.length) {
      delete defaultSettings.toolProfile;
    } else {
      defaultSettings.toolProfile = toolProfile;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'browserVerification')) {
    const browserVerification = normalizeBrowserVerificationConfig(input.browserVerification);
    if (browserVerification) defaultSettings.browserVerification = browserVerification;
    else delete defaultSettings.browserVerification;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'devServer')) {
    const devServer = normalizeDevServerConfig(input.devServer, project.rootPath || '');
    if (devServer) defaultSettings.devServer = devServer;
    else delete defaultSettings.devServer;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'providerProfile')) {
    const providerProfile = normalizeProviderProfile(input.providerProfile);
    if (providerProfile) defaultSettings.providerProfile = providerProfile;
    else delete defaultSettings.providerProfile;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'continuationPolicy')) {
    defaultSettings.continuationPolicy = normalizeContinuationPolicy(input.continuationPolicy, project.defaultSettings?.continuationPolicy);
  } else {
    defaultSettings.continuationPolicy = normalizeContinuationPolicy(defaultSettings.continuationPolicy, project.defaultSettings?.continuationPolicy);
  }

  updatedProject.defaultSettings = defaultSettings;
  updatedProject.phases = (Array.isArray(project.phases) ? project.phases : []).map((phase, index, phases) => {
    const patch = phasePatchMap.get(String(phase?.id || '').trim());
    if (!patch) return phase;
    const title = Object.prototype.hasOwnProperty.call(patch, 'title')
      ? (String(patch.title || '').trim() || phase.title || `Phase ${index + 1}`)
      : phase.title;
    const goal = Object.prototype.hasOwnProperty.call(patch, 'goal')
      ? String(patch.goal || '').trim()
      : phase.goal;
    return normalizeProjectPhase({
      ...phase,
      ...patch,
      id: phase.id,
      title,
      goal,
      status: Object.prototype.hasOwnProperty.call(patch, 'status') ? patch.status : phase.status,
      phaseContract: normalizePhaseContract(
        Object.prototype.hasOwnProperty.call(patch, 'phaseContract') ? patch.phaseContract : phase.phaseContract,
        { id: phase.id, title, goal },
        uiLanguage
      )
    }, phases, index, uiLanguage);
  });
  if (appendedPhaseInputs.length) {
    const validationCommands = await detectProjectValidationCommands(project.rootPath || '', PROJECT_INTEL_HELPERS);
    for (const rawPhase of appendedPhaseInputs) {
      const nextIndex = updatedProject.phases.length;
      const appendedPhase = normalizeProjectPhase(rawPhase, updatedProject.phases, nextIndex, uiLanguage);
      if (!Array.isArray(rawPhase?.phaseContract?.verification) || rawPhase.phaseContract.verification.length === 0) {
        appendedPhase.phaseContract.verification = uniqueBy([
          ...validationCommands.slice(0, 3),
          ...appendedPhase.phaseContract.verification
        ], (item) => item).slice(0, 4);
      }
      updatedProject.phases.push(appendedPhase);
    }
  }
  const requestedCurrentPhaseId = Object.prototype.hasOwnProperty.call(input, 'currentPhaseId')
    ? String(input.currentPhaseId || '').trim()
    : null;
  const appendedActivePhaseId = appendedPhaseInputs
    .map((phase) => String(phase?.id || '').trim())
    .map((id, index) => id || updatedProject.phases[(updatedProject.phases.length - appendedPhaseInputs.length) + index]?.id || '')
    .find((id, index) => String(appendedPhaseInputs[index]?.status || '').trim() === 'active' && id);
  const knownPhaseIds = new Set(updatedProject.phases.map((phase) => String(phase?.id || '').trim()).filter(Boolean));
  let currentPhaseId = requestedCurrentPhaseId;
  if (currentPhaseId === null && appendedActivePhaseId) {
    currentPhaseId = appendedActivePhaseId;
  }
  if (currentPhaseId && !knownPhaseIds.has(currentPhaseId)) currentPhaseId = '';
  if (currentPhaseId === null) {
    currentPhaseId = String(project.currentPhaseId || '').trim();
    if (!knownPhaseIds.has(currentPhaseId)) currentPhaseId = '';
    if (!currentPhaseId) {
      currentPhaseId = updatedProject.phases.find((phase) => String(phase?.status || '') === 'active')?.id || '';
    }
  }
  updatedProject.phases = updatedProject.phases.map((phase) => {
    const id = String(phase?.id || '').trim();
    if (!id) return phase;
    if (!currentPhaseId) {
      if (String(phase.status || '') === 'active') {
        return { ...phase, status: 'pending' };
      }
      return phase;
    }
    if (id === currentPhaseId) {
      return String(phase.status || '') === 'done' ? phase : { ...phase, status: 'active' };
    }
    return String(phase.status || '') === 'active' ? { ...phase, status: 'pending' } : phase;
  });
  if (!currentPhaseId) {
    const fallbackActive = updatedProject.phases.find((phase) => String(phase?.status || '') === 'active')?.id || '';
    currentPhaseId = fallbackActive;
  }
  updatedProject.currentPhaseId = currentPhaseId;
  const hasPhases = updatedProject.phases.length > 0;
  const hasOpenPhase = updatedProject.phases.some((phase) => String(phase?.status || '') !== 'done');
  updatedProject.status = hasPhases && !hasOpenPhase && !currentPhaseId ? 'completed' : 'active';
  await writeProjectRecord(updatedProject);
  return updatedProject;
}

function qualityFindingSeverity(category, findingCount = 1) {
  if (category === 'architecture-drift') return findingCount > 1 ? 'high' : 'medium';
  if (category === 'test-instability') return findingCount > 1 ? 'high' : 'medium';
  if (category === 'lint-debt') return 'medium';
  if (category === 'verification-gap') return 'medium';
  return 'low';
}

function qualityFindingActionability(category, severity) {
  if (category === 'docs-drift') {
    return {
      code: 'docs-sync',
      label: 'Docs sync'
    };
  }
  if (category === 'verification-gap') {
    return {
      code: 'next-maintenance-pass',
      label: 'Next maintenance pass'
    };
  }
  return {
    code: severity === 'high' ? 'before-next-feature' : 'queue-cleanup',
    label: severity === 'high' ? 'Before next feature' : 'Queue in cleanup lane'
  };
}

function qualityFindingSeverityScore(severity, findingCount = 1) {
  const normalizedSeverity = String(severity || '').trim().toLowerCase();
  const base = normalizedSeverity === 'high'
    ? 90
    : normalizedSeverity === 'medium'
      ? 60
      : 30;
  return Math.min(99, base + Math.max(0, Number(findingCount || 1) - 1) * 5);
}

function qualitySweepGrade(findings) {
  const highCount = findings.filter((item) => item.severity === 'high').length;
  if (highCount > 0 || findings.length >= 4) return 'needs-cleanup';
  if (findings.length >= 2) return 'watch';
  return findings.length ? 'stable-with-debt' : 'healthy';
}

function qualityCleanupTitle(category) {
  const labels = {
    'architecture-drift': 'Architecture drift cleanup',
    'lint-debt': 'Lint and static debt cleanup',
    'test-instability': 'Test instability cleanup',
    'verification-gap': 'Verification evidence cleanup',
    'docs-drift': 'Repo docs drift cleanup'
  };
  return labels[String(category || '').trim()] || 'Quality cleanup';
}

function qualityCleanupTaskId(sweepId, index) {
  return `${sweepId}-C${String(index + 1).padStart(2, '0')}`;
}

function escapeDebtTrackerCell(value) {
  return String(value || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function isLintCommand(command) {
  return /(?:^|\s)(?:eslint|lint|tsc|typecheck|npm run lint|pnpm lint|yarn lint)\b/i.test(String(command || ''));
}

function isTestCommand(command) {
  return /(?:^|\s)(?:test|jest|vitest|playwright|pytest|mocha|ava|npm test|pnpm test|yarn test)\b/i.test(String(command || ''));
}

function summarizeQualitySweepMarkdown(sweep) {
  const lines = [
    '# Quality Sweep',
    '',
    `- Sweep: ${sweep.sweepId}`,
    `- Trigger: ${sweep.trigger}`,
    `- Grade: ${sweep.grade}`,
    `- Project: ${sweep.projectTitle}`,
    `- Phase: ${sweep.phaseTitle || sweep.phaseId || '-'}`,
    `- Run count: ${sweep.runCount}`,
    `- Generated: ${sweep.createdAt}`,
    '',
    '## Summary',
    '',
    sweep.summary || 'No issues detected.',
    ''
  ];
  if (Array.isArray(sweep.findings) && sweep.findings.length) {
    lines.push('## Findings', '');
    for (const finding of sweep.findings) {
      lines.push(`### ${finding.category} [${finding.severity}]`, '');
      lines.push(`- Summary: ${finding.summary}`);
      lines.push(`- Score: ${finding.severityScore || 0}`);
      lines.push(`- Actionability: ${finding.actionabilityLabel || finding.actionability || '-'}`);
      lines.push(`- Finding count: ${finding.findingCount || 0}`);
      if (finding.recommendedAction) lines.push(`- Recommended action: ${finding.recommendedAction}`);
      if (Array.isArray(finding.evidence) && finding.evidence.length) {
        lines.push('- Evidence:');
        for (const item of finding.evidence) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function buildProjectQualitySweep(project, phase, phaseRuns) {
  const runTaskDiagnostics = [];
  for (const run of phaseRuns) {
    for (const task of (Array.isArray(run.tasks) ? run.tasks : [])) {
      const executionSummary = await readJson(taskArtifactPath(run.id, task.id, 'execution-summary.json')).catch(() => null);
      runTaskDiagnostics.push({ run, task, executionSummary });
    }
  }

  const findings = [];
  const outOfScopeEntries = runTaskDiagnostics.filter((entry) => Array.isArray(entry.executionSummary?.outOfScopeFiles) && entry.executionSummary.outOfScopeFiles.length);
  const driftRuns = phaseRuns.filter((run) => run?.autoReplan?.latest?.driftRisk === 'high' || run?.autoReplan?.latest?.objectiveStillValid === false);
  if (outOfScopeEntries.length || driftRuns.length) {
    const findingCount = outOfScopeEntries.length + driftRuns.length;
    const severity = qualityFindingSeverity('architecture-drift', findingCount);
    const actionability = qualityFindingActionability('architecture-drift', severity);
    findings.push({
      category: 'architecture-drift',
      severity,
      severityScore: qualityFindingSeverityScore(severity, findingCount),
      findingCount,
      actionability: actionability.code,
      actionabilityLabel: actionability.label,
      summary: 'Scope drift or objective drift detected in recent runs.',
      recommendedAction: 'Re-lock boundary docs and task scope in a maintenance/cleanup lane run before the next feature.',
      evidence: uniqueBy([
        ...outOfScopeEntries.map((entry) => `${entry.run.id}/${entry.task.id}: ${(entry.executionSummary?.outOfScopeFiles || []).join(', ')}`),
        ...driftRuns.map((run) => `${run.id}: ${run.autoReplan.latest.pauseReason || 'high drift risk'}`)
      ], (item) => item).slice(0, 6)
    });
  }

  const lintFailures = runTaskDiagnostics.filter((entry) => entry.executionSummary?.verificationOk === false
    && (entry.executionSummary?.verificationCommands || []).some((command) => isLintCommand(command)));
  if (lintFailures.length) {
    const findingCount = lintFailures.length;
    const severity = qualityFindingSeverity('lint-debt', findingCount);
    const actionability = qualityFindingActionability('lint-debt', severity);
    findings.push({
      category: 'lint-debt',
      severity,
      severityScore: qualityFindingSeverityScore(severity, findingCount),
      findingCount,
      actionability: actionability.code,
      actionabilityLabel: actionability.label,
      summary: 'Accumulated lint/static verification debt.',
      recommendedAction: 'Recover lint/typecheck in a maintenance run before adding new feature diffs.',
      evidence: lintFailures.slice(0, 6).map((entry) => `${entry.run.id}/${entry.task.id}: ${(entry.executionSummary?.verificationCommands || []).join(' | ')}`)
    });
  }

  const testFailures = runTaskDiagnostics.filter((entry) => entry.executionSummary?.verificationOk === false
    && (entry.executionSummary?.verificationCommands || []).some((command) => isTestCommand(command)));
  if (testFailures.length >= 2) {
    const findingCount = testFailures.length;
    const severity = qualityFindingSeverity('test-instability', findingCount);
    const actionability = qualityFindingActionability('test-instability', severity);
    findings.push({
      category: 'test-instability',
      severity,
      severityScore: qualityFindingSeverityScore(severity, findingCount),
      findingCount,
      actionability: actionability.code,
      actionabilityLabel: actionability.label,
      summary: 'Repeated test failures — a stabilization run is needed before new work.',
      recommendedAction: 'Isolate flaky or failing tests in the cleanup lane and document the reproduction path.',
      evidence: testFailures.slice(0, 6).map((entry) => `${entry.run.id}/${entry.task.id}: ${(entry.executionSummary?.verificationCommands || []).join(' | ')}`)
    });
  }

  const verificationGaps = runTaskDiagnostics.filter((entry) => {
    if (String(entry.task?.status || '') !== 'done') return false;
    const acceptance = normalizeAcceptanceCheckResults(entry.task?.lastExecution?.acceptanceCheckResults);
    const commands = Array.isArray(entry.executionSummary?.verificationCommands) ? entry.executionSummary.verificationCommands : [];
    return acceptance.length === 0 && commands.length === 0;
  });
  if (verificationGaps.length) {
    const findingCount = verificationGaps.length;
    const severity = qualityFindingSeverity('verification-gap', findingCount);
    const actionability = qualityFindingActionability('verification-gap', severity);
    findings.push({
      category: 'verification-gap',
      severity,
      severityScore: qualityFindingSeverityScore(severity, findingCount),
      findingCount,
      actionability: actionability.code,
      actionabilityLabel: actionability.label,
      summary: 'Some completed tasks were closed without mechanical verification evidence.',
      recommendedAction: 'Add acceptance metadata and verification commands in a maintenance pass.',
      evidence: verificationGaps.slice(0, 6).map((entry) => `${entry.run.id}/${entry.task.id}: ${entry.task.title || 'Untitled task'}`)
    });
  }

  const bootstrapTargets = buildRepoBootstrapTargets(project).map((entry) => entry.relativePath);
  const missingDocs = [];
  for (const relativePath of bootstrapTargets) {
    const resolved = path.join(project.rootPath || '', relativePath);
    if (!project.rootPath || !(await fileExists(resolved))) {
      missingDocs.push(relativePath);
    }
  }
  if (missingDocs.length) {
    const findingCount = missingDocs.length;
    const severity = qualityFindingSeverity('docs-drift', findingCount);
    const actionability = qualityFindingActionability('docs-drift', severity);
    findings.push({
      category: 'docs-drift',
      severity,
      severityScore: qualityFindingSeverityScore(severity, findingCount),
      findingCount,
      actionability: actionability.code,
      actionabilityLabel: actionability.label,
      summary: 'Repo-as-system-of-record doc skeleton is missing or incomplete.',
      recommendedAction: 'Restore bootstrap docs and update the active/completed plan and debt tracker to reflect current state.',
      evidence: missingDocs.slice(0, 6)
    });
  }

  const findingCountByCategory = findings.reduce((acc, finding) => {
    acc[finding.category] = (acc[finding.category] || 0) + 1;
    return acc;
  }, {});
  const grade = qualitySweepGrade(findings);
  const summary = findings.length
    ? `Quality sweep found ${findings.length} issue class(es): ${findings.map((item) => item.category).join(', ')}.`
    : 'Quality sweep found no active entropy signals.';
  return {
    schemaVersion: '1',
    sweepId: `QS-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    trigger: 'manual',
    createdAt: now(),
    cadence: 'daily recommended for active projects; force once after a major phase',
    projectId: project.id,
    projectTitle: project.title || '',
    projectRootPath: project.rootPath || '',
    phaseId: phase?.id || '',
    phaseTitle: phase?.title || '',
    runCount: phaseRuns.length,
    grade,
    summary,
    findingCountByCategory,
    findings,
    highestSeverityScore: findings.reduce((max, item) => Math.max(max, Number(item.severityScore || 0)), 0),
    recommendedActions: findings.map((item) => item.recommendedAction).filter(Boolean)
  };
}

function buildCleanupTasksFromSweep(sweep) {
  return (Array.isArray(sweep.findings) ? sweep.findings : []).map((finding, index) => ({
    id: qualityCleanupTaskId(sweep.sweepId, index),
    sourceSweepId: sweep.sweepId,
    phaseId: sweep.phaseId || '',
    phaseTitle: sweep.phaseTitle || '',
    category: finding.category,
    severity: finding.severity,
    severityScore: Number(finding.severityScore || 0),
    actionability: finding.actionability || '',
    actionabilityLabel: finding.actionabilityLabel || '',
    title: qualityCleanupTitle(finding.category),
    goal: finding.recommendedAction || finding.summary || 'Resolve the quality sweep finding.',
    summary: finding.summary || '',
    evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 6) : [],
    status: 'ready',
    lane: 'cleanup',
    updatedAt: sweep.createdAt,
    createdAt: sweep.createdAt
  }));
}

async function updateTechDebtTracker(project, sweep, cleanupTasks) {
  if (!project?.rootPath) return '';
  const trackerPath = path.join(project.rootPath, 'docs', 'tech-debt-tracker.md');
  await ensureDir(path.dirname(trackerPath));
  const existing = await fs.readFile(trackerPath, 'utf8').catch(() => '');
  const header = existing.trim()
    ? existing.replace(/\s+$/, '')
    : '# Tech Debt Tracker\n\n| Date | Area | Debt | Risk | Actionability | Cleanup Plan |\n|---|---|---|---|---|---|';
  const rows = (Array.isArray(sweep.findings) ? sweep.findings : []).map((finding, index) => {
    const cleanupTask = cleanupTasks[index];
    return `| ${escapeDebtTrackerCell(String(sweep.createdAt || '').slice(0, 10))} | ${escapeDebtTrackerCell([sweep.phaseTitle || sweep.phaseId, finding.category].filter(Boolean).join(' / '))} | ${escapeDebtTrackerCell(finding.summary)} | ${escapeDebtTrackerCell(`${finding.severity}${finding.severityScore ? ` (${finding.severityScore})` : ''}`)} | ${escapeDebtTrackerCell(finding.actionabilityLabel || finding.actionability || '-')} | ${escapeDebtTrackerCell(cleanupTask?.title ? `${cleanupTask.title}: ${cleanupTask.goal}` : (finding.recommendedAction || '-'))} |`;
  });
  const body = rows.length ? `${header}\n${rows.join('\n')}\n` : `${header}\n`;
  await fs.writeFile(trackerPath, body, 'utf8');
  return trackerPath;
}

export async function runProjectQualitySweep(projectIdValue, options = {}) {
  const project = await getProject(projectIdValue);
  const phaseId = String(options.phaseId || project.currentPhaseId || project.phases?.[0]?.id || '').trim();
  const phase = (Array.isArray(project.phases) ? project.phases : []).find((item) => String(item.id || '') === phaseId) || null;
  const allRuns = await listRuns();
  const phaseRuns = allRuns
    .filter((run) => run?.project?.id === projectIdValue && (!phaseId || String(run?.project?.phaseId || '') === phaseId))
    .sort(compareNewest);
  const runningRun = phaseRuns.find((run) => String(run.status || '') === 'running');
  if (runningRun) {
    const error = new Error(`Cannot run a quality sweep while ${runningRun.id} is still running.`);
    error.statusCode = 409;
    throw error;
  }

  const sweep = await buildProjectQualitySweep(project, phase, phaseRuns);
  const cleanupTasks = buildCleanupTasksFromSweep(sweep);
  await ensureDir(projectQualitySweepDir(project.id));
  const jsonPath = projectQualitySweepArtifactPath(project.id, sweep.sweepId, 'json');
  const mdPath = projectQualitySweepArtifactPath(project.id, sweep.sweepId, 'md');
  await writeJson(jsonPath, sweep);
  await fs.writeFile(mdPath, summarizeQualitySweepMarkdown(sweep), 'utf8');
  const debtTrackerPath = await updateTechDebtTracker(project, sweep, cleanupTasks);

  const updatedProject = {
    ...project,
    updatedAt: now(),
    maintenance: {
      ...(project.maintenance && typeof project.maintenance === 'object' ? project.maintenance : {}),
      cleanupTasks: uniqueBy([
        ...cleanupTasks,
        ...((Array.isArray(project.maintenance?.cleanupTasks) ? project.maintenance.cleanupTasks : []))
      ], (item) => String(item.id || '').trim()).slice(0, 60),
      qualitySweeps: uniqueBy([
        {
          sweepId: sweep.sweepId,
          createdAt: sweep.createdAt,
          phaseId: sweep.phaseId,
          phaseTitle: sweep.phaseTitle,
          grade: sweep.grade,
          findingCount: sweep.findings.length,
          highestSeverityScore: sweep.highestSeverityScore,
          categories: Object.keys(sweep.findingCountByCategory || {}),
          artifactPath: jsonPath,
          debtTrackerPath,
          cleanupTaskIds: cleanupTasks.map((item) => item.id)
        },
        ...((Array.isArray(project.maintenance?.qualitySweeps) ? project.maintenance.qualitySweeps : []))
      ], (item) => String(item.sweepId || '').trim()).slice(0, 12),
      latestQualitySweep: {
        sweepId: sweep.sweepId,
        createdAt: sweep.createdAt,
        phaseId: sweep.phaseId,
        phaseTitle: sweep.phaseTitle,
        grade: sweep.grade,
        findingCount: sweep.findings.length,
        highestSeverityScore: sweep.highestSeverityScore,
        categories: Object.keys(sweep.findingCountByCategory || {}),
        artifactPath: jsonPath,
        debtTrackerPath,
        cleanupTaskIds: cleanupTasks.map((item) => item.id)
      }
    }
  };
  await writeProjectRecord(updatedProject);
  const memory = await appendProjectQualitySweepMemory(ROOT_DIR, updatedProject, {
    ...sweep,
    artifactPath: jsonPath,
    markdownPath: mdPath
  });
  return {
    project: updatedProject,
    sweep,
    artifacts: {
      jsonPath,
      markdownPath: mdPath,
      debtTrackerPath
    },
    cleanupTasks,
    memory
  };
}

async function buildProjectRetentionSummary(project, runs) {
  const qualitySweeps = Array.isArray(project?.maintenance?.qualitySweeps) ? project.maintenance.qualitySweeps : [];
  const cleanupTasks = Array.isArray(project?.maintenance?.cleanupTasks) ? project.maintenance.cleanupTasks : [];
  const runCounts = {
    total: runs.length,
    active: runs.filter((run) => ['ready', 'running', 'needs_approval'].includes(String(run?.status || ''))).length,
    completed: runs.filter((run) => String(run?.status || '') === 'completed').length,
    stoppedOrFailed: runs.filter((run) => ['stopped', 'failed', 'partial_complete'].includes(String(run?.status || ''))).length
  };
  const sharedMemoryDir = project?.sharedMemoryKey ? path.join(MEMORY_DIR, project.sharedMemoryKey) : '';
  const sharedMemoryExists = sharedMemoryDir ? await fileExists(sharedMemoryDir) : false;
  const sharedMemoryFiles = sharedMemoryExists
    ? (await fs.readdir(sharedMemoryDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).length
    : 0;
  const latestSweep = qualitySweeps[0] || null;
  return {
    policy: 'preview-only',
    note: 'Retention/pruning is managed at the preview/context layer rather than via on-disk history rewrites.',
    runCounts,
    qualitySweepCount: qualitySweeps.length,
    cleanupTaskCount: cleanupTasks.length,
    sharedMemoryKey: project?.sharedMemoryKey || '',
    sharedMemoryExists,
    sharedMemoryFileCount: sharedMemoryFiles,
    hasLocalHarnessSettings: await fileExists(HARNESS_SETTINGS_FILE),
    latestRunUpdatedAt: runs[0]?.updatedAt || '',
    oldestRunUpdatedAt: runs.at(-1)?.updatedAt || '',
    latestQualitySweepAt: latestSweep?.createdAt || ''
  };
}

function normalizeProjectRunBucket(status) {
  const value = String(status || '').trim();
  if (value === 'running') return 'running';
  if (value === 'stopped') return 'stopped';
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'partial_complete') return 'failed';
  return 'ready';
}

function compareNewest(left, right) {
  const a = String(left?.updatedAt || '').trim();
  const b = String(right?.updatedAt || '').trim();
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

function buildCarryOverTaskEntry(run, phase, task) {
  const findings = Array.isArray(task?.findings) ? task.findings.filter(Boolean) : [];
  const checkpointNotes = Array.isArray(task?.checkpointNotes) ? task.checkpointNotes.filter(Boolean) : [];
  const lineageKind = task?.status === 'failed'
    ? 'failed-task'
    : (String(task?.lastExecution?.reviewDecision || '').trim().toLowerCase() === 'retry'
      ? 'retry-loop'
      : (checkpointNotes.some((note) => /automatic replanning/i.test(String(note || '')))
        ? 'replanned-backlog'
        : (String(run?.status || '').trim() === 'stopped'
          ? 'stopped-run'
          : (String(run?.status || '').trim() === 'partial_complete'
            ? 'partial-complete'
            : 'carry-over'))));
  return {
    runId: run.id,
    runTitle: run.title || '',
    runStatus: run.status || '',
    phaseId: phase?.id || '',
    phaseTitle: phase?.title || '',
    taskId: task.id,
    title: task.title || '',
    goal: task.goal || '',
    status: task.status || '',
    filesLikely: Array.isArray(task.filesLikely) ? task.filesLikely : [],
    acceptanceChecks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks : [],
    checkpointNotes,
    lineageKind,
    updatedAt: task.updatedAt || run.updatedAt || run.createdAt || '',
    summary: findings[0] || task.reviewSummary || (task.checkpointNotes || []).find(Boolean) || ''
  };
}

const projectHealth = createProjectHealth({
  buildCarryOverTaskEntry,
  clipText,
  isTaskSatisfiedStatus,
  localizedText,
  normalizeAcceptanceCheckResults,
  normalizeLanguage,
  normalizeContinuationPolicy,
  uniqueBy
});

function buildProjectPendingReviewEntries(run, phase) {
  const entries = [];
  const status = String(run?.status || '').trim();
  if (status === 'needs_approval') {
    entries.push({
      kind: run?.autoReplan?.latest?.driftRisk === 'high' || run?.autoReplan?.latest?.objectiveStillValid === false
        ? 'replan-review'
        : 'plan-approval',
      runId: run.id,
      runTitle: run.title || '',
      phaseId: phase?.id || '',
      phaseTitle: phase?.title || '',
      title: run.planSummary || 'Plan review pending',
      message: run?.autoReplan?.latest?.pauseReason
        || run?.humanLoop?.planApproval?.feedback
        || 'The run needs operator approval before execution can continue.',
      updatedAt: run.updatedAt || run.createdAt || ''
    });
  }
  if (status === 'needs_input') {
    const pendingCount = Array.isArray(run?.humanLoop?.clarifyPending) ? run.humanLoop.clarifyPending.length : 0;
    entries.push({
      kind: 'clarify-input',
      runId: run.id,
      runTitle: run.title || '',
      phaseId: phase?.id || '',
      phaseTitle: phase?.title || '',
      title: pendingCount ? `Clarify answers pending (${pendingCount})` : 'Clarify answers pending',
      message: pendingCount
        ? `The run is waiting for ${pendingCount} clarification answer(s) before planning can continue.`
        : 'The run is waiting for clarification input before planning can continue.',
      updatedAt: run.updatedAt || run.createdAt || ''
    });
  }
  return entries;
}

function buildBacklogLineageEntry(entry) {
  return {
    kind: entry.lineageKind || 'carry-over',
    runId: entry.runId,
    runTitle: entry.runTitle || '',
    runStatus: entry.runStatus || '',
    phaseId: entry.phaseId || '',
    phaseTitle: entry.phaseTitle || '',
    taskId: entry.taskId,
    title: entry.title || '',
    status: entry.status || '',
    summary: entry.summary || '',
    checkpointNotes: Array.isArray(entry.checkpointNotes) ? entry.checkpointNotes : [],
    updatedAt: entry.updatedAt || ''
  };
}

function buildProjectRiskEntries(run, phase) {
  const risks = [];
  for (const task of (Array.isArray(run?.tasks) ? run.tasks : [])) {
    if (task?.status === 'failed') {
      const findings = Array.isArray(task.findings) ? task.findings.filter(Boolean) : [];
      risks.push({
        kind: 'task-failed',
        runId: run.id,
        runTitle: run.title || '',
        phaseId: phase?.id || '',
        phaseTitle: phase?.title || '',
        taskId: task.id,
        title: task.title || '',
        message: findings[0] || task.reviewSummary || 'Task failed and needs operator attention.',
        updatedAt: task.updatedAt || run.updatedAt || run.createdAt || ''
      });
      continue;
    }
    const verification = task?.lastExecution?.verification;
    if (verification && verification.ok === false) {
      const message = Array.isArray(verification.failingChecks) && verification.failingChecks.length
        ? verification.failingChecks[0]
        : (String(verification.stderr || verification.stdout || '').trim() || 'Verification failed.');
      risks.push({
        kind: 'verification-gap',
        runId: run.id,
        runTitle: run.title || '',
        phaseId: phase?.id || '',
        phaseTitle: phase?.title || '',
        taskId: task.id,
        title: task.title || '',
        message,
        updatedAt: task.updatedAt || run.updatedAt || run.createdAt || ''
      });
    }
  }
  const latestReplan = run?.autoReplan?.latest || null;
  if (latestReplan?.driftRisk === 'high' || latestReplan?.objectiveStillValid === false) {
    risks.push({
      kind: 'objective-drift',
      runId: run.id,
      runTitle: run.title || '',
      phaseId: phase?.id || '',
      phaseTitle: phase?.title || '',
      taskId: '',
      title: 'Automatic replanning stopped the run',
      message: latestReplan.pauseReason || 'Automatic replanning flagged a high objective drift risk.',
      updatedAt: latestReplan.createdAt || run.updatedAt || run.createdAt || ''
    });
  }
  return risks;
}

function buildProjectContinuationContext(project, phase, phaseRuns = [], language = DEFAULT_HARNESS_SETTINGS.uiLanguage) {
  return projectHealth.buildProjectContinuationContext(project, phase, phaseRuns, language);
}

async function buildProjectRunSummary(projectPath, continuationContext = null) {
  const baseSummary = await buildProjectSummary(projectPath, PROJECT_INTEL_HELPERS);
  if (!continuationContext) return baseSummary;
  const lines = [baseSummary, '', '## Active continuation pack', ''];
  lines.push(`- Continuation mode: ${continuationContext.policyLabel || '-'}`);
  lines.push(`- Carry-over count: ${continuationContext.carryOverCount || 0}`);
  if (continuationContext.docsSyncExpectation) {
    lines.push(`- Docs sync rule: ${continuationContext.docsSyncExpectation}`);
  }
  if (Array.isArray(continuationContext.carryOverFocus) && continuationContext.carryOverFocus.length) {
    lines.push('', '### Carry-over focus', '');
    for (const item of continuationContext.carryOverFocus) {
      lines.push(`- ${item.taskId || '-'} ${item.title || ''}: ${item.summary || item.goal || '-'}`);
    }
  }
  if (Array.isArray(continuationContext.recentDocUpdates) && continuationContext.recentDocUpdates.length) {
    lines.push('', '### Recent doc updates', '');
    for (const item of continuationContext.recentDocUpdates) {
      lines.push(`- ${item.path}: ${item.note || item.runTitle || '-'}`);
    }
  }
  if (Array.isArray(continuationContext.recentRunSummaries) && continuationContext.recentRunSummaries.length) {
    lines.push('', '### Recent run outcomes', '');
    for (const item of continuationContext.recentRunSummaries) {
      lines.push(`- ${item.runTitle || item.runId || '-'} [${item.status || '-'}]: ${item.summary || '-'}`);
    }
  }
  if (continuationContext.latestQualitySweep?.summary) {
    lines.push('', '### Latest quality sweep', '', `- ${continuationContext.latestQualitySweep.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildProjectRuntimeObservability(project, phaseRuns = [], browserReadiness = null, language = DEFAULT_HARNESS_SETTINGS.uiLanguage) {
  return projectHealth.buildProjectRuntimeObservability(project, phaseRuns, browserReadiness, language);
}

function buildProjectHealthDashboard(project, phases = [], runs = [], browserReadiness = null, language = DEFAULT_HARNESS_SETTINGS.uiLanguage) {
  return projectHealth.buildProjectHealthDashboard(project, phases, runs, browserReadiness, language);
}

export async function getProjectOverview(projectIdValue) {
  const project = await getProject(projectIdValue);
  const environment = await buildEnvironmentDiagnostics();
  const harnessSettings = await getHarnessSettings(project?.rootPath || '');
  const uiLanguage = normalizeLanguage(harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage);
  const runs = (await listRuns()).filter((run) => run?.project?.id === projectIdValue);
  const retention = await buildProjectRetentionSummary(project, runs);
  const phases = (Array.isArray(project?.phases) ? project.phases : []).map((phase) => {
    const phaseRuns = runs
      .filter((run) => String(run?.project?.phaseId || '') === String(phase.id || ''))
      .sort(compareNewest);
    const runCounts = {
      ready: 0,
      running: 0,
      stopped: 0,
      failed: 0,
      completed: 0
    };
    for (const run of phaseRuns) {
      runCounts[normalizeProjectRunBucket(run.status)] += 1;
    }
    const carryOverTasks = phaseRuns
      .filter((run) => ['stopped', 'failed', 'partial_complete'].includes(String(run.status || '')))
      .flatMap((run) => (Array.isArray(run.tasks) ? run.tasks : [])
        .filter((task) => !['done', 'skipped'].includes(String(task?.status || '')))
        .map((task) => buildCarryOverTaskEntry(run, phase, task)))
      .sort(compareNewest);
    const pendingReview = phaseRuns
      .flatMap((run) => buildProjectPendingReviewEntries(run, phase))
      .sort(compareNewest)
      .slice(0, 6);
    const backlogLineage = carryOverTasks
      .map((entry) => buildBacklogLineageEntry(entry))
      .sort(compareNewest)
      .slice(0, 10);
    const openRisks = phaseRuns
      .flatMap((run) => buildProjectRiskEntries(run, phase))
      .sort(compareNewest)
      .slice(0, 8);
    const cleanupLane = (Array.isArray(project?.maintenance?.cleanupTasks) ? project.maintenance.cleanupTasks : [])
      .filter((task) => String(task?.status || '') === 'ready' && String(task?.phaseId || '') === String(phase.id || ''))
      .sort(compareNewest)
      .slice(0, 8);
    const latestQualitySweep = (Array.isArray(project?.maintenance?.qualitySweeps) ? project.maintenance.qualitySweeps : [])
      .find((entry) => String(entry?.phaseId || '') === String(phase.id || '')) || null;
    const recentRuns = phaseRuns.slice(0, 5).map((run) => summarizeRunState(run));
    return {
      id: phase.id,
      title: phase.title || '',
      goal: phase.goal || '',
      status: phase.status || '',
      phaseContract: phase.phaseContract
        ? {
            ...phase.phaseContract,
            path: projectPhaseContractPath(project.id, phase.id)
          }
        : null,
      runCounts,
      carryOverTasks,
      pendingReview,
      backlogLineage,
      openRisks,
      cleanupLane,
      latestQualitySweep,
      recentRuns
    };
  });

  const browserReadiness = buildProjectBrowserReadiness(project, environment);
  const healthDashboard = buildProjectHealthDashboard(project, phases, runs, browserReadiness, uiLanguage);
  return {
    project: {
      ...project,
      runtimeReadiness: {
        browser: browserReadiness
      },
      retention,
      healthDashboard
    },
    phases
  };
}

export async function listRuns() {
  await ensureDir(RUNS_DIR);
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      runs.push(await loadState(entry.name));
    } catch {}
  }
  return runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function listRunSummaries() {
  await ensureDir(RUNS_DIR);
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const summaries = (await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return summarizeRunState(await loadPersistedState(entry.name));
        } catch {
          return null;
        }
      })
  )).filter(Boolean);
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function getRun(runId) {
  const run = await loadState(runId);
  return {
    ...run,
    metrics: normalizePublicRunMetrics(run?.metrics)
  };
}

export async function getRunLogs(runId) {
  return readRecentLogs(runId);
}

export async function deleteRun(runId) {
  if (activeRuns.has(runId)) {
    const error = new Error('Cannot delete a running run. Stop it first.');
    error.statusCode = 409;
    throw error;
  }
  await withLock(runId, async () => {
    await fs.access(runDir(runId));
    await fs.rm(runDir(runId), { recursive: true, force: true });
  });
  writeLocks.delete(runId);
  bus.emit('run', { runId, type: 'deleted' });
  return { ok: true, runId };
}

export async function deleteProject(projectIdValue, options = {}) {
  const project = await loadProjectState(projectIdValue);
  const deleteRuns = options.deleteRuns === true;
  const deleteMemory = options.deleteMemory === true;
  const relatedRuns = (await listRunSummaries()).filter((run) => String(run?.project?.id || '') === String(projectIdValue || ''));
  const runningRun = relatedRuns.find((run) => activeRuns.has(run.id));

  if (runningRun && deleteRuns) {
    const error = new Error(`Cannot delete project runs while "${runningRun.title || runningRun.id}" is still running.`);
    error.statusCode = 409;
    throw error;
  }

  const deletedRuns = [];
  if (deleteRuns) {
    for (const run of relatedRuns) {
      await deleteRun(run.id);
      deletedRuns.push(run.id);
    }
  }

  let deletedMemory = false;
  if (deleteMemory && project.sharedMemoryKey) {
    await fs.rm(path.join(MEMORY_DIR, project.sharedMemoryKey), { recursive: true, force: true });
    deletedMemory = true;
  }

  await fs.rm(projectDir(projectIdValue), { recursive: true, force: true });
  return {
    ok: true,
    projectId: projectIdValue,
    deletedRuns,
    keptRuns: deleteRuns ? [] : relatedRuns.map((run) => run.id),
    deletedMemory,
    keptMemoryKey: deleteMemory ? '' : (project.sharedMemoryKey || '')
  };
}

export async function submitClarifyAnswers(runId, answers) {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    state.humanLoop.clarifyAnswers = {
      ...(state.humanLoop?.clarifyAnswers || {}),
      ...normalizeClarifyAnswers(answers, state.humanLoop?.clarifyQuestions || state.clarify?.openQuestions)
    };
    state.humanLoop.clarifyPending = [];
    state.clarify = {
      clarifiedObjective: '',
      scopeSummary: '',
      assumptions: [],
      openQuestions: [],
      architecturePattern: '',
      executionModel: ''
    };
    state.status = 'draft';
    await saveState(state);
    await rewriteSpecBundle(state);
  });
  await appendLog(runId, 'info', 'Clarify answers submitted.');
  return loadState(runId);
}

export async function approvePlan(runId) {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    state.humanLoop.planApproval = {
      ...state.humanLoop.planApproval,
      status: 'approved',
      approvedAt: now()
    };
    state.status = 'running';
    await saveState(state);
  });
  await appendLog(runId, 'info', 'Plan approved by user.');
  return loadState(runId);
}

export async function rejectPlan(runId, feedback) {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    state.humanLoop.planApproval = {
      ...state.humanLoop.planApproval,
      status: 'rejected',
      feedback: String(feedback || '').trim(),
      requestedAt: '',
      approvedAt: ''
    };
    state.planSummary = '';
    state.executionModel = '';
    state.executionPolicy = defaultExecutionPolicy(state.profile);
    state.tasks = [];
    state.status = 'draft';
    await saveState(state);
  });
  await appendLog(runId, 'warning', 'Plan rejected by user.', { feedback: String(feedback || '').trim() });
  return loadState(runId);
}

export async function updatePlanDraft(runId, input = {}) {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    const editableStatuses = ['draft', 'needs_approval', 'stopped', 'failed', 'partial_complete'];
    if (!editableStatuses.includes(state.status)) {
      throw new Error('Plan can only be edited before execution starts or while the run is paused/stopped.');
    }

    const agents = Array.isArray(input.agents) ? input.agents.map(normalizeAgent).filter((agent) => agent.name) : state.agents;
    const tasks = Array.isArray(input.tasks)
      ? (['draft', 'needs_approval'].includes(state.status)
        ? materializePlannedTasks(input.tasks)
        : mergeEditableBacklogTasks(state.tasks, input.tasks))
      : state.tasks;

    state.planSummary = String(input.summary || state.planSummary || '').trim();
    state.executionModel = String(input.executionModel || state.executionModel || '').trim();
    state.agents = agents;
    state.tasks = tasks;
    state.harnessConfig = {
      ...(state.harnessConfig || {}),
      teamBlueprint: agents
    };
    if (state.status === 'needs_approval') {
      state.humanLoop.planApproval = {
        ...(state.humanLoop?.planApproval || {}),
        status: 'pending',
        requestedAt: now()
      };
    }
    await saveState(state);
    await writeHarnessGuidanceDoc(state);
  });
  await appendLog(runId, 'info', 'Plan draft updated by user.', {
    taskCount: Array.isArray(input.tasks) ? input.tasks.length : undefined,
    agentCount: Array.isArray(input.agents) ? input.agents.length : undefined
  });
  await writeRunCheckpoint(runId, 'backlog-edited');
  return loadState(runId);
}

export async function searchRunMemory(runId, query) {
  const run = await loadState(runId);
  const snapshot = await resolvePromptMemory(run, query || run.memory?.searchQuery || '');
  await applyMemorySnapshot(runId, snapshot);
  return {
    query: snapshot.searchQuery,
    recentSummary: snapshot.recentSummary,
    searchResults: snapshot.searchResults,
    searchBackend: snapshot.searchBackend,
    memoryFile: snapshot.memoryFile,
    dailyDir: snapshot.dailyDir,
    failureAnalytics: snapshot.failureAnalytics || null,
    traceSummary: snapshot.traceSummary || null,
    graphInsights: snapshot.graphInsights || { topEdges: [], topSymbols: [] },
    temporalInsights: snapshot.temporalInsights || { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
  };
}

export async function diagnoseSetup(input = {}) {
  const projectPath = input.projectPath ? resolveInputPath(input.projectPath, '') : '';
  const rawSpecFiles = String(input.specFiles || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resolvedSpecFiles = rawSpecFiles.map((item) => resolveInputPath(item, projectPath));
  const harnessSettings = await getHarnessSettings(projectPath);
  const effectiveProviderProfile = normalizeProviderProfile(input.providerProfile, harnessSettings);
  const diagnostics = await buildPreflight(projectPath, resolvedSpecFiles, effectiveProviderProfile
    ? {
        ...harnessSettings,
        coordinationProvider: effectiveProviderProfile.coordinationProvider,
        workerProvider: effectiveProviderProfile.workerProvider
      }
    : harnessSettings);
  const inputQuality = diagnoseRunInputShape(input, normalizeLanguage(harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage));
  return {
    ...diagnostics,
    warnings: uniqueBy([...(diagnostics.warnings || []), ...inputQuality.warnings], (item) => item),
    actionPlan: [...(diagnostics.actionPlan || []), ...(inputQuality.actionPlan || [])]
  };
}

export async function refreshRunPreflight(runId) {
  return withLock(runId, async () => {
    const state = await loadState(runId);
    const preflight = await buildPreflight(state.projectPath || '', state.input?.specFiles || [], state.harnessConfig || null);
    const validationCommands = await detectProjectValidationCommands(state.projectPath || '', PROJECT_INTEL_HELPERS);
    state.preflight = preflight;
    state.projectContext = {
      ...(state.projectContext || {}),
      validationCommands
    };
    await saveState(state);
    return state;
  });
}

export async function retryTask(runId, taskId) {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'in_progress') {
      throw new Error('Task is already running.');
    }
    task.status = 'ready';
    task.attempts = 0;
    task.reviewSummary = '';
    task.findings = [];
    task.lastExecution = {
      ...(task.lastExecution || defaultTaskExecution()),
      applyResult: '',
      reviewDecision: ''
    };
    if (state.status === 'failed' || state.status === 'stopped' || state.status === 'partial_complete') {
      state.status = 'draft';
      state.result = null;
    }
    await saveState(state);
  });
  await appendLog(runId, 'warning', `Task ${taskId} re-queued by user.`, { taskId });
  return loadState(runId);
}

export async function requeueFailedTasks(runId) {
  let requeuedCount = 0;
  await withLock(runId, async () => {
    const state = await loadState(runId);
    for (const task of state.tasks) {
      if (task.status !== 'failed') continue;
      task.status = 'ready';
      task.attempts = 0;
      task.reviewSummary = '';
      task.findings = [];
      task.lastExecution = {
        ...(task.lastExecution || defaultTaskExecution()),
        applyResult: '',
        reviewDecision: ''
      };
      requeuedCount += 1;
    }
    if (requeuedCount > 0 && (state.status === 'failed' || state.status === 'stopped' || state.status === 'partial_complete')) {
      state.status = 'draft';
      state.result = null;
    }
    await saveState(state);
  });
  await appendLog(runId, 'warning', `Failed tasks re-queued by user.`, { requeuedCount });
  return loadState(runId);
}

export async function skipTask(runId, taskId, reason = '') {
  await withLock(runId, async () => {
    const state = await loadState(runId);
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'in_progress') {
      throw new Error('Task is already running.');
    }
    const note = String(reason || '').trim();
    task.status = 'skipped';
    task.reviewSummary = note || 'Skipped by user.';
    task.findings = note ? [note] : ['Skipped by user.'];
    task.lastExecution = {
      ...(task.lastExecution || defaultTaskExecution()),
      applyResult: 'Skipped by user.',
      reviewDecision: 'skipped'
    };
    if (state.status === 'failed' || state.status === 'stopped' || state.status === 'partial_complete') {
      state.status = 'draft';
      state.result = null;
    }
    await saveState(state);
  });
  await appendLog(runId, 'warning', `Task ${taskId} skipped by user.`, {
    taskId,
    reason: String(reason || '').trim()
  });
  return loadState(runId);
}

export async function createRun(input) {
  const title = String(input.title || input.objective || 'Harness Run').trim();
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${slugify(title)}`;
  const attachedProject = input.projectId ? await getProject(String(input.projectId || '').trim()) : null;
  const projectPath = input.projectPath ? resolveInputPath(input.projectPath, '') : (attachedProject?.rootPath || '');
  const harnessSettings = await getHarnessSettings(projectPath);
  const uiLanguage = normalizeLanguage(input.uiLanguage || harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, DEFAULT_HARNESS_SETTINGS.uiLanguage);
  const selectedPreset = getPreset(String(input.presetId || attachedProject?.defaultPresetId || 'auto').trim() || 'auto');
  const selectedPhase = attachedProject
    ? ((attachedProject.phases || []).find((phase) => phase.id === String(input.phaseId || attachedProject.currentPhaseId || '').trim())
      || (attachedProject.phases || []).find((phase) => String(phase?.status || '') === 'active')
      || null)
    : null;
  const allProjectRuns = attachedProject ? await listRuns() : [];
  const phaseRuns = attachedProject
    ? allProjectRuns
      .filter((run) => String(run?.project?.id || '') === String(attachedProject.id || '')
        && String(run?.project?.phaseId || '') === String(selectedPhase?.id || attachedProject.currentPhaseId || ''))
      .sort(compareNewest)
    : [];
  const continuationContext = attachedProject
    ? buildProjectContinuationContext(attachedProject, selectedPhase, phaseRuns, uiLanguage)
    : null;
  const projectRef = attachedProject
    ? {
        id: attachedProject.id,
        title: attachedProject.title,
        rootPath: attachedProject.rootPath || '',
        sharedMemoryKey: attachedProject.sharedMemoryKey,
        phaseId: selectedPhase?.id || '',
        phaseTitle: selectedPhase?.title || '',
        phaseGoal: selectedPhase?.goal || '',
        phaseContract: selectedPhase?.phaseContract || null,
        continuationContext,
        phaseContractPath: selectedPhase?.id ? projectPhaseContractPath(attachedProject.id, selectedPhase.id) : '',
        charterText: attachedProject?.charterText || '',
        charterPath: projectCharterPath(attachedProject.id)
      }
    : null;
  const memoryKey = projectRef?.sharedMemoryKey || projectKey(projectPath, title);

  if (projectPath) {
    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(localizedText(uiLanguage, '프로젝트 경로가 없거나 폴더가 아닙니다.', 'Project path does not exist or is not a directory.'));
    }
  }

  const memorySnapshot = await resolvePromptMemory(
    { memory: { projectKey: memoryKey }, projectPath },
    String(input.objective || title).trim(),
    4,
    { reindex: false }
  );
  const rawSpecFiles = String(input.specFiles || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const resolvedSpecFiles = rawSpecFiles.map((item) => resolveInputPath(item, projectPath));
  const rawInputSettings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const projectDefaultSettings = attachedProject?.defaultSettings && typeof attachedProject.defaultSettings === 'object'
    ? attachedProject.defaultSettings
    : {};
  const profileInputSettings = {
    ...projectDefaultSettings,
    ...rawInputSettings
  };
  const mergedInputSettings = {
    ...DEFAULT_SETTINGS,
    ...projectDefaultSettings,
    ...rawInputSettings
  };
  const toolProfile = normalizeToolProfile(input.toolProfile || attachedProject?.defaultSettings?.toolProfile);
  const runProfile = buildRunProfile(selectedPreset, profileInputSettings);
  const runOperationDefaults = getRunOperationDefaults(selectedPreset.id || 'auto');
  const effectiveProviderProfile = normalizeProviderProfile(input.providerProfile || attachedProject?.defaultSettings?.providerProfile, harnessSettings) || {
    coordinationProvider: normalizeAgentProvider(harnessSettings.coordinationProvider, DEFAULT_HARNESS_SETTINGS.coordinationProvider),
    workerProvider: normalizeAgentProvider(harnessSettings.workerProvider, DEFAULT_HARNESS_SETTINGS.workerProvider)
  };
  const effectiveHarnessSettings = {
    ...harnessSettings,
    coordinationProvider: effectiveProviderProfile.coordinationProvider,
    workerProvider: effectiveProviderProfile.workerProvider
  };
  const effectiveCodexRuntimeProfile = normalizeCodexRuntimeProfile(
    hasOwnSetting(rawInputSettings, 'codexRuntimeProfile')
      ? rawInputSettings.codexRuntimeProfile
      : (hasOwnSetting(projectDefaultSettings, 'codexRuntimeProfile')
        ? projectDefaultSettings.codexRuntimeProfile
        : effectiveHarnessSettings.codexRuntimeProfile),
    DEFAULT_SETTINGS.codexRuntimeProfile
  );
  const preflight = await buildPreflight(projectPath, resolvedSpecFiles, effectiveHarnessSettings);
  const validationCommands = await detectProjectValidationCommands(projectPath, PROJECT_INTEL_HELPERS);
  const browserVerification = normalizeBrowserVerificationConfig(input.browserVerification || attachedProject?.defaultSettings?.browserVerification);
  const devServer = normalizeDevServerConfig(input.devServer || attachedProject?.defaultSettings?.devServer, projectPath);

  await ensureDir(path.join(runDir(runId), 'input'));
  await ensureDir(path.join(runDir(runId), 'context'));
  await ensureDir(path.join(runDir(runId), 'tasks'));

  await fs.writeFile(
    path.join(runDir(runId), 'input', 'spec-bundle.md'),
    await buildSpecBundle({
      ...input,
      executionProfile: runProfile,
        projectContext: projectRef
          ? {
              title: projectRef.title,
              rootPath: projectRef.rootPath,
              phaseTitle: projectRef.phaseTitle,
              phaseGoal: projectRef.phaseGoal,
              phaseContract: projectRef.phaseContract || null,
              continuationContext: projectRef.continuationContext || null,
              charterText: attachedProject?.charterText || ''
          }
        : null
    }, resolvedSpecFiles),
    'utf8'
  );
  await fs.writeFile(
    path.join(runDir(runId), 'context', 'project-summary.md'),
    await buildProjectRunSummary(projectPath, continuationContext),
    'utf8'
  );
  await fs.writeFile(harnessGuidancePath(runId), '', 'utf8');
  await fs.writeFile(logPath(runId), '', 'utf8');
  await fs.writeFile(tracePath(runId), '', 'utf8');
  await fs.writeFile(runActionPath(runId), '', 'utf8');

  const starterTeamBlueprint = deriveTeamBlueprint({
    preset: selectedPreset,
    clarify: { architecturePattern: runProfile.flowProfile === 'hybrid' ? 'fan-out/fan-in' : 'pipeline' },
    profile: runProfile,
    harnessConfig: effectiveHarnessSettings
  });

  const state = {
    id: runId,
    title,
    status: 'draft',
    createdAt: now(),
    updatedAt: now(),
    projectPath,
    project: projectRef,
    input: {
      objective: String(input.objective || '').trim(),
      specText: String(input.specText || '').trim(),
      specFiles: resolvedSpecFiles
    },
    preflight,
    projectContext: {
      validationCommands,
      browserVerification,
      devServer,
      providerProfile: effectiveProviderProfile
    },
    toolProfile,
    settings: {
      ...mergedInputSettings,
      maxParallel: runProfile.maxParallel,
      maxTaskAttempts: Math.max(1, Number(
        hasOwnSetting(rawInputSettings, 'maxTaskAttempts')
          ? rawInputSettings.maxTaskAttempts
          : (hasOwnSetting(projectDefaultSettings, 'maxTaskAttempts')
            ? projectDefaultSettings.maxTaskAttempts
            : runOperationDefaults.maxTaskAttempts)
      ) || runOperationDefaults.maxTaskAttempts),
      maxGoalLoops: Math.max(1, Number(
        hasOwnSetting(rawInputSettings, 'maxGoalLoops')
          ? rawInputSettings.maxGoalLoops
          : (hasOwnSetting(projectDefaultSettings, 'maxGoalLoops')
            ? projectDefaultSettings.maxGoalLoops
            : runOperationDefaults.maxGoalLoops)
      ) || runOperationDefaults.maxGoalLoops),
      requirePlanApproval: mergedInputSettings.requirePlanApproval !== false,
      codexRuntimeProfile: effectiveCodexRuntimeProfile,
      codexModel: String(mergedInputSettings.codexModel || DEFAULT_SETTINGS.codexModel).trim() || DEFAULT_SETTINGS.codexModel,
      codexReasoningEffort: String(mergedInputSettings.codexReasoningEffort || DEFAULT_SETTINGS.codexReasoningEffort).trim() || DEFAULT_SETTINGS.codexReasoningEffort,
      codexServiceTier: String(mergedInputSettings.codexServiceTier || DEFAULT_SETTINGS.codexServiceTier).trim() || DEFAULT_SETTINGS.codexServiceTier,
      coordinationProvider: effectiveProviderProfile.coordinationProvider,
      workerProvider: effectiveProviderProfile.workerProvider,
      claudeModel: String(effectiveHarnessSettings.claudeModel || DEFAULT_SETTINGS.claudeModel).trim(),
      geminiModel: String(effectiveHarnessSettings.geminiModel || DEFAULT_SETTINGS.geminiModel).trim() || DEFAULT_SETTINGS.geminiModel,
      geminiProjectId: String(effectiveHarnessSettings.geminiProjectId || DEFAULT_SETTINGS.geminiProjectId).trim()
    },
    profile: runProfile,
    harnessConfig: {
      ...effectiveHarnessSettings,
      teamBlueprint: starterTeamBlueprint
    },
    preset: selectedPreset,
    clarify: {
      clarifiedObjective: '',
      scopeSummary: '',
      assumptions: [],
      openQuestions: [],
      architecturePattern: '',
      executionModel: ''
    },
    executionPolicy: defaultExecutionPolicy(runProfile),
    memory: {
      projectKey: memoryKey,
      dir: memorySnapshot.baseDir,
      memoryFile: memorySnapshot.memoryFile,
      dailyDir: memorySnapshot.dailyDir,
      dailyFile: memorySnapshot.dailyFile,
      indexFile: memorySnapshot.indexFile,
      recentSummary: memorySnapshot.recentSummary,
      searchQuery: memorySnapshot.searchQuery,
      searchResults: memorySnapshot.searchResults,
      retrievedContext: memorySnapshot.retrievedContext,
      searchBackend: memorySnapshot.searchBackend,
      failureAnalytics: memorySnapshot.failureAnalytics || null,
      traceSummary: memorySnapshot.traceSummary || null,
      graphInsights: memorySnapshot.graphInsights || { topEdges: [], topSymbols: [] },
      temporalInsights: memorySnapshot.temporalInsights || { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
    },
    humanLoop: {
      clarifyAnswers: {},
      clarifyQuestions: [],
      clarifyPending: [],
      planApproval: {
        status: 'idle',
        feedback: '',
        requestedAt: '',
        approvedAt: ''
      }
    },
    planSummary: '',
    executionModel: '',
    agents: starterTeamBlueprint.map((agent) => ({
      ...agent,
      responsibility: agent.role
    })),
    tasks: [],
    logs: [],
    metrics: {
      planningRuns: 0,
      executionRuns: 0,
      reviews: 0,
      goalChecks: 0,
      replanRuns: 0
    },
    autoReplan: {
      lastRunAt: '',
      latest: null
    },
    goalLoops: 0,
    result: null
  };

  await saveState(state);
  if (attachedProject) {
    await writeProjectRecord({
      ...attachedProject,
      updatedAt: now()
    }).catch(() => {});
  }
  await writeHarnessGuidanceDoc(state);
  await refreshRunMemory(runId, state.input.objective || state.title);
  await appendLog(runId, 'info', 'Run created.');
  await appendTrace(runId, 'run.created', {
    title,
    preset: selectedPreset.id,
    projectPath
  });
  await writeRunCheckpoint(runId, 'run-created');
  return loadState(runId);
}

export async function startRun(runId, { additionalRequirements = '' } = {}) {
  if (activeRuns.has(runId)) {
    return loadState(runId);
  }
  const controller = { stopRequested: false, children: new Set() };
  activeRuns.set(runId, controller);
  await withLock(runId, async () => {
    const state = await loadState(runId);
    if (additionalRequirements && additionalRequirements.trim()) {
      const trimmed = additionalRequirements.trim();
      state.input = state.input || {};
      state.input.additionalNotes = ((state.input.additionalNotes || '') + '\n\n---\n# Additional requirements (' + now() + ')\n\n' + trimmed).trim();
      const specBundlePath = path.join(runDir(runId), 'input', 'spec-bundle.md');
      const existing = await fs.readFile(specBundlePath, 'utf8').catch(() => '');
      await fs.writeFile(specBundlePath, existing + '\n\n# Additional requirements (' + now() + ')\n\n' + trimmed + '\n', 'utf8');
      await saveState(state);
      await appendLog(runId, 'info', 'Additional requirements applied to spec.');
    }
    if (state.humanLoop?.clarifyPending?.length) {
      state.status = 'needs_input';
    } else if (!state.tasks.length || state.status === 'draft') {
      state.status = 'running';
    } else if (state.status === 'needs_approval' && state.humanLoop?.planApproval?.status !== 'approved') {
      state.status = 'needs_approval';
    } else {
      state.status = 'running';
    }
    await saveState(state);
  });
  await appendLog(runId, 'info', 'Run started.');
  await appendTrace(runId, 'run.started', {});
  await writeRunCheckpoint(runId, 'run-started');
  loopRun(runId, controller);
  return loadState(runId);
}

export async function stopRun(runId) {
  const controller = activeRuns.get(runId);
  if (controller) {
    controller.stopRequested = true;
    for (const child of controller.children) {
      killProcessTree(child);
    }
  } else {
    await withLock(runId, async () => {
      const state = await loadState(runId);
      state.status = 'stopped';
      await saveState(state);
    });
  }
  await appendLog(runId, 'warning', 'Stop requested.');
  await writeRunCheckpoint(runId, 'stop-requested');
  return loadState(runId);
}
