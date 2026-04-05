import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GRAPH_INTELLIGENCE_DEFAULTS } from './run-config.mjs';

const HIGH_RISK_PATTERNS = [
  'auth',
  'security',
  'payment',
  'billing',
  'schema',
  'migration',
  'database',
  'public api',
  'breaking',
  '.env',
  'dockerfile',
  'package.json',
  'pnpm-lock',
  'package-lock',
  'yarn.lock'
];

const CODE_CONTEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php']);
const CODE_CONTEXT_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'runs', 'memory', '.harness-web']);
const JS_IMPORT_CLAUSE_PATTERN = /\bimport\s+(?:type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
const JS_REEXPORT_CLAUSE_PATTERN = /\bexport\s+(?:type\s+)?([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
const JS_EXPORT_NAMED_CLAUSE_PATTERN = /\bexport\s+\{([^}]+)\}(?!\s+from\b)/g;
const JS_EXPORT_DEFAULT_DECL_PATTERN = /\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_]\w*)/g;
const JS_EXPORT_DEFAULT_IDENTIFIER_PATTERN = /\bexport\s+default\s+(?!async\b|function\b|class\b)([A-Za-z_]\w*)\s*;?/g;
const JS_EXPORT_STAR_PATTERN = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g;
const JS_SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s+['"]([^'"]+)['"]/g;
const STATIC_IMPORT_PATTERN = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|require_relative\(\s*['"]([^'"]+)['"]\s*\)|require\s+['"]([^'"]+)['"])/g;
const PYTHON_IMPORT_PATTERN = /^\s*(?:from\s+([.\w/]+)\s+import\s+([A-Za-z0-9_,\s*]+)|import\s+([^\r\n]+))/gm;
const GO_IMPORT_PATTERN = /^\s*import\s+(?:\(\s*([\s\S]*?)\s*\)|(?:([A-Za-z_]\w*)\s+)?["`]([^"`]+)["`])/gm;
const GO_IMPORT_ENTRY_PATTERN = /^\s*(?:([A-Za-z_]\w*|_|\.)\s+)?["`]([^"`]+)["`]\s*$/gm;
const RUST_USE_PATTERN = /^\s*use\s+([^;]+);/gm;
const JAVA_IMPORT_PATTERN = /^\s*import\s+(?:static\s+)?([\w.*]+);/gm;
const CS_USING_PATTERN = /^\s*using\s+([\w.]+)\s*;/gm;
const CS_USING_ALIAS_PATTERN = /^\s*using\s+([A-Za-z_]\w*)\s*=\s*([\w.]+)\s*;/gm;
const PHP_USE_PATTERN = /^\s*use\s+([^;]+);/gm;
const PHP_REQUIRE_PATTERN = /\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?/g;
const COMMONJS_EXPORT_ASSIGN_PATTERN = /\b(?:module\.)?exports\.([A-Za-z_]\w*)\s*=/g;
const COMMONJS_EXPORT_OBJECT_PATTERN = /\bmodule\.exports\s*=\s*\{([^}]+)\}/g;
const COMMONJS_REQUIRE_DESTRUCTURED_PATTERN = /\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(\s*['"][^'"]+['"]\s*\)/g;
const COMMONJS_REQUIRE_ASSIGN_PATTERN = /\b(?:const|let|var|import)\s+([A-Za-z_]\w*)\s*(?:=\s*require\(\s*['"][^'"]+['"]\s*\)|=\s*await\s+import\(\s*['"][^'"]+['"]\s*\)|=\s*import\(\s*['"][^'"]+['"]\s*\))/g;
const EXPORT_SYMBOL_PATTERN = /\bexport\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_]\w*)/g;
const DECLARATION_SYMBOL_PATTERN = /\b(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_]\w*)/g;
const IMPORTED_SYMBOL_PATTERN = /\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_]\w*))/g;
const CALL_EXPRESSION_PATTERN = /(?:\b|\.)([A-Za-z_]\w*)\s*\(/g;
const VERIFICATION_TYPES = ['TEST', 'STATIC', 'BROWSER', 'MANUAL'];
const ACTION_CLASSES = ['memory-read', 'code-context', 'codex-exec', 'verification', 'git-write', 'recovery'];
const PROJECT_SYMBOL_IMPACT_MAX_FILES = 1200;
const PROJECT_SYMBOL_IMPACT_CACHE = new Map();
const CALL_EXPRESSION_IGNORED_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'delete', 'new', 'await', 'yield',
  'function', 'class', 'def', 'print', 'console', 'super', 'assert', 'sizeof', 'isset', 'empty',
  'echo', 'require', 'include', 'import', 'from', 'match'
]);

export const TASK_CAPABILITY_REGISTRY = {
  'memory-search': {
    actionClass: 'memory-read',
    provider: 'memory-store',
    mcpBridgeCandidate: 'memory/search',
    description: 'Searches project memory, artifact memory, and failure patterns.'
  },
  'code-context': {
    actionClass: 'code-context',
    provider: 'repo-scan',
    mcpBridgeCandidate: 'repo/code-context',
    description: 'Builds file and symbol hints from the current repository.'
  },
  codex: {
    actionClass: 'codex-exec',
    provider: 'codex-cli',
    mcpBridgeCandidate: 'agent/codex-exec',
    description: 'Runs Codex for task execution inside the current workspace.'
  },
  claude: {
    actionClass: 'codex-exec',
    provider: 'claude-code-cli',
    mcpBridgeCandidate: 'agent/claude-exec',
    description: 'Runs Claude Code CLI for task execution inside the current workspace.'
  },
  gemini: {
    actionClass: 'codex-exec',
    provider: 'gemini-cli',
    mcpBridgeCandidate: 'agent/gemini-exec',
    description: 'Runs Gemini CLI for task execution inside the current workspace.'
  },
  verification: {
    actionClass: 'verification',
    provider: 'local-shell',
    mcpBridgeCandidate: 'shell/verification',
    description: 'Runs harness-selected verification commands.'
  },
  'git-apply': {
    actionClass: 'git-write',
    provider: 'git',
    mcpBridgeCandidate: 'git/apply-patch',
    description: 'Applies a reviewed task patch back to the main repository.'
  },
  rollback: {
    actionClass: 'recovery',
    provider: 'harness',
    mcpBridgeCandidate: 'workspace/rollback',
    description: 'Restores the shared workspace after a rejected or failed task.'
  }
};

function now() {
  return new Date().toISOString();
}

function clipText(text, maxChars = 240) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function normalizeRepoPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

