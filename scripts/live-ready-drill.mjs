import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvePlan,
  createRun,
  deleteRun,
  diagnoseSetup,
  getHarnessSettings,
  getRun,
  initHarness,
  requeueFailedTasks,
  retryTask,
  skipTask,
  startRun,
  stopRun,
  updatePlanDraft,
  updateHarnessSettings,
  submitClarifyAnswers
} from '../app/orchestrator.mjs';
import { TASK_CAPABILITY_REGISTRY } from '../app/task-action-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await sleep(120);
  }
  throw new Error(`Timed out waiting for HTTP endpoint: ${url}`);
}

async function waitForRun(runId, predicate, timeoutMs = 20000, intervalMs = 120) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getRun(runId).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!run) {
      await sleep(intervalMs);
      continue;
    }
    if (predicate(run)) return run;
    await sleep(intervalMs);
  }
  const latest = await getRun(runId).catch(() => null);
  throw new Error(`Timed out waiting for run ${runId}. Latest status: ${latest?.status || 'unknown'} | result=${latest?.result?.summary || ''} | taskStatuses=${(latest?.tasks || []).map((task) => `${task.id}:${task.status}`).join(', ')}`);
}

async function restartRun(runId, attempts = 8) {
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await startRun(runId);
    if (!['draft', 'stopped'].includes(latest.status)) return latest;
    await sleep(180);
  }
  return latest;
}

async function waitForRunToSettle(runId, settleMs = 300, timeoutMs = 5000) {
  const startedAt = Date.now();
  let stableSince = 0;
  let lastSignature = '';
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await getRun(runId).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!latest) {
      await sleep(120);
      continue;
    }
    const signature = JSON.stringify({
      status: latest.status,
      updatedAt: latest.updatedAt,
      tasks: (latest.tasks || []).map((task) => ({
        id: task.id,
        status: task.status,
        attempts: task.attempts
      }))
    });
    if (signature === lastSignature) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= settleMs) return latest;
    } else {
      lastSignature = signature;
      stableSince = 0;
    }
    await sleep(120);
  }
  return latest || getRun(runId);
}

async function createDrillProject(parentDir, scenario) {
  const projectDir = path.join(parentDir, scenario);
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'README.md'), `# ${scenario}\n\nInitial content.\n`, 'utf8');
  await fs.writeFile(path.join(projectDir, 'src', 'index.js'), `export const scenario = '${scenario}';\n`, 'utf8');
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({
    name: `drill-${scenario}`,
    private: true,
    type: 'module'
  }, null, 2), 'utf8');
  return projectDir;
}

