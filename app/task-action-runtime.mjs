import { promises as fs } from 'node:fs';
import path from 'node:path';

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
const STATIC_IMPORT_PATTERN = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))/g;
const PYTHON_IMPORT_PATTERN = /^\s*(?:from\s+([.\w/]+)\s+import\s+([A-Za-z0-9_,\s*]+)|import\s+([.\w/.]+))/gm;
const EXPORT_SYMBOL_PATTERN = /\bexport\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_]\w*)/g;
const DECLARATION_SYMBOL_PATTERN = /\b(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_]\w*)/g;
const IMPORTED_SYMBOL_PATTERN = /\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_]\w*))/g;
const VERIFICATION_TYPES = ['TEST', 'STATIC', 'BROWSER', 'MANUAL'];
const ACTION_CLASSES = ['memory-read', 'code-context', 'codex-exec', 'verification', 'git-write', 'recovery'];

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
      result.push(normalized);
      if (result.length >= limit) break;
    }
  }
  return result;
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
  STATIC_IMPORT_PATTERN.lastIndex = 0;
  PYTHON_IMPORT_PATTERN.lastIndex = 0;
  IMPORTED_SYMBOL_PATTERN.lastIndex = 0;
  EXPORT_SYMBOL_PATTERN.lastIndex = 0;
  DECLARATION_SYMBOL_PATTERN.lastIndex = 0;
  while ((match = STATIC_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || match[2] || match[3] || '';
    imports.push({
      specifier,
      importedSymbols: []
    });
  }
  while ((match = PYTHON_IMPORT_PATTERN.exec(sourceText)) !== null) {
    const specifier = match[1] || match[3] || '';
    const imported = splitImportedSymbols(match[2] || '');
    imports.push({
      specifier,
      importedSymbols: imported
    });
    importedSymbols.push(...imported);
  }
  while ((match = IMPORTED_SYMBOL_PATTERN.exec(sourceText)) !== null) {
    importedSymbols.push(...splitImportedSymbols(match[1] || match[2] || ''));
  }
  while ((match = EXPORT_SYMBOL_PATTERN.exec(sourceText)) !== null) {
    const symbol = String(match[1] || '').trim();
    if (symbol) exports.push(symbol);
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
      diagnostics: ['No project root attached.']
    };
  }

  const queryTokens = tokenizeTaskContext(task);
  const likelyFiles = normalizeTaskFiles(task?.filesLikely);
  const discovered = await listCodeContextFiles(run.projectPath, 260);
  const candidateFiles = uniqueBy([
    ...likelyFiles,
    ...discovered
  ], (item) => normalizeRepoPath(item)).slice(0, 48);

  const relatedFiles = [];
  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(run.projectPath, ...relativePath.split('/'));
    const body = await fs.readFile(absolutePath, 'utf8').catch(() => '');
    if (!body) continue;
    const normalizedPath = normalizeRepoPath(relativePath);
    let score = likelyFiles.some((item) => normalizeRepoPath(item) === normalizedPath) ? 60 : 0;
    for (const token of queryTokens) {
      if (normalizedPath.includes(token)) score += 16;
      if (body.toLowerCase().includes(token)) score += 6;
    }
    const symbols = extractSymbolHints(body, queryTokens);
    const references = extractReferenceHints(body, queryTokens);
    const codeGraph = await extractStaticCodeGraph(run.projectPath, relativePath, body);
    score += symbols.length * 4;
    score += references.length * 2;
    score += (codeGraph.exports.length + codeGraph.declarations.length) * 2;
    score += codeGraph.imports.length;
    if (!score) continue;
    relatedFiles.push({
      path: relativePath,
      score,
      symbols,
      references,
      codeGraph,
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
    ...queryTokens
  ]);
  return {
    schemaVersion: '2',
    runId: run.id,
    taskId: task.id,
    generatedAt: now(),
    summary: selectedFiles.length
      ? `Top files: ${selectedFiles.map((item) => item.path).join(', ')} | symbol graph edges: ${selectedFiles.reduce((sum, item) => sum + Number(item.codeGraph?.imports?.length || 0), 0)}`
      : 'No strongly related code files were detected from the task goal and filesLikely.',
    queryTokens,
    symbolHints,
    relatedFiles: selectedFiles,
    diagnostics: selectedFiles.length ? [] : ['No matching file or symbol candidates passed the scoring threshold.']
  };
}
