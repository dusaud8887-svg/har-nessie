import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import {
  buildLinuxPickFolderLaunchers,
  buildMacOsPickFolderDialogScript,
  buildPickFolderDialogScript,
  folderPickerUnavailableMessage,
  folderPickerUnsupportedMessage,
  isFolderPickerSupportedPlatform
} from './folder-picker.mjs';
import {
  HARNESS_META_DIR,
  HARNESS_SETTINGS_FILE,
  MEMORY_DIR,
  PROJECTS_DIR,
  ROOT_DIR,
  RUNS_DIR
} from './harness-paths.mjs';
import {
  analyzeProjectIntake,
  approvePlan,
  createProject,
  createRun,
  deleteProject,
  deleteRun,
  diagnoseSetup,
  getProjectOverview,
  getHarnessSettings,
  getRun,
  getRunLogs,
  initHarness,
  listProjects,
  listRunSummaries,
  rejectPlan,
  requeueFailedTasks,
  refreshRunPreflight,
  retryTask,
  runProjectQualitySweep,
  searchRunMemory,
  skipTask,
  startRun,
  stopRun,
  submitClarifyAnswers,
  subscribe,
  summarizeRun,
  updateHarnessSettings,
  updateProject,
  updatePlanDraft
} from './orchestrator.mjs';

const PORT = Number(process.env.HARNESS_PORT || 3482);
const clients = new Set();

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const INDEX_HTML = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const STATIC_ASSET_PATHS = new Set(['/app.js', '/app.css', '/app-helpers.js', '/app-artifact-renderers.js', '/app-project-renderers.js', '/app-modal-actions.js']);

function contentTypeForStatic(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function sendStatic(res, relativePath) {
  const safePath = path.resolve(PUBLIC_DIR, '.' + relativePath);
  if (!safePath.startsWith(PUBLIC_DIR)) throw new BadRequestError('Invalid static asset path.');
  const body = await fs.readFile(safePath);
  res.writeHead(200, { 'content-type': contentTypeForStatic(safePath) });
  res.end(body);
}
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestError';
    this.statusCode = 400;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new BadRequestError('Request body must be valid JSON.');
  }
}

async function pickFolderDialog(options = {}) {
  if (!isFolderPickerSupportedPlatform(process.platform)) {
    throw new BadRequestError(folderPickerUnsupportedMessage(process.platform));
  }

  const initialPath = String(options.initialPath || '').trim();
  const uiLanguage = String(options.uiLanguage || 'en').trim().toLowerCase() === 'ko' ? 'ko' : 'en';
  if (process.platform === 'win32') {
    return pickWindowsFolderDialog(initialPath, uiLanguage);
  }
  if (process.platform === 'darwin') {
    return pickMacOsFolderDialog(initialPath, uiLanguage);
  }
  if (process.platform === 'linux') {
    return pickLinuxFolderDialog(initialPath, uiLanguage);
  }
  throw new BadRequestError(folderPickerUnsupportedMessage(process.platform));
}

async function runPickerProcess(command, args, options = {}) {
  const spawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  };
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, spawnOptions);
    const stdout = [];
    const stderr = [];
    if (child.stdout) child.stdout.on('data', (chunk) => stdout.push(chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        output: Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim(),
        error: Buffer.concat(stderr).toString('utf8').replace(/^\uFEFF/, '').trim()
      });
    });
  });
}

async function pickWindowsFolderDialog(initialPath, uiLanguage) {
  const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    '-NoProfile',
    '-STA',
    '-Command',
    buildPickFolderDialogScript(initialPath, uiLanguage)
  ];
  const result = await runPickerProcess(powershellPath, command, { windowsHide: true });
  if (result.code !== 0 && result.error) {
    throw new BadRequestError(result.error);
  }
  return { path: result.output || '' };
}

async function pickMacOsFolderDialog(initialPath, uiLanguage) {
  const script = buildMacOsPickFolderDialogScript();
  const result = await runPickerProcess('osascript', script.flatMap((line) => ['-e', line]), {
    env: {
      ...process.env,
      HARNESS_PICK_FOLDER_INITIAL_PATH: initialPath,
      HARNESS_PICK_FOLDER_TITLE: uiLanguage === 'en' ? 'Choose a project folder' : '프로젝트 폴더를 선택하세요'
    }
  });
  if (result.code === 0) return { path: result.output || '' };
  if (/user canceled/i.test(result.error || '')) return { path: '' };
  throw new BadRequestError(result.error || folderPickerUnavailableMessage('darwin'));
}