function normalizeTaskFiles(filesLikely) {
  return [...new Set(
    (Array.isArray(filesLikely) ? filesLikely : [])
      .map((item) => String(item || '').trim().replace(/\\/g, '/'))
      .filter((item) => item && item !== '*')
  )];
}

function tokenizeTaskContext(task) {
  return uniqueBy(
    (String(task?.title || '') + ' ' + String(task?.goal || '') + ' ' + (task?.acceptanceChecks || []).join(' '))
      .match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [],
    (item) => item.toLowerCase()
  )
    .map((item) => item.toLowerCase())
    .filter((item) => !['the', 'this', 'that', 'with', 'from', 'into', 'then', 'task', 'goal', 'file', 'files', 'check'].includes(item))
    .slice(0, 10);
}

function classifyVerificationType(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return [];
  const tags = [];
  if (/(playwright|browser|ui |ui$|dom|selector|preview|screenshot|page\.|dev server|localhost:|http:\/\/|https:\/\/)/i.test(value)) {
    tags.push('BROWSER');
  }
  if (/(eslint|lint|typecheck|tsc|static|format|prettier|compile|build)/i.test(value)) {
    tags.push('STATIC');
  }
  if (/(test|jest|vitest|pytest|mocha|ava|integration|e2e|unit)/i.test(value)) {
    tags.push('TEST');
  }
  if (/(manual|operator|visually|confirm|check in app|human|qa)/i.test(value)) {
    tags.push('MANUAL');
  }
  return [...new Set(tags)];
}

function normalizeVerificationTypes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => VERIFICATION_TYPES.includes(item)))];
}

export function buildAcceptanceMetadata(acceptanceChecks = []) {
  return (Array.isArray(acceptanceChecks) ? acceptanceChecks : [])
    .map((check) => ({
      check: String(check || '').trim(),
      verificationTypes: normalizeVerificationTypes(classifyVerificationType(check))
    }))
    .filter((item) => item.check);
}

export function inferTaskVerificationTypes(task, extraTexts = []) {
  const metadata = Array.isArray(task?.acceptanceMetadata) && task.acceptanceMetadata.length
    ? task.acceptanceMetadata
    : buildAcceptanceMetadata(task?.acceptanceChecks || []);
  return [...new Set([
    ...metadata.flatMap((item) => normalizeVerificationTypes(item.verificationTypes)),
    ...(Array.isArray(extraTexts) ? extraTexts : []).flatMap((text) => classifyVerificationType(text))
  ])];
}

export function normalizeToolProfile(value) {
  if (!value || typeof value !== 'object') {
    return {
      id: 'default',
      label: 'Default',
      allowedActionClasses: []
    };
  }
  const id = String(value.id || 'custom').trim() || 'custom';
  const label = String(value.label || id).trim() || id;
  const allowedActionClasses = [...new Set((Array.isArray(value.allowedActionClasses) ? value.allowedActionClasses : [])
    .map((item) => String(item || '').trim())
    .filter((item) => ACTION_CLASSES.includes(item)))];
  return {
    id,
    label,
    allowedActionClasses
  };
}

function classifyTaskRisk(run, task) {
  const fileCount = normalizeTaskFiles(task?.filesLikely).length;
  const fileBudget = Number(run?.profile?.fileBudget || 0);
  const haystack = [
    run?.preset?.id || '',
    task?.title || '',
    task?.goal || '',
    ...(task?.constraints || []),
    ...(task?.acceptanceChecks || []),
    ...(task?.filesLikely || [])
  ].join('\n').toLowerCase();
  if (HIGH_RISK_PATTERNS.some((pattern) => haystack.includes(pattern))) return 'high';
  if (fileBudget && fileCount > fileBudget + 1) return 'high';
  if (fileBudget && fileCount > fileBudget) return 'medium';
  if ((task?.filesLikely || []).length >= 4 || String(run?.preset?.id || '').includes('refactor')) return 'medium';
  return 'low';
}

export function buildTaskActionPolicy(run, task, executionCtx, readOnlyVerification = false) {
  const riskLevel = classifyTaskRisk(run, task);
  const fileCount = normalizeTaskFiles(task?.filesLikely).length;
  const fileBudget = Number(run?.profile?.fileBudget || 0);
  const verificationTypes = inferTaskVerificationTypes(task, run?.projectContext?.validationCommands || []);
  const toolProfile = normalizeToolProfile(run?.toolProfile);
  const allowedActionClasses = new Set(['memory-read']);
  if (run?.projectPath) allowedActionClasses.add('code-context');
  if (!readOnlyVerification) allowedActionClasses.add('codex-exec');
  if (run?.projectPath && Array.isArray(run?.projectContext?.validationCommands) && run.projectContext.validationCommands.length > 0) {
    allowedActionClasses.add('verification');
  }
  if (readOnlyVerification) allowedActionClasses.add('verification');
  if (executionCtx?.mode === 'git-worktree') allowedActionClasses.add('git-write');
  if (executionCtx?.mode === 'shared') allowedActionClasses.add('recovery');
  if (toolProfile.allowedActionClasses.length) {
    for (const actionClass of [...allowedActionClasses]) {
      if (!toolProfile.allowedActionClasses.includes(actionClass)) {
        allowedActionClasses.delete(actionClass);
      }
    }
  }

  const policyNotes = [];
  if (riskLevel === 'high') {
    policyNotes.push('High-risk task: preserve strict replay records and review the apply/rollback result carefully.');
  }
  if (fileBudget && fileCount > fileBudget) {
    policyNotes.push(`This task exceeds the active file budget (${fileCount}/${fileBudget}). Split it or add a diagnosis-first step before implementation.`);
  }
  if (run?.profile?.diagnosisFirst !== false) {
    policyNotes.push('Diagnosis-first profile is active: prefer read-only inspection before broad implementation when scope is uncertain.');
  }
  if (readOnlyVerification) {
    policyNotes.push('Read-only verification task: implementation actions are disabled.');
  }
  if (verificationTypes.includes('BROWSER')) {
    policyNotes.push('Browser verification is expected for this task. If browser tooling is unavailable, record the gap explicitly instead of silently skipping it.');
  }
  if (verificationTypes.includes('MANUAL')) {
    policyNotes.push('Manual verification is expected for this task. Preserve the operator-visible acceptance state in artifacts.');
  }
  if (toolProfile.allowedActionClasses.length) {
    policyNotes.push(`Tool profile "${toolProfile.label}" limits actions to: ${toolProfile.allowedActionClasses.join(', ')}.`);
  }

  return {
    version: '2',
    riskLevel,
    readOnlyVerification,
    verificationTypes,
    toolProfile,
    allowedActionClasses: [...allowedActionClasses],
    policyNotes,
    capabilities: Object.entries(TASK_CAPABILITY_REGISTRY)
      .filter(([, capability]) => allowedActionClasses.has(capability.actionClass))
      .map(([id, capability]) => ({
        id,
        actionClass: capability.actionClass,
        provider: capability.provider,
        mcpBridgeCandidate: capability.mcpBridgeCandidate,
        description: capability.description
      }))
  };
}

