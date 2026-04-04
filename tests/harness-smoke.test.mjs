import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeProjectIntake,
  applyPlanPolicy,
  buildActionReplayEnvelope,
  buildCodexExecArgs,
  buildContinuationPromptLines,
  createProject,
  createRun,
  decideReviewRoute,
  deleteProject,
  deleteRun,
  diagnoseSetup,
  evaluateFreshSessionState,
  getProject,
  getProjectOverview,
  getRun,
  getHarnessSettings,
  listProjects,
  parseJsonReply,
  requeueFailedTasks,
  runBrowserVerification,
  runProjectQualitySweep,
  retryTask,
  skipTask,
  stopRun,
  updateProject,
  updateHarnessSettings,
  updatePlanDraft
} from '../app/orchestrator.mjs';
import { appendArtifactMemory, ensureProjectMemory, searchProjectMemory } from '../app/memory-store.mjs';
import { buildAcceptanceMetadata, buildTaskActionPolicy, buildTaskCodeContext, inferTaskVerificationTypes, normalizeToolProfile } from '../app/task-action-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForServerReady(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) return;
    } catch {
      // Keep polling until the server accepts requests.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for harness server: ${baseUrl}`);
}

async function stopServerProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 1500);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function startHarnessServerForTest() {
  const port = 4300 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'app/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HARNESS_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServerReady(baseUrl);
    return {
      baseUrl,
      child,
      stop: async () => stopServerProcess(child)
    };
  } catch (error) {
    await stopServerProcess(child);
    const output = Buffer.concat([...stdout, ...stderr]).toString('utf8').trim();
    throw new Error(output ? `${error.message}\n${output}` : error.message);
  }
}