async function probeShellCommand(command) {
  const result = await runPickerProcess('/bin/sh', ['-lc', `command -v ${command}`], {
    stdio: ['ignore', 'ignore', 'ignore']
  }).catch(() => null);
  return result?.code === 0;
}

async function pickLinuxFolderDialog(initialPath, uiLanguage) {
  const launchers = buildLinuxPickFolderLaunchers(initialPath, uiLanguage);
  for (const launcher of launchers) {
    if (!await probeShellCommand(launcher.command)) continue;
    const result = await runPickerProcess(launcher.command, launcher.args);
    if (result.code === 0) return { path: result.output || '' };
    if (!result.output && !result.error) return { path: '' };
    throw new BadRequestError(result.error || folderPickerUnavailableMessage('linux'));
  }
  throw new BadRequestError(folderPickerUnavailableMessage('linux'));
}

function matchRunId(pathname, suffix) {
  const normalizedSuffix = String(suffix || '').replace(/\$+$/, '');
  const match = pathname.match(new RegExp(`^/api/runs/([^/]+)${normalizedSuffix}$`));
  if (!match) return '';
  const value = decodeURIComponent(match[1]);
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new BadRequestError('Invalid run ID.');
  }
  return value;
}

function matchProjectId(pathname) {
  const match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (!match) return '';
  const value = decodeURIComponent(match[1]);
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new BadRequestError('Invalid project ID.');
  }
  return value;
}

function matchProjectIdAction(pathname, action) {
  const match = pathname.match(new RegExp(`^/api/projects/([^/]+)/${action}$`));
  if (!match) return '';
  const value = decodeURIComponent(match[1]);
  if (!value || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new BadRequestError('Invalid project ID.');
  }
  return value;
}