async function installFakeProviders(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  const stateFile = path.join(binDir, 'fake-provider-state.json');
  for (const name of ['codex', 'claude', 'gemini']) {
    await fs.writeFile(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0fake-provider.mjs" ${name} %*\r\n`, 'utf8');
    await fs.writeFile(path.join(binDir, name), `#!/bin/sh\nnode "$(dirname "$0")/fake-provider.mjs" ${name} "$@"\n`, 'utf8');
    await fs.chmod(path.join(binDir, name), 0o755).catch(() => {});
  }
  await fs.writeFile(path.join(binDir, 'fake-provider.mjs'), `
import { promises as fs } from 'node:fs';
import path from 'node:path';

const provider = String(process.argv[2] || 'codex').trim().toLowerCase();
const args = process.argv.slice(3);
const stateFile = process.env.FAKE_HARNESS_PROVIDER_STATE || process.env.FAKE_CODEX_STATE;
const cwdMarker = path.basename(process.cwd()).toLowerCase();
function readFlagValue(flags) {
  const index = args.findIndex((arg) => flags.includes(arg));
  if (index < 0) return '';
  const collected = [];
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    const value = args[cursor];
    if (cursor > index + 1 && /^--?[a-z]/i.test(value)) break;
    collected.push(value);
  }
  return collected.join(' ').trim();
}

const outputFile = readFlagValue(['-o', '--output-last-message']);
const stdinPrompt = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', () => resolve(''));
});
const promptArg = readFlagValue(['-p', '--prompt']) || args.at(-1) || '';
const prompt = promptArg === '-' ? stdinPrompt : (promptArg || stdinPrompt || '');
const providerName = provider === 'claude' ? 'Claude Code' : (provider === 'gemini' ? 'Gemini CLI' : 'Codex');
const promptFileHint = extractPromptFile(prompt);
const resolvedPrompt = promptFileHint
  ? await fs.readFile(promptFileHint, 'utf8').catch(() => prompt)
  : prompt;

async function readState() {
  try {
    return JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch {
    return { attempts: {} };
  }
}

async function writeState(state) {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

async function emitLastMessage(text) {
  if (outputFile) {
    await fs.writeFile(path.resolve(process.cwd(), outputFile), text, 'utf8');
  }
  process.stdout.write(text);
}

async function printJson(value) {
  await emitLastMessage(JSON.stringify(value, null, 2));
}

function extractPromptFile(value) {
  const match = String(value || '').match(/Read and execute the task instructions in this file first:\\s*(.+)$/s);
  const raw = match ? match[1].trim() : '';
  return raw.replace(/^["']|["']$/g, '');
}

function extractValue(label, body) {
  const prefix = String(label || '') + ':';
  for (const line of String(body || '').split(/\\r?\\n/)) {
    if (!line.startsWith(prefix)) continue;
    return line.slice(prefix.length).trim();
  }
  return '';
}

function promptMentionsRole(promptText, roleNeedle) {
  return new RegExp('You are(?: the)? [^\\n]*' + roleNeedle, 'i').test(String(promptText || ''));
}

function isClarifyPrompt(promptText) {
  const body = String(promptText || '');
  return promptMentionsRole(body, 'acting as the harness clarifier')
    || body.includes('"clarifiedObjective":"string"')
    || body.includes('"openQuestions":[{"id":"string","question":"string"}]');
}

function isPlannerPrompt(promptText) {
  const body = String(promptText || '');
  return promptMentionsRole(body, 'supervisor for a local engineering harness')
    || (body.includes('"agents":[{"name":"string","role":"string","model":"codex|claude|gemini","responsibility":"string"}]')
      && body.includes('"tasks":[{'));
}

function isReviewPrompt(promptText) {
  const body = String(promptText || '');
  return promptMentionsRole(body, 'verifier for a local engineering harness')
    || body.includes('"functionalFindings":["string"]')
    || body.includes('"retryDiagnosis":"string"');
}

function isGoalJudgePrompt(promptText) {
  const body = String(promptText || '');
  return promptMentionsRole(body, 'goal judge for a local engineering harness')
    || body.includes('"goalAchieved":true|false');
}

function isAutomaticReplanPrompt(promptText) {
  const body = String(promptText || '');
  return promptMentionsRole(body, 'acting as the automatic replanner for a local engineering harness')
    || body.includes('"shouldReplan":true|false')
    || body.includes('"driftRisk":"low|medium|high"');
}

async function reviewResponse(promptText) {
  const body = String(promptText || '');
  const diffPath = extractValue('Task diff', body);
  const diffText = diffPath ? await fs.readFile(diffPath, 'utf8').catch(() => '') : '';
  const scenarioText = [cwdMarker, body].filter(Boolean).join('\\n');
  const hasDiff = Boolean(String(diffText || '').trim());
  if (!hasDiff || scenarioText.includes('skip-flow') || scenarioText.includes('Skip README task')) {
    return {
      decision: 'retry',
      summary: '변경 근거가 부족하거나 작업이 비어 있어 재시도가 필요하다.',
      findings: ['diff가 비어 있거나 적용 가능한 변경이 확인되지 않았다.'],
      functionalFindings: ['요구된 observable state를 입증할 변경이 남아 있지 않다.'],
      codeFindings: [],
      acceptanceCheckResults: [{ check: 'README에 drill 마커가 남는다.', status: 'fail', note: 'README 변경 diff가 없다.' }],
      retryDiagnosis: '변경 적용 없이 review 단계에 진입했다.',
      updatedTask: {}
    };
  }
  return {
    decision: 'approve',
    summary: '요구된 변경과 acceptance evidence가 확인돼 승인한다.',
    findings: [],
    functionalFindings: ['README 변경 diff와 handoff evidence가 현재 목표와 일치한다.'],
    codeFindings: [],
    acceptanceCheckResults: [{ check: 'README에 drill 마커가 남는다.', status: 'pass', note: 'README diff가 존재한다.' }],
    retryDiagnosis: '',
    updatedTask: {}
  };
}

function goalJudgeResponse(promptText) {
  const promptBody = String(promptText || '');
  const ledgerBlock = promptBody.includes('Current task ledger:\\n')
    ? promptBody.split('Current task ledger:\\n')[1]?.split('\\n\\nReturn JSON only with this shape:')[0] || ''
    : '';
  const statuses = [...String(ledgerBlock || promptBody).matchAll(/"status":\s*"([^"]+)"/g)].map((match) => match[1]);
  if (!statuses.length) {
    return {
      goalAchieved: true,
      summary: '태스크가 없으므로 목표를 달성한 것으로 본다.',
      findings: [],
      newTasks: []
    };
  }
  const hasFailed = statuses.includes('failed');
  const hasActive = statuses.some((status) => !['done', 'skipped', 'failed'].includes(status));
  const allSatisfied = statuses.every((status) => ['done', 'skipped'].includes(status));
  if (allSatisfied) {
    return {
      goalAchieved: true,
      summary: '남은 작업 없이 목표를 달성했다.',
      findings: statuses.includes('skipped') ? ['건너뛴 태스크가 있으므로 후속 수동 확인은 필요하다.'] : [],
      newTasks: []
    };
  }
  if (hasFailed) {
    return {
      goalAchieved: false,
      summary: '실패 태스크가 남아 있어 목표를 아직 달성하지 못했다.',
      findings: ['실패 태스크를 retry, requeue, skip 중 하나로 처리해야 한다.'],
      newTasks: []
    };
  }
  return {
    goalAchieved: false,
    summary: hasActive ? '진행 중인 태스크가 남아 있다.' : '실패 태스크를 다시 처리해야 한다.',
    findings: hasActive ? [] : ['실패 태스크가 정리될 때까지 목표를 닫지 않는다.'],
    newTasks: []
  };
}

async function automaticReplanResponse(promptText) {
  const body = String(promptText || '');
  const state = await readState();
  state.replans = state.replans || {};
  if ((body.includes('replan-flow') || body.includes('Placeholder README follow-up')) && !state.replans.replanFlowApplied) {
    state.replans.replanFlowApplied = true;
    await writeState(state);
    return {
      shouldReplan: true,
      summary: '첫 batch 결과를 반영해 후속 태스크를 더 구체적으로 나누고 검증 태스크를 추가한다.',
      objectiveStillValid: true,
      driftRisk: 'low',
      pauseForHuman: false,
      preserve: ['README 한 파일 범위를 유지한다.', '기존 objective를 확장하지 않는다.'],
      whyNow: ['첫 태스크가 끝나 후속 태스크를 더 구체적으로 고정할 수 있다.'],
      edits: [{
        id: 'T002',
        title: 'Finalize README after replanning',
        goal: '첫 태스크 결과를 바탕으로 README 마커를 최종 상태로 정리한다.',
        dependsOn: ['T001'],
        filesLikely: ['README.md'],
        constraints: ['README만 수정한다.'],
        acceptanceChecks: ['README에 FINALIZED 마커가 남는다.'],
        checkpointNotes: ['첫 태스크 결과를 읽고 이어서 마무리한다.']
      }],
      newTasks: [{
        title: 'Record verification note after replanning',
        goal: 'README에 최종 확인용 verification note를 남긴다.',
        dependsOn: ['T002'],
        filesLikely: ['README.md'],
        constraints: ['README만 수정한다.'],
        acceptanceChecks: ['README에 VERIFIED 마커가 남는다.'],
        checkpointNotes: ['automatic replanning으로 추가된 후속 확인 태스크']
      }]
    };
  }
  await writeState(state);
  return {
    shouldReplan: false,
    summary: '현재 backlog를 유지한다.',
    objectiveStillValid: true,
    driftRisk: 'low',
    pauseForHuman: false,
    preserve: ['현재 objective 유지'],
    whyNow: [],
    edits: [],
    newTasks: []
  };
}

async function handleImplementation(promptText) {
  const promptFile = extractPromptFile(promptText);
  const body = promptFile ? await fs.readFile(promptFile, 'utf8').catch(() => promptText) : promptText;
  const taskTitle = extractValue('Title', body);
  const projectRoot = extractValue('Project root', body);
  const readmePath = promptFile
    ? path.join(path.dirname(promptFile), 'README.md')
    : (projectRoot ? path.join(projectRoot, 'README.md') : path.join(process.cwd(), 'README.md'));
  const scenarioText = [cwdMarker, body, promptText].filter(Boolean).join('\\n');
  const state = await readState();
  const key = scenarioText.includes('retry-flow') || scenarioText.includes('Retry README task')
    ? 'retry-task'
    : scenarioText.includes('requeue-flow') || scenarioText.includes('Requeue README task')
      ? 'requeue-task'
      : scenarioText.includes('skip-flow') || scenarioText.includes('Skip README task')
        ? 'skip-task'
        : scenarioText.includes('stop-resume-flow') || scenarioText.includes('Slow README task')
          ? 'slow-task'
          : (taskTitle || 'success-task');
  state.attempts[key] = (state.attempts[key] || 0) + 1;
  await writeState(state);
  const attempt = state.attempts[key];

  if (scenarioText.includes('stop-resume-flow') || scenarioText.includes('Slow README task')) {
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await fs.writeFile(readmePath, '# stop-resume-flow\\n\\nSTOP-RESUME-SUCCESS\\n', 'utf8');
  } else if (scenarioText.includes('replan-flow') || scenarioText.includes('Prepare README for replan flow') || scenarioText.includes('Finalize README after replanning') || scenarioText.includes('Record verification note after replanning')) {
    if (taskTitle.includes('Prepare README for replan flow')) {
      await fs.writeFile(readmePath, '# replan-flow\\n\\nPREPARED\\n', 'utf8');
    } else if (taskTitle.includes('Finalize README after replanning')) {
      await fs.appendFile(readmePath, 'FINALIZED\\n', 'utf8');
    } else if (taskTitle.includes('Record verification note after replanning')) {
      await fs.appendFile(readmePath, 'VERIFIED\\n', 'utf8');
    } else {
      await fs.writeFile(readmePath, '# replan-flow\\n\\nPREPARED\\n', 'utf8');
    }
  } else if (scenarioText.includes('retry-flow') || scenarioText.includes('Retry README task')) {
    if (attempt >= 2) {
      await fs.writeFile(readmePath, '# retry-flow\\n\\nRETRY-SUCCESS\\n', 'utf8');
    }
  } else if (scenarioText.includes('requeue-flow') || scenarioText.includes('Requeue README task')) {
    if (attempt >= 2) {
      await fs.writeFile(readmePath, '# requeue-flow\\n\\nREQUEUE-SUCCESS\\n', 'utf8');
    }
  } else if (scenarioText.includes('skip-flow') || scenarioText.includes('Skip README task')) {
    // Intentionally leave the workspace unchanged so the harness forces a blocked review.
  } else {
    await fs.writeFile(readmePath, '# clarify-needed-success\\n\\nSUCCESS-MARKER\\n', 'utf8');
  }

  await emitLastMessage([
    'Context read',
    'Summary',
    providerName + ' updated README for the requested drill scenario.',
    'Files changed',
    readmePath || 'README.md',
    'Checks run',
    'none',
    'Acceptance check results',
    '1. PASS',
    'Risks or follow-ups',
    'none',
    providerName + ' handoff',
    'handoff complete'
  ].join('\\n'));
}

if (args.includes('--version')) {
  process.stdout.write('fake-' + provider + ' 1.0.0\\n');
  process.exit(0);
}

if (isClarifyPrompt(resolvedPrompt)) {
  const hasAnswers = !resolvedPrompt.includes('Known clarify answers: None')
    || resolvedPrompt.includes('"scope_q"')
    || resolvedPrompt.includes('"answer"')
    || resolvedPrompt.includes('# Clarification Answers')
    || resolvedPrompt.includes('README만 수정하면 된다.');
  if ((resolvedPrompt.includes('clarify-needed-success') || cwdMarker.includes('clarify-needed-success')) && !hasAnswers) {
    await printJson({
      clarifiedObjective: 'README 시나리오를 안전하게 반영한다.',
      scopeSummary: 'README 한 파일만 수정한다.',
      assumptions: ['README 수정만 필요하다.'],
      openQuestions: [{ id: 'scope_q', question: 'README만 수정해도 되는가?' }],
      recommendedPresetId: 'existing-repo-feature',
      architecturePattern: 'pipeline',
      executionModel: providerName + '가 계획, 구현, 검토를 순차 수행한다.'
    });
  } else {
    await printJson({
      clarifiedObjective: 'README 기반 drill 시나리오를 완료한다.',
      scopeSummary: 'README 한 파일 안에서 작업을 끝낸다.',
      assumptions: ['인접 파일 수정은 필요 없다.'],
      openQuestions: [],
      recommendedPresetId: 'existing-repo-feature',
      architecturePattern: 'pipeline',
      executionModel: providerName + '가 계획, 구현, 검토를 순차 수행한다.'
    });
  }
  process.exit(0);
}

if (isPlannerPrompt(resolvedPrompt)) {
  let title = 'Update README success';
  let goal = 'README에 성공 마커를 남긴다.';
  if (resolvedPrompt.includes('retry-flow') || cwdMarker.includes('retry-flow')) {
    title = 'Retry README task';
    goal = '첫 실패 후 retry로 README를 수정한다.';
  } else if (resolvedPrompt.includes('requeue-flow') || cwdMarker.includes('requeue-flow')) {
    title = 'Requeue README task';
    goal = '첫 실패 후 requeue로 README를 수정한다.';
  } else if (resolvedPrompt.includes('skip-flow') || cwdMarker.includes('skip-flow')) {
    title = 'Skip README task';
    goal = '의도적으로 실패한 뒤 skip 흐름을 점검한다.';
  } else if (resolvedPrompt.includes('stop-resume-flow') || cwdMarker.includes('stop-resume-flow')) {
    title = 'Slow README task';
    goal = '중단 후 resume로 README를 수정한다.';
  } else if (resolvedPrompt.includes('replan-flow') || cwdMarker.includes('replan-flow')) {
    await printJson({
      summary: 'README 한 파일에서 automatic replanning 경로를 검증한다.',
      executionModel: providerName + ' planner -> implementer -> replanner -> goal judge',
      agents: [
        { name: 'planner', role: '계획 수립', model: provider, responsibility: '태스크 정의' },
        { name: 'implementer', role: 'README 수정', model: provider, responsibility: '단일 파일 실행' },
        { name: 'replanner', role: 'backlog refinement', model: provider, responsibility: '후속 태스크 자동 정제' },
        { name: 'goal-judge', role: '완료 판단', model: provider, responsibility: '최종 상태 결정' }
      ],
      tasks: [{
        title: 'Prepare README for replan flow',
        goal: 'README에 초기 마커를 남겨 automatic replanning의 입력을 만든다.',
        dependsOn: [],
        filesLikely: ['README.md'],
        constraints: ['README만 수정한다.'],
        acceptanceChecks: ['README에 PREPARED 마커가 남는다.']
      }, {
        title: 'Placeholder README follow-up',
        goal: '첫 태스크 뒤 더 구체화될 후속 작업 자리를 남긴다.',
        dependsOn: ['T001'],
        filesLikely: ['README.md'],
        constraints: ['README만 수정한다.'],
        acceptanceChecks: ['README 후속 작업이 완료된다.']
      }]
    });
    process.exit(0);
  }
  await printJson({
    summary: 'README 한 파일로 drill 시나리오를 검증한다.',
    executionModel: providerName + ' planner -> implementer -> goal judge',
    agents: [
      { name: 'planner', role: '계획 수립', model: provider, responsibility: '태스크 정의' },
      { name: 'implementer', role: 'README 수정', model: provider, responsibility: '단일 파일 실행' },
      { name: 'goal-judge', role: '완료 판단', model: provider, responsibility: '최종 상태 결정' }
    ],
    tasks: [{
      title,
      goal,
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: ['README만 수정한다.'],
      acceptanceChecks: ['README에 drill 마커가 남는다.']
    }]
  });
  process.exit(0);
}

if (isReviewPrompt(resolvedPrompt)) {
  await printJson(await reviewResponse(resolvedPrompt));
  process.exit(0);
}

if (isGoalJudgePrompt(resolvedPrompt)) {
  await printJson(goalJudgeResponse(resolvedPrompt));
  process.exit(0);
}

if (isAutomaticReplanPrompt(resolvedPrompt)) {
  await printJson(await automaticReplanResponse(resolvedPrompt));
  process.exit(0);
}

await handleImplementation(resolvedPrompt);
`, 'utf8');
  return {
    binDir,
    stateFile
  };
}

function withPrependedPath(binDir) {
  const previousPath = process.env.PATH || '';
  const previousFakeState = process.env.FAKE_HARNESS_PROVIDER_STATE || process.env.FAKE_CODEX_STATE || '';
  return {
    apply(stateFile) {
      process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
      process.env.FAKE_HARNESS_PROVIDER_STATE = stateFile;
      process.env.FAKE_CODEX_STATE = stateFile;
    },
    restore() {
      process.env.PATH = previousPath;
      if (previousFakeState) {
        process.env.FAKE_HARNESS_PROVIDER_STATE = previousFakeState;
        process.env.FAKE_CODEX_STATE = previousFakeState;
      } else {
        delete process.env.FAKE_HARNESS_PROVIDER_STATE;
        delete process.env.FAKE_CODEX_STATE;
      }
    }
  };
}

async function runApprovedScenario(title, objective, projectPath, extra = {}) {
  const run = await createRun({
    title,
    projectPath,
    objective,
    specText: '',
    specFiles: '',
    settings: {
      maxParallel: 1,
      maxTaskAttempts: extra.maxTaskAttempts || 1,
      maxGoalLoops: extra.maxGoalLoops || 1
    }
  });

  await startRun(run.id);
  let current = await waitForRun(run.id, (value) => value.status === 'needs_input' || value.status === 'needs_approval');
  if (current.status === 'needs_input') {
    await submitClarifyAnswers(run.id, { scope_q: 'README만 수정하면 된다.' });
    await waitForRunToSettle(run.id);
    current = await restartRun(run.id);
    current = await waitForRun(run.id, (value) => value.status === 'needs_approval');
  }
  await approvePlan(run.id);
  current = await restartRun(run.id);
  return {
    runId: run.id,
    state: current
  };
}

async function startHarnessServer(port) {
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', 'app/server.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      HARNESS_PORT: String(port)
    }
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  await waitForHttp(`http://127.0.0.1:${port}/api/runs`);
  return {
    child,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('close', resolve)).catch(() => {});
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (errorOutput) {
        throw new Error(errorOutput);
      }
    }
  };
}