test('server serves every boot asset referenced by index.html', async () => {
  const server = await startHarnessServerForTest();
  try {
    const response = await fetch(`${server.baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
      .map((match) => match[1])
      .filter((assetPath) => !assetPath.startsWith('/api/'));

    assert.ok(assetPaths.includes('/app-helpers.js'));

    for (const assetPath of assetPaths) {
      const assetResponse = await fetch(`${server.baseUrl}${assetPath}`);
      assert.equal(assetResponse.status, 200, `${assetPath} should be reachable from the harness server`);
    }
  } finally {
    await server.stop();
  }
});

test('getRun exposes generic metrics and hides legacy codex metric aliases', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'generic-metrics-smoke',
      projectPath: root,
      objective: 'generic metrics smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.metrics.executionRuns = 3;
    state.metrics.reviews = 2;
    state.metrics.codexRuns = 9;
    state.metrics.codexReviews = 8;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const refreshed = await getRun(run.id);
    assert.equal(refreshed.metrics.executionRuns, 3);
    assert.equal(refreshed.metrics.reviews, 2);
    assert.equal(Object.hasOwn(refreshed.metrics, 'codexRuns'), false);
    assert.equal(Object.hasOwn(refreshed.metrics, 'codexReviews'), false);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('artifact API keeps agent fields primary while reading legacy codex artifact files', async () => {
  let runId = '';
  const server = await startHarnessServerForTest();
  try {
    const run = await createRun({
      title: 'artifact-api-generic-smoke',
      projectPath: root,
      objective: 'artifact api generic smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.tasks = [{
      id: 'T001',
      title: 'Legacy artifact task',
      goal: 'Read legacy artifact names through generic API fields',
      dependsOn: [],
      filesLikely: [],
      constraints: [],
      acceptanceChecks: [],
      status: 'done',
      attempts: 1,
      reviewSummary: '',
      findings: [],
      checkpointNotes: [],
      lastExecution: {}
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const taskDir = path.join(root, 'runs', run.id, 'tasks', 'T001');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'codex-prompt.md'), 'legacy prompt body\n', 'utf8');
    await fs.writeFile(path.join(taskDir, 'codex-output.md'), 'legacy output body\n', 'utf8');
    await fs.writeFile(path.join(taskDir, 'codex-review.json'), '{"decision":"approve"}\n', 'utf8');

    const response = await fetch(`${server.baseUrl}/api/runs/${run.id}/tasks/T001/artifacts`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.agentPrompt.trim(), 'legacy prompt body');
    assert.equal(payload.agentOutput.trim(), 'legacy output body');
    assert.match(payload.agentReview, /approve/);
    assert.equal(Object.hasOwn(payload, 'codexPrompt'), false);
    assert.equal(Object.hasOwn(payload, 'codexOutput'), false);
    assert.equal(Object.hasOwn(payload, 'codexReview'), false);
  } finally {
    await server.stop();
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('artifact API exposes extended review taxonomy fields', async () => {
  let runId = '';
  const server = await startHarnessServerForTest();
  try {
    const run = await createRun({
      title: 'artifact-api-review-taxonomy-smoke',
      projectPath: root,
      objective: 'artifact api review taxonomy smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.tasks = [{
      id: 'T001',
      title: 'Review taxonomy task',
      goal: 'Expose structured review findings by category',
      dependsOn: [],
      filesLikely: [],
      constraints: [],
      acceptanceChecks: [],
      status: 'ready',
      attempts: 1,
      reviewSummary: '',
      findings: [],
      checkpointNotes: [],
      lastExecution: {}
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const taskDir = path.join(root, 'runs', run.id, 'tasks', 'T001');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'review-verdict.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T001',
      decision: 'retry',
      route: 'agent-review',
      summary: '구조와 검증 실패를 먼저 정리해야 합니다.',
      findings: ['공통 메모 하나'],
      functionalFindings: ['완료 조건이 실제 동작과 어긋납니다.'],
      structuralFindings: ['상세 패널 상태와 렌더 책임이 한 함수에 섞여 있습니다.'],
      codeFindings: ['실패 경로에서 null guard가 없습니다.'],
      staticVerificationFindings: ['npm run validate가 이 변경을 아직 커버하지 않습니다.'],
      browserUxFindings: ['초기 로딩 실패가 화면에 드러나지 않습니다.'],
      retryDiagnosis: '분류별로 원인을 분리해서 재시도해야 합니다.'
    }, null, 2), 'utf8');

    const response = await fetch(`${server.baseUrl}/api/runs/${run.id}/tasks/T001/artifacts`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(payload.reviewVerdict.functionalFindings, ['완료 조건이 실제 동작과 어긋납니다.']);
    assert.deepEqual(payload.reviewVerdict.structuralFindings, ['상세 패널 상태와 렌더 책임이 한 함수에 섞여 있습니다.']);
    assert.deepEqual(payload.reviewVerdict.codeFindings, ['실패 경로에서 null guard가 없습니다.']);
    assert.deepEqual(payload.reviewVerdict.staticVerificationFindings, ['npm run validate가 이 변경을 아직 커버하지 않습니다.']);
    assert.deepEqual(payload.reviewVerdict.browserUxFindings, ['초기 로딩 실패가 화면에 드러나지 않습니다.']);
  } finally {
    await server.stop();
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('memory search tolerates hyphenated harness terms', async () => {
  const projectKey = `test-memory-${Date.now()}`;
  const memoryDir = path.join(root, 'memory', 'projects', projectKey);
  try {
    await ensureProjectMemory(root, projectKey, { projectPath: root });
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      '# Project Memory\n\nCodex fan-out docs-first regression note\n',
      'utf8'
    );
    const result = await searchProjectMemory(root, projectKey, 'codex fan-out docs-first', 5, { projectPath: root });
    assert.ok(Array.isArray(result.searchResults));
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('memory search skips sqlite reindex when memory docs are unchanged', async () => {
  const projectKey = `test-memory-cache-${Date.now()}`;
  const memoryDir = path.join(root, 'memory', 'projects', projectKey);
  try {
    await ensureProjectMemory(root, projectKey, { projectPath: root });
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      '# Project Memory\n\nStable cache validation note\n',
      'utf8'
    );
    const first = await searchProjectMemory(root, projectKey, 'stable cache validation', 5, { projectPath: root });
    const firstStat = await fs.stat(first.indexFile);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await searchProjectMemory(root, projectKey, 'stable cache validation', 5, { projectPath: root });
    const secondStat = await fs.stat(second.indexFile);
    assert.equal(first.reindexed, true);
    assert.equal(second.reindexed, false);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('quoted project path and UTF-16 spec file are accepted', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-spec-'));
  const specPath = path.join(tempDir, 'spec-utf16.txt');
  const text = '한글 UTF16 명세 테스트';
  const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  let runId = '';

  try {
    await fs.writeFile(specPath, body);
    const diagnostics = await diagnoseSetup({
      projectPath: `"${root}"`,
      specFiles: `"${specPath}"`
    });
    assert.equal(diagnostics.specFiles?.[0]?.readable, true);

    const run = await createRun({
      title: 'quoted-path-smoke',
      projectPath: `"${root}"`,
      objective: 'quoted path + utf16 spec',
      specText: '',
      specFiles: `"${specPath}"`,
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    assert.equal(run.projectPath, root);

    const specBundle = await fs.readFile(path.join(root, 'runs', run.id, 'input', 'spec-bundle.md'), 'utf8');
    assert.match(specBundle, /한글 UTF16 명세 테스트/);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('createRun captures project-local prompt source precedence', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-prompt-source-'));
  let runId = '';
  try {
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '# Project AGENTS\n\nProject-local instruction wins.\n', 'utf8');
    const run = await createRun({
      title: 'project-local-prompt-source-smoke',
      projectPath: tempDir,
      objective: 'capture project local prompt source',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    assert.equal(run.harnessConfig.promptSourceReport.precedence, 'project-local > machine-local > user-global > repo-docs fallback');
    assert.equal(run.harnessConfig.promptSourceReport.activeSources[0]?.scope, 'project-local');
    assert.equal(run.harnessConfig.promptSourceReport.activeSources[0]?.label, 'AGENTS.md');

    const guidance = await fs.readFile(path.join(root, 'runs', run.id, 'context', 'harness-guidance.md'), 'utf8');
    assert.match(guidance, /## Effective Prompt Sources/);
    assert.match(guidance, /\[project-local\] AGENTS\.md/);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('project-backed runs inherit charter, phase, and shared memory identity', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-project-backed-'));
  let runId = '';
  let projectId = '';
  let memoryKey = '';
  try {
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Project Root\n', 'utf8');
      const project = await createProject({
        title: 'write-claw',
        rootPath: tempDir,
        charterText: 'write_claw 프로젝트는 phase별로 나눠 점진적으로 구축한다.',
        bootstrapRepoDocs: true,
        defaultPresetId: 'greenfield-app',
        defaultSettings: {
          maxParallel: 1,
          codexReasoningEffort: 'medium',
          taskBudget: 5,
          fileBudget: 2,
          freshSessionThreshold: '60m'
        },
      phases: [
        { title: 'Foundation', goal: '초기 구조와 헌법을 고정한다.' },
        { title: 'Editor Core', goal: '핵심 작성 플로우를 만든다.' }
      ]
    });
      projectId = project.id;
      memoryKey = project.sharedMemoryKey;
      assert.equal(project.bootstrap.enabled, true);
      assert.ok(project.bootstrap.generated.includes('AGENTS.md'));
      assert.ok(project.bootstrap.generated.includes('ARCHITECTURE.md'));
      assert.ok(project.bootstrap.generated.includes('docs/exec-plans/active/README.md'));
      assert.ok(Array.isArray(project.phases?.[0]?.phaseContract?.deliverables));
      assert.ok(Array.isArray(project.phases?.[0]?.phaseContract?.verification));
      const phaseContract = await fs.readFile(path.join(root, 'projects', project.id, 'phases', project.phases[0].id, 'phase-contract.md'), 'utf8');
      const repoAgents = await fs.readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
      const architecture = await fs.readFile(path.join(tempDir, 'ARCHITECTURE.md'), 'utf8');
      assert.match(repoAgents, /table-of-contents/i);
      assert.match(architecture, /Subsystem Map/);
      assert.match(phaseContract, /# Phase Contract/);
      assert.match(phaseContract, /## Verification/);

      const run = await createRun({
      title: 'foundation-run',
      projectId: project.id,
      phaseId: project.phases[0].id,
      objective: 'Foundation phase만 계획한다.',
      specText: '',
      specFiles: '',
      settings: {
        maxTaskAttempts: 2
      }
    });
    runId = run.id;

    assert.equal(run.project?.id, project.id);
    assert.equal(run.project?.phaseId, project.phases[0].id);
    assert.equal(run.project?.phaseTitle, 'Foundation');
    assert.equal(run.projectPath, tempDir);
      assert.equal(run.memory.projectKey, project.sharedMemoryKey);
      assert.equal(run.settings.maxParallel, 1);
      assert.equal(run.settings.codexReasoningEffort, 'medium');
      assert.equal(run.profile.flowProfile, 'sequential');
      assert.equal(run.profile.taskBudget, 5);
      assert.equal(run.profile.fileBudget, 2);
      assert.equal(run.profile.diagnosisFirst, true);
      assert.equal(run.profile.freshSessionThreshold, '60m');
      assert.equal(run.executionPolicy.parallelMode, 'sequential');

      const specBundle = await fs.readFile(path.join(root, 'runs', run.id, 'input', 'spec-bundle.md'), 'utf8');
      const guidance = await fs.readFile(path.join(root, 'runs', run.id, 'context', 'harness-guidance.md'), 'utf8');
      assert.match(specBundle, /# Project Context/);
      assert.match(specBundle, /# Execution Profile/);
      assert.match(specBundle, /Task budget: 5/);
      assert.match(specBundle, /File budget: 2/);
      assert.match(specBundle, /Project: write-claw/);
      assert.match(specBundle, /Current phase: Foundation/);
      assert.match(specBundle, /## Phase Contract/);
      assert.match(specBundle, /Project Charter/);
      assert.match(guidance, /## Project Container/);
      assert.match(guidance, /## Execution Profile/);
      assert.match(guidance, /Fresh session threshold: 60m/);
      assert.match(guidance, /Foundation/);
      assert.match(guidance, /Phase contract file:/);

    const listed = await listProjects();
    const loaded = await getProject(project.id);
    assert.ok(listed.some((item) => item.id === project.id));
    assert.equal(loaded.currentPhaseId, project.phases[0].id);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('analyzeProjectIntake detects docs and builds a docs-grounded starter run draft', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-project-intake-'));
  try {
    await fs.mkdir(path.join(tempDir, 'docs', 'product-specs'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'docs', 'exec-plans'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'docs', 'product-specs', 'nested'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Write Claw\n\n초기 제품 목표와 사용자 흐름.\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '# AGENTS\n\n프로젝트 문서를 source of truth로 사용한다.\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'docs', 'product-specs', 'editor.md'), '# Editor Spec\n\n핵심 편집기 요구사항.\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'docs', 'product-specs', 'nested', 'requirements.pdf'), '%PDF-1.4 fake requirement pdf', 'utf8');
    await fs.writeFile(path.join(tempDir, 'docs', 'exec-plans', 'phase-1.md'), '# Phase 1 Plan\n\nFoundation backlog.\n', 'utf8');
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'write-claw',
        scripts: {
          test: 'vitest run',
          lint: 'eslint .'
        }
      }, null, 2),
      'utf8'
    );

    const intake = await analyzeProjectIntake({ rootPath: tempDir });

    assert.equal(intake.rootPath, tempDir);
    assert.equal(intake.recommendedProject.defaultPresetId, 'docs-spec-first');
    assert.equal(intake.recommendedProject.phaseTitle, 'Project Intake');
    assert.match(intake.recommendedProject.charterText, /system of record/i);
    assert.equal(intake.starterRunDraft.presetId, 'docs-spec-first');
    assert.match(intake.starterRunDraft.objective, /phase\/task backlog/i);
    assert.ok(Array.isArray(intake.docs.candidates));
    assert.ok(intake.docs.candidates.some((item) => item.relativePath === 'README.md'));
    assert.ok(intake.docs.candidates.some((item) => item.kind === 'plan'));
    assert.ok(intake.docs.candidates.some((item) => item.relativePath.endsWith('requirements.pdf')));
    assert.ok(intake.docs.recommendedSpecFiles.some((item) => item.endsWith(path.join('docs', 'product-specs', 'editor.md'))));
    assert.ok(Array.isArray(intake.docs.recommendedSpecDetails));
      assert.ok(intake.docs.recommendedSpecDetails.some((item) => /(포함했습니다|Included because)/.test(item.selectionReason || '')));
    assert.ok(intake.repo.validationCommands.includes('npm run test'));
    assert.match(intake.repo.summary, /Repository constitution and focused context pack/);
    assert.ok(['safe_auto', 'caution_auto', 'manual_required'].includes(intake.preflight.autonomy?.tier));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('project-backed runs include a continuation pack from recent docs and carry-over context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-continuation-'));
  let projectId = '';
  let firstRunId = '';
  let secondRunId = '';
  try {
    await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Continuation Repo\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'docs', 'spec.md'), '# Spec\n', 'utf8');

    const project = await createProject({
      title: 'continuation-project',
      rootPath: tempDir,
      phases: [{ id: 'P001', title: 'Foundation', goal: 'Keep shipping in slices.', status: 'active' }],
      defaultSettings: {
        continuationPolicy: {
          mode: 'guided',
          autoQualitySweepOnPhaseComplete: false,
          keepDocsInSync: true
        }
      }
    });
    projectId = project.id;

    const firstRun = await createRun({
      title: 'foundation-doc-sync',
      projectId: project.id,
      phaseId: 'P001',
      projectPath: tempDir,
      objective: 'Refresh the spec and leave the next slice ready.',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    firstRunId = firstRun.id;

    const firstRunStatePath = path.join(root, 'runs', firstRun.id, 'state.json');
    const firstRunState = JSON.parse(await fs.readFile(firstRunStatePath, 'utf8'));
    firstRunState.status = 'completed';
    firstRunState.result = {
      summary: 'Updated docs/spec.md and left follow-up backlog for the next run.'
    };
    firstRunState.tasks = [{
      id: 'T001',
      title: 'Update product spec',
      goal: 'Reflect the latest implementation shape in the source-of-record docs.',
      dependsOn: [],
      filesLikely: ['docs/spec.md'],
      constraints: [],
      acceptanceChecks: ['docs/spec.md reflects the latest implementation'],
      status: 'done',
      attempts: 1,
      reviewSummary: 'docs/spec.md was updated and the next implementation slice should continue from it.',
      findings: [],
      checkpointNotes: [],
      lastExecution: {
        changedFiles: ['docs/spec.md'],
        repoChangedFiles: ['docs/spec.md'],
        outOfScopeFiles: [],
        acceptanceCheckResults: [{ check: 'docs/spec.md reflects the latest implementation', status: 'pass', note: 'spec updated' }]
      }
    }, {
      id: 'T002',
      title: 'Continue implementation from updated docs',
      goal: 'Use the refreshed spec as the next slice baseline.',
      dependsOn: [],
      filesLikely: ['src/app.ts'],
      constraints: [],
      acceptanceChecks: ['next run starts from the updated docs'],
      status: 'failed',
      attempts: 1,
      reviewSummary: 'Carry this work into the next run after the docs update.',
      findings: ['Not finished in this run.'],
      checkpointNotes: [],
      lastExecution: {
        changedFiles: [],
        repoChangedFiles: [],
        outOfScopeFiles: []
      }
    }];
    await fs.writeFile(firstRunStatePath, JSON.stringify(firstRunState, null, 2), 'utf8');

    const secondRun = await createRun({
      title: 'foundation-next-slice',
      projectId: project.id,
      phaseId: 'P001',
      projectPath: tempDir,
      objective: 'Continue the next slice from the updated docs.',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    secondRunId = secondRun.id;

    const specBundle = await fs.readFile(path.join(root, 'runs', secondRun.id, 'input', 'spec-bundle.md'), 'utf8');
    const projectSummary = await fs.readFile(path.join(root, 'runs', secondRun.id, 'context', 'project-summary.md'), 'utf8');

    assert.match(specBundle, /## Continuation Pack/);
    assert.match(specBundle, /Auto-prepare suggested draft/);
    assert.match(specBundle, /docs\/spec\.md/);
    assert.match(specBundle, /foundation-doc-sync/);
    assert.match(specBundle, /source-of-record docs or specs/);

    assert.match(projectSummary, /## Active continuation pack/);
    assert.match(projectSummary, /Carry-over focus/);
    assert.match(projectSummary, /Recent doc updates/);
    assert.match(projectSummary, /docs\/spec\.md/);
  } finally {
    if (secondRunId) await deleteRun(secondRunId).catch(() => {});
    if (firstRunId) await deleteRun(firstRunId).catch(() => {});
    if (projectId) await deleteProject(projectId, { deleteRuns: true, deleteMemory: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('manual quality sweep writes a maintenance artifact and memory summary', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-quality-sweep-'));
  let runId = '';
  let projectId = '';
  let memoryKey = '';
  try {
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Repo Root\n', 'utf8');
    const project = await createProject({
      title: 'quality-sweep-project',
      rootPath: tempDir,
      sharedMemoryKey: `quality-sweep-${Date.now()}`,
      phases: [{ id: 'P001', title: 'Foundation', goal: 'Stabilize the repo', status: 'active' }]
    });
    projectId = project.id;
    memoryKey = project.sharedMemoryKey;

    const run = await createRun({
      title: 'quality-sweep-source-run',
      projectId: project.id,
      phaseId: 'P001',
      projectPath: tempDir,
      objective: 'Create a maintenance signal for the quality sweep.',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const stateFile = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.status = 'failed';
    state.tasks = [
      {
        id: 'T001',
        title: 'Fix lint debt',
        goal: 'Repair the static analysis failures',
        dependsOn: [],
        filesLikely: ['src/app.ts'],
        constraints: [],
        acceptanceChecks: ['npm run lint passes'],
        status: 'failed',
        attempts: 1,
        reviewSummary: 'lint still fails',
        findings: ['ESLint failure remains'],
        checkpointNotes: [],
        lastExecution: {
          workspaceMode: 'git-worktree',
          changedFiles: ['src/app.ts'],
          repoChangedFiles: ['src/app.ts'],
          outOfScopeFiles: ['src/stray.ts'],
          scopeEnforcement: 'strict',
          applyResult: 'Patch was not applied because automatic verification failed.',
          lastExitCode: 1,
          lastRunAt: new Date().toISOString(),
          reviewDecision: 'retry',
          reviewRoute: 'codex-review',
          acceptanceCheckResults: [{ check: 'npm run lint passes', status: 'fail', note: 'eslint reported errors' }],
          allowedActionClasses: [],
          actionCounts: {},
          lastAction: null,
          codeContextSummary: '',
          recoveryHint: 'Fix lint first.'
        }
      },
      {
        id: 'T002',
        title: 'Close a task without evidence',
        goal: 'Simulate verification gap',
        dependsOn: [],
        filesLikely: ['docs/guide.md'],
        constraints: [],
        acceptanceChecks: [],
        status: 'done',
        attempts: 1,
        reviewSummary: 'marked done without verification',
        findings: [],
        checkpointNotes: [],
        lastExecution: {
          workspaceMode: 'git-worktree',
          changedFiles: ['docs/guide.md'],
          repoChangedFiles: ['docs/guide.md'],
          outOfScopeFiles: [],
          scopeEnforcement: 'strict',
          applyResult: 'Patch applied.',
          lastExitCode: 0,
          lastRunAt: new Date().toISOString(),
          reviewDecision: 'approve',
          reviewRoute: 'codex-review',
          acceptanceCheckResults: [],
          allowedActionClasses: [],
          actionCounts: {},
          lastAction: null,
          codeContextSummary: '',
          recoveryHint: ''
        }
      }
    ];
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');

    await fs.mkdir(path.join(root, 'runs', run.id, 'tasks', 'T001'), { recursive: true });
    await fs.mkdir(path.join(root, 'runs', run.id, 'tasks', 'T002'), { recursive: true });
    await fs.writeFile(path.join(root, 'runs', run.id, 'tasks', 'T001', 'execution-summary.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T001',
      verificationOk: false,
      verificationCommands: ['npm run lint'],
      changedFiles: ['src/app.ts'],
      outOfScopeFiles: ['src/stray.ts']
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(root, 'runs', run.id, 'tasks', 'T002', 'execution-summary.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T002',
      verificationOk: true,
      verificationCommands: [],
      changedFiles: ['docs/guide.md'],
      outOfScopeFiles: []
    }, null, 2), 'utf8');

    const result = await runProjectQualitySweep(project.id);
    assert.equal(result.sweep.grade, 'needs-cleanup');
    assert.ok(result.sweep.findings.some((item) => item.category === 'lint-debt'));
    assert.ok(result.sweep.findings.some((item) => item.category === 'verification-gap'));
    assert.ok(result.sweep.findings.some((item) => item.category === 'docs-drift'));
    assert.ok(result.sweep.findings.every((item) => Number(item.severityScore || 0) > 0));
    assert.ok(result.sweep.findings.every((item) => typeof item.actionabilityLabel === 'string' && item.actionabilityLabel.length > 0));
    assert.ok(result.sweep.highestSeverityScore >= 60);
    assert.ok(Array.isArray(result.cleanupTasks));
    assert.ok(result.cleanupTasks.some((item) => item.category === 'lint-debt'));
    assert.ok(result.cleanupTasks.some((item) => Number(item.severityScore || 0) > 0));

    const sweepJson = await fs.readFile(result.artifacts.jsonPath, 'utf8');
    const debtTracker = await fs.readFile(result.artifacts.debtTrackerPath, 'utf8');
    const memoryFile = await fs.readFile(path.join(root, 'memory', 'projects', memoryKey, 'MEMORY.md'), 'utf8');
    const updatedProject = await getProject(project.id);
    const overview = await getProjectOverview(project.id);
    const foundation = overview.phases.find((entry) => entry.id === 'P001');

    assert.match(sweepJson, /architecture-drift/);
    assert.match(sweepJson, /"actionabilityLabel": "(Queue in cleanup lane|Docs sync|Next maintenance pass)"/);
    assert.match(debtTracker, /lint\/static verification debt/i);
    assert.match(debtTracker, /Actionability/);
    assert.match(memoryFile, /Quality Sweep/);
    assert.equal(updatedProject.maintenance.latestQualitySweep.sweepId, result.sweep.sweepId);
    assert.equal(updatedProject.maintenance.latestQualitySweep.highestSeverityScore, result.sweep.highestSeverityScore);
    assert.ok(updatedProject.maintenance.cleanupTasks.some((item) => item.sourceSweepId === result.sweep.sweepId));
    assert.ok(foundation.latestQualitySweep?.highestSeverityScore >= 60);
    assert.ok(foundation.cleanupLane.some((item) => item.sourceSweepId === result.sweep.sweepId));
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('updateProject rewrites the phase contract artifact and overview', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-phase-contract-update-'));
  let projectId = '';
  let memoryKey = '';
  try {
    const project = await createProject({
      title: 'phase-contract-update',
      rootPath: tempDir,
      phases: [{ id: 'P001', title: 'Foundation', goal: 'initial goal', status: 'active' }]
    });
    projectId = project.id;
    memoryKey = project.sharedMemoryKey;

    const updated = await updateProject(project.id, {
      phases: [{
        id: 'P001',
        goal: 'updated phase goal',
        phaseContract: {
          goal: 'lock phase scope before implementation',
          deliverables: ['starter backlog locked', 'acceptance checklist fixed'],
          verification: ['npm run test', 'operator review note'],
          nonNegotiables: ['phase 범위를 넘지 않는다'],
          outOfScope: ['visual polish'],
          carryOverRules: ['미완료 태스크는 다음 run에 contract 기준으로 넘긴다']
        }
      }]
    });
    const overview = await getProjectOverview(project.id);
    const contractMarkdown = await fs.readFile(path.join(root, 'projects', project.id, 'phases', 'P001', 'phase-contract.md'), 'utf8');

    assert.equal(updated.phases[0].goal, 'updated phase goal');
    assert.equal(updated.phases[0].phaseContract.goal, 'lock phase scope before implementation');
    assert.deepEqual(updated.phases[0].phaseContract.deliverables, ['starter backlog locked', 'acceptance checklist fixed']);
    assert.equal(overview.phases[0].phaseContract.goal, 'lock phase scope before implementation');
    assert.match(contractMarkdown, /updated phase goal|Foundation/);
    assert.match(contractMarkdown, /starter backlog locked/);
    assert.match(contractMarkdown, /operator review note/);

    const phaseShift = await updateProject(project.id, {
      currentPhaseId: '',
      phases: [{ id: 'P001', status: 'done' }]
    });
    assert.equal(phaseShift.currentPhaseId, '');
    assert.equal(phaseShift.phases[0].status, 'done');
    assert.equal(phaseShift.status, 'completed');

    const appended = await updateProject(project.id, {
      phases: [{
        title: 'Phase 2',
        goal: 'resume feature work',
        status: 'active'
      }]
    });
    const appendedPhase = appended.phases.find((phase) => phase.title === 'Phase 2');
    assert.ok(appendedPhase);
    assert.equal(appended.currentPhaseId, appendedPhase.id);
    assert.equal(appended.status, 'active');
    assert.ok(Array.isArray(appendedPhase.phaseContract.verification));
    assert.ok(appendedPhase.phaseContract.verification.length > 0);
  } finally {
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('createProject preserves existing repo docs during bootstrap', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-project-bootstrap-'));
  let projectId = '';
  let memoryKey = '';
  try {
    await fs.mkdir(path.join(tempDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'AGENTS.md'), '# Existing AGENTS\n', 'utf8');
    const project = await createProject({
      title: 'bootstrap-preserve',
      rootPath: tempDir,
      bootstrapRepoDocs: true,
      charterText: 'bootstrap preserve smoke'
    });
    projectId = project.id;
    memoryKey = project.sharedMemoryKey;

    assert.equal(project.bootstrap.enabled, true);
    assert.ok(project.bootstrap.preservedExisting.includes('AGENTS.md'));
    assert.ok(project.bootstrap.generated.includes('ARCHITECTURE.md'));
    const existingAgents = await fs.readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
    const execPlans = await fs.readFile(path.join(tempDir, 'docs', 'exec-plans', 'active', 'README.md'), 'utf8');
    assert.equal(existingAgents, '# Existing AGENTS\n');
    assert.match(execPlans, /Active Execution Plans/);
  } finally {
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('project overview groups runs by phase and exposes carry-over backlog and open risks', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-project-overview-'));
  let projectId = '';
  let firstRunId = '';
  let secondRunId = '';
  let thirdRunId = '';
  let memoryKey = '';
  try {
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Project Root\n', 'utf8');
    const project = await createProject({
      title: 'overview-project',
      rootPath: tempDir,
      charterText: 'Project overview smoke.',
      phases: [
        { title: 'Foundation', goal: '기초를 고정한다.', status: 'active' },
        { title: 'Polish', goal: '세부 개선을 마무리한다.', status: 'planned' }
      ]
    });
    projectId = project.id;
    memoryKey = project.sharedMemoryKey;

    const firstRun = await createRun({
      title: 'foundation-failed-run',
      projectId: project.id,
      phaseId: project.phases[0].id,
      objective: 'Foundation carry-over를 만든다.',
      specText: '',
      specFiles: ''
    });
    firstRunId = firstRun.id;
    const firstState = await getRun(firstRun.id);
    firstState.status = 'failed';
    firstState.updatedAt = new Date(Date.now() + 1000).toISOString();
    firstState.tasks = [
      {
        id: 'T001',
        title: '헌법 문서 정리',
        goal: 'AGENTS와 architecture skeleton을 고정한다.',
        status: 'failed',
        findings: ['ARCHITECTURE.md boundary section is still missing.'],
        acceptanceChecks: ['ARCHITECTURE.md boundary section present'],
        filesLikely: ['AGENTS.md', 'ARCHITECTURE.md'],
        updatedAt: firstState.updatedAt,
        lastExecution: {
          verification: {
            ok: false,
            failingChecks: ['ARCHITECTURE.md boundary section present']
          }
        }
      },
      {
        id: 'T002',
        title: '다음 단계 준비',
        goal: 'carry-over queue에 남는다.',
        status: 'ready',
        acceptanceChecks: ['README 링크 확인'],
        filesLikely: ['README.md'],
        updatedAt: firstState.updatedAt
      }
    ];
    await fs.writeFile(path.join(root, 'runs', firstRun.id, 'state.json'), JSON.stringify(firstState, null, 2), 'utf8');

    const secondRun = await createRun({
      title: 'polish-complete-run',
      projectId: project.id,
      phaseId: project.phases[1].id,
      objective: 'Polish phase를 완료한다.',
      specText: '',
      specFiles: ''
    });
    secondRunId = secondRun.id;
    const secondState = await getRun(secondRun.id);
    secondState.status = 'completed';
    secondState.updatedAt = new Date(Date.now() + 2000).toISOString();
    secondState.tasks = [
      {
        id: 'T003',
        title: 'polish done',
        goal: 'done',
        status: 'done',
        acceptanceChecks: ['done'],
        filesLikely: ['README.md'],
        updatedAt: secondState.updatedAt
      }
    ];
    secondState.result = {
      summary: 'Polish phase complete.',
      goalAchieved: true
    };
    await fs.writeFile(path.join(root, 'runs', secondRun.id, 'state.json'), JSON.stringify(secondState, null, 2), 'utf8');

    const thirdRun = await createRun({
      title: 'foundation-review-run',
      projectId: project.id,
      phaseId: project.phases[0].id,
      objective: 'Foundation review를 기다린다.',
      specText: '',
      specFiles: ''
    });
    thirdRunId = thirdRun.id;
    const thirdState = await getRun(thirdRun.id);
    thirdState.status = 'needs_approval';
    thirdState.planSummary = 'Foundation plan awaiting approval.';
    thirdState.updatedAt = new Date(Date.now() + 3000).toISOString();
    thirdState.humanLoop = {
      ...(thirdState.humanLoop || {}),
      planApproval: {
        status: 'requested',
        feedback: '',
        requestedAt: thirdState.updatedAt,
        approvedAt: ''
      }
    };
    await fs.writeFile(path.join(root, 'runs', thirdRun.id, 'state.json'), JSON.stringify(thirdState, null, 2), 'utf8');

      const overview = await getProjectOverview(project.id);
      assert.equal(overview.project.id, project.id);
      assert.equal(typeof overview.project.runtimeReadiness?.browser?.ready, 'boolean');
      assert.match(overview.project.runtimeReadiness?.browser?.policy || '', /optional|project-baseline/);
      assert.equal(overview.project.retention?.policy, 'preview-only');
      assert.equal(overview.project.retention?.runCounts?.total, 3);
      assert.ok(overview.project.healthDashboard);
      assert.ok(['healthy', 'watch', 'attention'].includes(overview.project.healthDashboard.status));
      assert.ok(overview.project.healthDashboard.successor);
      assert.ok(overview.project.healthDashboard.docsDrift);
      assert.ok(overview.project.healthDashboard.runtimeObservability);
      assert.ok(overview.project.healthDashboard.reminder);
      assert.equal(overview.phases.length, 2);
    const foundation = overview.phases.find((phase) => phase.id === project.phases[0].id);
    const polish = overview.phases.find((phase) => phase.id === project.phases[1].id);
    assert.equal(foundation.runCounts.failed, 1);
    assert.equal(foundation.carryOverTasks.length, 2);
    assert.equal(foundation.carryOverTasks[0].runId, firstRun.id);
    assert.equal(foundation.carryOverTasks[0].lineageKind, 'failed-task');
    assert.equal(foundation.backlogLineage[0]?.taskId, foundation.carryOverTasks[0].taskId);
    assert.equal(foundation.pendingReview[0]?.runId, thirdRun.id);
    assert.match(foundation.pendingReview[0]?.kind || '', /plan-approval/);
    assert.match(foundation.openRisks[0]?.message || '', /ARCHITECTURE\.md boundary section/i);
    assert.equal(Array.isArray(foundation.cleanupLane), true);
    assert.equal(foundation.recentRuns[0]?.id, thirdRun.id);
    assert.ok(foundation.recentRuns.some((run) => run.id === firstRun.id));
    assert.equal(polish.runCounts.completed, 1);
    assert.equal(polish.recentRuns[0]?.id, secondRun.id);
  } finally {
    if (firstRunId) {
      await fs.rm(path.join(root, 'runs', firstRunId), { recursive: true, force: true }).catch(() => {});
    }
    if (secondRunId) {
      await fs.rm(path.join(root, 'runs', secondRunId), { recursive: true, force: true }).catch(() => {});
    }
    if (thirdRunId) {
      await fs.rm(path.join(root, 'runs', thirdRunId), { recursive: true, force: true }).catch(() => {});
    }
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

test('artifact APIs and memory indexing prefer provider-neutral task artifact names', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-generic-artifacts-'));
  let runId = '';
  try {
    const run = await createRun({
      title: 'generic-artifact-smoke',
      projectPath: tempDir,
      objective: 'generic artifact naming smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const taskRoot = path.join(root, 'runs', run.id, 'tasks', 'T001');
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'agent-prompt.md'), 'Prompt body', 'utf8');
    await fs.writeFile(path.join(taskRoot, 'agent-output.md'), 'Output body', 'utf8');
    await fs.writeFile(path.join(taskRoot, 'agent-review.json'), JSON.stringify({ decision: 'approve', route: 'agent-review', summary: 'ok' }, null, 2), 'utf8');

    const state = await getRun(run.id);
    state.tasks = [{
      id: 'T001',
      title: 'generic artifact task',
      goal: 'index generic artifacts',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: [],
      acceptanceChecks: [],
      status: 'done',
      attempts: 1,
      reviewSummary: 'ok',
      findings: [],
      checkpointNotes: [],
      lastExecution: {
        reviewRoute: 'agent-review',
        acceptanceCheckResults: [],
        actionCounts: {}
      }
    }];
    await fs.writeFile(path.join(root, 'runs', run.id, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    const snapshot = await appendArtifactMemory(root, state, state.tasks[0]);
    assert.ok(snapshot.searchResults.some((item) => item.kind === 'artifact-record'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'runs', run.id, 'artifact-manifest.json'), 'utf8'));
    assert.ok(manifest.entries.some((entry) => entry.kind === 'prompt'));
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('createRun initializes structured trace file', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'trace-smoke',
      projectPath: root,
      objective: 'trace initialization smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    const trace = await fs.readFile(path.join(root, 'runs', run.id, 'trace.ndjson'), 'utf8');
    const runActions = await fs.readFile(path.join(root, 'runs', run.id, 'run-actions.jsonl'), 'utf8');
    assert.match(trace, /"event":"run\.created"/);
    assert.equal(runActions, '');
    const firstEntry = JSON.parse(trace.trim().split(/\r?\n/)[0]);
    assert.equal(firstEntry.schemaVersion, '2');
    assert.equal(firstEntry.runId, run.id);
    assert.equal(firstEntry.phase, 'run');
    const guidance = await fs.readFile(path.join(root, 'runs', run.id, 'context', 'harness-guidance.md'), 'utf8');
    assert.match(guidance, /# Harness Guidance/);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('buildTaskActionPolicy marks high-risk tasks and exposes MCP bridge candidates', () => {
  const policy = buildTaskActionPolicy({
    projectPath: root,
    preset: { id: 'existing-repo-feature' },
    projectContext: { validationCommands: ['npm test'] },
    profile: { fileBudget: 1, diagnosisFirst: true }
  }, {
    id: 'T900',
    title: 'Migrate auth schema',
    goal: 'Update auth database schema safely',
    filesLikely: ['src/auth/schema.ts', 'src/auth/migrate.ts'],
    constraints: ['schema migration'],
    acceptanceChecks: ['npm test exits 0']
  }, {
    mode: 'git-worktree'
  }, false);

  assert.equal(policy.riskLevel, 'high');
  assert.ok(policy.verificationTypes.includes('TEST'));
  assert.ok(policy.allowedActionClasses.includes('git-write'));
  assert.ok(policy.capabilities.some((item) => item.mcpBridgeCandidate === 'git/apply-patch'));
  assert.ok(policy.policyNotes.some((item) => /file budget/i.test(item)));
  assert.ok(policy.policyNotes.some((item) => /Diagnosis-first profile/i.test(item)));
});

test('buildAcceptanceMetadata classifies acceptance checks into verification types', () => {
  const metadata = buildAcceptanceMetadata([
    'npm test exits 0',
    'eslint passes without warnings',
    'Preview page renders and screenshot matches',
    'Manual QA confirms editor selection state'
  ]);

  assert.deepEqual(metadata[0].verificationTypes, ['TEST']);
  assert.deepEqual(metadata[1].verificationTypes, ['STATIC']);
  assert.deepEqual(metadata[2].verificationTypes, ['BROWSER']);
  assert.deepEqual(metadata[3].verificationTypes, ['MANUAL']);
});

test('inferTaskVerificationTypes merges acceptance metadata and command hints', () => {
  const verificationTypes = inferTaskVerificationTypes({
    acceptanceChecks: [
      'Preview page renders correctly',
      'Manual QA confirms keyboard shortcut state'
    ]
  }, ['npm test', 'npm run lint']);

  assert.ok(verificationTypes.includes('BROWSER'));
  assert.ok(verificationTypes.includes('MANUAL'));
  assert.ok(verificationTypes.includes('TEST'));
  assert.ok(verificationTypes.includes('STATIC'));
});

test('createRun stores browser verification and dev server config in project context', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'browser-config-smoke',
      projectPath: root,
      objective: 'store browser verification defaults',
      specText: '',
      specFiles: '',
      browserVerification: {
        url: 'http://127.0.0.1:4173',
        selector: '#app',
        timeoutMs: 9000
      },
      devServer: {
        command: 'npm run dev',
        url: 'http://127.0.0.1:4173',
        timeoutMs: 15000
      },
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    assert.equal(run.projectContext.browserVerification.url, 'http://127.0.0.1:4173');
    assert.equal(run.projectContext.browserVerification.selector, '#app');
    assert.equal(run.projectContext.devServer.command, 'npm run dev');
    assert.equal(run.projectContext.devServer.url, 'http://127.0.0.1:4173');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('runBrowserVerification degrades gracefully when no browser target is configured', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-browser-verify-'));
  try {
    const result = await runBrowserVerification({
      projectContext: {},
      projectPath: tempDir
    }, {
      id: 'T-browser',
      acceptanceChecks: ['Preview page renders'],
      constraints: []
    }, {
      reviewCwd: tempDir
    }, tempDir, { children: new Set() });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'unverifiable');
    assert.match(result.note, /No browser target URL configured/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('normalizeToolProfile accepts a project-local allowlist profile', () => {
  const profile = normalizeToolProfile({
    id: 'safe-impl',
    label: 'Safe Impl',
    allowedActionClasses: ['memory-read', 'verification', 'codex-exec', 'unknown-class']
  });

  assert.equal(profile.id, 'safe-impl');
  assert.equal(profile.label, 'Safe Impl');
  assert.deepEqual(profile.allowedActionClasses, ['memory-read', 'verification', 'codex-exec']);
});

test('buildTaskActionPolicy respects tool profile allowlist', () => {
  const policy = buildTaskActionPolicy({
    projectPath: root,
    preset: { id: 'existing-repo-feature' },
    projectContext: { validationCommands: ['npm test'] },
    profile: { fileBudget: 3, diagnosisFirst: true },
    toolProfile: {
      id: 'safe-read',
      label: 'Safe Read',
      allowedActionClasses: ['memory-read', 'code-context', 'verification']
    }
  }, {
    id: 'T901',
    title: 'Review feature scope',
    goal: 'Inspect the repo and verify behavior',
    filesLikely: ['src/app.ts'],
    constraints: [],
    acceptanceChecks: ['npm test exits 0']
  }, {
    mode: 'git-worktree'
  }, false);

  assert.equal(policy.toolProfile.id, 'safe-read');
  assert.ok(policy.allowedActionClasses.includes('memory-read'));
  assert.ok(policy.allowedActionClasses.includes('verification'));
  assert.equal(policy.allowedActionClasses.includes('codex-exec'), false);
  assert.equal(policy.allowedActionClasses.includes('git-write'), false);
  assert.ok(policy.policyNotes.some((item) => /Tool profile "Safe Read"/.test(item)));
});

test('createRun stores tool profile in run state', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'tool-profile-smoke',
      projectPath: root,
      objective: 'store a tool profile',
      specText: '',
      specFiles: '',
      toolProfile: {
        id: 'safe-read',
        label: 'Safe Read',
        allowedActionClasses: ['memory-read', 'code-context', 'verification']
      },
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    assert.equal(run.toolProfile.id, 'safe-read');
    assert.deepEqual(run.toolProfile.allowedActionClasses, ['memory-read', 'code-context', 'verification']);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('buildActionReplayEnvelope normalizes replayable action input shape', () => {
  const replay = buildActionReplayEnvelope('memory-search', {
    query: 'fix auth retry',
    stage: 'execute',
    filesLikely: ['src/auth-service.ts', 'src/auth-service.ts'],
    relatedFiles: [{ path: 'src/auth-service.ts' }, 'src/token-utils.ts'],
    symbolHints: ['buildAuthSession', 'buildAuthSession', 'buildToken']
  }, {
    taskId: 'T-auth'
  });

  assert.equal(replay.schemaVersion, '2');
  assert.equal(replay.kind, 'capability-input');
  assert.equal(replay.replayable, true);
  assert.equal(replay.taskId, 'T-auth');
  assert.deepEqual(replay.filesLikely, ['src/auth-service.ts']);
  assert.deepEqual(replay.relatedFiles, ['src/auth-service.ts', 'src/token-utils.ts']);
  assert.deepEqual(replay.symbolHints, ['buildAuthSession', 'buildToken']);
});

test('parseJsonReply extracts a balanced JSON object from mixed agent output', () => {
  const parsed = parseJsonReply([
    'Planner notes before the payload.',
    '{"decision":"approve","summary":"ok"}',
    'Trailing commentary that should be ignored.'
  ].join('\n'));

  assert.deepEqual(parsed, {
    decision: 'approve',
    summary: 'ok'
  });
});

test('parseJsonReply reads fenced JSON blocks before giving up', () => {
  const parsed = parseJsonReply([
    '```json',
    '{"goalAchieved":true,"summary":"done"}',
    '```'
  ].join('\n'));

  assert.equal(parsed.goalAchieved, true);
  assert.equal(parsed.summary, 'done');
});

