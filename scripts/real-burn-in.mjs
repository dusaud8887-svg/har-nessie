import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approvePlan,
  createProject,
  createRun,
  getProjectOverview,
  getRun,
  initHarness,
  retryTask,
  submitClarifyAnswers,
  runProjectQualitySweep,
  startRun,
  stopRun,
  updatePlanDraft
} from '../app/orchestrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(root, 'docs', 'research');
const burnInMode = process.argv.includes('--full') ? 'full' : 'fast';
const timing = burnInMode === 'full'
  ? { activityMs: 180000, terminalMs: 240000, stopMs: 90000, recoveryMs: 15000, scenarioMs: 420000, totalMs: 3600000 }
  : { activityMs: 45000, terminalMs: 75000, stopMs: 45000, recoveryMs: 8000, scenarioMs: 240000, totalMs: 18 * 60 * 1000 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProcess(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function initGitRepo(projectDir, initialFiles) {
  await fs.mkdir(projectDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(initialFiles)) {
    const filePath = path.join(projectDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
  const gitEnv = {
    GIT_AUTHOR_NAME: 'Codex',
    GIT_AUTHOR_EMAIL: 'codex@example.com',
    GIT_COMMITTER_NAME: 'Codex',
    GIT_COMMITTER_EMAIL: 'codex@example.com'
  };
  await runProcess('git', ['init'], projectDir, gitEnv);
  await runProcess('git', ['add', '.'], projectDir, gitEnv);
  await runProcess('git', ['commit', '-m', 'initial'], projectDir, gitEnv);
}

async function waitForRun(runId, predicate, timeoutMs = 180000, intervalMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await getRun(runId);
    if (predicate(run)) return run;
    await sleep(intervalMs);
  }
  const latest = await getRun(runId).catch(() => null);
  throw new Error(`Timed out waiting for run ${runId}. Latest status: ${latest?.status || 'unknown'} | result=${latest?.result?.summary || ''} | taskStatuses=${(latest?.tasks || []).map((task) => `${task.id}:${task.status}`).join(', ')}`);
}

async function waitForTerminalOutcome(runId, expectedStatus = '', timeoutMs = 180000, settleMs = 30000, intervalMs = 500) {
  const normalizedExpected = String(expectedStatus || '').trim();
  const predicate = (run) => terminal(run) && (!normalizedExpected || run.status === normalizedExpected);
  try {
    return await waitForRun(runId, predicate, timeoutMs, intervalMs);
  } catch (error) {
    const settleStartedAt = Date.now();
    let latest = await getRun(runId).catch(() => null);
    while (Date.now() - settleStartedAt < settleMs) {
      if (latest && terminal(latest)) {
        return latest;
      }
      await sleep(intervalMs);
      latest = await getRun(runId).catch(() => latest);
    }
    if (latest && terminal(latest)) {
      return latest;
    }
    throw error;
  }
}

async function runWithBudget(label, fn, budgetMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(budgetMs / 1000)}s budget.`)), budgetMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminal(run) {
  return ['completed', 'failed', 'stopped', 'partial_complete'].includes(String(run?.status || ''));
}

function buildClarifyAnswers(run, scenario = {}) {
  const questions = Array.isArray(run?.humanLoop?.clarifyPending)
    ? run.humanLoop.clarifyPending
    : Array.isArray(run?.humanLoop?.clarifyQuestions)
      ? run.humanLoop.clarifyQuestions
      : [];
  const answers = {};
  for (const item of questions) {
    const id = String(item?.id || '').trim();
    const question = String(item?.question || '').trim();
    const key = `${id} ${question}`.toLowerCase();
    if (key.includes('retry') && key.includes('path')) {
      answers[id] = scenario.retryTarget || '하네스 실행 흐름의 retry 경로를 검증한다. 애플리케이션 비즈니스 retry는 아니다.';
      continue;
    }
    if (key.includes('marker') || key.includes('format')) {
      answers[id] = scenario.markerFormat || 'README 본문에 명시적인 한 줄 marker를 추가하면 된다.';
      continue;
    }
    if (key.includes('scope') || key.includes('range') || key.includes('file')) {
      answers[id] = scenario.scope || '지정된 파일만 수정한다.';
      continue;
    }
    if (key.includes('verify') || key.includes('verification')) {
      answers[id] = scenario.verification || 'acceptanceChecks에 적은 기계적 검증 기준을 따른다.';
      continue;
    }
    answers[id] = scenario.fallback || '현재 objective와 task draft를 그대로 따른다.';
  }
  return answers;
}

async function ensureClarified(runId, scenario = {}) {
  let run = await getRun(runId);
  const pending = Array.isArray(run?.humanLoop?.clarifyPending) ? run.humanLoop.clarifyPending : [];
  if (!pending.length) return run;
  const answers = buildClarifyAnswers(run, scenario);
  if (!Object.keys(answers).length) return run;
  await submitClarifyAnswers(runId, answers);
  return waitForRun(runId, (value) => value.status === 'draft', 30000, 250);
}

async function launchRunWithClarify(runId, scenario = {}) {
  let current = await startRun(runId);
  for (;;) {
    current = await waitForRun(
      runId,
      (value) =>
        value.status === 'needs_input'
        || value.status === 'needs_approval'
        || terminal(value)
        || (value.status === 'running' && (value.tasks || []).some((task) => task.status !== 'ready')),
      timing.activityMs,
      500
    );
    if (current.status === 'needs_input') {
      await ensureClarified(runId, scenario);
      current = await startRun(runId);
      continue;
    }
    if (current.status === 'needs_approval') {
      await approvePlan(runId);
      current = await startRun(runId);
      continue;
    }
    return current;
  }
}

function summarizeRun(run, expectedStatus, objective) {
  return {
    objective,
    profile: run?.preset?.id || 'auto',
    actualTerminalStatus: run?.status || '',
    operatorExpectedStatus: expectedStatus,
    mismatch: String(run?.status || '') !== String(expectedStatus || ''),
    recoveryNeeded: ['failed', 'stopped', 'partial_complete'].includes(String(run?.status || '')),
    nextAction: run?.result?.summary || run?.planSummary || (run?.tasks || []).find((task) => task.status !== 'done' && task.status !== 'skipped')?.title || '',
    taskStatuses: (run?.tasks || []).map((task) => `${task.id}:${task.status}`)
  };
}

async function runScenarioA(tempRoot) {
  const repoDir = path.join(tempRoot, 'run-a-feature');
  await initGitRepo(repoDir, {
    'README.md': '# Run A\n\nBase line.\n',
    'package.json': JSON.stringify({ name: 'run-a', private: true, type: 'module' }, null, 2) + '\n'
  });
  const run = await createRun({
    title: 'burn-in-run-a',
    projectPath: repoDir,
    presetId: 'existing-repo-feature',
    objective: 'README에 feature marker를 추가하고 retry path를 검증한다.',
    specText: '',
    specFiles: '',
    settings: {
      requirePlanApproval: false,
      maxParallel: 1,
      maxTaskAttempts: 1,
      maxGoalLoops: 1,
      codexReasoningEffort: 'low',
      codexServiceTier: 'fast'
    }
  });
  await updatePlanDraft(run.id, {
    summary: 'Run A manual burn-in plan',
    executionModel: 'single-agent execution with forced retry',
    tasks: [{
      id: 'T001',
      title: 'README feature marker 추가',
      goal: 'README에 FEATURE_RUN_A marker를 추가한다.',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: ['README.md만 수정한다.'],
      acceptanceChecks: ['README contains FEATURE_RUN_A', 'Preview page renders FEATURE_RUN_A']
      }]
  });
  await launchRunWithClarify(run.id, {
    retryTarget: '하네스 실행 흐름의 retry 경로를 검증한다. 앱 비즈니스 retry는 아니다.',
    markerFormat: 'README에 FEATURE_RUN_A 라는 literal marker를 한 줄로 추가하면 된다.',
    scope: 'README.md만 수정한다.'
  });
  const firstTerminal = await waitForTerminalOutcome(run.id, '', timing.terminalMs);
  const firstSummary = summarizeRun(firstTerminal, 'failed', 'Run A first pass should fail on browser verification');

  await retryTask(run.id, 'T001');
  await updatePlanDraft(run.id, {
    summary: 'Run A retry after browser unverifiable path',
    tasks: [{
      id: 'T001',
      title: 'README feature marker 추가',
      goal: 'README에 FEATURE_RUN_A marker를 추가한다.',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: ['README.md만 수정한다.'],
      acceptanceChecks: ['README contains FEATURE_RUN_A']
      }]
  });
  await launchRunWithClarify(run.id, {
    retryTarget: '같은 하네스 retry 흐름을 이어서 검증한다.',
    markerFormat: 'README에 FEATURE_RUN_A literal marker를 유지한다.',
    scope: 'README.md만 수정한다.'
  });
  const finalRun = await waitForTerminalOutcome(run.id, 'completed', timing.terminalMs);
  return {
    name: 'Run A',
    repoDir,
    runId: run.id,
    firstPass: firstSummary,
    finalPass: summarizeRun(finalRun, 'completed', 'Run A should complete after retry'),
    resultSummary: finalRun.result?.summary || ''
  };
}

async function runScenarioB(tempRoot) {
  const repoDir = path.join(tempRoot, 'run-b-bugfix');
  await initGitRepo(repoDir, {
    'README.md': '# Run B\n\nBUG: old text.\n',
    'src/value.js': "export const value = 'old-bug';\n",
    'package.json': JSON.stringify({ name: 'run-b', private: true, type: 'module' }, null, 2) + '\n'
  });
  const run = await createRun({
    title: 'burn-in-run-b',
    projectPath: repoDir,
    presetId: 'existing-repo-bugfix',
    objective: 'stop/resume를 포함해 간단한 bugfix를 완료한다.',
    specText: '',
    specFiles: '',
    settings: {
      requirePlanApproval: false,
      maxParallel: 1,
      maxTaskAttempts: 1,
      maxGoalLoops: 1,
      codexReasoningEffort: 'low',
      codexServiceTier: 'fast'
    }
  });
  await updatePlanDraft(run.id, {
    summary: 'Run B manual bugfix plan',
    executionModel: 'single-agent with manual stop/resume',
    tasks: [{
      id: 'T001',
      title: 'bug marker 수정',
      goal: 'src/value.js와 README의 old-bug를 fixed-bug로 바꾼다.',
      dependsOn: [],
      filesLikely: ['README.md', 'src/value.js'],
      constraints: ['README.md와 src/value.js만 수정한다.'],
      acceptanceChecks: ['README contains fixed-bug']
      }]
  });
  await launchRunWithClarify(run.id, {
    scope: 'README.md와 src/value.js만 수정한다.',
    fallback: 'stop/resume를 검증하는 bugfix burn-in이다. current objective를 그대로 따른다.'
  });
  await sleep(250);
  let stoppedSummary = null;
  const midRun = await getRun(run.id);
  if (!terminal(midRun)) {
    await stopRun(run.id);
    const stopped = await waitForRun(run.id, (value) => value.status === 'stopped', timing.stopMs, 250);
    stoppedSummary = summarizeRun(stopped, 'stopped', 'Run B should stop cleanly before resume');
    await sleep(1200);
    await launchRunWithClarify(run.id, {
      scope: 'README.md와 src/value.js만 수정한다.',
      fallback: 'resume 이후에도 같은 bugfix objective를 그대로 따른다.'
    });
  }
  const finalRun = await waitForTerminalOutcome(run.id, 'completed', timing.terminalMs);
  return {
    name: 'Run B',
    repoDir,
    runId: run.id,
    stopPass: stoppedSummary,
    finalPass: summarizeRun(finalRun, 'completed', 'Run B should complete after resume'),
    resultSummary: finalRun.result?.summary || ''
  };
}

async function runScenarioC(tempRoot) {
  const repoDir = path.join(tempRoot, 'run-c-project');
  await initGitRepo(repoDir, {
    'README.md': '# Run C\n\nStart.\n',
    'package.json': JSON.stringify({ name: 'run-c', private: true, type: 'module' }, null, 2) + '\n'
  });
  const project = await createProject({
    title: 'burn-in-project-c',
    rootPath: repoDir,
    bootstrapRepoDocs: true,
    phases: [{ id: 'P001', title: 'Foundation', goal: 'Carry-over and quality loop validation', status: 'active' }]
  });
  const run = await createRun({
    title: 'burn-in-run-c',
    projectId: project.id,
    phaseId: 'P001',
    presetId: 'greenfield-app',
    objective: 'carry-over backlog와 quality sweep를 실제 provider run으로 확인한다.',
    specText: '',
    specFiles: '',
    settings: {
      requirePlanApproval: false,
      maxParallel: 1,
      maxTaskAttempts: 1,
      maxGoalLoops: 1,
      codexReasoningEffort: 'low',
      codexServiceTier: 'fast'
    }
  });
  await updatePlanDraft(run.id, {
    summary: 'Run C greenfield maintenance plan',
    executionModel: 'single-agent with carry-over and quality sweep',
    tasks: [{
      id: 'T001',
      title: 'foundation marker 추가',
      goal: 'README에 GREENFIELD_RUN_C_1 marker를 추가한다.',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: ['README.md만 수정한다.'],
      acceptanceChecks: ['README contains GREENFIELD_RUN_C_1']
    }]
  });
  await launchRunWithClarify(run.id, {
    markerFormat: 'README에 GREENFIELD_RUN_C_1 literal marker를 추가한다.',
    scope: 'README.md만 수정한다.',
    verification: 'README marker 확인만 수행한다.'
  });
  const activeRun = await getRun(run.id);
  let terminalRun = activeRun;
  if (!terminal(activeRun)) {
    await stopRun(run.id);
    terminalRun = await waitForRun(run.id, (value) => value.status === 'stopped', timing.stopMs, 250);
  }
  const sweep = await runProjectQualitySweep(project.id, { phaseId: 'P001' });
  const overview = await getProjectOverview(project.id);
  const foundation = overview.phases.find((phase) => phase.id === 'P001') || null;
  return {
    name: 'Run C',
    repoDir,
    projectId: project.id,
    runId: run.id,
    finalPass: summarizeRun(terminalRun, 'stopped', 'Run C should leave carry-over after a controlled stop and quality sweep'),
    qualitySweep: {
      grade: sweep.sweep.grade,
      findingCount: sweep.sweep.findings.length,
      cleanupTaskCount: sweep.cleanupTasks.length
    },
    carryOverCount: foundation?.carryOverTasks?.length || 0,
    cleanupLaneCount: foundation?.cleanupLane?.length || 0
  };
}

async function runRecoveryCheck(runId) {
  const runRoot = path.join(root, 'runs', runId);
  const statePath = path.join(runRoot, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const targetTask = Array.isArray(state.tasks) ? state.tasks.find((item) => item.status === 'done') || state.tasks[0] : null;
  if (!targetTask) {
    return {
      ok: false,
      note: 'No task was available for provider-connected recovery validation.'
    };
  }
  state.status = 'running';
  targetTask.status = 'in_progress';
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  await initHarness();
  const recovered = await waitForRun(runId, (value) => value.status === 'stopped', timing.recoveryMs, 250);
  const recoveredTask = (recovered.tasks || []).find((item) => item.id === targetTask.id) || recovered.tasks?.[0] || null;
  return {
    ok: recovered.status === 'stopped' && recoveredTask?.status === 'ready',
    recoveredStatus: recovered.status,
    recoveredTaskId: recoveredTask?.id || '',
    recoveredTaskStatus: recoveredTask?.status || '',
    note: recoveredTask?.reviewSummary || ''
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-real-burn-in-'));
  const startedAt = new Date().toISOString();
  const runs = [];
  try {
    const burnInStartedAt = Date.now();
    const remainingBudget = () => Math.max(1000, timing.totalMs - (Date.now() - burnInStartedAt));
    const runScenario = async (name, fn) => {
      const budgetMs = Math.min(timing.scenarioMs, remainingBudget());
      if (budgetMs <= 1000) {
        return {
          name,
          skipped: true,
          error: 'Global fast burn-in budget exhausted before scenario start.'
        };
      }
      try {
        return await runWithBudget(name, () => fn(tempRoot), budgetMs);
      } catch (error) {
        return {
          name,
          failed: true,
          error: String(error?.message || error || 'Unknown burn-in failure')
        };
      }
    };

    runs.push(await runScenario('Run A', runScenarioA));
    runs.push(await runScenario('Run B', runScenarioB));
    runs.push(await runScenario('Run C', runScenarioC));

    let recovery = { ok: false, skipped: true, note: 'No eligible completed run for recovery check.' };
    const recoveryTarget = runs.find((item) => item?.runId)?.runId || '';
    if (recoveryTarget && remainingBudget() > 1000) {
      try {
        recovery = await runWithBudget('Recovery', () => runRecoveryCheck(recoveryTarget), Math.min(60000, remainingBudget()));
      } catch (error) {
        recovery = {
          ok: false,
          failed: true,
          note: String(error?.message || error || 'Recovery check failed.')
        };
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      tempRoot,
      mode: burnInMode,
      durationMs: Date.now() - burnInStartedAt,
      runs,
      recovery
    };

    const lines = [
      '# Real Burn-In Report',
      '',
      `- Date: ${startedAt}`,
      `- Mode: ${burnInMode}`,
      `- Temp root: ${tempRoot}`,
      '',
      '## Matrix',
      ''
    ];
    for (const run of runs) {
      lines.push(`### ${run.name}`, '');
      if (run.error) {
        lines.push(`- Error: ${run.error}`);
        lines.push(`- Skipped: ${Boolean(run.skipped)}`);
        lines.push(`- Failed: ${Boolean(run.failed)}`);
        lines.push('');
        continue;
      }
      lines.push(`- Repo: ${run.repoDir}`);
      lines.push(`- Run ID: ${run.runId}`);
      if (run.firstPass) lines.push(`- First pass: ${run.firstPass.actualTerminalStatus} | expected ${run.firstPass.operatorExpectedStatus} | mismatch=${run.firstPass.mismatch}`);
      if (run.stopPass) lines.push(`- Stop pass: ${run.stopPass.actualTerminalStatus} | expected ${run.stopPass.operatorExpectedStatus} | mismatch=${run.stopPass.mismatch}`);
      if (run.finalPass) lines.push(`- Final pass: ${run.finalPass.actualTerminalStatus} | expected ${run.finalPass.operatorExpectedStatus} | mismatch=${run.finalPass.mismatch}`);
      if (run.qualitySweep) lines.push(`- Quality sweep: grade=${run.qualitySweep.grade} findings=${run.qualitySweep.findingCount} cleanup=${run.qualitySweep.cleanupTaskCount}`);
      if (run.carryOverCount !== undefined) lines.push(`- Carry-over: ${run.carryOverCount}`);
      if (run.cleanupLaneCount !== undefined) lines.push(`- Cleanup lane: ${run.cleanupLaneCount}`);
      if (run.resultSummary) lines.push(`- Result summary: ${run.resultSummary}`);
      lines.push('');
    }
    lines.push('## Recovery', '');
    lines.push(`- ok: ${Boolean(recovery?.ok)}`);
    lines.push(`- recovered status: ${recovery?.recoveredStatus || '-'}`);
    lines.push(`- recovered task: ${(recovery?.recoveredTaskId || '-')}${recovery?.recoveredTaskStatus ? `:${recovery.recoveredTaskStatus}` : ''}`);
    lines.push(`- note: ${recovery?.note || '-'}`, '');

    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, '2026-04-real-burn-in-report.md'), `${lines.join('\n')}\n`, 'utf8');
    await fs.writeFile(path.join(reportDir, '2026-04-real-burn-in-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