function providerReadinessFromRun(run) {
  const environment = run.preflight?.environment || {};
  const project = run.preflight?.project || {};
  const validationCommands = Array.isArray(run.projectContext?.validationCommands) ? run.projectContext.validationCommands : [];
  return Object.entries(TASK_CAPABILITY_REGISTRY).map(([id, capability]) => ({
    capabilityId: id,
    bridge: capability.mcpBridgeCandidate,
    provider: capability.provider,
    ready: id === 'memory-search'
      ? true
      : id === 'code-context'
        ? Boolean(run.projectPath)
        : ['codex', 'claude', 'gemini'].includes(id)
          ? Boolean(environment[id]?.ok)
          : id === 'verification'
            ? validationCommands.length > 0
            : id === 'git-apply'
              ? Boolean(project.worktreeEligible)
              : true,
    note: id === 'verification'
      ? (validationCommands.length ? validationCommands.join(' | ') : 'No mechanical verification command detected for this project.')
      : id === 'git-apply'
        ? (project.worktreeEligible ? 'Clean git worktree available.' : 'Shared workspace fallback only.')
        : ''
  }));
}

function selectedProviderReadinessFromRun(run) {
  const environment = run.preflight?.environment || {};
  const profile = run.preflight?.providerProfile || {};
  return {
    coordinationProvider: String(profile.coordinationProvider || '').trim() || 'codex',
    workerProvider: String(profile.workerProvider || '').trim() || 'codex',
    selectedProviders: [...new Set([profile.coordinationProvider || 'codex', profile.workerProvider || 'codex'])].map((provider) => ({
      provider,
      ready: Boolean(environment[provider]?.ok),
      version: String(environment[provider]?.version || '').trim(),
      error: String(environment[provider]?.error || '').trim()
    }))
  };
}