function assertTrustedLocalOrigin(req) {
  const host = String(req.headers.host || '').trim();
  const allowedHosts = new Set([host, `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].filter(Boolean));
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  let originHost = '';
  let refererHost = '';
  try {
    originHost = origin ? new URL(origin).host : '';
    refererHost = referer ? new URL(referer).host : '';
  } catch {
    throw new BadRequestError('Invalid origin.');
  }

  if (originHost && !allowedHosts.has(originHost)) {
    throw new BadRequestError('Untrusted origin.');
  }
  if (!originHost && refererHost && !allowedHosts.has(refererHost)) {
    throw new BadRequestError('Untrusted referer.');
  }
}

function matchTaskParams(pathname) {
  const match = pathname.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/artifacts$/);
  if (!match) return null;
  const runId = decodeURIComponent(match[1]);
  const taskId = decodeURIComponent(match[2]);
  if (!runId || !taskId || runId.includes('/') || runId.includes('\\') || runId.includes('..') || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    throw new BadRequestError('Invalid task path.');
  }
  return {
    runId,
    taskId
  };
}

function matchTaskActionParams(pathname, action) {
  const match = pathname.match(new RegExp(`^/api/runs/([^/]+)/tasks/([^/]+)/${action}$`));
  if (!match) return null;
  const runId = decodeURIComponent(match[1]);
  const taskId = decodeURIComponent(match[2]);
  if (!runId || !taskId || runId.includes('/') || runId.includes('\\') || runId.includes('..') || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    throw new BadRequestError('Invalid task path.');
  }
  return {
    runId,
    taskId
  };
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function readOptionalTextFirst(filePaths) {
  for (const filePath of filePaths) {
    const text = await readOptionalText(filePath);
    if (String(text || '').trim()) return text;
  }
  return '';
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readOptionalJsonLines(filePath) {
  const text = await readOptionalText(filePath);
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

async function readOptionalDataUrl(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png'
      ? 'image/png'
      : (ext === '.jpg' || ext === '.jpeg')
        ? 'image/jpeg'
        : 'application/octet-stream';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

function runLanguage(run) {
  const candidate = String(run?.harnessConfig?.uiLanguage || run?.harnessConfig?.agentLanguage || 'en').trim().toLowerCase();
  return candidate === 'ko' ? 'ko' : 'en';
}

function localizeRunText(run, ko, en) {
  return runLanguage(run) === 'en' ? String(en || ko || '') : String(ko || en || '');
}

function clipPreview(text, maxChars = 2400) {
  const value = String(text || '');
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

async function readStateFile(runId) {
  return JSON.parse(await fs.readFile(path.join(RUNS_DIR, runId, 'state.json'), 'utf8'));
}

async function readPreviewFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return '(binary file preview unavailable)';
    }
    return clipPreview(buffer.toString('utf8'));
  } catch (error) {
    return `(preview unavailable: ${error.message})`;
  }
}

async function readTaskWorkspacePreview(runId, taskId) {
  const state = await readStateFile(runId).catch(() => null);
  const task = state?.tasks?.find((item) => item.id === taskId) || null;
  const taskRoot = path.join(RUNS_DIR, runId, 'tasks', taskId);
  const workspaceDir = path.join(taskRoot, 'workspace');
  const workspaceExists = await fs.access(workspaceDir).then(() => true).catch(() => false);

  let changedFiles = [];
  try {
    changedFiles = JSON.parse(await fs.readFile(path.join(taskRoot, 'changed-files.json'), 'utf8'));
  } catch {
    changedFiles = (task?.lastExecution?.changedFiles || []).map((item) => ({ path: item }));
  }

  const files = [];
  for (const item of changedFiles.slice(0, 6)) {
    const relativePath = String(item?.path || item || '').trim().replace(/\\/g, '/');
    if (!relativePath) continue;
    const candidates = [];
    if (workspaceExists) {
      candidates.push({
        label: 'workspace',
        path: path.join(workspaceDir, ...relativePath.split('/'))
      });
    }
    if (state?.projectPath) {
      candidates.push({
        label: 'project',
        path: path.join(state.projectPath, ...relativePath.split('/'))
      });
    }

    let preview = '(file not found)';
    let source = 'missing';
    for (const candidate of candidates) {
      const exists = await fs.access(candidate.path).then(() => true).catch(() => false);
      if (!exists) continue;
      source = candidate.label;
      preview = await readPreviewFile(candidate.path);
      break;
    }

    files.push({
      path: relativePath,
      source,
      preview
    });
  }

  return {
    workspaceExists,
    workspaceMode: task?.lastExecution?.workspaceMode || '',
    files
  };
}

async function readRunTraceEntries(runId, limit = 200) {
  return (await readOptionalJsonLines(path.join(RUNS_DIR, runId, 'trace.ndjson'))).slice(-limit);
}

async function readRunActionRecords(runId, limit = 120) {
  return (await readOptionalJsonLines(path.join(RUNS_DIR, runId, 'run-actions.jsonl'))).slice(-limit);
}

function buildRunAnalytics(run, traceEntries = []) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const lastTrace = traceEntries.at(-1) || null;
  const activeTask = tasks.find((task) => task.status === 'in_progress') || null;
  const retryTasks = tasks.filter((task) => String(task.lastExecution?.reviewDecision || '') === 'retry' || task.status === 'failed');
  const acceptanceCounts = new Map();
  for (const task of tasks) {
    for (const result of Array.isArray(task.lastExecution?.acceptanceCheckResults) ? task.lastExecution.acceptanceCheckResults : []) {
      if (String(result?.status || '') !== 'fail') continue;
      const key = String(result?.check || '').trim();
      if (!key) continue;
      acceptanceCounts.set(key, (acceptanceCounts.get(key) || 0) + 1);
    }
  }
  const operatorSummary = {
    phase: run.status === 'needs_input'
      ? 'clarify'
      : run.status === 'needs_approval'
        ? 'approval'
        : activeTask
          ? 'execute'
          : (String(lastTrace?.phase || run.status || 'idle')),
    step: activeTask
      ? `${activeTask.id} ${activeTask.title}`
      : (lastTrace?.event || run.status || 'idle'),
    detail: activeTask?.lastExecution?.codeContextSummary
      || activeTask?.reviewSummary
      || run.planSummary
      || '',
    lastAction: activeTask?.lastExecution?.lastAction
      || (lastTrace ? { capabilityId: lastTrace.event || '', at: lastTrace.at || '', summary: JSON.stringify(lastTrace.meta || {}) } : null),
    rawPreserved: 'trace.ndjson, trajectory.jsonl, agent raw artifacts, and actions.jsonl remain on disk.',
    elapsed: run.createdAt && run.updatedAt
      ? Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000))
      : 0
  };
  return {
    traceEventCount: traceEntries.length,
    lastTraceAt: lastTrace?.at || '',
    lastTraceEvent: lastTrace?.event || '',
    retryCount: retryTasks.length,
    scopeDriftCount: tasks.filter((task) => (task.lastExecution?.outOfScopeFiles || []).length > 0).length,
    acceptanceHeatmap: [...acceptanceCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([check, count]) => ({ check, count })),
    operatorSummary
  };
}

function buildDecisionPanel(run, analytics, runActionRecords = []) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const failedTasks = tasks.filter((task) => task.status === 'failed');
  const retryableTasks = failedTasks.filter((task) => String(task.lastExecution?.reviewDecision || '') === 'retry');
  const blockedTask = failedTasks[0] || tasks.find((task) => task.status === 'ready') || null;
  const lastRunAction = runActionRecords.at(-1) || null;
  const actions = [];

  if (run.status === 'needs_input') {
    actions.push({
      id: 'answer-clarify',
      label: localizeRunText(run, '작업 전 확인 응답', 'Answer pre-work questions'),
      description: localizeRunText(run, '열린 질문에 답하면 planner 단계로 바로 복귀한다.', 'Answer the open questions to return directly to the planner stage.')
    });
  } else if (run.status === 'needs_approval') {
    actions.push({
      id: 'approve-plan',
      label: localizeRunText(run, '계획 승인', 'Approve plan'),
      description: localizeRunText(run, '계획 요약과 verification step을 확인한 뒤 실행을 시작한다.', 'Check the plan summary and verification step, then start execution.')
    });
  } else if (retryableTasks.length === 1) {
    actions.push({
      id: 'retry-task',
      label: localizeRunText(run, `${retryableTasks[0].id} 재시도`, `Retry ${retryableTasks[0].id}`),
      description: localizeRunText(run, '단일 실패 태스크라서 root cause를 고친 뒤 바로 retry하는 것이 가장 짧다.', 'There is one failed task, so fixing the root cause and retrying it is the shortest path.')
    });
  } else if (failedTasks.length > 1) {
    actions.push({
      id: 'requeue-failed',
      label: localizeRunText(run, '실패 태스크 재큐잉', 'Requeue failed tasks'),
      description: localizeRunText(run, '실패 태스크가 여러 개라서 개별 retry보다 requeue-failed가 더 안전하다.', 'Several tasks failed, so requeueing them together is safer than retrying one by one.')
    });
  } else if (blockedTask) {
    actions.push({
      id: 'inspect-task',
      label: localizeRunText(run, `${blockedTask.id} 확인`, `Inspect ${blockedTask.id}`),
      description: localizeRunText(run, '현재 태스크 정의, acceptance check, 최근 action 기록을 먼저 확인한다.', 'Check the current task definition, acceptance checks, and recent action log first.')
    });
  } else {
    actions.push({
      id: 'observe',
      label: localizeRunText(run, '진행 관찰', 'Observe progress'),
      description: localizeRunText(run, '지금은 별도 개입 없이 요약과 trace만 관찰하면 된다.', 'For now, it is enough to watch the summary and trace without intervening.')
    });
  }

  if ((analytics?.scopeDriftCount || 0) > 0) {
    actions.push({
      id: 'inspect-scope',
      label: localizeRunText(run, '범위 이탈 확인', 'Inspect scope drift'),
      description: localizeRunText(run, 'scope drift가 있었으므로 diff와 timeline을 먼저 확인한다.', 'There was scope drift, so check the diff and timeline first.')
    });
  }
  if ((analytics?.retryCount || 0) > 0 && !actions.some((item) => item.id === 'retry-task')) {
    actions.push({
      id: 'review-retries',
      label: localizeRunText(run, 'retry 원인 검토', 'Review retry causes'),
      description: localizeRunText(run, '반복 실패가 있으므로 retry-plan과 verification 결과를 우선 본다.', 'There are repeated failures, so review the retry plan and verification results first.')
    });
  }

  return {
    headline: actions[0]?.label || localizeRunText(run, '진행 관찰', 'Observe progress'),
    primaryAction: actions[0] || null,
    actions: actions.slice(0, 3),
    supportingSignals: [
      `failed=${failedTasks.length}`,
      `retryable=${retryableTasks.length}`,
      `scopeDrift=${analytics?.scopeDriftCount || 0}`,
      lastRunAction ? `lastRunAction=${lastRunAction.capabilityId || lastRunAction.phase || 'unknown'}` : ''
    ].filter(Boolean),
    lastRunAction,
    blockedTaskId: blockedTask?.id || ''
  };
}

function buildRecoveryGuide(run, analytics) {
  const steps = [];
  if (run.status === 'needs_input') {
    steps.push(localizeRunText(run, '답변 대기 중인 작업 전 확인 질문에 응답한 뒤 다시 시작한다.', 'Answer the pending pre-work questions, then resume the run.'));
  }
  if (run.status === 'needs_approval') {
    steps.push(localizeRunText(run, '계획 요약과 첫 태스크를 검토한 뒤 승인하거나 수정한다.', 'Review the plan summary and first task, then approve or request changes.'));
  }
  if (run.status === 'stopped') {
    steps.push(localizeRunText(run, '중단 이유를 확인하고 시작/재개 버튼으로 이어서 실행한다.', 'Check why the run stopped, then continue with Start/Resume.'));
  }
  if (run.status === 'failed' || run.status === 'partial_complete') {
    steps.push(localizeRunText(run, '실패 태스크의 요약, 검증 결과, action 기록을 읽고 재시도 또는 requeue를 결정한다.', 'Read the failed task summary, verification results, and action log, then choose retry or requeue.'));
  }
  if ((analytics?.scopeDriftCount || 0) > 0) {
    steps.push(localizeRunText(run, '범위 밖 변경이 있었으므로 Timeline과 변경점 탭을 먼저 확인한다.', 'There were out-of-scope changes, so check the Timeline and Changes tabs first.'));
  }
  if ((analytics?.retryCount || 0) > 0) {
    steps.push(localizeRunText(run, 'retry 태스크의 root cause와 failing acceptance check를 먼저 제거한다.', 'Fix the retry task root cause and failing acceptance checks first.'));
  }
  if (!steps.length) {
    steps.push(localizeRunText(run, '현재 run은 별도 복구 조치 없이 계속 진행 가능하다.', 'This run can continue without additional recovery steps.'));
  }
  return {
    title: localizeRunText(run, '복구 안내', 'Recovery guide'),
    status: run.status || 'unknown',
    steps,
    rawPreserved: analytics?.operatorSummary?.rawPreserved || '',
    manualRunbookPath: path.join(ROOT_DIR, 'docs', 'research', 'archive', '2026-04-recovery-runbook.md')
  };
}

async function readTaskArtifacts(runId, taskId) {
  const taskRoot = path.join(RUNS_DIR, runId, 'tasks', taskId);
  const promptText = await readOptionalTextFirst([path.join(taskRoot, 'agent-prompt.md'), path.join(taskRoot, 'codex-prompt.md')]);
  const outputText = await readOptionalTextFirst([path.join(taskRoot, 'agent-output.md'), path.join(taskRoot, 'codex-output.md')]);
  const reviewText = await readOptionalTextFirst([path.join(taskRoot, 'agent-review.json'), path.join(taskRoot, 'codex-review.json')]);
  const changedFilesText = await readOptionalText(path.join(taskRoot, 'changed-files.json'));
  let changedFiles = [];
  if (changedFilesText.trim()) {
    try {
      changedFiles = JSON.parse(changedFilesText);
    } catch {
      changedFiles = [];
    }
  }
  const traceEntries = (await readOptionalJsonLines(path.join(RUNS_DIR, runId, 'trace.ndjson')))
    .filter((entry) => String(entry?.taskId || entry?.meta?.taskId || '') === taskId)
    .slice(-80);
  const trajectoryEntries = (await readOptionalJsonLines(path.join(taskRoot, 'trajectory.jsonl'))).slice(-120);
  const verificationJson = await readOptionalJson(path.join(taskRoot, 'verification.json'));
  return {
    agentPrompt: promptText,
    agentOutput: outputText,
    verificationReport: await readOptionalText(path.join(taskRoot, 'verification.json')),
    verificationJson,
    browserVerification: verificationJson?.browser || null,
    browserScreenshotDataUrl: await readOptionalDataUrl(path.join(taskRoot, 'browser-screenshot.png')),
    diffPatch: await readOptionalText(path.join(taskRoot, 'diff.patch')),
    changedFiles,
    agentReview: reviewText,
    handoff: await readOptionalJson(path.join(taskRoot, 'handoff.json')),
    reviewVerdict: await readOptionalJson(path.join(taskRoot, 'review-verdict.json')),
    retryPlan: await readOptionalJson(path.join(taskRoot, 'retry-plan.json')),
    executionSummary: await readOptionalJson(path.join(taskRoot, 'execution-summary.json')),
    traceEntries,
    trajectoryEntries,
    actionRecords: (await readOptionalJsonLines(path.join(taskRoot, 'actions.jsonl'))).slice(-120),
    codeContext: await readOptionalJson(path.join(RUNS_DIR, runId, 'context', 'code-context', `${taskId}.json`)),
    workspacePreview: await readTaskWorkspacePreview(runId, taskId)
  };
}

async function getSystemInfo() {
  const projectEntries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const runEntries = await fs.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  const memoryEntries = await fs.readdir(MEMORY_DIR, { withFileTypes: true }).catch(() => []);
  return {
    rootDir: ROOT_DIR,
    projectsDir: PROJECTS_DIR,
    runsDir: RUNS_DIR,
    memoryDir: MEMORY_DIR,
    settingsFile: HARNESS_SETTINGS_FILE,
    projectCount: projectEntries.filter((entry) => entry.isDirectory()).length,
    runCount: runEntries.filter((entry) => entry.isDirectory()).length,
    memoryProjectCount: memoryEntries.filter((entry) => entry.isDirectory()).length,
    hasLocalSettings: await fs.access(HARNESS_SETTINGS_FILE).then(() => true).catch(() => false)
  };
}

await initHarness();

subscribe((event) => {
  const payload = `data: ${JSON.stringify({
    runId: event.runId,
    type: event.type,
    entry: event.entry || null,
    summary: event.state ? summarizeRun(event.state) : null
  })}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (req.method === 'GET' && STATIC_ASSET_PATHS.has(url.pathname)) {
      await sendStatic(res, url.pathname);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('retry: 1500\n\n');
      res.write(`data: ${JSON.stringify({ type: 'sync', runs: await listRunSummaries() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      sendJson(res, 200, await listRunSummaries());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/system') {
      sendJson(res, 200, await getSystemInfo());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, 200, await getHarnessSettings());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      sendJson(res, 200, await updateHarnessSettings(await readBody(req)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/diagnostics') {
      sendJson(res, 200, await diagnoseSetup(await readBody(req)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, await listProjects());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects/intake') {
      sendJson(res, 200, await analyzeProjectIntake(await readBody(req)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      sendJson(res, 201, await createProject(await readBody(req)));
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && !url.pathname.endsWith('/quality-sweep')) {
      const projectId = matchProjectIdAction(url.pathname, '$');
      if (projectId) {
        sendJson(res, 200, await updateProject(projectId, await readBody(req)));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/quality-sweep')) {
      const projectId = matchProjectIdAction(url.pathname, 'quality-sweep');
      if (projectId) {
        sendJson(res, 200, await runProjectQualitySweep(projectId, await readBody(req)));
        return;
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
      const projectId = matchProjectId(url.pathname);
      if (projectId) {
        sendJson(res, 200, await deleteProject(projectId, {
          deleteRuns: ['1', 'true', 'yes'].includes(String(url.searchParams.get('deleteRuns') || '').toLowerCase()),
          deleteMemory: ['1', 'true', 'yes'].includes(String(url.searchParams.get('deleteMemory') || '').toLowerCase())
        }));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
      const projectId = matchProjectId(url.pathname);
      if (projectId) {
        sendJson(res, 200, await getProjectOverview(projectId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      assertTrustedLocalOrigin(req);
      sendJson(res, 200, await pickFolderDialog(await readBody(req)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/runs') {
      sendJson(res, 201, await createRun(await readBody(req)));
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/clarify-answers')) {
      const runId = matchRunId(url.pathname, '/clarify-answers$');
      if (runId) {
        const body = await readBody(req);
        await submitClarifyAnswers(runId, body.answers || {});
        sendJson(res, 200, await startRun(runId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/approve-plan')) {
      const runId = matchRunId(url.pathname, '/approve-plan');
      if (runId) {
        await approvePlan(runId);
        sendJson(res, 200, await startRun(runId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/reject-plan')) {
      const runId = matchRunId(url.pathname, '/reject-plan$');
      if (runId) {
        const body = await readBody(req);
        sendJson(res, 200, await rejectPlan(runId, body.feedback || ''));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/plan-edit')) {
      const runId = matchRunId(url.pathname, '/plan-edit$');
      if (runId) {
        sendJson(res, 200, await updatePlanDraft(runId, await readBody(req)));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/diagnostics')) {
      const runId = matchRunId(url.pathname, '/diagnostics$');
      if (runId) {
        sendJson(res, 200, await refreshRunPreflight(runId));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.includes('/tasks/') && url.pathname.endsWith('/artifacts')) {
      const match = matchTaskParams(url.pathname);
      if (match) {
        sendJson(res, 200, await readTaskArtifacts(match.runId, match.taskId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/retry')) {
      const match = matchTaskActionParams(url.pathname, 'retry');
      if (match) {
        sendJson(res, 200, await retryTask(match.runId, match.taskId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/skip')) {
      const match = matchTaskActionParams(url.pathname, 'skip');
      if (match) {
        const body = await readBody(req);
        sendJson(res, 200, await skipTask(match.runId, match.taskId, body.reason || ''));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.endsWith('/memory')) {
      const runId = matchRunId(url.pathname, '/memory$');
      if (runId) {
        sendJson(res, 200, await searchRunMemory(runId, url.searchParams.get('q') || ''));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.endsWith('/logs')) {
      const runId = matchRunId(url.pathname, '/logs');
      if (runId) {
        sendJson(res, 200, await getRunLogs(runId));
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const runId = matchRunId(url.pathname, '$');
      if (runId) {
        const run = await getRun(runId);
        const { logs, ...detail } = run;
        const traceEntries = await readRunTraceEntries(runId);
        const runActionRecords = await readRunActionRecords(runId);
        const analytics = buildRunAnalytics(run, traceEntries);
        sendJson(res, 200, {
          ...detail,
          analytics,
          checkpoint: await readOptionalJson(path.join(RUNS_DIR, runId, 'run-checkpoint.json')),
          decisionPanel: buildDecisionPanel(run, analytics, runActionRecords),
          recoveryGuide: buildRecoveryGuide(run, analytics),
          runActionRecords
        });
        return;
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/runs/')) {
      const runId = matchRunId(url.pathname, '$');
      if (runId) {
        sendJson(res, 200, await deleteRun(runId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/start')) {
      const runId = matchRunId(url.pathname, '/start$');
      if (runId) {
        const body = await readBody(req);
        sendJson(res, 200, await startRun(runId, { additionalRequirements: body.additionalRequirements || '' }));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/stop')) {
      const runId = matchRunId(url.pathname, '/stop$');
      if (runId) {
        sendJson(res, 200, await stopRun(runId));
        return;
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/requeue-failed')) {
      const runId = matchRunId(url.pathname, '/requeue-failed$');
      if (runId) {
        sendJson(res, 200, await requeueFailedTasks(runId));
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message });
  }
});

server.keepAliveTimeout = 0;   // Do not let the idle timer close SSE streams.
server.headersTimeout = 65000; // Allow slower orchestrator responses to finish.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Harness web UI: http://127.0.0.1:${PORT}`);
});