export function summarizeActionOutput(capabilityId, result) {
  if (capabilityId === 'memory-search') {
    return {
      query: result?.searchQuery || '',
      hitCount: Array.isArray(result?.searchResults) ? result.searchResults.length : 0,
      searchBackend: result?.searchBackend || '',
      summary: clipText(result?.retrievedContext || '', 220)
    };
  }
  if (capabilityId === 'code-context') {
    return {
      fileCount: Array.isArray(result?.relatedFiles) ? result.relatedFiles.length : 0,
      summary: clipText(result?.summary || '', 240)
    };
  }
  if (['codex', 'claude', 'gemini'].includes(capabilityId)) {
    return {
      code: result?.code,
      timedOut: Boolean(result?.timedOut),
      stdout: clipText(result?.stdout || '', 220),
      stderr: clipText(result?.stderr || '', 220)
    };
  }
  if (capabilityId === 'verification') {
    return {
      code: result?.code,
      ok: result?.code === 0,
      stdout: clipText(result?.stdout || '', 220),
      stderr: clipText(result?.stderr || '', 220)
    };
  }
  return {
    ok: result?.ok !== false,
    message: clipText(result?.message || '', 220)
  };
}

async function listCodeContextFiles(projectPath, limit = 240) {
  const result = [];
  if (!projectPath) return result;
  const queue = [''];
  while (queue.length > 0 && result.length < limit) {
    const relativeDir = queue.shift();
    const absoluteDir = path.join(projectPath, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      const normalized = relativePath.replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!CODE_CONTEXT_IGNORED_DIRS.has(entry.name)) queue.push(relativePath);
        continue;
      }
      if (!CODE_CONTEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const absolutePath = path.join(projectPath, relativePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      result.push({
        path: normalized,
        absolutePath,
        size: Number(stat?.size || 0),
        mtimeMs: Number(stat?.mtimeMs || 0)
      });
      if (result.length >= limit) break;
    }
  }
  return result;
}

function createSymbolImpactEntry(symbol) {
  return {
    symbol,
    importerFiles: new Set(),
    definedIn: new Set(),
    targetFiles: new Set(),
    callerFiles: new Set(),
    callCount: 0,
    importedInFiles: new Set(),
    exportedFromFiles: new Set()
  };
}

function createEdgeImpactEntry(targetPath, importedSymbols = []) {
  return {
    targetPath,
    importedSymbols: [...importedSymbols],
    importerFiles: new Set(),
    callerFiles: new Set(),
    callCount: 0
  };
}

function createFileImpactEntry(targetPath) {
  return {
    targetPath,
    importerFiles: new Set(),
    callerFiles: new Set()
  };
}