async function scenarioClarifyApprovalSuccess(projectPath) {
  const { runId } = await runApprovedScenario('drill-clarify-success', 'clarify-needed-success', projectPath, { maxTaskAttempts: 1 });
  const completed = await waitForRun(runId, (value) => value.status === 'completed');
  assert.equal(completed.tasks[0]?.status, 'done');
  return {
    name: 'clarify-approval-success',
    runId,
    status: completed.status,
    taskStatus: completed.tasks[0]?.status || '',
    providerReadiness: providerReadinessFromRun(completed)
  };
}

async function scenarioRetry(projectPath) {
  const { runId } = await runApprovedScenario('drill-retry-flow', 'retry-flow', projectPath, { maxTaskAttempts: 1 });
  const failed = await waitForRun(runId, (value) => value.tasks[0]?.status === 'failed' && ['failed', 'partial_complete'].includes(value.status));
  assert.equal(failed.tasks[0]?.status, 'failed');
  await retryTask(runId, failed.tasks[0].id);
  await restartRun(runId);
  const completed = await waitForRun(runId, (value) => value.status === 'completed');
  assert.equal(completed.tasks[0]?.status, 'done');
  return {
    name: 'retry-flow',
    runId,
    status: completed.status,
    taskStatus: completed.tasks[0]?.status || ''
  };
}