test('decideReviewRoute blocks out-of-scope edits before agent review', () => {
  const review = decideReviewRoute(
    { preset: { id: 'existing-repo-feature' } },
    {
      title: 'Patch the API handler',
      goal: 'Keep the change inside the existing endpoint',
      acceptanceChecks: ['npm test'],
      constraints: [],
      filesLikely: ['src/api/handler.ts']
    },
    ['src/api/handler.ts', 'src/auth/session.ts'],
    {
      outOfScopeFiles: ['src/auth/session.ts']
    },
    {
      ok: true,
      selectedCommands: ['npm test']
    }
  );

  assert.equal(review?.decision, 'retry');
  assert.equal(review?.route, 'rule-blocked');
  assert.match(review?.summary || '', /out-of-scope files changed/i);
});

test('decideReviewRoute blocks verification failures before agent review', () => {
  const review = decideReviewRoute(
    { preset: { id: 'existing-repo-feature' } },
    {
      title: 'Update the API handler',
      goal: 'Implement the new response shape',
      acceptanceChecks: ['npm test exits 0'],
      constraints: [],
      filesLikely: ['src/api/handler.ts']
    },
    ['src/api/handler.ts'],
    {
      outOfScopeFiles: []
    },
    {
      ok: false,
      selectedCommands: ['npm test']
    }
  );

  assert.equal(review?.decision, 'retry');
  assert.equal(review?.route, 'rule-blocked');
  assert.match((review?.findings || []).join('\n'), /automatic verification failed/i);
});