function edgeImpactKey(targetPath, importedSymbols = []) {
  const normalizedTarget = normalizeRepoPath(targetPath);
  const normalizedSymbols = [...new Set((Array.isArray(importedSymbols) ? importedSymbols : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return `${normalizedTarget}#${normalizedSymbols.join(',') || '*'}`;
}

function createProjectGraphSignature(projectPath, discoveredFiles = [], limit, truncated) {
  const digest = createHash('sha1');
  digest.update(`${normalizeRepoPath(projectPath)}|${limit}|${truncated ? 'truncated' : 'complete'}\n`);
  for (const entry of discoveredFiles) {
    digest.update(`${entry.path}|${entry.size}|${entry.mtimeMs}\n`);
  }
  return digest.digest('hex');
}

function cacheKeyForProjectGraph(projectPath) {
  return normalizeRepoPath(projectPath);
}

function cloneAnalyzedEntry(entry = null) {
  if (!entry) return null;
  return {
    path: entry.path,
    body: entry.body,
    bodyLower: entry.bodyLower,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    codeGraph: entry.codeGraph
  };
}

function finalizeSymbolImpact(entries, limit = 8) {
  return [...entries.values()]
    .map((entry) => ({
      symbol: entry.symbol,
      importerCount: entry.importerFiles.size,
      callerCount: entry.callerFiles.size,
      callCount: entry.callCount,
      importerFiles: [...entry.importerFiles].sort().slice(0, limit),
      callerFiles: [...entry.callerFiles].sort().slice(0, limit),
      definedIn: [...entry.definedIn].sort().slice(0, limit),
      targetFiles: [...entry.targetFiles].sort().slice(0, limit),
      importedInFiles: [...entry.importedInFiles].sort().slice(0, limit),
      exportedFromFiles: [...entry.exportedFromFiles].sort().slice(0, limit)
    }))
    .sort((left, right) =>
      (right.callerCount + right.importerCount) - (left.callerCount + left.importerCount)
      || right.callCount - left.callCount
      || left.symbol.localeCompare(right.symbol)
    );
}

function finalizeFileImpact(entries, limit = 8) {
  return [...entries.values()]
    .map((entry) => ({
      path: entry.targetPath,
      importedByCount: entry.importerFiles.size,
      importedByFiles: [...entry.importerFiles].sort().slice(0, limit),
      calledByCount: entry.callerFiles.size,
      calledByFiles: [...entry.callerFiles].sort().slice(0, limit)
    }))
    .sort((left, right) =>
      (right.calledByCount + right.importedByCount) - (left.calledByCount + left.importedByCount)
      || left.path.localeCompare(right.path)
    );
}

async function buildProjectSymbolImpactIndex(projectPath, limit = PROJECT_SYMBOL_IMPACT_MAX_FILES) {
  const discoveredFiles = await listCodeContextFiles(projectPath, limit);
  const truncated = discoveredFiles.length >= limit;
  const signature = createProjectGraphSignature(projectPath, discoveredFiles, limit, truncated);
  const cacheKey = cacheKeyForProjectGraph(projectPath);
  const cached = PROJECT_SYMBOL_IMPACT_CACHE.get(cacheKey) || null;
  if (cached?.signature === signature && cached?.limit === limit) {
    return {
      ...cached.result,
      cache: {
        hit: true,
        reusedFiles: cached.result.indexedFileCount,
        refreshedFiles: 0
      }
    };
  }

  const previousFileMap = cached?.analyzedFileMap || new Map();
  const analyzedFiles = [];
  let reusedFiles = 0;
  let refreshedFiles = 0;

  for (const discovered of discoveredFiles) {
    const previous = previousFileMap.get(normalizeRepoPath(discovered.path));
    if (previous && previous.size === discovered.size && previous.mtimeMs === discovered.mtimeMs) {
      analyzedFiles.push(cloneAnalyzedEntry(previous));
      reusedFiles += 1;
      continue;
    }
    const body = await fs.readFile(discovered.absolutePath, 'utf8').catch(() => '');
    if (!body) continue;
    analyzedFiles.push({
      path: discovered.path,
      body,
      bodyLower: body.toLowerCase(),
      size: discovered.size,
      mtimeMs: discovered.mtimeMs,
      codeGraph: await extractStaticCodeGraph(projectPath, discovered.path, body)
    });
    refreshedFiles += 1;
  }

  const fileImpactMap = new Map();
  const symbolImpactMap = new Map();
  const edgeImpactMap = new Map();
  const definitionMap = new Map();

  for (const entry of analyzedFiles) {
    const sourcePath = entry.path;
    for (const symbol of [...(entry.codeGraph.exports || []), ...(entry.codeGraph.declarations || [])]) {
      const normalizedSymbol = String(symbol || '').trim();
      if (!normalizedSymbol) continue;
      const key = normalizedSymbol.toLowerCase();
      if (!definitionMap.has(key)) definitionMap.set(key, new Set());
      definitionMap.get(key).add(sourcePath);
      const current = symbolImpactMap.get(key) || createSymbolImpactEntry(normalizedSymbol);
      current.definedIn.add(sourcePath);
      current.targetFiles.add(sourcePath);
      current.exportedFromFiles.add(sourcePath);
      symbolImpactMap.set(key, current);
    }
  }

  for (const entry of analyzedFiles) {
    const sourcePath = entry.path;
    const callSet = new Set((Array.isArray(entry.codeGraph.calls) ? entry.codeGraph.calls : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean));
    const accountedCallSymbols = new Set();

    for (const imported of entry.codeGraph.imports || []) {
      const targetPath = String(imported?.target || '').trim().replace(/\\/g, '/');
      if (!targetPath) continue;
      const fileImpact = fileImpactMap.get(targetPath) || createFileImpactEntry(targetPath);
      fileImpact.importerFiles.add(sourcePath);
      fileImpactMap.set(targetPath, fileImpact);

      const importedSymbols = (Array.isArray(imported?.importedSymbols) ? imported.importedSymbols : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
      const edgeKey = edgeImpactKey(targetPath, importedSymbols);
      const currentEdge = edgeImpactMap.get(edgeKey) || createEdgeImpactEntry(targetPath, importedSymbols);
      currentEdge.importerFiles.add(sourcePath);
      edgeImpactMap.set(edgeKey, currentEdge);

      for (const symbol of importedSymbols) {
        const key = symbol.toLowerCase();
        const current = symbolImpactMap.get(key) || createSymbolImpactEntry(symbol);
        current.importerFiles.add(sourcePath);
        current.importedInFiles.add(sourcePath);
        current.targetFiles.add(targetPath);
        const symbolDefinitions = definitionMap.get(key);
        if (symbolDefinitions?.size) {
          for (const definedPath of symbolDefinitions) current.definedIn.add(definedPath);
        }
        if (callSet.has(key)) {
          current.callerFiles.add(sourcePath);
          current.callCount += 1;
          currentEdge.callerFiles.add(sourcePath);
          currentEdge.callCount += 1;
          fileImpact.callerFiles.add(sourcePath);
          accountedCallSymbols.add(key);
        }
        symbolImpactMap.set(key, current);
      }
    }

    for (const callSymbol of callSet) {
      if (accountedCallSymbols.has(callSymbol)) continue;
      const symbolDefinitions = definitionMap.get(callSymbol);
      if (!symbolDefinitions?.size) continue;
      const current = symbolImpactMap.get(callSymbol) || createSymbolImpactEntry(callSymbol);
      current.callerFiles.add(sourcePath);
      current.callCount += 1;
      for (const definedPath of symbolDefinitions) {
        current.definedIn.add(definedPath);
        current.targetFiles.add(definedPath);
        const fileImpact = fileImpactMap.get(definedPath) || createFileImpactEntry(definedPath);
        fileImpact.callerFiles.add(sourcePath);
        fileImpactMap.set(definedPath, fileImpact);
      }
      symbolImpactMap.set(callSymbol, current);
    }
  }

  const analyzedFileMap = new Map(analyzedFiles.map((entry) => [normalizeRepoPath(entry.path), entry]));
  const result = {
    analyzedFiles,
    analyzedFileMap,
    symbolImpact: finalizeSymbolImpact(symbolImpactMap),
    fileImpact: finalizeFileImpact(fileImpactMap),
    edgeImpact: [...edgeImpactMap.values()]
      .map((entry) => ({
        targetPath: entry.targetPath,
        importedSymbols: [...entry.importedSymbols],
        importerCount: entry.importerFiles.size,
        importerFiles: [...entry.importerFiles].sort().slice(0, 8),
        callerCount: entry.callerFiles.size,
        callCount: entry.callCount,
        callerFiles: [...entry.callerFiles].sort().slice(0, 8)
      }))
      .sort((left, right) =>
        (right.callerCount + right.importerCount) - (left.callerCount + left.importerCount)
        || right.callCount - left.callCount
        || left.targetPath.localeCompare(right.targetPath)
      ),
    indexedFileCount: analyzedFiles.length,
    truncated,
    cache: {
      hit: false,
      reusedFiles,
      refreshedFiles
    },
    diagnostics: truncated
      ? [`Code graph indexing hit the file cap (${limit}). Global symbol impact is partial.`]
      : []
  };
  PROJECT_SYMBOL_IMPACT_CACHE.set(cacheKey, {
    signature,
    limit,
    analyzedFileMap,
    result
  });
  return result;
}

function symbolImpactForEntry(symbols = [], projectGraph = null, limit = 6) {
  const ranked = [];
  const dedupe = new Set();
  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    const normalized = String(symbol || '').trim();
    if (!normalized) continue;
    const match = (projectGraph?.symbolImpact || []).find((item) => item.symbol.toLowerCase() === normalized.toLowerCase());
    if (!match) continue;
    const key = match.symbol.toLowerCase();
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    ranked.push(match);
  }
  return ranked
    .sort((left, right) =>
      (right.callerCount + right.importerCount) - (left.callerCount + left.importerCount)
      || right.callCount - left.callCount
      || left.symbol.localeCompare(right.symbol)
    )
    .slice(0, limit);
}

function fileImpactForPath(relativePath, projectGraph = null) {
  const normalizedPath = normalizeRepoPath(relativePath);
  return (projectGraph?.fileImpact || []).find((item) => normalizeRepoPath(item.path) === normalizedPath) || null;
}

function edgeImpactForImport(targetPath, importedSymbols = [], projectGraph = null) {
  const exactKey = edgeImpactKey(targetPath, importedSymbols);
  const exact = (projectGraph?.edgeImpact || []).find((item) => edgeImpactKey(item.targetPath, item.importedSymbols) === exactKey);
  if (exact) return exact;
  return (projectGraph?.edgeImpact || []).find((item) =>
    normalizeRepoPath(item.targetPath) === normalizeRepoPath(targetPath)
  ) || null;
}

function buildCriticalSymbols(symbolImpact = [], threshold = graphCriticalRiskThreshold()) {
  return (Array.isArray(symbolImpact) ? symbolImpact : [])
    .map((item) => ({
      ...item,
      riskScore: calculateProjectSymbolRiskScore(item)
    }))
    .filter((item) => isCriticalGraphRisk(item.riskScore, threshold))
    .sort((left, right) => right.riskScore - left.riskScore || left.symbol.localeCompare(right.symbol));
}

function normalizeGraphRiskInputs(item = {}) {
  return {
    importerCount: Number(item.importerCount ?? item.currentCount ?? 0),
    callerCount: Number(item.callerCount || 0),
    callCount: Number(item.callCount || 0),
    memoryCount: Number(item.memoryCount || 0),
    memoryWeight: Number(item.memoryWeight || 0)
  };
}

function calculateWeightedGraphRiskScore(item = {}, weights = {}) {
  const values = normalizeGraphRiskInputs(item);
  return Number(
    Object.entries(weights || {}).reduce((sum, [key, weight]) => sum + (Number(values[key] || 0) * Number(weight || 0)), 0).toFixed(3)
  );
}

export function calculateProjectSymbolRiskScore(item = {}, overrides = null) {
  return calculateWeightedGraphRiskScore(item, overrides || GRAPH_INTELLIGENCE_DEFAULTS.weights.projectSymbol);
}

export function calculateExecutionSymbolRiskScore(item = {}, overrides = null) {
  return calculateWeightedGraphRiskScore(item, overrides || GRAPH_INTELLIGENCE_DEFAULTS.weights.executionSymbol);
}

export function calculateExecutionEdgeRiskScore(item = {}, overrides = null) {
  return calculateWeightedGraphRiskScore(item, overrides || GRAPH_INTELLIGENCE_DEFAULTS.weights.executionEdge);
}

export function graphCriticalRiskThreshold() {
  return Number(GRAPH_INTELLIGENCE_DEFAULTS.thresholds.criticalRisk || 15);
}

export function temporalConcentrationThreshold() {
  return Number(GRAPH_INTELLIGENCE_DEFAULTS.thresholds.temporalConcentration || 0.55);
}

export function isCriticalGraphRisk(score, threshold = graphCriticalRiskThreshold()) {
  return Number(score || 0) > Number(threshold || graphCriticalRiskThreshold());
}

export function isTemporalMemoryConcentrated(recentShare, threshold = temporalConcentrationThreshold()) {
  return Number(recentShare || 0) >= Number(threshold || temporalConcentrationThreshold());
}

export async function buildProjectCodeIntelligence(projectPath, options = {}) {
  if (!projectPath) {
    return {
      indexedFileCount: 0,
      truncated: false,
      cache: { hit: false, reusedFiles: 0, refreshedFiles: 0 },
      thresholds: { ...(GRAPH_INTELLIGENCE_DEFAULTS.thresholds || {}) },
      topSymbols: [],
      criticalSymbols: [],
      topFiles: [],
      topEdges: [],
      diagnostics: ['No project root attached.']
    };
  }
  const limit = Number(options.limit || PROJECT_SYMBOL_IMPACT_MAX_FILES);
  const projectGraph = await buildProjectSymbolImpactIndex(projectPath, limit);
  return {
    indexedFileCount: projectGraph.indexedFileCount,
    truncated: projectGraph.truncated,
    cache: projectGraph.cache || { hit: false, reusedFiles: 0, refreshedFiles: 0 },
    thresholds: { ...(GRAPH_INTELLIGENCE_DEFAULTS.thresholds || {}) },
    topSymbols: projectGraph.symbolImpact.slice(0, 8),
    criticalSymbols: buildCriticalSymbols(projectGraph.symbolImpact),
    topFiles: projectGraph.fileImpact.slice(0, 8),
    topEdges: projectGraph.edgeImpact.slice(0, 8),
    diagnostics: projectGraph.diagnostics || []
  };
}

function extractSymbolHints(body, queryTokens) {
  const lines = String(body || '').split(/\r?\n/);
  const hints = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!/(function|class|interface|type|const|let|var|export|def |import )/.test(trimmed)) continue;
    if (queryTokens.length && !queryTokens.some((token) => trimmed.toLowerCase().includes(token))) continue;
    hints.push(trimmed.replace(/\s+/g, ' ').trim());
    if (hints.length >= 6) break;
  }
  return hints;
}

function extractReferenceHints(body, queryTokens) {
  const lines = String(body || '').split(/\r?\n/);
  const hits = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (queryTokens.length && !queryTokens.some((token) => trimmed.toLowerCase().includes(token))) continue;
    if (!/[.(]/.test(trimmed) && !/\bfrom\b/.test(trimmed)) continue;
    hits.push(trimmed.replace(/\s+/g, ' ').trim());
    if (hits.length >= 6) break;
  }
  return hits;
}

function extractIdentifierHints(values) {
  return uniqueBy(
    values.flatMap((item) => String(item || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []),
    (item) => item.toLowerCase()
  )
    .filter((item) => item.length >= 4)
    .slice(0, 14);
}

function splitImportedSymbols(text) {
  return String(text || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .map((item) => item.replace(/\s+as\s+[A-Za-z_]\w*$/i, '').trim())
    .filter(Boolean);
}

function splitImportedSymbolsPreservingAlias(text) {
  return String(text || '')
    .split(',')
    .flatMap((item) => {
      const value = String(item || '').trim();
      if (!value) return [];
      const aliasMatch = value.match(/^(.*?)\s+as\s+([A-Za-z_]\w*)$/i);
      if (!aliasMatch) {
        const normalized = parseSimpleQualifiedSymbol(value);
        return normalized.length ? normalized : [value];
      }
      return [
        ...parseSimpleQualifiedSymbol(String(aliasMatch[1] || '').trim()),
        String(aliasMatch[2] || '').trim()
      ].filter(Boolean);
    })
    .filter(Boolean);
}

function parseRustUseSymbols(specifier) {
  const value = String(specifier || '').trim();
  if (!value) return [];
  const lastSegment = value.split('::').pop() || '';
  if (lastSegment.startsWith('{') && lastSegment.endsWith('}')) {
    return splitImportedSymbols(lastSegment.slice(1, -1));
  }
  return splitImportedSymbols(lastSegment.replace(/\{.*$/, '').replace(/\s+as\s+[A-Za-z_]\w*$/i, ''));
}

function parsePhpUseSymbols(specifier) {
  return String(specifier || '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+as\s+/i)[0] || '')
    .map((entry) => entry.split('\\').pop() || '')
    .filter(Boolean);
}

function parseSimpleQualifiedSymbol(specifier) {
  const value = String(specifier || '').trim();
  if (!value) return [];
  const cleaned = value.replace(/\.\*$/, '').replace(/\*$/, '');
  const parts = cleaned.split(/[./\\:]+/).filter(Boolean);
  return parts.length ? [parts[parts.length - 1]] : [];
}

function extractCallReferences(sourceText) {
  const calls = [];
  let match;
  CALL_EXPRESSION_PATTERN.lastIndex = 0;
  while ((match = CALL_EXPRESSION_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (!symbol) continue;
    if (CALL_EXPRESSION_IGNORED_WORDS.has(symbol.toLowerCase())) continue;
    const prefix = sourceText.slice(Math.max(0, match.index - 32), match.index);
    if (/\b(?:function|def|class|interface|type|enum|new)\s+$/i.test(prefix)) continue;
    calls.push(symbol);
  }
  return uniqueBy(calls, (item) => item.toLowerCase());
}

function parseImportClauseSymbols(clause) {
  const value = String(clause || '').trim();
  if (!value) return [];
  const parts = value.split(',').map((item) => String(item || '').trim()).filter(Boolean);
  const symbols = [];
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      symbols.push(...splitImportedSymbols(part.slice(1, -1)));
      continue;
    }
    const namespaceMatch = part.match(/^\*\s+as\s+([A-Za-z_]\w*)$/);
    if (namespaceMatch) {
      symbols.push(namespaceMatch[1]);
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(part)) {
      symbols.push(part);
    }
  }
  return [...new Set(symbols)];
}

async function resolveStaticImportTarget(projectPath, fromRelativePath, specifier) {
  const root = String(projectPath || '').trim();
  const fromPath = String(fromRelativePath || '').trim().replace(/\\/g, '/');
  const raw = String(specifier || '').trim();
  if (!root || !fromPath || !raw.startsWith('.')) return '';
  const fromDir = path.posix.dirname(fromPath);
  const basePath = path.posix.normalize(path.posix.join(fromDir, raw));
  const candidates = [
    basePath,
    ...[...CODE_CONTEXT_EXTENSIONS].map((ext) => `${basePath}${ext}`),
    ...[...CODE_CONTEXT_EXTENSIONS].map((ext) => path.posix.join(basePath, `index${ext}`))
  ];
  for (const candidate of candidates) {
    const absolutePath = path.join(root, ...candidate.split('/'));
    try {
      await fs.access(absolutePath);
      return candidate;
    } catch {
      continue;
    }
  }
  return basePath;
}

export function extractStaticCodeGraphFacts(sourceText) {
  const imports = [];
  const exports = [];
  const declarations = [];
  const importedSymbols = [];
  let match;
  JS_IMPORT_CLAUSE_PATTERN.lastIndex = 0;
  JS_REEXPORT_CLAUSE_PATTERN.lastIndex = 0;
  JS_EXPORT_NAMED_CLAUSE_PATTERN.lastIndex = 0;
  JS_EXPORT_DEFAULT_DECL_PATTERN.lastIndex = 0;
  JS_EXPORT_DEFAULT_IDENTIFIER_PATTERN.lastIndex = 0;
  JS_EXPORT_STAR_PATTERN.lastIndex = 0;
  JS_SIDE_EFFECT_IMPORT_PATTERN.lastIndex = 0;
  STATIC_IMPORT_PATTERN.lastIndex = 0;
  PYTHON_IMPORT_PATTERN.lastIndex = 0;
  GO_IMPORT_PATTERN.lastIndex = 0;
  GO_IMPORT_ENTRY_PATTERN.lastIndex = 0;
  RUST_USE_PATTERN.lastIndex = 0;
  JAVA_IMPORT_PATTERN.lastIndex = 0;
  CS_USING_PATTERN.lastIndex = 0;
  CS_USING_ALIAS_PATTERN.lastIndex = 0;
  PHP_USE_PATTERN.lastIndex = 0;
  PHP_REQUIRE_PATTERN.lastIndex = 0;
  COMMONJS_EXPORT_ASSIGN_PATTERN.lastIndex = 0;
  COMMONJS_EXPORT_OBJECT_PATTERN.lastIndex = 0;
  COMMONJS_REQUIRE_DESTRUCTURED_PATTERN.lastIndex = 0;
  COMMONJS_REQUIRE_ASSIGN_PATTERN.lastIndex = 0;
  IMPORTED_SYMBOL_PATTERN.lastIndex = 0;
  EXPORT_SYMBOL_PATTERN.lastIndex = 0;
  DECLARATION_SYMBOL_PATTERN.lastIndex = 0;
  while ((match = JS_IMPORT_CLAUSE_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[2] || '';
    const clauseSymbols = parseImportClauseSymbols(match[1] || '');
    imports.push({
      specifier,
      importedSymbols: clauseSymbols
    });
    importedSymbols.push(...clauseSymbols);
  }
  while ((match = JS_REEXPORT_CLAUSE_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[2] || '';
    const clauseSymbols = parseImportClauseSymbols(match[1] || '');
    imports.push({
      specifier,
      importedSymbols: clauseSymbols
    });
    importedSymbols.push(...clauseSymbols);
    exports.push(...clauseSymbols);
  }
  while ((match = JS_EXPORT_NAMED_CLAUSE_PATTERN.exec(sourceText)) !== null) {
    exports.push(...splitImportedSymbols(match[1] || ''));
  }
  while ((match = JS_EXPORT_DEFAULT_DECL_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (!symbol) continue;
    exports.push(symbol);
    declarations.push(symbol);
  }
  while ((match = JS_EXPORT_DEFAULT_IDENTIFIER_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (!symbol) continue;
    exports.push(symbol);
  }
  while ((match = JS_EXPORT_STAR_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    imports.push({
      specifier,
      importedSymbols: []
    });
  }
  while ((match = JS_SIDE_EFFECT_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    imports.push({
      specifier,
      importedSymbols: []
    });
  }
  while ((match = STATIC_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || match[2] || match[3] || match[4] || '';
    imports.push({
      specifier,
      importedSymbols: []
    });
  }
  while ((match = PYTHON_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || match[3] || '';
    const imported = match[2]
      ? splitImportedSymbolsPreservingAlias(match[2] || '')
      : splitImportedSymbolsPreservingAlias(parseSimpleQualifiedSymbol(match[3] || '').join(','));
    imports.push({
      specifier,
      importedSymbols: imported
    });
    importedSymbols.push(...imported);
  }
  while ((match = GO_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const blockBody = match[1] || '';
    if (blockBody) {
      GO_IMPORT_ENTRY_PATTERN.lastIndex = 0;
      let blockMatch;
      while ((blockMatch = GO_IMPORT_ENTRY_PATTERN.exec(blockBody)) !== null) {
        const specifier = blockMatch[2] || '';
        const alias = blockMatch[1] || '';
        const symbols = alias && alias !== '_' && alias !== '.' ? [alias] : parseSimpleQualifiedSymbol(specifier);
        imports.push({ specifier, importedSymbols: symbols });
        importedSymbols.push(...symbols);
      }
      continue;
    }
    const specifier = match[3] || '';
    const alias = match[2] || '';
    const symbols = alias ? [alias] : parseSimpleQualifiedSymbol(specifier);
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = RUST_USE_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    const symbols = parseRustUseSymbols(specifier);
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = JAVA_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    const symbols = parseSimpleQualifiedSymbol(specifier);
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = CS_USING_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    const symbols = parseSimpleQualifiedSymbol(specifier);
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = CS_USING_ALIAS_PATTERN.exec(sourceText)) !== null) {
    const alias = match[1] || '';
    const specifier = match[2] || '';
    const symbols = uniqueBy([alias, ...parseSimpleQualifiedSymbol(specifier)], (item) => String(item || '').toLowerCase());
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = PHP_USE_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    const symbols = parsePhpUseSymbols(specifier);
    imports.push({ specifier, importedSymbols: symbols });
    importedSymbols.push(...symbols);
  }
  while ((match = PHP_REQUIRE_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || '';
    imports.push({ specifier, importedSymbols: [] });
  }
  while ((match = COMMONJS_REQUIRE_DESTRUCTURED_PATTERN.exec(sourceText)) !== null) {
    importedSymbols.push(...splitImportedSymbols(match[1] || ''));
  }
  while ((match = COMMONJS_REQUIRE_ASSIGN_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (symbol) importedSymbols.push(symbol);
  }
  while ((match = IMPORTED_SYMBOL_PATTERN.exec(sourceText)) !== null) {
    importedSymbols.push(...splitImportedSymbols(match[1] || match[2] || ''));
  }
  while ((match = EXPORT_SYMBOL_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (symbol) exports.push(symbol);
  }
  while ((match = COMMONJS_EXPORT_ASSIGN_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (symbol) exports.push(symbol);
  }
  while ((match = COMMONJS_EXPORT_OBJECT_PATTERN.exec(sourceText)) !== null) {
    exports.push(...splitImportedSymbols(match[1] || ''));
  }
  while ((match = DECLARATION_SYMBOL_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (symbol) declarations.push(symbol);
  }
  const referenceHints = extractReferenceHints(sourceText, []);
  return {
    imports: uniqueBy(imports, (item) => `${item.specifier}:${(item.importedSymbols || []).join(',')}`),
    exports: uniqueBy(exports, (item) => item),
    declarations: uniqueBy(declarations, (item) => item),
    importedSymbols: uniqueBy(importedSymbols, (item) => String(item || '').toLowerCase()).filter(Boolean),
    calls: extractCallReferences(sourceText),
    references: extractIdentifierHints(referenceHints)
  };
}

export async function extractStaticCodeGraph(projectPath, relativePath, body = '') {
  const sourceText = String(body || '').trim()
    ? String(body || '')
    : await fs.readFile(path.join(projectPath, ...String(relativePath || '').split('/')), 'utf8').catch(() => '');
  const facts = extractStaticCodeGraphFacts(sourceText);
  const imports = [];
  for (const entry of facts.imports) {
    imports.push({
      specifier: entry.specifier,
      importedSymbols: Array.isArray(entry.importedSymbols) ? entry.importedSymbols : [],
      target: await resolveStaticImportTarget(projectPath, relativePath, entry.specifier)
    });
  }
  return {
    imports: uniqueBy(imports, (item) => `${item.specifier}:${item.target}:${(item.importedSymbols || []).join(',')}`),
    exports: facts.exports,
    declarations: facts.declarations,
    importedSymbols: facts.importedSymbols,
    calls: facts.calls,
    references: facts.references
  };
}

export async function buildTaskCodeContext(run, task) {
  if (!run?.projectPath) {
    return {
      schemaVersion: '2',
      runId: run?.id || '',
      taskId: task?.id || '',
      generatedAt: now(),
      summary: 'Project path is unavailable, so no code context was built.',
      queryTokens: [],
      symbolHints: [],
      relatedFiles: [],
      projectGraph: {
        indexedFileCount: 0,
        truncated: false,
        cache: { hit: false, reusedFiles: 0, refreshedFiles: 0 },
        topSymbols: [],
        criticalSymbols: [],
        topFiles: [],
        topEdges: []
      },
      diagnostics: ['No project root attached.']
    };
  }

  const queryTokens = tokenizeTaskContext(task);
  const likelyFiles = normalizeTaskFiles(task?.filesLikely);
  const projectGraph = await buildProjectSymbolImpactIndex(run.projectPath, PROJECT_SYMBOL_IMPACT_MAX_FILES);
  const candidateFiles = uniqueBy([
    ...likelyFiles,
    ...projectGraph.analyzedFiles.map((item) => item.path)
  ], (item) => normalizeRepoPath(item)).slice(0, 160);

  const relatedFiles = [];
  for (const relativePath of candidateFiles) {
    const analyzed = projectGraph.analyzedFileMap.get(normalizeRepoPath(relativePath));
    const body = analyzed?.body || '';
    if (!body) continue;
    const normalizedPath = normalizeRepoPath(relativePath);
    let score = likelyFiles.some((item) => normalizeRepoPath(item) === normalizedPath) ? 60 : 0;
    for (const token of queryTokens) {
      if (normalizedPath.includes(token)) score += 16;
      if ((analyzed?.bodyLower || '').includes(token)) score += 6;
    }
    const symbols = extractSymbolHints(body, queryTokens);
    const references = extractReferenceHints(body, queryTokens);
    const codeGraph = analyzed?.codeGraph || await extractStaticCodeGraph(run.projectPath, relativePath, body);
    const fileImpact = fileImpactForPath(relativePath, projectGraph);
    const exportedSymbolImpact = symbolImpactForEntry([
      ...(codeGraph.exports || []),
      ...(codeGraph.declarations || [])
    ], projectGraph);
    const importedSymbolImpact = symbolImpactForEntry(codeGraph.importedSymbols || [], projectGraph);
    const calledSymbolImpact = symbolImpactForEntry(codeGraph.calls || [], projectGraph);
    const outgoingEdgeImpact = (codeGraph.imports || [])
      .map((entry) => {
        const target = String(entry?.target || '').trim().replace(/\\/g, '/');
        if (!target) return null;
        const symbolImpact = symbolImpactForEntry(entry.importedSymbols || [], projectGraph, 3);
        const edgeImpact = edgeImpactForImport(target, entry.importedSymbols || [], projectGraph);
        const targetFileImpact = fileImpactForPath(target, projectGraph);
        return {
          target,
          importedSymbols: Array.isArray(entry.importedSymbols) ? entry.importedSymbols : [],
          importerCount: Math.max(
            Number(edgeImpact?.importerCount || 0),
            Number(targetFileImpact?.importedByCount || 0),
            ...symbolImpact.map((item) => Number(item.importerCount || 0)),
            0
          ),
          callerCount: Math.max(
            Number(edgeImpact?.callerCount || 0),
            Number(targetFileImpact?.calledByCount || 0),
            ...symbolImpact.map((item) => Number(item.callerCount || 0)),
            0
          ),
          callCount: Math.max(
            Number(edgeImpact?.callCount || 0),
            ...symbolImpact.map((item) => Number(item.callCount || 0)),
            0
          ),
          importerFiles: uniqueBy([
            ...(edgeImpact?.importerFiles || []),
            ...(targetFileImpact?.importedByFiles || []),
            ...symbolImpact.flatMap((item) => item.importerFiles || [])
          ], (item) => item).slice(0, 5),
          callerFiles: uniqueBy([
            ...(edgeImpact?.callerFiles || []),
            ...(targetFileImpact?.calledByFiles || []),
            ...symbolImpact.flatMap((item) => item.callerFiles || [])
          ], (item) => item).slice(0, 5)
        };
      })
      .filter(Boolean)
      .sort((left, right) =>
        (right.callerCount + right.importerCount) - (left.callerCount + left.importerCount)
        || right.callCount - left.callCount
        || left.target.localeCompare(right.target)
      )
      .slice(0, 6);
    score += symbols.length * 4;
    score += references.length * 2;
    score += (codeGraph.exports.length + codeGraph.declarations.length) * 2;
    score += codeGraph.imports.length;
    score += Number((codeGraph.calls || []).length || 0) * 2;
    score += Number(fileImpact?.importedByCount || 0) * 3;
    score += Number(fileImpact?.calledByCount || 0) * 4;
    score += ((exportedSymbolImpact[0]?.importerCount || 0) * 3) + ((exportedSymbolImpact[0]?.callerCount || 0) * 4);
    score += ((importedSymbolImpact[0]?.importerCount || 0) * 2) + ((importedSymbolImpact[0]?.callerCount || 0) * 2);
    score += (calledSymbolImpact[0]?.callerCount || 0) * 3;
    if (!score) continue;
    relatedFiles.push({
      path: relativePath,
      score,
      symbols,
      references,
      codeGraph,
      impact: {
        importedByCount: Number(fileImpact?.importedByCount || 0),
        importedByFiles: fileImpact?.importedByFiles || [],
        calledByCount: Number(fileImpact?.calledByCount || 0),
        calledByFiles: fileImpact?.calledByFiles || [],
        exportedSymbolImpact,
        importedSymbolImpact,
        calledSymbolImpact,
        outgoingEdgeImpact
      },
      snippet: clipText(body, 280)
    });
  }

  relatedFiles.sort((left, right) => right.score - left.score);
  const selectedFiles = relatedFiles.slice(0, 5);
  const symbolHints = extractIdentifierHints([
    ...selectedFiles.flatMap((item) => item.symbols),
    ...selectedFiles.flatMap((item) => item.references),
    ...selectedFiles.flatMap((item) => item.codeGraph?.exports || []),
    ...selectedFiles.flatMap((item) => item.codeGraph?.declarations || []),
    ...selectedFiles.flatMap((item) => item.codeGraph?.importedSymbols || []),
    ...selectedFiles.flatMap((item) => item.codeGraph?.calls || []),
    ...queryTokens
  ]);
  return {
    schemaVersion: '2',
    runId: run.id,
    taskId: task.id,
    generatedAt: now(),
    summary: selectedFiles.length
      ? `Top files: ${selectedFiles.map((item) => item.path).join(', ')} | symbol graph edges: ${selectedFiles.reduce((sum, item) => sum + Number(item.codeGraph?.imports?.length || 0), 0)} | call refs: ${selectedFiles.reduce((sum, item) => sum + Number(item.codeGraph?.calls?.length || 0), 0)} | global symbol impact indexed files: ${projectGraph.indexedFileCount}`
      : 'No strongly related code files were detected from the task goal and filesLikely.',
    queryTokens,
    symbolHints,
    relatedFiles: selectedFiles,
    projectGraph: {
      indexedFileCount: projectGraph.indexedFileCount,
      truncated: projectGraph.truncated,
      cache: projectGraph.cache || { hit: false, reusedFiles: 0, refreshedFiles: 0 },
      topSymbols: projectGraph.symbolImpact.slice(0, 8),
      criticalSymbols: buildCriticalSymbols(projectGraph.symbolImpact),
      topFiles: projectGraph.fileImpact.slice(0, 8),
      topEdges: projectGraph.edgeImpact.slice(0, 8)
    },
    diagnostics: [
      ...(selectedFiles.length ? [] : ['No matching file or symbol candidates passed the scoring threshold.']),
      ...(projectGraph.diagnostics || [])
    ]
  };
}