async function scenarioRequeue(projectPath) {
  const { runId } = await runApprovedScenario('drill-requeue-flow', 'requeue-flow', projectPath, { maxTaskAttempts: 1 });
  const failed = await waitForRun(runId, (value) => value.tasks[0]?.status === 'failed' && ['failed', 'partial_complete'].includes(value.status));
  assert.equal(failed.tasks[0]?.status, 'failed');
  await requeueFailedTasks(runId);
  await restartRun(runId);
  const completed = await waitForRun(runId, (value) => value.status === 'completed');
  assert.equal(completed.tasks[0]?.status, 'done');
  return {
    name: 'requeue-flow',
    runId,
    status: completed.status,
    taskStatus: completed.tasks[0]?.status || ''
  };
}

async function scenarioSkip(projectPath) {
  const { runId } = await runApprovedScenario('drill-skip-flow', 'skip-flow', projectPath, { maxTaskAttempts: 1 });
  const failed = await waitForRun(runId, (value) => value.tasks[0]?.status === 'failed' && ['failed', 'partial_complete'].includes(value.status));
  assert.equal(failed.tasks[0]?.status, 'failed');
  await skipTask(runId, failed.tasks[0].id, 'Drill decided to skip the blocked task.');
  await restartRun(runId);
  const completed = await waitForRun(runId, (value) => value.status === 'completed');
  assert.equal(completed.tasks[0]?.status, 'skipped');
  return {
    name: 'skip-flow',
    runId,
    status: completed.status,
    taskStatus: completed.tasks[0]?.status || ''
  };
}