test('buildTaskCodeContext returns related file symbols and references', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-code-context-'));
  try {
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'auth-service.ts'), [
      "import { buildToken } from './token-utils';",
      'export function buildAuthSession(userId) {',
      '  return buildToken(userId);',
      '}'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'token-utils.ts'), [
      'export function buildToken(value) {',
      '  return `token:${value}`;',
      '}'
    ].join('\n'), 'utf8');

    const context = await buildTaskCodeContext({
      id: 'run-code-context',
      projectPath: tempDir
    }, {
      id: 'T123',
      title: 'Adjust auth session handling',
      goal: 'Change buildAuthSession behavior',
      filesLikely: ['src/auth-service.ts'],
      acceptanceChecks: ['buildAuthSession returns a token']
    });

    assert.match(context.summary, /src\/auth-service\.ts/);
    assert.ok(context.symbolHints.some((item) => item === 'buildAuthSession'));
    assert.ok(context.relatedFiles[0].symbols.some((item) => item.includes('buildAuthSession')));
    assert.ok(context.relatedFiles[0].references.some((item) => item.includes('buildToken')));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('buildTaskCodeContext keeps distinct file casing on Unix-like platforms', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-case-context-'));
  try {
    if (process.platform === 'win32') return;
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'CaseProbe.ts'), 'export const probe = true;\n', 'utf8');
    try {
      await fs.access(path.join(tempDir, 'src', 'caseprobe.ts'));
      return;
    } catch {}
    await fs.writeFile(path.join(tempDir, 'src', 'CaseFile.ts'), [
      'export function keepCase() {',
      "  return 'ok';",
      '}'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(tempDir, 'src', 'casefile.ts'), [
      'export function wrongCase() {',
      "  return 'no';",
      '}'
    ].join('\n'), 'utf8');

    const context = await buildTaskCodeContext({
      id: 'run-case-context',
      projectPath: tempDir
    }, {
      id: 'T124',
      title: 'Adjust the uppercase file only',
      goal: 'Change keepCase behavior',
      filesLikely: ['src/CaseFile.ts'],
      acceptanceChecks: ['keepCase returns ok']
    });

    assert.match(context.summary, /src\/CaseFile\.ts/);
    assert.doesNotMatch(context.summary, /src\/casefile\.ts/);
    assert.ok(context.relatedFiles.some((item) => item.path === 'src/CaseFile.ts'));
    assert.ok(!context.relatedFiles.some((item) => item.path === 'src/casefile.ts'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('searchProjectMemory compacts duplicate artifact memory and ranks symbol-grounded hits first', async () => {
  const projectKey = `test-memory-ranking-${Date.now()}`;
  const memoryDir = path.join(root, 'memory', 'projects', projectKey);
  try {
    await ensureProjectMemory(root, projectKey, { projectPath: root });
    await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '# Project Memory\n\nGeneral notes only.\n', 'utf8');
    await fs.writeFile(path.join(memoryDir, 'memory-artifacts.ndjson'), [
      JSON.stringify({
        schemaVersion: '2',
        artifactId: 'old-artifact',
        projectKey,
        runId: 'run-1',
        taskId: 'T-auth',
        kind: 'review-verdict',
        stage: 'review',
        title: 'Task T-auth Review Verdict',
        summary: 'buildAuthSession verification failed and requires retry',
        keywords: ['auth', 'retry'],
        filesLikely: ['src/auth-service.ts'],
        decision: 'retry',
        verificationOk: false,
        rootCause: 'verification failure',
        taskTitle: 'Fix auth session retry flow',
        taskStatus: 'failed',
        changedFiles: ['src/auth-service.ts'],
        outOfScopeFiles: [],
        acceptanceFailures: ['npm test exits 0'],
        sourcePath: path.join(memoryDir, 'runs', 'run-1.md'),
        createdAt: '2026-04-01T00:00:00.000Z',
        symbolHints: ['buildAuthSession', 'buildToken']
      }),
      JSON.stringify({
        schemaVersion: '2',
        artifactId: 'new-artifact',
        projectKey,
        runId: 'run-2',
        taskId: 'T-auth',
        kind: 'review-verdict',
        stage: 'review',
        title: 'Task T-auth Review Verdict',
        summary: 'buildAuthSession verification failed and requires retry',
        keywords: ['auth', 'retry'],
        filesLikely: ['src/auth-service.ts'],
        decision: 'retry',
        verificationOk: false,
        rootCause: 'verification failure',
        taskTitle: 'Fix auth session retry flow',
        taskStatus: 'failed',
        changedFiles: ['src/auth-service.ts'],
        outOfScopeFiles: [],
        acceptanceFailures: ['npm test exits 0'],
        sourcePath: path.join(memoryDir, 'runs', 'run-2.md'),
        createdAt: '2026-04-02T00:00:00.000Z',
        symbolHints: ['buildAuthSession', 'buildToken']
      }),
      JSON.stringify({
        schemaVersion: '2',
        artifactId: 'other-artifact',
        projectKey,
        runId: 'run-3',
        taskId: 'T-docs',
        kind: 'review-verdict',
        stage: 'review',
        title: 'Task T-docs Review Verdict',
        summary: 'README wording update',
        keywords: ['docs'],
        filesLikely: ['README.md'],
        decision: 'approved',
        verificationOk: true,
        rootCause: '',
        taskTitle: 'Adjust docs',
        taskStatus: 'done',
        changedFiles: ['README.md'],
        outOfScopeFiles: [],
        acceptanceFailures: [],
        sourcePath: path.join(memoryDir, 'runs', 'run-3.md'),
        createdAt: '2026-04-02T01:00:00.000Z',
        symbolHints: []
      })
    ].join('\n') + '\n', 'utf8');

    const result = await searchProjectMemory(
      root,
      projectKey,
      'fix auth session retry',
      5,
      { projectPath: root },
      {
        stage: 'review',
        taskId: 'T-auth',
        filesLikely: ['src/auth-service.ts'],
        relatedFiles: ['src/auth-service.ts'],
        symbolHints: ['buildAuthSession']
      }
    );

    assert.equal(result.compaction.removedCount, 1);
    assert.equal(result.searchResults[0]?.kind, 'artifact-record');
    assert.ok(result.searchResults[0]?.rankingMeta?.matchedSymbols.includes('buildAuthSession'));
    assert.equal(result.failureAnalytics.longHorizon.windowDays, 14);
    assert.equal(result.failureAnalytics.retryCount, 1);
  } finally {
    await fs.rm(memoryDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('artifact memory writes manifest, summaries, and searchable records', async () => {
  let runId = '';
  let projectKey = '';
  try {
    const run = await createRun({
      title: 'artifact-memory-smoke',
      projectPath: root,
      objective: 'artifact memory smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.tasks = [{
      id: 'T001',
      title: 'Fix login retry flow',
      goal: 'Preserve structured artifact summaries',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: ['최소 수정'],
      acceptanceChecks: ['npm test exits 0'],
      status: 'failed',
      attempts: 1,
      reviewSummary: '로그인 검증이 실패해서 재시도가 필요합니다.',
      findings: ['Retry diagnosis: 검증 실패 원인을 먼저 고립하세요.'],
      lastExecution: {
        workspaceMode: 'shared',
        changedFiles: ['README.md'],
        repoChangedFiles: ['README.md'],
        outOfScopeFiles: [],
        scopeEnforcement: 'best-effort',
        applyResult: 'Patch was not applied because automatic verification failed.',
        lastExitCode: 1,
        lastRunAt: new Date().toISOString(),
        reviewDecision: 'retry',
        reviewRoute: 'codex-review',
        acceptanceCheckResults: [{ check: 'npm test exits 0', status: 'fail', note: 'smoke failure' }]
      }
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const taskRoot = path.join(root, 'runs', run.id, 'tasks', 'T001');
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.writeFile(path.join(taskRoot, 'codex-prompt.md'), 'Read and execute the task instructions.', 'utf8');
    await fs.writeFile(path.join(taskRoot, 'codex-output.md'), 'Tests failed while checking login flow.', 'utf8');
    await fs.writeFile(path.join(taskRoot, 'codex-review.json'), JSON.stringify({
      decision: 'retry',
      summary: '로그인 검증이 실패했습니다.',
      findings: ['검증 실패를 먼저 수정하세요.'],
      retryDiagnosis: 'verification failure'
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(taskRoot, 'verification.json'), JSON.stringify({
      selectedCommands: ['npm test'],
      results: [{ command: 'npm test', code: 1, stdout: '', stderr: 'failed' }],
      ok: false,
      note: 'One or more verification commands failed.'
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(taskRoot, 'handoff.json'), JSON.stringify({
      schemaVersion: '1',
      runId: run.id,
      taskId: 'T001',
      stage: 'planner-to-executor',
      goal: 'Preserve structured artifact summaries',
      filesLikely: ['README.md'],
      expectedScope: 'best-effort'
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(taskRoot, 'review-verdict.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T001',
      decision: 'retry',
      route: 'codex-review',
      summary: '로그인 검증이 실패해서 재시도가 필요합니다.',
      findings: ['검증 실패를 먼저 수정하세요.'],
      retryDiagnosis: 'verification failure'
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(taskRoot, 'retry-plan.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T001',
      reason: '로그인 검증 실패',
      rootCause: 'verification failure',
      changedApproach: ['검증 실패를 먼저 고립'],
      extraChecks: ['npm test exits 0']
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(taskRoot, 'execution-summary.json'), JSON.stringify({
      schemaVersion: '1',
      taskId: 'T001',
      workspaceMode: 'shared',
      expectedScope: 'best-effort',
      changedFiles: ['README.md'],
      repoChangedFiles: ['README.md'],
      outOfScopeFiles: [],
      verificationOk: false,
      verificationCommands: ['npm test'],
      reviewDecision: 'retry',
      reviewRoute: 'codex-review',
      applyResult: 'Patch was not applied because automatic verification failed.',
      lastExitCode: 1,
      attempt: 1,
      completedAt: new Date().toISOString()
    }, null, 2), 'utf8');

    const snapshot = await appendArtifactMemory(root, state, state.tasks[0]);
    projectKey = run.memory.projectKey;
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'runs', run.id, 'artifact-manifest.json'), 'utf8'));
    const artifactIndex = await fs.readFile(path.join(root, 'memory', 'projects', run.memory.projectKey, 'memory-artifacts.ndjson'), 'utf8');
    const runMemory = await fs.readFile(path.join(root, 'memory', 'projects', run.memory.projectKey, 'runs', `${run.id}.md`), 'utf8');
    const taskMemory = await fs.readFile(path.join(root, 'memory', 'projects', run.memory.projectKey, 'tasks', `${run.id}-T001.md`), 'utf8');

    assert.equal(Array.isArray(manifest.entries), true);
    assert.equal(manifest.entries.some((entry) => entry.kind === 'review-verdict'), true);
    assert.match(artifactIndex, /review-verdict/);
    assert.match(runMemory, /Fix login retry flow/);
    assert.match(taskMemory, /Retry diagnosis/);
    assert.ok(snapshot.searchResults.some((item) => ['artifact-memory', 'task-memory', 'run-memory'].includes(item.kind)));
    assert.ok(snapshot.searchResults.some((item) => item.kind === 'artifact-record'));
    assert.equal(snapshot.failureAnalytics.retryCount >= 1, true);
    assert.equal(snapshot.failureAnalytics.verificationFailures >= 1, true);
    assert.equal(snapshot.traceSummary.artifactCount >= 1, true);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    if (projectKey) {
      await fs.rm(path.join(root, 'memory', 'projects', projectKey), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('createRun seeds memory analytics fields', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'memory-analytics-smoke',
      projectPath: root,
      objective: 'memory analytics smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    assert.equal(typeof run.memory.failureAnalytics, 'object');
    assert.equal(typeof run.memory.traceSummary, 'object');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('continuation prompt lines compact recent task state and direct resume guidance', () => {
  const lines = buildContinuationPromptLines({
    tasks: [{
      id: 'T001',
      title: 'Earlier task',
      status: 'done',
      goal: 'Finish the first step',
      attempts: 1,
      reviewSummary: '첫 단계는 완료되었습니다.',
      lastExecution: {
        lastRunAt: '2026-04-03T00:00:01.000Z'
      }
    }, {
      id: 'T002',
      title: 'Retry the failing step',
      status: 'failed',
      goal: 'Fix the regression',
      attempts: 2,
      reviewSummary: '자동 검증 실패를 먼저 해결해야 합니다.',
      lastExecution: {
        lastRunAt: '2026-04-03T00:00:02.000Z',
        acceptanceCheckResults: [{ check: 'npm test exits 0', status: 'fail', note: 'smoke failure' }]
      }
    }],
    goalLoops: 1,
      profile: {
        flowProfile: 'sequential',
        taskBudget: 6,
        fileBudget: 2,
        diagnosisFirst: true,
        freshSessionThreshold: '2 failed replans or 60m'
      },
      project: {
        phaseTitle: 'Foundation',
        phaseGoal: '현재 phase만 고정한다.'
      },
      result: {
        summary: '이전 goal judge가 재시도를 요구했습니다.'
      }
    }, 'T002');

    const prompt = lines.join('\n');
    assert.match(prompt, /Direct resume rule/);
    assert.match(prompt, /Current focus: T002 Retry the failing step/);
    assert.match(prompt, /Active profile: flow=sequential/);
    assert.match(prompt, /Fresh session policy: 2 failed replans or 60m/);
    assert.match(prompt, /Current phase boundary: stay inside Foundation/);
    assert.match(prompt, /acceptance=failed/);
    assert.match(prompt, /latestResult=/);
  });

test('applyPlanPolicy injects a read-only verification task when code changes lack verification', () => {
  const { rawTasks, policy } = applyPlanPolicy({
      preset: { id: 'existing-repo-feature' },
      profile: { flowProfile: 'sequential', taskBudget: 8, fileBudget: 3, diagnosisFirst: false, freshSessionThreshold: '90m' },
      clarify: { architecturePattern: 'pipeline' },
      projectContext: { validationCommands: ['npm test', 'npm run lint'] }
    }, {
    tasks: [{
      title: 'Update the API handler',
      goal: 'Implement the new response shape',
      dependsOn: [],
      filesLikely: ['src/api/handler.ts'],
      constraints: ['Keep the diff small'],
      acceptanceChecks: ['The response shape matches the new spec']
    }]
  });

  assert.equal(policy.verificationNudgeNeeded, true);
  assert.equal(policy.syntheticTasks.includes('verification-nudge'), true);
  assert.equal(rawTasks.at(-1).title, 'Verify the integrated changes mechanically');
  assert.match(rawTasks.at(-1).constraints.join(' | '), /Do not edit any files/);
});

test('applyPlanPolicy injects diagnosis-first scoping work for broad greenfield plans', () => {
  const { rawTasks, policy } = applyPlanPolicy({
    preset: { id: 'greenfield-app' },
    profile: { flowProfile: 'sequential', taskBudget: 8, fileBudget: 2, diagnosisFirst: true, freshSessionThreshold: '75m' },
    clarify: { architecturePattern: 'pipeline' },
    projectContext: { validationCommands: ['npm test'] },
    project: { phaseTitle: 'Foundation' }
  }, {
    tasks: [{
      title: '앱 기본 구조를 한 번에 만든다',
      goal: 'routing, state, editor shell을 모두 만든다',
      dependsOn: [],
      filesLikely: ['src/app.tsx', 'src/router.tsx', 'src/editor.tsx'],
      constraints: ['초기 구조를 잡는다'],
      acceptanceChecks: ['앱이 실행된다']
    }]
  });

  assert.equal(rawTasks[0].title, 'Diagnose current phase scope and lock implementation boundaries');
  assert.ok(policy.syntheticTasks.includes('diagnosis-first'));
  assert.ok(policy.policyNotes.some((item) => /Diagnosis-first profile/i.test(item)));
  assert.equal(policy.parallelMode, 'sequential');
});

test('evaluateFreshSessionState recommends a fresh run after threshold crossings', () => {
  const result = evaluateFreshSessionState({
    createdAt: new Date(Date.now() - (91 * 60 * 1000)).toISOString(),
    profile: { freshSessionThreshold: '3 failed replans or 90m' },
    metrics: { replanPauseCount: 2, replanHighDriftCount: 0 }
  }, {
    pauseForHuman: true,
    driftRisk: 'medium'
  });

  assert.equal(result.recommended, true);
  assert.match(result.reason, /fresh run recommended/i);
});

test('applyPlanPolicy skips verification nudge for docs-only plans', () => {
  const { rawTasks, policy } = applyPlanPolicy({
    preset: { id: 'docs-spec-first' },
    clarify: { architecturePattern: 'pipeline' },
    projectContext: { validationCommands: ['npm test'] }
  }, {
    tasks: [{
      title: 'Update the README and docs',
      goal: 'Document the new feature and acceptance criteria',
      dependsOn: [],
      filesLikely: ['README.md', 'docs/guide.md'],
      constraints: ['Document only'],
      acceptanceChecks: ['README includes the new behavior summary']
    }]
  });

  assert.equal(policy.verificationNudgeNeeded, false);
  assert.equal(rawTasks.some((task) => task.title === 'Verify the integrated changes mechanically'), false);
});

test('createRun defaults Codex execution settings', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'codex-default-settings-smoke',
      projectPath: root,
      objective: 'codex default settings smoke',
      presetId: 'greenfield-app',
      specText: '',
      specFiles: ''
    });
    runId = run.id;
    assert.equal(run.settings.maxParallel, 1);
    assert.equal(run.settings.maxTaskAttempts, 2);
    assert.equal(run.settings.maxGoalLoops, 4);
    assert.equal(run.settings.codexModel, 'gpt-5.4');
    assert.equal(run.settings.codexReasoningEffort, 'high');
    assert.equal(run.settings.codexServiceTier, 'fast');
    assert.equal(run.profile.flowProfile, 'sequential');
    assert.equal(run.profile.taskBudget, 8);
    assert.equal(run.profile.fileBudget, 2);
    assert.equal(run.profile.replanThreshold, 'task-batch');
    assert.equal(run.profile.freshSessionThreshold, '2 high-drift replans or 75m');
    assert.equal(run.agents.find((agent) => agent.name === 'planner')?.model, run.settings.coordinationProvider);
    assert.equal(run.agents.find((agent) => agent.name === 'implementer')?.model, run.settings.workerProvider);
    assert.equal(run.agents.find((agent) => agent.name === 'verifier')?.model, run.settings.coordinationProvider);
    assert.equal(run.agents.find((agent) => agent.name === 'goal-judge')?.model, run.settings.coordinationProvider);
    const guidance = await fs.readFile(path.join(root, 'runs', run.id, 'context', 'harness-guidance.md'), 'utf8');
    assert.match(guidance, /## Execution Profile/);
    assert.match(guidance, /Task budget: 8/);
    assert.match(guidance, /Diagnosis-first: required/);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('createRun applies larger goal loop defaults for docs-first and greenfield presets', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-preset-defaults-'));
  let docsRunId = '';
  let greenfieldRunId = '';
  try {
    await fs.writeFile(path.join(tempDir, 'README.md'), '# Preset Defaults\n', 'utf8');
    const docsRun = await createRun({
      title: 'docs-default-smoke',
      projectPath: tempDir,
      objective: 'docs-first default settings smoke',
      presetId: 'docs-spec-first',
      specText: '',
      specFiles: ''
    });
    docsRunId = docsRun.id;
    assert.equal(docsRun.settings.maxParallel, 1);
    assert.equal(docsRun.settings.maxTaskAttempts, 2);
    assert.equal(docsRun.settings.maxGoalLoops, 4);

    const greenfieldRun = await createRun({
      title: 'greenfield-default-smoke',
      projectPath: tempDir,
      objective: 'greenfield default settings smoke',
      presetId: 'greenfield-app',
      specText: '',
      specFiles: ''
    });
    greenfieldRunId = greenfieldRun.id;
    assert.equal(greenfieldRun.settings.maxParallel, 1);
    assert.equal(greenfieldRun.settings.maxTaskAttempts, 2);
    assert.equal(greenfieldRun.settings.maxGoalLoops, 4);
  } finally {
    if (docsRunId) await fs.rm(path.join(root, 'runs', docsRunId), { recursive: true, force: true }).catch(() => {});
    if (greenfieldRunId) await fs.rm(path.join(root, 'runs', greenfieldRunId), { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('createRun snapshots coordination and worker provider settings', async () => {
  let runId = '';
  const originalSettings = await getHarnessSettings(root);
  try {
    await updateHarnessSettings({
      ...originalSettings,
      codexRuntimeProfile: 'safe',
      coordinationProvider: 'claude',
      workerProvider: 'gemini',
      claudeModel: 'claude-sonnet-4-5',
      geminiModel: 'gemini-2.5-flash',
      geminiProjectId: 'c-gemini-admin',
      claudeNotes: 'plan and review only',
      geminiNotes: 'implementation only'
    });

    const run = await createRun({
      title: 'provider-profile-smoke',
      projectPath: root,
      objective: 'provider profile smoke',
      presetId: 'greenfield-app',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    assert.equal(run.settings.coordinationProvider, 'claude');
    assert.equal(run.settings.workerProvider, 'gemini');
    assert.equal(run.settings.codexRuntimeProfile, 'safe');
    assert.equal(run.settings.claudeModel, 'claude-sonnet-4-5');
    assert.equal(run.settings.geminiModel, 'gemini-2.5-flash');
    assert.equal(run.settings.geminiProjectId, 'c-gemini-admin');
    assert.equal(run.harnessConfig.coordinationProvider, 'claude');
    assert.equal(run.harnessConfig.workerProvider, 'gemini');

    const byName = Object.fromEntries((run.agents || []).map((agent) => [agent.name, agent.model]));
    assert.equal(byName.planner, 'claude');
    assert.equal(byName.implementer, 'gemini');
    assert.equal(byName.verifier, 'claude');
    assert.equal(byName['goal-judge'], 'claude');
    assert.equal(run.preflight.providerProfile?.coordinationProvider, 'claude');
    assert.equal(run.preflight.providerProfile?.workerProvider, 'gemini');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    await updateHarnessSettings(originalSettings);
  }
});

test('updateHarnessSettings persists the codex runtime profile', async () => {
  const originalSettings = await getHarnessSettings(root);
  try {
    const updated = await updateHarnessSettings({
      ...originalSettings,
      codexRuntimeProfile: 'full-auto'
    });
    assert.equal(updated.codexRuntimeProfile, 'full-auto');

    const reloaded = await getHarnessSettings(root);
    assert.equal(reloaded.codexRuntimeProfile, 'full-auto');
  } finally {
    await updateHarnessSettings(originalSettings);
  }
});

test('buildCodexExecArgs maps runtime profiles to codex CLI flags', () => {
  const safeArgs = buildCodexExecArgs({
    codexRuntimeProfile: 'safe',
    codexModel: 'gpt-5.4',
    codexReasoningEffort: 'high',
    codexServiceTier: 'fast'
  }, 'safe.txt');
  assert.ok(safeArgs.includes('-a'));
  assert.ok(safeArgs.includes('untrusted'));
  assert.ok(safeArgs.includes('-s'));
  assert.ok(safeArgs.includes('read-only'));
  assert.equal(safeArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  const fullAutoArgs = buildCodexExecArgs({
    codexRuntimeProfile: 'full-auto',
    codexModel: 'gpt-5.4',
    codexReasoningEffort: 'high',
    codexServiceTier: 'fast'
  }, 'full.txt');
  assert.ok(fullAutoArgs.includes('on-request'));
  assert.ok(fullAutoArgs.includes('workspace-write'));
  assert.equal(fullAutoArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);

  const yoloArgs = buildCodexExecArgs({
    codexRuntimeProfile: 'yolo',
    codexModel: 'gpt-5.4',
    codexReasoningEffort: 'high',
    codexServiceTier: 'fast'
  }, 'yolo.txt');
  assert.ok(yoloArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(yoloArgs.includes('approval_policy="never"'));
  assert.ok(yoloArgs.includes('sandbox_mode="danger-full-access"'));
});

test('createRun lets project provider defaults override machine provider defaults', async () => {
  let projectId = '';
  let runId = '';
  const originalSettings = await getHarnessSettings(root);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-project-provider-'));
  try {
    await updateHarnessSettings({
      ...originalSettings,
      coordinationProvider: 'codex',
      workerProvider: 'codex'
    });
    const project = await createProject({
      title: 'Project Provider Defaults',
      rootPath: tempDir,
      phases: [{ title: 'Foundation', goal: 'ship phase one' }]
    });
    projectId = project.id;
    await updateProject(project.id, {
      providerProfile: {
        coordinationProvider: 'claude',
        workerProvider: 'gemini'
      }
    });

    const run = await createRun({
      title: 'project-provider-defaults-smoke',
      projectId: project.id,
      projectPath: tempDir,
      objective: 'respect project provider defaults',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    assert.equal(run.settings.coordinationProvider, 'claude');
    assert.equal(run.settings.workerProvider, 'gemini');
    assert.equal(run.projectContext?.providerProfile?.coordinationProvider, 'claude');
    assert.equal(run.projectContext?.providerProfile?.workerProvider, 'gemini');
    assert.equal(run.preflight.providerProfile?.coordinationProvider, 'claude');
    assert.equal(run.preflight.providerProfile?.workerProvider, 'gemini');

    const byName = Object.fromEntries((run.agents || []).map((agent) => [agent.name, agent.model]));
    assert.equal(byName.planner, 'claude');
    assert.equal(byName.implementer, 'gemini');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await updateHarnessSettings(originalSettings);
  }
});

test('recent logs are hydrated without persisting them into state.json', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'recent-log-smoke',
      projectPath: root,
      objective: 'recent log hydration smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const rawState = JSON.parse(await fs.readFile(path.join(root, 'runs', run.id, 'state.json'), 'utf8'));
    assert.equal(Object.hasOwn(rawState, 'logs'), false);

    const hydrated = await getRun(run.id);
    assert.ok(Array.isArray(hydrated.logs));
    assert.match(hydrated.logs.at(-1)?.message || '', /Run created\./);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('manual retry resets attempts and reopens a failed run', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'retry-smoke',
      projectPath: root,
      objective: 'retry reset smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 3, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'failed';
    state.tasks = [{
      id: 'task-1',
      title: 'Retry me',
      goal: 'Reset attempts',
      dependsOn: [],
      filesLikely: [],
      acceptanceChecks: [],
      attempts: 3,
      status: 'failed',
      reviewSummary: 'Previous failure',
      findings: ['Failed once too often'],
      lastExecution: {
        workspaceMode: 'shared',
        applyResult: 'failed',
        reviewDecision: 'reject'
      }
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    await retryTask(run.id, 'task-1');
    const refreshed = await getRun(run.id);
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.tasks[0].status, 'ready');
    assert.equal(refreshed.tasks[0].attempts, 0);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('requeueFailedTasks resets all failed tasks and reopens the run', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'requeue-failed-smoke',
      projectPath: root,
      objective: 'requeue failed tasks smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 3, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'failed';
    state.tasks = [{
      id: 'task-1',
      title: 'Retry me',
      goal: 'Reset attempts',
      dependsOn: [],
      filesLikely: [],
      acceptanceChecks: [],
      attempts: 3,
      status: 'failed',
      reviewSummary: 'Previous failure',
      findings: ['Failed once too often'],
      lastExecution: {
        workspaceMode: 'shared',
        applyResult: 'failed',
        reviewDecision: 'reject'
      }
    }, {
      id: 'task-2',
      title: 'Also retry me',
      goal: 'Reset attempts too',
      dependsOn: [],
      filesLikely: [],
      acceptanceChecks: [],
      attempts: 2,
      status: 'failed',
      reviewSummary: 'Another failure',
      findings: ['Another failure'],
      lastExecution: {
        workspaceMode: 'shared',
        applyResult: 'failed',
        reviewDecision: 'reject'
      }
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    await requeueFailedTasks(run.id);
    const refreshed = await getRun(run.id);
    assert.equal(refreshed.status, 'draft');
    assert.deepEqual(refreshed.tasks.map((task) => task.status), ['ready', 'ready']);
    assert.deepEqual(refreshed.tasks.map((task) => task.attempts), [0, 0]);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('skipTask marks the task as skipped', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'skip-smoke',
      projectPath: root,
      objective: 'skip task smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'failed';
    state.tasks = [{
      id: 'task-1',
      title: 'Skip me',
      goal: 'Skip task',
      dependsOn: [],
      filesLikely: [],
      acceptanceChecks: [],
      attempts: 1,
      status: 'failed',
      reviewSummary: 'Failure',
      findings: ['Failure'],
      lastExecution: {
        workspaceMode: 'shared',
        applyResult: 'failed',
        reviewDecision: 'reject'
      }
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    await skipTask(run.id, 'task-1', 'User decided to skip');
    const refreshed = await getRun(run.id);
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.tasks[0].status, 'skipped');
    assert.equal(refreshed.tasks[0].lastExecution.reviewDecision, 'skipped');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('updatePlanDraft lets the user edit agents and tasks before execution', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'plan-edit-smoke',
      projectPath: root,
      objective: 'plan edit smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'needs_approval';
    state.planSummary = 'old summary';
    state.agents = [{ name: 'planner', role: 'old', model: 'codex', responsibility: 'old' }];
    state.tasks = [{
      id: 'T001',
      title: 'old task',
      goal: 'old goal',
      dependsOn: [],
      filesLikely: [],
      constraints: [],
      acceptanceChecks: [],
      status: 'ready',
      attempts: 0,
      reviewSummary: '',
      findings: [],
      lastExecution: {}
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const updated = await updatePlanDraft(run.id, {
      summary: '수정된 계획 요약',
      executionModel: 'Codex가 계획, 구현, 검증을 담당',
      agents: [{ name: '구현 담당', role: '코드 구현', model: 'codex', responsibility: '태스크 실행' }],
      tasks: [{
        id: 'T010',
        title: '첫 태스크 수정',
        goal: '수정된 목표',
        dependsOn: [],
        filesLikely: ['README.md'],
        constraints: ['최소 수정'],
        acceptanceChecks: ['README 변경 확인']
      }]
    });

    assert.equal(updated.planSummary, '수정된 계획 요약');
    assert.equal(updated.agents[0].name, '구현 담당');
    assert.equal(updated.agents[0].model, 'codex');
    assert.equal(updated.tasks[0].id, 'T010');
    assert.equal(updated.tasks[0].title, '첫 태스크 수정');
    assert.equal(updated.tasks[0].status, 'ready');
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('stopRun writes a resume checkpoint artifact and checkpoint memory', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'checkpoint-stop-smoke',
      projectPath: root,
      objective: 'checkpoint stop smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    await updatePlanDraft(run.id, {
      tasks: [{
        id: 'T001',
        title: '대기 태스크',
        goal: '중단 후 재개 요약을 만든다',
        dependsOn: [],
        filesLikely: ['README.md'],
        constraints: ['문서만 수정'],
        acceptanceChecks: ['README 변경 확인']
      }]
    });

    await stopRun(run.id);
    const checkpoint = JSON.parse(await fs.readFile(path.join(root, 'runs', run.id, 'run-checkpoint.json'), 'utf8'));
    const dailyMemory = await fs.readFile(path.join(run.memory.dailyDir, path.basename(run.memory.dailyFile)), 'utf8');

    assert.equal(checkpoint.status, 'stopped');
    assert.match(checkpoint.nextAction, /재개|resume/i);
    assert.equal(checkpoint.pendingTasks[0]?.id, 'T001');
    assert.match(dailyMemory, /Run Checkpoint/);
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('updatePlanDraft edits paused backlog while preserving completed tasks', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'paused-backlog-edit-smoke',
      projectPath: root,
      objective: 'paused backlog edit smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const statePath = path.join(root, 'runs', run.id, 'state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.status = 'stopped';
    state.tasks = [{
      id: 'T001',
      title: '완료 태스크',
      goal: '이미 완료됨',
      dependsOn: [],
      filesLikely: ['README.md'],
      constraints: [],
      acceptanceChecks: ['README exists'],
      status: 'done',
      attempts: 1,
      reviewSummary: '완료됨',
      findings: [],
      checkpointNotes: [],
      lastExecution: { lastRunAt: new Date().toISOString() }
    }, {
      id: 'T002',
      title: '대기 태스크',
      goal: '나중에 수정',
      dependsOn: [],
      filesLikely: ['docs/guide.md'],
      constraints: [],
      acceptanceChecks: ['guide updated'],
      status: 'ready',
      attempts: 0,
      reviewSummary: '',
      findings: [],
      checkpointNotes: [],
      lastExecution: {}
    }];
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

    const updated = await updatePlanDraft(run.id, {
      tasks: [{
        id: 'T001',
        title: '변경 시도',
        goal: '완료 태스크는 바뀌면 안 됨'
      }, {
        id: 'T002',
        title: '수정된 대기 태스크',
        goal: 'checkpoint note를 반영한다',
        filesLikely: ['docs/guide.md'],
        constraints: ['checkpoint 반영'],
        acceptanceChecks: ['guide updated', 'summary updated'],
        checkpointNotes: ['실패 upstream를 가정하지 말 것']
      }, {
        title: '새 태스크 추가',
        goal: '후속 검증 태스크 추가',
        dependsOn: ['T002'],
        filesLikely: ['tests/'],
        constraints: ['read-only verification'],
        acceptanceChecks: ['verification plan recorded']
      }]
    });

    assert.equal(updated.status, 'stopped');
    assert.equal(updated.tasks.find((task) => task.id === 'T001')?.title, '완료 태스크');
    assert.equal(updated.tasks.find((task) => task.id === 'T002')?.title, '수정된 대기 태스크');
    assert.ok(updated.tasks.find((task) => task.id === 'T002')?.checkpointNotes.includes('실패 upstream를 가정하지 말 것'));
    assert.ok(updated.tasks.some((task) => task.title === '새 태스크 추가' && task.status === 'ready'));
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('deleteRun removes a non-running run directory', async () => {
  let runId = '';
  try {
    const run = await createRun({
      title: 'delete-smoke',
      projectPath: root,
      objective: 'delete run smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;
    const runPath = path.join(root, 'runs', run.id);
    await fs.access(runPath);

    const result = await deleteRun(run.id);
    assert.equal(result.ok, true);
    await assert.rejects(fs.access(runPath));
    runId = '';
  } finally {
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
  }
});

test('deleteProject removes project directory and optionally deletes project runs and shared memory', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-delete-project-'));
  let projectId = '';
  let runId = '';
  let memoryKey = '';
  try {
    const project = await createProject({
      title: 'delete-project-smoke',
      rootPath: tempDir,
      charterText: 'Delete project smoke test',
      phases: [{ title: 'Foundation', goal: 'Delete project state safely.' }]
    });
    projectId = project.id;
    memoryKey = project.sharedMemoryKey;

    await ensureProjectMemory(root, memoryKey, { projectPath: tempDir });
    await fs.writeFile(path.join(root, 'memory', 'projects', memoryKey, 'MEMORY.md'), '# Project Memory\n\nDelete me.\n', 'utf8');

    const run = await createRun({
      title: 'delete-project-run',
      projectId: project.id,
      objective: 'project delete smoke',
      specText: '',
      specFiles: '',
      settings: { maxParallel: 1, maxTaskAttempts: 1, maxGoalLoops: 1 }
    });
    runId = run.id;

    const projectPath = path.join(root, 'projects', project.id);
    const runPath = path.join(root, 'runs', run.id);
    const memoryPath = path.join(root, 'memory', 'projects', memoryKey);
    await fs.access(projectPath);
    await fs.access(runPath);
    await fs.access(memoryPath);

    const result = await deleteProject(project.id, { deleteRuns: true, deleteMemory: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deletedRuns, [run.id]);
    assert.equal(result.deletedMemory, true);
    await assert.rejects(fs.access(projectPath));
    await assert.rejects(fs.access(runPath));
    await assert.rejects(fs.access(memoryPath));

    projectId = '';
    runId = '';
    memoryKey = '';
  } finally {
    if (projectId) {
      await fs.rm(path.join(root, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
    }
    if (runId) {
      await fs.rm(path.join(root, 'runs', runId), { recursive: true, force: true }).catch(() => {});
    }
    if (memoryKey) {
      await fs.rm(path.join(root, 'memory', 'projects', memoryKey), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