async function scenarioStopResume(projectPath) {
  const { runId } = await runApprovedScenario('drill-stop-resume-flow', 'stop-resume-flow', projectPath, { maxTaskAttempts: 2 });
  const current = await waitForRun(runId, (value) =>
    value.status === 'completed'
    || value.tasks.some((task) => task.status === 'in_progress')
  );
  if (current.status === 'completed') {
    assert.equal(current.tasks[0]?.status, 'done');
    return {
      name: 'stop-resume-flow',
      runId,
      status: current.status,
      taskStatus: current.tasks[0]?.status || ''
    };
  }
  await stopRun(runId);
  const stopped = await waitForRun(runId, (value) => value.status === 'stopped');
  assert.ok(['ready', 'failed', 'in_progress', 'done'].includes(stopped.tasks[0]?.status || ''));
  await restartRun(runId);
  const completed = await waitForRun(runId, (value) => value.status === 'completed');
  assert.equal(completed.tasks[0]?.status, 'done');
  return {
    name: 'stop-resume-flow',
    runId,
    status: completed.status,
    taskStatus: completed.tasks[0]?.status || ''
  };
}

async function scenarioProviderProfileRecovery(projectPath) {
  const previousSettings = await getHarnessSettings();
  await updateHarnessSettings({
    ...previousSettings,
    coordinationProvider: 'codex',
    workerProvider: 'gemini',
    geminiProjectId: previousSettings.geminiProjectId || 'fake-gemini-project'
  });
  try {
    const run = await createRun({
      title: 'drill-provider-profile-recovery',
      projectPath,
      objective: 'stop-resume-flow',
      specText: '',
      specFiles: '',
      providerProfile: {
        coordinationProvider: 'codex',
        workerProvider: 'gemini'
      },
      settings: {
        maxParallel: 1,
        maxTaskAttempts: 2,
        maxGoalLoops: 1,
        geminiProjectId: previousSettings.geminiProjectId || 'fake-gemini-project'
      }
    });
    await startRun(run.id);
    let current = await waitForRun(run.id, (value) => value.status === 'needs_input' || value.status === 'needs_approval');
    if (current.status === 'needs_input') {
      await submitClarifyAnswers(run.id, { scope_q: 'README만 수정하면 된다.' });
      await waitForRunToSettle(run.id);
      current = await restartRun(run.id);
      current = await waitForRun(run.id, (value) => value.status === 'needs_approval');
    }
    await updatePlanDraft(run.id, {
      agents: (Array.isArray(current.agents) ? current.agents : []).map((agent) =>
        String(agent?.name || '').trim() === 'implementer'
          ? { ...agent, model: 'gemini' }
          : agent
      )
    });
    await approvePlan(run.id);
    await restartRun(run.id);
    const runId = run.id;
    await waitForRun(runId, (value) =>
      value.status === 'stopped' || value.tasks.some((task) => task.status === 'in_progress')
    );
    await stopRun(runId);
    const stopped = await waitForRun(runId, (value) => value.status === 'stopped');
    assert.ok(['ready', 'failed', 'in_progress', 'done'].includes(stopped.tasks[0]?.status || ''));
    await restartRun(runId);
    const completed = await waitForRun(runId, (value) => value.status === 'completed');
    const providerProfile = selectedProviderReadinessFromRun(completed);
    assert.equal(providerProfile.coordinationProvider, 'codex');
    assert.equal(providerProfile.workerProvider, 'gemini');
    assert.ok(providerProfile.selectedProviders.every((item) => item.ready === true));
    return {
      name: 'provider-profile-recovery',
      runId,
      status: completed.status,
      taskStatus: completed.tasks[0]?.status || '',
      providerProfile
    };
  } finally {
    await updateHarnessSettings(previousSettings);
  }
}

async function scenarioAutomaticReplan(projectPath) {
  const { runId } = await runApprovedScenario('drill-replan-flow', 'replan-flow', projectPath, {
    maxTaskAttempts: 1,
    maxGoalLoops: 2
  });
  const completed = await waitForRun(runId, (value) =>
    ['completed', 'partial_complete'].includes(String(value?.status || ''))
    && value.autoReplan?.latest?.applied === true
    && (value.autoReplan?.latest?.changedTaskIds || []).length >= 1
    && (value.autoReplan?.latest?.newTaskIds || []).length >= 1
  , 30000);
  const changedTaskIds = new Set(completed.autoReplan?.latest?.changedTaskIds || []);
  const newTaskIds = new Set(completed.autoReplan?.latest?.newTaskIds || []);
  assert.equal(completed.autoReplan?.latest?.applied, true);
  assert.ok(newTaskIds.size >= 1);
  assert.ok(changedTaskIds.size >= 1);
  assert.ok((completed.tasks || []).some((task) =>
    changedTaskIds.has(task.id) || task.title === 'Finalize README after replanning'
  ));
  assert.ok((completed.tasks || []).some((task) =>
    newTaskIds.has(task.id) || task.title === 'Record verification note after replanning'
  ));
  return {
    name: 'replan-flow',
    runId,
    status: completed.status,
    taskCount: completed.tasks.length,
    autoReplanApplied: Boolean(completed.autoReplan?.latest?.applied),
    changedTaskIds: completed.autoReplan?.latest?.changedTaskIds || [],
    newTaskIds: completed.autoReplan?.latest?.newTaskIds || []
  };
}

export async function runLiveReadyDrill() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-live-ready-'));
  const fakeBin = await installFakeProviders(path.join(tempRoot, 'fake-bin'));
  const env = withPrependedPath(fakeBin.binDir);
  const createdRuns = [];
  env.apply(fakeBin.stateFile);

  try {
    const diagnostics = await diagnoseSetup({ projectPath: root, specFiles: '' });

    const successProject = await createDrillProject(tempRoot, 'clarify-needed-success');
    const retryProject = await createDrillProject(tempRoot, 'retry-flow');
    const requeueProject = await createDrillProject(tempRoot, 'requeue-flow');
    const skipProject = await createDrillProject(tempRoot, 'skip-flow');
    const stopProject = await createDrillProject(tempRoot, 'stop-resume-flow');
    const providerRecoveryProject = await createDrillProject(tempRoot, 'stop-resume-flow-provider');
    const replanProject = await createDrillProject(tempRoot, 'replan-flow');

    const scenarios = [];
    const success = await scenarioClarifyApprovalSuccess(successProject);
    createdRuns.push(success.runId);
    scenarios.push(success);

    const retry = await scenarioRetry(retryProject);
    createdRuns.push(retry.runId);
    scenarios.push(retry);

    const requeue = await scenarioRequeue(requeueProject);
    createdRuns.push(requeue.runId);
    scenarios.push(requeue);

    const skip = await scenarioSkip(skipProject);
    createdRuns.push(skip.runId);
    scenarios.push(skip);

    const stopResume = await scenarioStopResume(stopProject);
    createdRuns.push(stopResume.runId);
    scenarios.push(stopResume);

    const providerRecovery = await scenarioProviderProfileRecovery(providerRecoveryProject);
    createdRuns.push(providerRecovery.runId);
    scenarios.push(providerRecovery);

    const replan = await scenarioAutomaticReplan(replanProject);
    createdRuns.push(replan.runId);
    scenarios.push(replan);

    return {
      ok: true,
      scenarioCount: scenarios.length,
      diagnostics,
      scenarios
    };
  } finally {
    env.restore();
    for (const runId of createdRuns) {
      await deleteRun(runId).catch(() => {});
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runCorruptionDrill() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-corruption-drill-'));
  const fakeBin = await installFakeProviders(path.join(tempRoot, 'fake-bin'));
  const env = withPrependedPath(fakeBin.binDir);
  let runId = '';
  let server = null;
  env.apply(fakeBin.stateFile);

  try {
    const projectPath = await createDrillProject(tempRoot, 'corruption-flow');
    const success = await scenarioClarifyApprovalSuccess(projectPath);
    runId = success.runId;
    const completed = await waitForRunToSettle(runId);
    const taskId = completed.tasks[0]?.id || 'T001';
    const runRoot = path.join(root, 'runs', runId);
    const taskRoot = path.join(runRoot, 'tasks', taskId);
    const runActionsFile = path.join(runRoot, 'run-actions.jsonl');
    const taskActionsFile = path.join(taskRoot, 'actions.jsonl');
    const codeContextFile = path.join(runRoot, 'context', 'code-context', `${taskId}.json`);
    const statePath = path.join(runRoot, 'state.json');

    await fs.appendFile(runActionsFile, '{"broken":\n', 'utf8');
    await fs.appendFile(taskActionsFile, '{"broken":\n', 'utf8');
    await fs.rm(codeContextFile, { force: true }).catch(() => {});

    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'running';
    state.tasks[0].status = 'in_progress';
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    await initHarness();
    const recovered = await waitForRunToSettle(runId, 200);
    assert.equal(recovered.status, 'stopped');
    assert.equal(recovered.tasks[0]?.status, 'ready');
    assert.ok((recovered.tasks[0]?.findings || []).some((item) => String(item).includes('Recovered after harness restart.')));

    const port = 3800 + Math.floor(Math.random() * 200);
    server = await startHarnessServer(port);
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`)).json();
    const artifacts = await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/tasks/${taskId}/artifacts`)).json();

    assert.equal(detail.status, 'stopped');
    assert.ok(Array.isArray(artifacts.actionRecords));
    assert.equal(artifacts.codeContext, null);
    assert.ok(detail.recoveryGuide?.manualRunbookPath);

    return {
      ok: true,
      runId,
      taskId,
      detailStatus: detail.status,
      recoveredTaskStatus: recovered.tasks[0]?.status || '',
      actionRecordCount: artifacts.actionRecords.length,
      codeContextMissing: artifacts.codeContext === null
    };
  } finally {
    env.restore();
    if (server) {
      await server.stop().catch(() => {});
    }
    if (runId) {
      await deleteRun(runId).catch(() => {});
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = process.argv.includes('corruption')
    ? await runCorruptionDrill()
    : await runLiveReadyDrill();
  process.stdout.write(JSON.stringify(report, null, 2) + '\\n');
}
