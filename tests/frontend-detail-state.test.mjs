import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appScript = await fs.readFile(path.join(root, 'public', 'app.js'), 'utf8');
const appHelpersScript = await fs.readFile(path.join(root, 'public', 'app-helpers.js'), 'utf8');
const appArtifactRenderersScript = await fs.readFile(path.join(root, 'public', 'app-artifact-renderers.js'), 'utf8');
const appProjectRenderersScript = await fs.readFile(path.join(root, 'public', 'app-project-renderers.js'), 'utf8');
const appModalActionsScript = await fs.readFile(path.join(root, 'public', 'app-modal-actions.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMockElement(id, state) {
  let html = '';
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    id,
    style: {},
    dataset: {},
    scrollTop: 0,
    value: '',
    checked: false,
    disabled: false,
    reset() {
      this.value = '';
      this.checked = false;
    },
    focus() {},
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatchEvent(type, event = {}) {
      const handler = listeners.get(type);
      if (handler) handler(event);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) || '';
    }
  };
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return html;
    },
    set(value) {
      html = String(value);
      state.sync(id, html);
    }
  });
  return element;
}

function createDocument() {
  const elements = new Map();
  const selectors = new Map();
  const state = {
    ensureElement(id) {
      if (!elements.has(id)) {
        elements.set(id, createMockElement(id, state));
      }
      return elements.get(id);
    },
    sync(id, html) {
      if (id === 'main-area') {
        if (html.includes('id="run-header-shell"')) state.ensureElement('run-header-shell');
        if (html.includes('id="run-tabs-shell"')) state.ensureElement('run-tabs-shell');
        if (html.includes('id="content-area"')) state.ensureElement('content-area');
        if (html.includes('id="project-new-phase-title"')) state.ensureElement('project-new-phase-title');
        if (html.includes('id="project-new-phase-goal"')) state.ensureElement('project-new-phase-goal');
        if (html.includes('id="project-settings-charter"')) state.ensureElement('project-settings-charter');
        if (html.includes('id="project-settings-preset"')) state.ensureElement('project-settings-preset');
        if (html.includes('id="project-settings-coordination-provider"')) state.ensureElement('project-settings-coordination-provider');
        if (html.includes('id="project-settings-worker-provider"')) state.ensureElement('project-settings-worker-provider');
        if (html.includes('id="project-settings-continuation-mode"')) state.ensureElement('project-settings-continuation-mode');
        if (html.includes('id="project-settings-doc-sync"')) state.ensureElement('project-settings-doc-sync');
        if (html.includes('id="project-settings-auto-sweep"')) state.ensureElement('project-settings-auto-sweep');
        if (html.includes('id="project-settings-tool-id"')) state.ensureElement('project-settings-tool-id');
        if (html.includes('id="project-settings-tool-label"')) state.ensureElement('project-settings-tool-label');
        if (html.includes('id="project-settings-tool-actions"')) state.ensureElement('project-settings-tool-actions');
        if (html.includes('id="project-settings-browser-url"')) state.ensureElement('project-settings-browser-url');
        if (html.includes('id="project-settings-dev-command"')) state.ensureElement('project-settings-dev-command');
      }
      if (id === 'content-area') {
        selectors.delete('.log-panel');
        selectors.delete('.artifact-list');
        selectors.delete('.viewer-content');
        if (html.includes('class="log-panel"')) selectors.set('.log-panel', createMockElement('log-panel', state));
        if (html.includes('class="artifact-list"')) selectors.set('.artifact-list', createMockElement('artifact-list', state));
        if (html.includes('class="viewer-content"')) selectors.set('.viewer-content', createMockElement('viewer-content', state));
      }
    }
  };

  [
    'global-banner',
    'main-area',
    'project-list',
    'project-search-input',
    'run-list',
    'run-search-input',
    'run-form',
    'harness-settings-form',
    'plan-edit-form',
    'reject-plan-form',
    'skip-task-form',
    'addreq-form',
    'create-modal',
    'create-project-modal',
    'settings-modal',
    'plan-edit-modal',
    'reject-plan-modal',
    'skip-task-modal',
    'addreq-modal',
    'project-path-input',
    'project-root-input',
    'create-run-context',
    'bootstrap-project-docs',
    'include-global-agents',
    'include-karpathy',
    'custom-constitution',
    'planner-strategy',
    'team-strategy',
    'codex-notes',
    'plan-edit-summary',
    'plan-edit-execution-model',
    'plan-edit-agents-list',
    'plan-edit-tasks-list',
    'project-form',
    'reject-plan-feedback',
    'skip-task-reason',
    'addreq-text',
    'draft-diagnostics',
    'mem-q',
    'mem-results'
  ].forEach((id) => state.ensureElement(id));

  return {
    getElementById(id) {
      return state.ensureElement(id);
    },
    querySelector(selector) {
      return selectors.get(selector) || null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea[data-clarify-question-id]') return [];
      return [];
    }
  };
}

function createFetchStub() {
  const queues = new Map();
  const calls = [];
  const requests = [];

  function queue(url, payload) {
    const key = String(url);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(payload);
  }

  async function fetch(url, options = {}) {
    const key = String(url);
    calls.push(key);
    requests.push({ url: key, options });
    const queueForUrl = queues.get(key) || [];
    if (!queueForUrl.length) {
      throw new Error(`Unexpected fetch: ${key}`);
    }
    const next = queueForUrl.shift();
    const payload = await (typeof next === 'function' ? next() : next);
    return {
      ok: true,
      async json() {
        return payload;
      },
      async text() {
        return typeof payload === 'string' ? payload : JSON.stringify(payload);
      }
    };
  }

  return { queue, fetch, calls, requests };
}

async function createUiHarness(options = {}) {
  const document = createDocument();
  const fetchStub = createFetchStub();
  fetchStub.queue('/api/runs', []);
  fetchStub.queue('/api/projects', []);
  fetchStub.queue('/api/system', {});

  const formValueMap = {
    'run-form': {
      title: 'run-title-input',
      projectPath: 'project-path-input',
      objective: 'run-objective-input',
      successCriteria: 'run-success-criteria-input',
      excludedScope: 'run-excluded-scope-input',
      targetUsers: 'run-target-users-input',
      exampleIO: 'run-example-io-input',
      protectedAreas: 'run-protected-areas-input',
      specFiles: 'run-spec-files-input',
      presetId: 'run-preset-input'
    },
    'project-form': {
      title: 'project-title-input',
      rootPath: 'project-root-input',
      charterText: 'project-charter-input',
      defaultPresetId: 'project-default-preset-input',
      phaseTitle: 'project-phase-title-input',
      phaseGoal: 'project-phase-goal-input',
      bootstrapRepoDocs: 'bootstrap-project-docs'
    }
  };

  const context = vm.createContext({
    console,
    document,
    setTimeout,
    clearTimeout,
    setImmediate,
    AbortController,
    FormData: class {
      constructor(form) {
        this.form = form;
      }
      get(name) {
        const formId = this.form?.id || '';
        const elementId = formValueMap[formId]?.[name];
        if (!elementId) return '';
        const element = document.getElementById(elementId);
        if (!element) return '';
        if (elementId === 'bootstrap-project-docs') {
          return element.checked ? 'on' : '';
        }
        return element.value || '';
      }
    },
    EventSource: class {
      constructor(url) {
        this.url = url;
        this.onmessage = null;
        context.__lastEventSource = this;
      }
      close() {}
    },
    fetch: fetchStub.fetch,
    alert() {},
    confirm() {
      return true;
    },
    encodeURIComponent,
    JSON,
    Promise,
    Map,
    Set,
    Date,
    URL
  });
  context.window = context;
  context.addEventListener = () => {};
  const initialLanguage = Object.hasOwn(options, 'language') ? options.language : 'ko';
  context.localStorage = {
    getItem(key) {
      if (key === 'har-nessie-ui-language') return initialLanguage;
      return null;
    },
    setItem() {},
    removeItem() {}
  };
  vm.runInContext(appHelpersScript, context, { filename: path.join(root, 'public', 'app-helpers.js') });
  vm.runInContext(appArtifactRenderersScript, context, { filename: path.join(root, 'public', 'app-artifact-renderers.js') });
  vm.runInContext(appProjectRenderersScript, context, { filename: path.join(root, 'public', 'app-project-renderers.js') });
  vm.runInContext(appModalActionsScript, context, { filename: path.join(root, 'public', 'app-modal-actions.js') });
  vm.runInContext(appScript, context, { filename: path.join(root, 'public', 'app.js') });
  await flush();
  await flush();
  fetchStub.calls.length = 0;
  return { context, document, fetchStub };
}

test('UI defaults to English when no saved language exists', async () => {
  const { context, document } = await createUiHarness({ language: null });
  assert.equal(vm.runInContext('HarnessUiHelpers.getUiLanguage()', context), 'en');
  assert.equal(document.documentElement?.lang || 'en', 'en');
});

function makeTask(id, title = id) {
  return {
    id,
    title,
    goal: `${title} goal`,
    status: 'ready',
    dependsOn: [],
    filesLikely: [],
    constraints: [],
    acceptanceChecks: ['renders selected detail'],
    attempts: 0,
    findings: [],
    lastExecution: {}
  };
}

function makeSummary(id, updatedAt) {
  return {
    id,
    title: id,
    status: 'draft',
    updatedAt,
    taskCounts: {
      ready: 1,
      in_progress: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      total: 1
    }
  };
}

test('stale run detail hydration does not override the latest selection', async () => {
  const { context, fetchStub } = await createUiHarness();
  const run1Detail = deferred();
  const run1Logs = deferred();
  const run2Detail = deferred();
  const run2Logs = deferred();

  vm.runInContext(`
    runs = [
      ${JSON.stringify(makeSummary('run-1', '2026-04-02T12:00:00Z'))},
      ${JSON.stringify(makeSummary('run-2', '2026-04-02T12:05:00Z'))}
    ];
  `, context);

  fetchStub.queue('/api/runs/run-1', run1Detail.promise);
  fetchStub.queue('/api/runs/run-1/logs', run1Logs.promise);
  fetchStub.queue('/api/runs/run-2', run2Detail.promise);
  fetchStub.queue('/api/runs/run-2/logs', run2Logs.promise);
  fetchStub.queue('/api/runs/run-2/tasks/T200/artifacts', {});

  const firstSelection = vm.runInContext(`selectRun('run-1')`, context);
  const secondSelection = vm.runInContext(`selectRun('run-2')`, context);

  run2Detail.resolve({
    ...makeSummary('run-2', '2026-04-02T12:05:00Z'),
    tasks: [makeTask('T200', 'second task')],
    logs: []
  });
  run2Logs.resolve([]);
  await flush();
  await flush();

  run1Detail.resolve({
    ...makeSummary('run-1', '2026-04-02T12:00:00Z'),
    tasks: [makeTask('T100', 'first task')],
    logs: []
  });
  run1Logs.resolve([]);

  await Promise.all([firstSelection, secondSelection]);

  assert.equal(vm.runInContext('selectedRunId', context), 'run-2');
  assert.equal(vm.runInContext('selectedTaskId', context), 'T200');
  assert.equal(vm.runInContext('selectedTab', context), 'dashboard');
});

test('detail scroll state is isolated per tab', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('run-1', '2026-04-02T12:00:00Z'))},
      tasks: [${JSON.stringify(makeTask('T001', 'overview task'))}],
      logs: []
    }];
    selectedRunId = 'run-1';
    selectedTaskId = 'T001';
    selectedTab = 'dashboard';
  `, context);

  await vm.runInContext('renderDetail()', context);
  document.getElementById('content-area').scrollTop = 480;

  vm.runInContext(`selectedTab = 'technical'`, context);
  await vm.runInContext('renderDetail()', context);
  assert.equal(document.getElementById('content-area').scrollTop, 0);

  vm.runInContext(`selectedTab = 'dashboard'`, context);
  await vm.runInContext('renderDetail()', context);
  assert.equal(document.getElementById('content-area').scrollTop, 480);
});

test('refreshRuns keeps cached task artifacts when the selected run summary is unchanged', async () => {
  const { context, fetchStub } = await createUiHarness();
  const task = makeTask('T001', 'cached task');

  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('run-1', '2026-04-02T12:00:00Z'))},
      tasks: [${JSON.stringify(task)}],
      logs: []
    }];
    selectedRunId = 'run-1';
    selectedTaskId = 'T001';
    selectedTab = 'technical';
    artifactState.set('run-1:T001', { agentOutput: 'cached output', codexOutput: 'cached output' });
  `, context);

  fetchStub.queue('/api/runs', [makeSummary('run-1', '2026-04-02T12:00:00Z')]);
  fetchStub.queue('/api/runs/run-1', {
    ...makeSummary('run-1', '2026-04-02T12:00:00Z'),
    tasks: [task],
    logs: []
  });
  fetchStub.queue('/api/runs/run-1/logs', []);

  await vm.runInContext('refreshRuns(false)', context);

  assert.equal(fetchStub.calls.filter((url) => url.endsWith('/artifacts')).length, 0);
  assert.equal(vm.runInContext(`artifactState.get('run-1:T001').agentOutput`, context), 'cached output');
});

test('renderArtifactTabs tolerates a missing artifacts payload', async () => {
  const { context } = await createUiHarness();
  const markup = vm.runInContext(`
    renderArtifactTabs(undefined, ${JSON.stringify(makeTask('T001', 'no artifacts yet'))})
  `, context);

  assert.match(markup, /아직 실행 산출물이 없습니다/);
  assert.doesNotMatch(markup, /TypeError/);
});

test('renderArtifactTabs shows timeline entries from trace and trajectory artifacts', async () => {
  const { context } = await createUiHarness();
  const markup = vm.runInContext(`
    artifactSubTab = 'timeline';
    renderArtifactTabs(${JSON.stringify({
      traceEntries: [
        { at: '2026-04-03T00:00:00.000Z', event: 'task.started', taskId: 'T001', meta: { verificationOk: true } }
      ],
      trajectoryEntries: [
        { at: '2026-04-03T00:00:01.000Z', kind: 'verification-summary', ok: true, note: 'All checks passed.' }
      ]
    })}, ${JSON.stringify(makeTask('T001', 'timeline task'))})
  `, context);

  assert.match(markup, /타임라인/);
  assert.match(markup, /task\.started/);
  assert.match(markup, /verification-summary/);
  assert.doesNotMatch(markup, /TypeError/);
});

test('renderArtifactTabs shows extended review taxonomy sections', async () => {
  const { context } = await createUiHarness();
  const markup = vm.runInContext(`
    artifactSubTab = 'summary';
    renderArtifactTabs(${JSON.stringify({
      reviewVerdict: {
        summary: '구조와 검증 실패를 먼저 분리해야 합니다.',
        retryDiagnosis: '카테고리별로 원인을 나눠 재시도하세요.',
        functionalFindings: ['완료 조건이 실제 동작과 어긋납니다.'],
        structuralFindings: ['상세 상태와 렌더 책임이 한곳에 몰려 있습니다.'],
        codeFindings: ['실패 경로에서 null guard가 없습니다.'],
        staticVerificationFindings: ['validate가 이 회귀를 아직 잡지 못합니다.'],
        browserUxFindings: ['로딩 실패가 화면에 드러나지 않습니다.'],
        findings: ['공통 메모 하나']
      }
    })}, ${JSON.stringify(makeTask('T001', 'summary task'))})
  `, context);

  assert.match(markup, /구조 검토/);
  assert.match(markup, /정적 검증 검토/);
  assert.match(markup, /브라우저 UX 검토/);
  assert.match(markup, /공통 메모/);
  assert.doesNotMatch(markup, /TypeError/);
});

test('planning tab shows active prompt source precedence', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('run-1', '2026-04-02T12:00:00Z'))},
      tasks: [${JSON.stringify(makeTask('T001', 'planning task'))}],
      logs: [],
      harnessConfig: {
        promptSourceReport: {
          precedence: 'project-local > machine-local > user-global > repo-docs fallback',
          shadowingNote: 'AGENTS.md currently wins and the remaining source applies as lower-priority guidance.',
          activeSources: [
            { scope: 'project-local', label: 'AGENTS.md', summary: 'Project-local instruction wins.' },
            { scope: 'machine-local', label: '.harness-web/settings.json#customConstitution', summary: 'Machine local notes.' }
          ],
          shadowedSources: [
            { scope: 'machine-local', label: '.harness-web/settings.json#customConstitution', summary: 'Machine local notes.' }
          ]
        }
      }
    }];
    selectedRunId = 'run-1';
    selectedTaskId = 'T001';
    selectedTab = 'planning';
  `, context);

  await vm.runInContext('renderDetail()', context);

  const markup = document.getElementById('content-area').innerHTML;
  assert.match(markup, /지금 가장 먼저 따르는 원칙/);
  assert.match(markup, /이 프로젝트 안의 지침/);
  assert.match(markup, /Project-local instruction wins/);
  assert.match(markup, /추가로 참고하는 원칙/);
  assert.match(markup, /에이전트 구성이 아직 없습니다/);
});

test('dashboard shows operator progress summary and recovery guide from analytics', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('run-1', '2026-04-02T12:00:00Z'))},
      status: 'failed',
      tasks: [{
        ...${JSON.stringify(makeTask('T002', 'ship progress summary'))},
        status: 'failed',
        lastExecution: {
          lastRunAt: '2026-04-03T01:23:45.000Z',
          lastAction: {
            capabilityId: 'verification',
            at: '2026-04-03T01:23:50.000Z',
            summary: 'npm test failed'
          }
        }
      }],
      logs: [{ at: '2026-04-03T01:23:50.000Z', message: 'Codex implementation started T002.' }],
      analytics: {
        operatorSummary: {
          phase: 'recovery',
          step: 'T002 ship progress summary',
          detail: 'verification failure',
          elapsed: 95,
          lastAction: {
            capabilityId: 'verification',
            summary: 'npm test failed'
          },
          rawPreserved: 'trace.ndjson, trajectory.jsonl, agent raw artifacts, and actions.jsonl remain on disk.'
        }
      },
      decisionPanel: {
        headline: 'T002 재시도',
        blockedTaskId: 'T002',
        supportingSignals: ['failed=1', 'retryable=1', 'scopeDrift=0'],
        lastRunAction: {
          capabilityId: 'verification',
          summary: 'npm test failed'
        },
        actions: [
          { id: 'retry-task', label: 'T002 재시도', description: '단일 실패 태스크라서 바로 retry하는 것이 가장 짧다.' },
          { id: 'review-retries', label: 'retry 원인 검토', description: 'verification 결과를 먼저 본다.' }
        ]
      },
      runActionRecords: [
        {
          capabilityId: 'memory-search',
          phase: 'plan',
          summary: 'recent failure patterns'
        }
      ],
      recoveryGuide: {
        title: 'Recovery Runbook',
        status: 'failed',
        rawPreserved: 'trace.ndjson, trajectory.jsonl, agent raw artifacts, and actions.jsonl remain on disk.',
        manualRunbookPath: 'D:/har-nessie/docs/research/archive/2026-04-recovery-runbook.md',
        steps: ['실패 태스크 요약과 action 기록을 먼저 확인한다.']
      }
    }];
    selectedRunId = 'run-1';
    selectedTaskId = 'T002';
    selectedTab = 'dashboard';
  `, context);

  await vm.runInContext('renderDetail()', context);

  const markup = document.getElementById('content-area').innerHTML;
  assert.ok(markup.indexOf('현재 흐름 한눈에 보기') < markup.indexOf('운영 진행 요약'));
  assert.match(markup, /자동화 신뢰도/);
  assert.match(markup, /검증 근거/);
  assert.match(markup, /복구 루프/);
  assert.match(markup, /운영 진행 요약/);
  assert.match(markup, /운영자 결정 패널/);
  assert.match(markup, /T002 재시도/);
  assert.match(markup, /recovery/);
  assert.match(markup, /T002 ship progress summary/);
  assert.match(markup, /Recovery Runbook/);
  assert.match(markup, /2026-04-recovery-runbook\.md/);
  assert.match(markup, /verification/);
  assert.match(markup, /같은 계획으로 다시 시도/);
  assert.match(markup, /이번 목표에서 제외/);
  assert.match(markup, /런타임 관측/);
  assert.match(markup, /1m 35s/);
});

test('renderArtifactTabs shows action and code context tabs', async () => {
  const { context } = await createUiHarness();
  const markup = vm.runInContext(`
    artifactSubTab = 'actions';
    renderArtifactTabs(${JSON.stringify({
      actionRecords: [
        { capabilityId: 'verification', status: 'completed', actionClass: 'verification', provider: 'local-shell', at: '2026-04-03T00:00:00.000Z' }
      ],
      codeContext: {
        summary: 'Top files: src/app.ts',
        queryTokens: ['app'],
        relatedFiles: [
          { path: 'src/app.ts', score: 82, symbols: ['export function buildApp'], snippet: 'export function buildApp() {}' }
        ]
      }
    })}, ${JSON.stringify(makeTask('T001', 'timeline task'))})
  `, context);

  assert.match(markup, /액션/);
  assert.match(markup, /verification/);
  assert.doesNotMatch(markup, /TypeError/);
});

test('renderDetail escapes task headers and logs and tolerates null run status', async () => {
  const { context, document } = await createUiHarness();
  const dangerousTask = makeTask('<T001>', 'escaped task');

  vm.runInContext(`
    runs = [{
      ...${JSON.stringify({ ...makeSummary('run-1', '2026-04-02T12:00:00Z'), status: null })},
      tasks: [${JSON.stringify(dangerousTask)}],
      logs: [{ at: '2026-04-02 <12:00>', message: 'message <b>bold</b>' }]
    }];
    selectedRunId = 'run-1';
    selectedTaskId = '<T001>';
    selectedTab = 'dashboard';
  `, context);

  await vm.runInContext('renderDetail()', context);
  assert.match(document.getElementById('content-area').innerHTML, /hero-card/);

  vm.runInContext(`selectedTab = 'technical'`, context);
  await vm.runInContext('renderDetail()', context);

  const technicalMarkup = document.getElementById('content-area').innerHTML;
  assert.match(technicalMarkup, /태스크 상세: &lt;T001&gt;/);
  assert.match(technicalMarkup, /\[2026-04-02 &lt;12:00&gt;\] message &lt;b&gt;bold&lt;\/b&gt;/);
});

test('needs_input dashboard shows plain-language clarify help and example answers', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('write-claw-intake', '2026-04-04T10:00:00Z'))},
      title: 'write-claw-intake',
      status: 'needs_input',
      preset: { id: 'docs-spec-first' },
      tasks: [],
      logs: [],
      humanLoop: {
        clarifyPending: [{
          id: 'q_scope',
          question: '이번 intake는 전체 재정리에 가깝나요, 아니면 현재 구현 위의 보완에 가깝나요?',
          helpText: '이번 run이 어디까지 바뀌어도 되는지 정하려는 질문입니다.',
          exampleAnswer: '현재 구현을 존중하되, docs와 어긋난 핵심 부분은 재정리해 주세요.'
        }]
      }
    }];
    selectedRunId = 'write-claw-intake';
    selectedTab = 'dashboard';
  `, context);

  await vm.runInContext('renderDetail()', context);

  const markup = document.getElementById('content-area').innerHTML;
  assert.match(markup, /이 작업은 구현 전 정리 단계입니다/);
  assert.match(markup, /작업 전에 1가지만 확인하면 됩니다/);
  assert.match(markup, /이번 run이 어디까지 바뀌어도 되는지 정하려는 질문입니다/);
  assert.match(markup, /예시 답변: 현재 구현을 존중하되, docs와 어긋난 핵심 부분은 재정리해 주세요/);
  assert.match(markup, /잘 모르겠으면 원하는 결과를 짧게 적어 주세요/);
});

test('needs_approval dashboard shows beginner approval guidance', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    runs = [{
      ...${JSON.stringify(makeSummary('run-approval', '2026-04-04T10:10:00Z'))},
      title: 'run-approval',
      status: 'needs_approval',
      planSummary: '로그인 버그 재현 후 최소 수정으로 해결합니다.',
      clarify: { architecturePattern: 'pipeline', executionModel: '계획, 구현, 검토 순서로 진행합니다.' },
      tasks: [${JSON.stringify(makeTask('T001', '로그인 실패 재현'))}],
      agents: [{ name: 'planner', role: '작업 순서를 정리합니다.', model: 'codex' }],
      logs: []
    }];
    selectedRunId = 'run-approval';
    selectedTab = 'dashboard';
  `, context);

  await vm.runInContext('renderDetail()', context);

  const markup = document.getElementById('content-area').innerHTML;
  assert.match(markup, /모르면 이렇게 판단하면 됩니다/);
  assert.match(markup, /목표가 맞고, 손대면 안 되는 영역만 안 건드리면 대부분 바로 시작해도 됩니다/);
  assert.match(markup, /바로 시작해도 되는 신호/);
  assert.match(markup, /다시 조정해야 하는 신호/);
  assert.match(markup, /이 계획으로 시작/);
  assert.match(markup, /계획 다시 조정/);
  assert.match(markup, /첫 작업 자세히 보기/);
});

test('project detail settings explain which fields most users should change', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-alpha', {
    project: { id: 'project-alpha', title: 'Alpha', status: 'active', currentPhaseId: 'P001', rootPath: 'D:/alpha', defaultPresetId: 'auto', defaultSettings: {}, retention: {} },
    phases: [{ id: 'P001', title: 'Foundation', status: 'active', runCounts: {}, carryOverTasks: [], pendingReview: [], backlogLineage: [], openRisks: [], cleanupLane: [], recentRuns: [], phaseContract: { goal: 'Initial', deliverables: [], verification: [], nonNegotiables: [], outOfScope: [], carryOverRules: [] } }]
  });
  vm.runInContext(`
    projects = [{ id: 'project-alpha', title: 'Alpha', status: 'active', rootPath: 'D:/alpha', phases: [{ id: 'P001', title: 'Foundation' }], currentPhaseId: 'P001' }];
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);

  const markup = document.getElementById('main-area').innerHTML;
  assert.match(markup, /프로젝트 기본값 편집/);
  assert.match(markup, /대부분은 프로젝트 헌장, 기본 작업 방식, 기본 계획\/검토 담당, 기본 구현 담당만 맞추면 충분합니다/);
  assert.match(markup, /모르면 기본값 그대로 두세요/);
  assert.match(markup, /웹 화면을 실제로 자동 확인해야 할 때만 적으면 됩니다/);
});

test('project board renders phase summaries, carry-over backlog, cleanup lane, and recent runs', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-alpha', {
    project: {
      id: 'project-alpha',
      title: 'Project Alpha',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'greenfield-app',
        defaultSettings: {
          providerProfile: { coordinationProvider: 'claude', workerProvider: 'gemini' },
          toolProfile: { id: 'safe', label: 'Safe Profile' },
          browserVerification: { url: 'http://127.0.0.1:4173' },
          devServer: { command: 'npm run dev' }
        },
        runtimeReadiness: {
          browser: {
            configured: true,
            policy: 'project-baseline',
            policyLabel: '이 프로젝트 baseline',
            policyNote: '이 프로젝트는 browser verification 또는 dev-server 설정이 있어 Playwright를 baseline dependency로 보는 편이 맞습니다.',
            ready: true,
            targetUrl: 'http://127.0.0.1:4173',
            runtime: { installed: true, version: '1.52.0' },
            note: '브라우저 검증을 바로 실행할 수 있습니다.'
          }
        },
        healthDashboard: {
          status: 'attention',
          statusLabel: '운영 주의',
          successor: {
            ready: true,
            title: '이어받을 작업 기준으로 다음 run 초안 준비됨',
            detail: 'T101을 먼저 닫는 흐름이 가장 자연스럽습니다.'
          },
          docsDrift: {
            level: 'medium',
            summary: '최근 구현 변경 일부가 문서 갱신보다 앞서 있습니다.',
            recommendedAction: '다음 run에서 docs와 구현을 함께 점검하세요.',
            reintakeRecommended: true
          },
          repeatedFailures: {
            warning: true,
            summary: 'verification failed 패턴이 반복되었습니다.'
          },
          runtimeObservability: {
            warning: true,
            browserPolicyLabel: '이 프로젝트 baseline',
            headline: '주의해서 볼 런타임 신호가 있습니다.',
            detail: '브라우저 확인과 verification 결과를 같이 보는 편이 좋습니다.',
            highlights: ['foundation retry: npm run test failed']
          },
          reminder: {
            title: '재분석 권장',
            detail: '재분석 후 docs 기준으로 backlog를 다시 맞추는 편이 안전합니다.'
          },
          docsFlow: {
            label: '문서 기준 프로젝트',
            detail: '다음 run도 docs/source-of-record와 구현을 함께 맞추는 흐름이 권장됩니다.'
          }
        },
        retention: {
          policy: 'preview-only',
          note: 'Retention/pruning은 on-disk history rewrite 대신 preview/context 계층에서 먼저 관리합니다.',
          runCounts: { total: 3, active: 1, completed: 1, stoppedOrFailed: 1 },
          qualitySweepCount: 2,
          cleanupTaskCount: 1,
          sharedMemoryKey: 'project-alpha-memory',
          sharedMemoryExists: true,
          sharedMemoryFileCount: 1
        },
        bootstrap: {
          enabled: true,
          generated: ['AGENTS.md', 'ARCHITECTURE.md']
        }
    },
    phases: [
      {
        id: 'phase-foundation',
        title: 'Foundation',
        goal: 'core architecture and recovery loop',
        status: 'active',
        phaseContract: {
          goal: 'core architecture and recovery loop',
          deliverables: ['checkpoint/resume contract', 'initial backlog freeze'],
          verification: ['npm run test', 'manual recovery drill evidence'],
          nonNegotiables: ['phase 범위를 넘지 않는다'],
          outOfScope: ['editor polishing'],
          carryOverRules: ['미완료 태스크는 carry-over backlog로 연결한다'],
          path: 'D:/har-nessie/projects/project-alpha/phases/phase-foundation/phase-contract.md'
        },
        runCounts: { ready: 0, running: 1, stopped: 0, failed: 1, completed: 0 },
        carryOverTasks: [
          {
            runId: 'run-foundation-1',
            runTitle: 'foundation retry',
            taskId: 'T101',
            title: 'stabilize checkpoint resume',
            summary: 'resume checkpoint drift',
            lineageKind: 'failed-task'
          }
        ],
        pendingReview: [
          {
            kind: 'plan-approval',
            runId: 'run-foundation-2',
            runTitle: 'foundation approval',
            title: 'Foundation plan awaiting approval',
            message: 'operator approval is required before execution'
          }
        ],
        cleanupLane: [
          {
            id: 'QS-1-C01',
            title: 'Lint and static debt cleanup',
            category: 'lint-debt',
            severity: 'medium',
            severityScore: 60,
            actionabilityLabel: 'cleanup lane 적재',
            goal: 'Restore lint verification before the next feature run.',
            sourceSweepId: 'QS-1'
          }
        ],
        latestQualitySweep: {
          createdAt: '2026-04-03T10:00:00.000Z',
          grade: 'needs-cleanup',
          categories: ['lint-debt', 'docs-drift'],
          findingCount: 2,
          highestSeverityScore: 60
        },
        backlogLineage: [
          {
            kind: 'failed-task',
            runId: 'run-foundation-1',
            runTitle: 'foundation retry',
            taskId: 'T101',
            title: 'stabilize checkpoint resume',
            summary: 'resume checkpoint drift'
          }
        ],
        openRisks: [
          {
            kind: 'task-failed',
            taskId: 'T101',
            message: 'verification failed after retry'
          }
        ],
        recentRuns: [
          {
            id: 'run-foundation-1',
            title: 'foundation retry',
            status: 'failed',
            updatedAt: '2026-04-03T03:00:00.000Z'
          }
        ]
      }
    ]
  });

  vm.runInContext(`
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      phases: [{ id: 'phase-foundation', title: 'Foundation' }]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);

  const markup = document.getElementById('main-area').innerHTML;
  assert.equal(vm.runInContext('selectedProjectId', context), 'project-alpha');
  assert.equal(vm.runInContext('selectedRunId', context), '');
  assert.match(markup, /id="content-area"/);
  assert.match(markup, /Project Alpha/);
  assert.match(markup, /다음 우선 조치/);
  assert.match(markup, /운영 건강도/);
  assert.match(markup, /즉시 확인/);
  assert.match(markup, /검토 대기/);
  assert.match(markup, /정리 작업/);
  assert.match(markup, /일괄 조치 바로가기/);
  assert.match(markup, /첫 리뷰 열기|첫 이어받을 작업 열기|정리 점검 실행/);
  assert.match(markup, /운영 큐/);
  assert.match(markup, /지금 바로 처리할 항목/);
  assert.match(markup, /계획\/검토 대기 먼저 처리|이어받을 작업 먼저 정리|quality cleanup 실행|다음 단계를 계속 진행/);
  assert.match(markup, /이 프로젝트로 새 작업 만들기/);
  assert.match(markup, /정리 점검 실행/);
  assert.match(markup, /장기 운영 체크/);
  assert.match(markup, /문서 drift/);
  assert.match(markup, /반복 실패/);
  assert.match(markup, /런타임 관측/);
  assert.match(markup, /문서 기준 프로젝트/);
  assert.match(markup, /기본 실행 설정/);
  assert.match(markup, /Claude가 계획\/검토 · Gemini가 구현/);
  assert.match(markup, /Safe Profile/);
  assert.match(markup, /검증 \/ 런타임 연결/);
  assert.match(markup, /브라우저 확인 기본 정책/);
  assert.match(markup, /이 프로젝트 baseline/);
  assert.match(markup, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(markup, /npm run dev/);
  assert.match(markup, /기록 보존 \/ 정리/);
  assert.match(markup, /preview-only/);
  assert.match(markup, /project-alpha-memory/);
  assert.match(markup, /Foundation/);
  assert.match(markup, /단계 계약/);
  assert.match(markup, /checkpoint\/resume contract/);
  assert.match(markup, /manual recovery drill evidence/);
  assert.match(markup, /phase-contract\.md/);
  assert.match(markup, /이어받을 작업/);
  assert.match(markup, /stabilize checkpoint resume/);
  assert.match(markup, /검토 대기/);
  assert.match(markup, /foundation approval/);
  assert.match(markup, /operator approval is required before execution/);
  assert.match(markup, /정리 작업 대기열/);
  assert.match(markup, /Lint and static debt cleanup/);
  assert.match(markup, /cleanup lane 적재/);
  assert.match(markup, /score 60/);
  assert.match(markup, /최근 정리 점검/);
  assert.match(markup, /finding 2 · max score 60/);
  assert.match(markup, /이어온 작업 기록/);
  assert.match(markup, /실패 후 이어받기/);
  assert.match(markup, /열린 위험/);
  assert.match(markup, /verification failed after retry/);
  assert.match(markup, /최근 작업/);
  assert.match(markup, /foundation retry/);
});

test('sidebar search filters projects and runs independently', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    projects = [
      {
        id: 'project-alpha',
        title: 'Project Alpha',
        status: 'active',
        rootPath: 'D:/repos/project-alpha',
        currentPhaseId: 'phase-foundation',
        phases: [{ id: 'phase-foundation', title: 'Foundation' }]
      },
      {
        id: 'project-beta',
        title: 'Write Claw',
        status: 'active',
        rootPath: 'D:/repos/write-claw',
        currentPhaseId: 'phase-delivery',
        phases: [{ id: 'phase-delivery', title: 'Delivery' }]
      }
    ];
    runs = [
      { id: 'run-alpha', title: 'Foundation Retry', status: 'failed', updatedAt: '2026-04-03T03:00:00.000Z', taskCounts: { total: 3, done: 1, skipped: 0, failed: 1 } },
      { id: 'run-beta', title: 'Write Claw Bootstrap', status: 'running', updatedAt: '2026-04-03T04:00:00.000Z', taskCounts: { total: 5, done: 2, skipped: 0, failed: 0 } }
    ];
    renderProjectList();
    renderRunList();
    projectOverviewState.set('project-alpha', { phases: [{ cleanupLane: [], pendingReview: [{ runId: 'run-alpha' }], openRisks: [] }] });
    projectOverviewState.set('project-beta', { phases: [{ cleanupLane: [{ id: 'C1' }], pendingReview: [], openRisks: [{ kind: 'risk' }] }] });
    renderProjectList();
  `, context);

  let projectMarkup = document.getElementById('project-list').innerHTML;
  assert.match(projectMarkup, /주의 필요/);
  assert.match(projectMarkup, /리뷰 대기/);
  assert.match(projectMarkup, /정리 필요/);

  vm.runInContext(`setProjectFilter('cleanup')`, context);
  projectMarkup = document.getElementById('project-list').innerHTML;
  assert.match(projectMarkup, /Write Claw/);
  assert.doesNotMatch(projectMarkup, /Project Alpha/);

  vm.runInContext(`updateProjectSearch('write')`, context);
  projectMarkup = document.getElementById('project-list').innerHTML;
  assert.match(projectMarkup, /Write Claw/);
  assert.doesNotMatch(projectMarkup, /Project Alpha/);

  vm.runInContext(`updateRunSearch('bootstrap')`, context);
  let runMarkup = document.getElementById('run-list').innerHTML;
  assert.match(runMarkup, /Write Claw Bootstrap/);
  assert.doesNotMatch(runMarkup, /Foundation Retry/);

  vm.runInContext(`updateProjectSearch('missing'); updateRunSearch('missing');`, context);
  projectMarkup = document.getElementById('project-list').innerHTML;
  runMarkup = document.getElementById('run-list').innerHTML;
  assert.match(projectMarkup, /검색 조건에 맞는 프로젝트가 없습니다/);
  assert.match(runMarkup, /검색 조건에 맞는 작업이 없습니다/);
});

test('project settings editor saves updated defaults and rerenders the project overview', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  const initialOverview = {
    project: {
      id: 'project-alpha',
      title: 'Project Alpha',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'greenfield-app',
      charterText: 'initial charter',
      defaultSettings: {
        providerProfile: { coordinationProvider: 'codex', workerProvider: 'codex' },
        toolProfile: { id: 'safe', label: 'Safe Profile', allowedActionClasses: ['verification'] },
        browserVerification: { url: 'http://127.0.0.1:4173' },
        devServer: { command: 'npm run dev' }
      },
      bootstrap: { enabled: true, generated: ['AGENTS.md'] }
    },
    phases: [
      {
        id: 'phase-foundation',
        title: 'Foundation',
        goal: 'ship the baseline harness',
        status: 'active',
        runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
        carryOverTasks: [],
        pendingReview: [],
        cleanupLane: [],
        latestQualitySweep: null,
        backlogLineage: [],
        openRisks: [],
        recentRuns: []
      }
    ]
  };
  const savedOverview = {
    project: {
      ...initialOverview.project,
      charterText: 'updated charter',
      defaultPresetId: 'docs-spec-first',
      defaultSettings: {
        providerProfile: { coordinationProvider: 'claude', workerProvider: 'gemini' },
        toolProfile: { id: 'custom-safe', label: 'Custom Safe', allowedActionClasses: ['verification', 'git-write'] },
        browserVerification: { url: 'http://127.0.0.1:3000' },
        devServer: { command: 'npm run preview' },
        continuationPolicy: {
          mode: 'manual',
          autoQualitySweepOnPhaseComplete: true,
          keepDocsInSync: false
        }
      }
    },
    phases: initialOverview.phases
  };

  fetchStub.queue('/api/projects/project-alpha', initialOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects', [{
    id: 'project-alpha',
    title: 'Project Alpha',
    status: 'active',
    rootPath: 'D:/repos/project-alpha',
    currentPhaseId: 'phase-foundation',
    defaultPresetId: 'docs-spec-first',
    phases: [{ id: 'phase-foundation', title: 'Foundation' }]
  }]);

  vm.runInContext(`
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'greenfield-app',
      phases: [{ id: 'phase-foundation', title: 'Foundation' }]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);

  document.getElementById('project-settings-charter').value = 'updated charter';
  document.getElementById('project-settings-preset').value = 'docs-spec-first';
  document.getElementById('project-settings-coordination-provider').value = 'claude';
  document.getElementById('project-settings-worker-provider').value = 'gemini';
  document.getElementById('project-settings-continuation-mode').value = 'manual';
  document.getElementById('project-settings-doc-sync').checked = false;
  document.getElementById('project-settings-auto-sweep').checked = true;
  document.getElementById('project-settings-tool-id').value = 'custom-safe';
  document.getElementById('project-settings-tool-label').value = 'Custom Safe';
  document.getElementById('project-settings-tool-actions').value = 'verification, git-write';
  document.getElementById('project-settings-browser-url').value = 'http://127.0.0.1:3000';
  document.getElementById('project-settings-dev-command').value = 'npm run preview';

  await vm.runInContext(`saveProjectSettings()`, context);

  const markup = document.getElementById('main-area').innerHTML;
  assert.match(markup, /프로젝트 기본값 편집/);
  assert.match(markup, /updated charter/);
  assert.match(markup, /문서 \/ 명세 먼저/);
  assert.match(markup, /Claude가 계획\/검토 · Gemini가 구현/);
  assert.match(markup, /연속 작업 운영/);
  assert.match(markup, /수동/);
  assert.match(markup, /문서 동기화 선택 · 단계 완료 시 정리 점검 자동/);
  assert.match(markup, /Custom Safe/);
  assert.match(markup, /기본 담당 AI/);
  assert.match(markup, /기본 계획\/검토 담당/);
  assert.match(markup, /연속 작업 운영 방식/);
  assert.match(markup, /고급: 도구 제한 이름/);
  assert.match(markup, /선택: 브라우저 확인 URL/);
  assert.match(markup, />0 \/ 0 \/ 0</);
  assert.match(markup, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(markup, /npm run preview/);
  const updateRequest = fetchStub.requests.find((entry) => entry.url === '/api/projects/project-alpha' && entry.options?.method === 'POST');
  const updateBody = JSON.parse(String(updateRequest?.options?.body || '{}'));
  assert.deepEqual(updateBody.continuationPolicy, {
    mode: 'manual',
    autoQualitySweepOnPhaseComplete: true,
    keepDocsInSync: false
  });
});

test('project board shows browser runtime readiness when available', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-ready', {
    project: {
      id: 'project-ready',
      title: 'Project Ready',
      rootPath: 'D:/repos/project-ready',
      currentPhaseId: 'phase-1',
      defaultPresetId: 'existing-repo-feature',
      charterText: 'runtime ready project',
      defaultSettings: {
        browserVerification: { url: 'http://127.0.0.1:4173' }
      },
      runtimeReadiness: {
        browser: {
          configured: true,
          policy: 'project-baseline',
          policyLabel: '이 프로젝트 baseline',
          policyNote: '이 프로젝트는 browser verification 또는 dev-server 설정이 있어 Playwright를 baseline dependency로 보는 편이 맞습니다.',
          ready: false,
          targetUrl: 'http://127.0.0.1:4173',
          runtime: { installed: false, version: '', error: 'Playwright is not installed.' },
          note: '브라우저 검증은 설정됐지만 Playwright 런타임이 없습니다.'
        }
      },
      bootstrap: { enabled: false, generated: [] }
    },
    phases: [{
      id: 'phase-1',
      title: 'Foundation',
      goal: 'goal',
      status: 'active',
      runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
      carryOverTasks: [],
      pendingReview: [],
      cleanupLane: [],
      latestQualitySweep: null,
      backlogLineage: [],
      openRisks: [],
      recentRuns: []
    }]
  });

  vm.runInContext(`
    projects = [{
      id: 'project-ready',
      title: 'Project Ready',
      status: 'active',
      rootPath: 'D:/repos/project-ready',
      currentPhaseId: 'phase-1',
      phases: [{ id: 'phase-1', title: 'Foundation', status: 'active' }]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-ready')`, context);
  const markup = document.getElementById('main-area').innerHTML;
  assert.match(markup, /브라우저 확인 기본 정책/);
  assert.match(markup, /이 프로젝트 baseline/);
  assert.match(markup, /런타임 미준비/);
  assert.match(markup, /Playwright 런타임이 없습니다/);
});

test('phase contract editor saves updated contract fields and rerenders the phase card', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  const initialOverview = {
    project: {
      id: 'project-alpha',
      title: 'Project Alpha',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'greenfield-app',
      charterText: 'initial charter',
      defaultSettings: {},
      bootstrap: { enabled: true, generated: [] }
    },
    phases: [
      {
        id: 'phase-foundation',
        title: 'Foundation',
        goal: 'initial phase goal',
        status: 'active',
        phaseContract: {
          goal: 'initial contract goal',
          deliverables: ['checkpoint/resume contract'],
          verification: ['npm run test'],
          nonNegotiables: ['phase 범위를 넘지 않는다'],
          outOfScope: ['editor polish'],
          carryOverRules: ['미완료 태스크는 carry-over backlog로 연결한다'],
          path: 'D:/har-nessie/projects/project-alpha/phases/phase-foundation/phase-contract.md'
        },
        runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
        carryOverTasks: [],
        pendingReview: [],
        cleanupLane: [],
        latestQualitySweep: null,
        backlogLineage: [],
        openRisks: [],
        recentRuns: []
      }
    ]
  };
  const savedOverview = {
    project: initialOverview.project,
    phases: [
      {
        ...initialOverview.phases[0],
        goal: 'updated phase goal',
        phaseContract: {
          ...initialOverview.phases[0].phaseContract,
          goal: 'updated contract goal',
          deliverables: ['starter backlog locked', 'acceptance checklist fixed'],
          verification: ['npm run test', 'operator review note']
        }
      }
    ]
  };

  fetchStub.queue('/api/projects/project-alpha', initialOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects', [{
    id: 'project-alpha',
    title: 'Project Alpha',
    status: 'active',
    rootPath: 'D:/repos/project-alpha',
    currentPhaseId: 'phase-foundation',
    phases: [{ id: 'phase-foundation', title: 'Foundation' }]
  }]);

  vm.runInContext(`
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      phases: [{ id: 'phase-foundation', title: 'Foundation' }]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);

  document.getElementById('phase-contract-phase-goal-phase-foundation').value = 'updated phase goal';
  document.getElementById('phase-contract-goal-phase-foundation').value = 'updated contract goal';
  document.getElementById('phase-contract-deliverables-phase-foundation').value = 'starter backlog locked\nacceptance checklist fixed';
  document.getElementById('phase-contract-verification-phase-foundation').value = 'npm run test\noperator review note';

  await vm.runInContext(`saveProjectPhaseContract('phase-foundation')`, context);

  const updateRequest = fetchStub.requests.find((entry) => entry.url === '/api/projects/project-alpha' && entry.options?.method === 'POST');
  const updateBody = JSON.parse(String(updateRequest?.options?.body || '{}'));
  assert.equal(updateBody.phases?.[0]?.goal, 'updated phase goal');
  assert.deepEqual(updateBody.phases?.[0]?.phaseContract?.deliverables, ['starter backlog locked', 'acceptance checklist fixed']);

  const markup = document.getElementById('main-area').innerHTML;
  assert.match(markup, /단계 계약 편집/);
  assert.match(markup, /updated phase goal/);
  assert.match(markup, /updated contract goal/);
  assert.match(markup, /starter backlog locked/);
  assert.match(markup, /operator review note/);
});

test('project phase actions switch the current phase and surface the new active phase', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  const initialOverview = {
    project: {
      id: 'project-alpha',
      title: 'Project Alpha',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'existing-repo-feature',
      charterText: 'initial charter',
      defaultSettings: {},
      bootstrap: { enabled: true, generated: [] }
    },
    phases: [
      {
        id: 'phase-foundation',
        title: 'Foundation',
        goal: 'foundation goal',
        status: 'active',
        runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
        carryOverTasks: [],
        pendingReview: [],
        cleanupLane: [],
        latestQualitySweep: null,
        backlogLineage: [],
        openRisks: [],
        recentRuns: []
      },
      {
        id: 'phase-build',
        title: 'Build',
        goal: 'build goal',
        status: 'pending',
        runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
        carryOverTasks: [],
        pendingReview: [],
        cleanupLane: [],
        latestQualitySweep: null,
        backlogLineage: [],
        openRisks: [],
        recentRuns: []
      }
    ]
  };
  const savedOverview = {
    project: {
      ...initialOverview.project,
      currentPhaseId: 'phase-build'
    },
    phases: [
      { ...initialOverview.phases[0], status: 'pending' },
      { ...initialOverview.phases[1], status: 'active' }
    ]
  };

  fetchStub.queue('/api/projects/project-alpha', initialOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects', [{
    id: 'project-alpha',
    title: 'Project Alpha',
    status: 'active',
    rootPath: 'D:/repos/project-alpha',
    currentPhaseId: 'phase-build',
    phases: [
      { id: 'phase-foundation', title: 'Foundation', status: 'pending' },
      { id: 'phase-build', title: 'Build', status: 'active' }
    ]
  }]);

  vm.runInContext(`
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      phases: [
        { id: 'phase-foundation', title: 'Foundation', status: 'active' },
        { id: 'phase-build', title: 'Build', status: 'pending' }
      ]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);
  await vm.runInContext(`setProjectPhase('phase-build', 'activate')`, context);

  const updateRequest = fetchStub.requests.find((entry) => entry.url === '/api/projects/project-alpha' && entry.options?.method === 'POST');
  const updateBody = JSON.parse(String(updateRequest?.options?.body || '{}'));
  assert.equal(updateBody.currentPhaseId, 'phase-build');
  assert.equal(updateBody.phases?.[0]?.id, 'phase-build');
  assert.equal(updateBody.phases?.[0]?.status, 'active');

  const markup = document.getElementById('main-area').innerHTML;
  assert.match(markup, /현재 단계/);
  assert.match(markup, /Build/);
  assert.match(markup, /이 단계 완료/);
});

test('phase completion triggers an automatic quality sweep when the project setting is enabled', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  const initialOverview = {
    project: {
      id: 'project-alpha',
      title: 'Project Alpha',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultPresetId: 'existing-repo-feature',
      charterText: 'initial charter',
      defaultSettings: {
        continuationPolicy: {
          mode: 'guided',
          autoQualitySweepOnPhaseComplete: true,
          keepDocsInSync: true
        }
      },
      bootstrap: { enabled: true, generated: [] }
    },
    phases: [{
      id: 'phase-foundation',
      title: 'Foundation',
      goal: 'foundation goal',
      status: 'active',
      runCounts: { ready: 0, running: 0, stopped: 0, failed: 0, completed: 0 },
      carryOverTasks: [],
      pendingReview: [],
      cleanupLane: [],
      latestQualitySweep: null,
      backlogLineage: [],
      openRisks: [],
      recentRuns: []
    }]
  };
  const savedOverview = {
    project: {
      ...initialOverview.project,
      status: 'completed',
      currentPhaseId: ''
    },
    phases: [{
      ...initialOverview.phases[0],
      status: 'done'
    }]
  };

  fetchStub.queue('/api/projects/project-alpha', initialOverview);
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects/project-alpha/quality-sweep', { sweepId: 'SWEEP-1', grade: 'B' });
  fetchStub.queue('/api/projects/project-alpha', savedOverview);
  fetchStub.queue('/api/projects', [{
    id: 'project-alpha',
    title: 'Project Alpha',
    status: 'completed',
    rootPath: 'D:/repos/project-alpha',
    currentPhaseId: '',
    phases: [{ id: 'phase-foundation', title: 'Foundation', status: 'done' }]
  }]);

  vm.runInContext(`
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      currentPhaseId: 'phase-foundation',
      defaultSettings: {
        continuationPolicy: {
          mode: 'guided',
          autoQualitySweepOnPhaseComplete: true,
          keepDocsInSync: true
        }
      },
      phases: [{ id: 'phase-foundation', title: 'Foundation', status: 'active' }]
    }];
    renderProjectList();
  `, context);

  await vm.runInContext(`selectProject('project-alpha')`, context);
  await vm.runInContext(`setProjectPhase('phase-foundation', 'complete')`, context);

  const sweepRequest = fetchStub.requests.find((entry) => entry.url === '/api/projects/project-alpha/quality-sweep');
  assert.equal(sweepRequest?.options?.method, 'POST');
  assert.deepEqual(JSON.parse(String(sweepRequest?.options?.body || '{}')), { phaseId: 'phase-foundation' });
  assert.match(document.getElementById('global-banner').innerHTML, /정리 점검도 자동으로 실행했습니다/);
});

test('folder picker request forwards the current path as initialPath', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/pick-folder', { path: 'D:/repos/write-claw' });
  document.getElementById('project-root-input').value = 'D:/repos';

  await vm.runInContext('pickProjectRootFolder()', context);

  assert.equal(document.getElementById('project-root-input').value, 'D:/repos/write-claw');
  const pickFolderRequest = fetchStub.requests.find((entry) => entry.url === '/api/pick-folder');
  assert.equal(pickFolderRequest?.url, '/api/pick-folder');
  assert.equal(JSON.parse(String(pickFolderRequest?.options?.body || '{}')).initialPath, 'D:/repos');
});

test('empty detail state renders the control plane launch surface and live snapshot', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    harnessSettings = { codexRuntimeProfile: 'yolo' };
    projects = [{
      id: 'project-beta',
      title: 'Project Beta',
      status: 'active',
      rootPath: 'D:/repos/project-beta',
      defaultPresetId: 'docs-spec-first',
      phases: [{ id: 'phase-1', title: 'Delivery' }],
      currentPhaseId: 'phase-1'
    }];
    runs = [{
      id: 'run-blocked',
      title: 'Blocked Run',
      status: 'needs_approval',
      updatedAt: '2026-04-04T00:00:00Z',
      taskCounts: { total: 3, done: 1, failed: 0, skipped: 0 }
    }];
    selectedRunId = '';
    selectedProjectId = '';
    renderProjectList();
    renderRunList();
    renderDetail();
  `, context);

  const mainMarkup = document.getElementById('main-area').innerHTML;
  const snapshotMarkup = document.getElementById('sidebar-live-snapshot').innerHTML;
  assert.match(mainMarkup, /Har-Nessie/);
  assert.match(mainMarkup, /문서와 메모리를 바탕으로 장기 작업을 운영하는 로컬 하네스/);
  assert.match(mainMarkup, /Surfacing your deep issues/);
  assert.match(mainMarkup, /자동화 신뢰도/);
  assert.match(mainMarkup, /누적 프로젝트 메모리/);
  assert.match(mainMarkup, /문서 많은 제품\/서비스/);
  assert.match(snapshotMarkup, /Control Plane/);
  assert.match(snapshotMarkup, /먼저 확인이 필요한 작업이 1개 있습니다/);
  assert.match(snapshotMarkup, /즉시 진행/);
});

test('english mode localizes project operations screens without mixed korean text', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    HarnessUiHelpers.setUiLanguage('en');
    projects = [{
      id: 'project-alpha',
      title: 'Project Alpha',
      status: 'active',
      rootPath: 'D:/repos/project-alpha',
      defaultPresetId: 'docs-spec-first',
      currentPhaseId: 'phase-1',
      defaultSettings: {
        providerProfile: { coordinationProvider: 'codex', workerProvider: 'codex' },
        continuationPolicy: { mode: 'guided', keepDocsInSync: true, autoQualitySweepOnPhaseComplete: true },
        toolProfile: { id: 'default', label: 'Default' },
        browserVerification: {},
        devServer: {}
      }
    }];
    projectOverviewState.set('project-alpha', {
      project: {
        ...projects[0],
        retention: {
          policy: 'preview-only',
          runCounts: { total: 4, active: 1, completed: 2, stoppedOrFailed: 1 },
          sharedMemoryExists: false,
          qualitySweepCount: 1,
          cleanupTaskCount: 2
        },
        runtimeReadiness: {
          browser: {
            configured: false,
            ready: false,
            policyLabel: '선택적',
            policyNote: '기본 harness 운영에서는 Playwright optional 정책을 유지합니다.',
            note: '브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.'
          }
        },
        healthDashboard: {
          status: 'attention',
          statusLabel: '운영 주의',
          successor: {
            ready: false,
            title: '검토 대기 먼저 해소',
            detail: '사람 확인이 필요한 계획/질문이 남아 있어 다음 run 자동 연결보다 검토 해소가 먼저입니다.'
          },
          docsDrift: {
            level: 'high',
            summary: '최근 구현 변경이 문서 반영 없이 누적되어 docs drift 가능성이 높습니다.',
            recommendedAction: '재분석 후 docs-first maintenance run으로 문서와 backlog를 다시 맞추는 편이 안전합니다.',
            reintakeRecommended: true
          },
          repeatedFailures: {
            warning: true,
            summary: '최근 반복 실패 패턴은 아직 뚜렷하지 않습니다.'
          },
          runtimeObservability: {
            warning: true,
            browserPolicyLabel: '선택적',
            headline: '주의해서 볼 런타임 신호가 있습니다.',
            detail: '브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.',
            highlights: []
          },
          reminder: {
            title: '현재 cadence 양호',
            detail: '지금은 권장 다음 작업 초안으로 현재 단계를 이어가면 됩니다.'
          },
          docsFlow: {
            label: '문서 기준 프로젝트',
            detail: '다음 run도 docs/source-of-record와 구현을 함께 맞추는 흐름이 권장됩니다.'
          },
          runtimeObservability: {
            warning: true,
            browserPolicyLabel: '선택적',
            headline: '주의해서 볼 런타임 신호가 있습니다.',
            detail: '브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.',
            highlights: ['Compose the guided inbox flow: Escalation handoff still drops linked evidence in the review step.']
          }
        }
      },
      phases: [{
        id: 'phase-1',
        title: 'Delivery',
        goal: 'Close the docs-backed slice.',
        status: 'active',
        phaseContract: null,
        runCounts: { running: 0, completed: 1 },
        carryOverTasks: [],
        pendingReview: [],
        backlogLineage: [],
        openRisks: [],
        cleanupLane: [],
        recentRuns: []
      }]
    });
    selectedProjectId = 'project-alpha';
    renderDetail();
  `, context);

  const mainMarkup = document.getElementById('main-area').innerHTML;
  assert.match(mainMarkup, /Project operations/);
  assert.match(mainMarkup, /Attention needed/);
  assert.match(mainMarkup, /Clear pending review first/);
  assert.match(mainMarkup, /Cadence looks healthy/);
  assert.match(mainMarkup, /Docs-first project/);
  assert.match(mainMarkup, /You can continue the current phase with the suggested next-run draft now\./);
  assert.match(mainMarkup, /Re-analyze and run a docs-first maintenance pass to realign docs and backlog\./);
  assert.match(mainMarkup, /Compose the guided inbox flow: Escalation handoff still drops linked evidence in the review step\./);
  assert.match(mainMarkup, /Show detailed operations and history/);
  assert.doesNotMatch(mainMarkup, /검토 대기 먼저 해소|현재 cadence 양호|문서 기준 프로젝트|지금은 권장 다음 작업 초안으로 현재 단계를 이어가면 됩니다|큰 흐름이 바뀌면 docs도 같은 run 안에서 함께 갱신합니다/);
});

test('english mode localizes project list cards and artifact tabs without korean fallback text', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    HarnessUiHelpers.setUiLanguage('en');
    projects = [{
      id: 'project-beta',
      title: 'Project Beta',
      status: 'active',
      rootPath: '',
      defaultPresetId: 'docs-spec-first',
      phases: [],
      currentPhaseId: ''
    }];
    selectedProjectId = '';
    renderProjectList();
  `, context);

  const projectListMarkup = document.getElementById('project-list').innerHTML;
  assert.match(projectListMarkup, /No active phase/);
  assert.match(projectListMarkup, /0 phase\(s\)/);
  assert.match(projectListMarkup, /No root path/);
  assert.doesNotMatch(projectListMarkup, /활성 단계 없음|단계 0개|root 미지정/);

  const artifactMarkup = vm.runInContext(`
    HarnessUiHelpers.setUiLanguage('en');
    artifactSubTab = 'browser';
    renderArtifactTabs({
      browserVerification: {
        status: 'failed',
        targetUrl: 'http://127.0.0.1:3000',
        selector: '',
        note: ''
      },
      actionRecords: [
        { capabilityId: 'verification', status: 'completed', actionClass: 'verification', provider: 'local-shell', at: '2026-04-03T00:00:00.000Z' }
      ],
      codeContext: {
        summary: 'Context summary',
        queryTokens: ['alpha'],
        relatedFiles: []
      }
    }, ${JSON.stringify(makeTask('T001', 'review browser state'))}, 'browser')
  `, context);
  assert.match(artifactMarkup, /Browser verification/);
  assert.match(artifactMarkup, />Handoff</);
  assert.match(artifactMarkup, />Timeline</);
  assert.match(artifactMarkup, />Actions</);
  assert.match(artifactMarkup, />Context</);
  assert.match(artifactMarkup, /None/);
  assert.doesNotMatch(artifactMarkup, /없음|타임라인|액션|문맥/);
});

test('create run context shows inherited project defaults', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    projects = [{
      id: 'project-beta',
      title: 'Project Beta',
      rootPath: 'D:/repos/project-beta',
      currentPhaseId: 'phase-1',
      defaultPresetId: 'existing-repo-feature',
      defaultSettings: {
        providerProfile: { coordinationProvider: 'claude', workerProvider: 'gemini' },
        toolProfile: { id: 'safe', label: 'Safe Profile' },
        browserVerification: { url: 'http://127.0.0.1:3000' },
        devServer: { command: 'npm run preview' }
      },
      phases: [{ id: 'phase-1', title: 'Delivery' }]
    }];
    selectedProjectId = 'project-beta';
    openCreateModal();
  `, context);

  const markup = document.getElementById('create-run-context').innerHTML;
  assert.match(markup, /Project Beta/);
  assert.match(markup, /Delivery/);
  assert.match(markup, /기본 작업 방식/);
  assert.match(markup, /Claude가 계획\/검토 · Gemini가 구현/);
  assert.match(markup, /Safe Profile/);
  assert.match(markup, /브라우저 확인 기본 정책: 이 프로젝트 baseline/);
  assert.match(markup, /http:\/\/127\.0\.0\.1:3000/);
  assert.match(markup, /npm run preview/);
});

test('guided project flow prefills the recommended next run draft', async () => {
  const { context, document } = await createUiHarness();
  vm.runInContext(`
    projects = [{
      id: 'project-beta',
      title: 'Project Beta',
      rootPath: 'D:/repos/project-beta',
      currentPhaseId: 'phase-1',
      defaultPresetId: 'docs-spec-first',
      defaultSettings: {
        continuationPolicy: {
          mode: 'guided',
          autoQualitySweepOnPhaseComplete: false,
          keepDocsInSync: true
        }
      },
      phases: [{ id: 'phase-1', title: 'Delivery', goal: 'Close the current docs-backed slice.' }]
    }];
    projectOverviewState.set('project-beta', {
      project: projects[0],
      phases: [{
        id: 'phase-1',
        title: 'Delivery',
        goal: 'Close the current docs-backed slice.',
        status: 'active',
        carryOverTasks: [{
          taskId: 'T021',
          title: 'Refresh document-driven backlog',
          summary: 'Update docs and continue implementation from the latest source of record.'
        }],
        pendingReview: [],
        cleanupLane: [],
        latestQualitySweep: null,
        backlogLineage: [],
        openRisks: [],
        recentRuns: []
      }]
    });
    selectedProjectId = 'project-beta';
    openCreateModal();
  `, context);

  assert.equal(document.getElementById('run-title-input').value, 'Project Beta-t021');
  assert.match(document.getElementById('run-objective-input').value, /T021/);
  assert.match(document.getElementById('run-objective-input').value, /Refresh document-driven backlog/);
  assert.match(document.getElementById('run-success-criteria-input').value, /문서|source of record/);
  assert.match(document.getElementById('create-run-context').innerHTML, /연속 작업 운영: 권장 초안 자동 준비/);
});

test('project intake analysis prefills project form and opens a first-run draft', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  document.getElementById('project-root-input').value = 'D:/repos/write_claw';
  document.getElementById('project-title-input').value = 'write_claw';

  fetchStub.queue('/api/projects/intake', {
    rootPath: 'D:/repos/write_claw',
    preflight: {
      ready: true,
      project: {
        isGitRepo: true,
        worktreeEligible: true
      },
      blockers: [],
      warnings: [],
      autonomy: {
        label: '안전 자동화',
        score: 92,
        tier: 'safe_auto',
        summary: '현재 상태는 비교적 안전하게 자동 진행할 수 있습니다.'
      }
    },
    repo: {
      titleSuggestion: 'write_claw',
      validationCommands: ['npm run test', 'npm run lint'],
      summary: 'Suggested validation commands'
    },
    docs: {
      candidates: [
        { relativePath: 'README.md', kind: 'overview', sourceRoot: '', snippet: '프로젝트 개요' },
        { relativePath: 'docs/product-specs/editor.md', kind: 'spec', sourceRoot: 'docs/product-specs', snippet: 'Editor spec' },
        { relativePath: 'docs/exec-plans/phase-1.md', kind: 'plan', sourceRoot: 'docs/exec-plans', snippet: 'Foundation backlog' }
      ],
      specFolderCandidates: [
        { root: 'docs/product-specs', docCount: 1, kinds: ['spec'], recommended: true },
        { root: 'docs/exec-plans', docCount: 1, kinds: ['plan'], recommended: true }
      ],
      selectedSpecRoots: ['docs/product-specs'],
      recommendedSpecFiles: ['D:/repos/write_claw/README.md', 'D:/repos/write_claw/docs/product-specs/editor.md'],
      recommendedSpecDetails: [
        { path: 'D:/repos/write_claw/README.md', relativePath: 'README.md', kind: 'overview', selectionReason: '프로젝트 전체 개요를 빠르게 잡는 최상위 문서라서 포함했습니다.' },
        { path: 'D:/repos/write_claw/docs/product-specs/editor.md', relativePath: 'docs/product-specs/editor.md', kind: 'spec', selectionReason: '선택한 문서 묶음(docs/product-specs) 안의 핵심 명세 문서라서 포함했습니다.' }
      ]
    },
    recommendedProject: {
      title: 'write_claw',
      defaultPresetId: 'existing-repo-feature',
      phaseTitle: 'Project Intake',
      phaseGoal: 'docs와 repo를 대조해 backlog를 고정한다.',
      charterText: 'write_claw 프로젝트는 문서를 system of record로 삼는다.'
    },
    starterRunDraft: {
      title: 'write_claw-intake',
      presetId: 'docs-spec-first',
      objective: '현재 저장소와 docs를 분석해 phase/task backlog를 만든다.',
      successCriteria: '핵심 docs와 repo 구조를 근거로 실행 가능한 backlog를 정리한다.',
      excludedScope: '초기 intake run에서는 넓은 구현을 하지 않는다.',
      specFiles: ['D:/repos/write_claw/README.md', 'D:/repos/write_claw/docs/product-specs/editor.md'],
      specFilesText: 'D:/repos/write_claw/README.md\nD:/repos/write_claw/docs/product-specs/editor.md'
    }
  });
  fetchStub.queue('/api/projects/intake', {
    rootPath: 'D:/repos/write_claw',
    preflight: {
      ready: true,
      project: {
        isGitRepo: true,
        worktreeEligible: true
      },
      blockers: [],
      warnings: [],
      autonomy: {
        label: '안전 자동화',
        score: 92,
        tier: 'safe_auto',
        summary: '현재 상태는 비교적 안전하게 자동 진행할 수 있습니다.'
      }
    },
    repo: {
      titleSuggestion: 'write_claw',
      validationCommands: ['npm run test', 'npm run lint'],
      summary: 'Suggested validation commands'
    },
    docs: {
      candidates: [
        { relativePath: 'README.md', kind: 'overview', sourceRoot: '', snippet: '프로젝트 개요' },
        { relativePath: 'docs/product-specs/editor.md', kind: 'spec', sourceRoot: 'docs/product-specs', snippet: 'Editor spec' },
        { relativePath: 'docs/exec-plans/phase-1.md', kind: 'plan', sourceRoot: 'docs/exec-plans', snippet: 'Foundation backlog' }
      ],
      specFolderCandidates: [
        { root: 'docs/product-specs', docCount: 1, kinds: ['spec'], recommended: true },
        { root: 'docs/exec-plans', docCount: 1, kinds: ['plan'], recommended: true }
      ],
      selectedSpecRoots: ['docs/exec-plans'],
      recommendedSpecFiles: ['D:/repos/write_claw/README.md', 'D:/repos/write_claw/docs/exec-plans/phase-1.md'],
      recommendedSpecDetails: [
        { path: 'D:/repos/write_claw/README.md', relativePath: 'README.md', kind: 'overview', selectionReason: '프로젝트 전체 개요를 빠르게 잡는 최상위 문서라서 포함했습니다.' },
        { path: 'D:/repos/write_claw/docs/exec-plans/phase-1.md', relativePath: 'docs/exec-plans/phase-1.md', kind: 'plan', selectionReason: '선택한 문서 묶음(docs/exec-plans) 안의 실행 계획 문서라서 포함했습니다.' }
      ]
    },
    recommendedProject: {
      title: 'write_claw',
      defaultPresetId: 'existing-repo-feature',
      phaseTitle: 'Project Intake',
      phaseGoal: 'docs와 repo를 대조해 backlog를 고정한다.',
      charterText: 'write_claw 프로젝트는 문서를 system of record로 삼는다.'
    },
    starterRunDraft: {
      title: 'write_claw-intake',
      presetId: 'docs-spec-first',
      objective: '현재 저장소와 docs를 분석해 phase/task backlog를 만든다.',
      successCriteria: '핵심 docs와 repo 구조를 근거로 실행 가능한 backlog를 정리한다.',
      excludedScope: '초기 intake run에서는 넓은 구현을 하지 않는다.',
      specFiles: ['D:/repos/write_claw/README.md', 'D:/repos/write_claw/docs/exec-plans/phase-1.md'],
      specFilesText: 'D:/repos/write_claw/README.md\nD:/repos/write_claw/docs/exec-plans/phase-1.md'
    }
  });

  await vm.runInContext('analyzeProjectIntakeDraft()', context);

  const intakeMarkup = document.getElementById('project-intake-results').innerHTML;
  assert.match(intakeMarkup, /현재 저장소 분석 결과/);
  assert.match(intakeMarkup, /지금 가장 추천하는 다음 행동/);
  assert.match(intakeMarkup, /자동화 신뢰도 안전 자동화 \(92\)/);
  assert.match(intakeMarkup, /프로젝트<\/strong><div>단계, 기본 작업 방식, 담당 AI, 정리 점검, 이어받을 작업, 공유 메모리를 오래 유지하는 작업 상자입니다/);
  assert.match(intakeMarkup, /README\.md/);
  assert.match(intakeMarkup, /추천 첫 작업/);
  assert.match(intakeMarkup, /명세로 볼 폴더 선택/);
  assert.match(intakeMarkup, /버튼 의미/);
  assert.match(intakeMarkup, /권장: 프로젝트 \+ 첫 작업 생성/);
  assert.match(intakeMarkup, /docs\/product-specs/);
  assert.match(intakeMarkup, /핵심 명세 문서라서 포함했습니다/);
  assert.match(intakeMarkup, /쉽게 말해 이렇게 고릅니다/);
  assert.match(intakeMarkup, /생성 후 바로 할 일/);
  assert.match(intakeMarkup, /명세 경로를 복사했습니다/);
  assert.equal(document.getElementById('project-charter-input').value, 'write_claw 프로젝트는 문서를 system of record로 삼는다.');
  assert.equal(document.getElementById('project-default-preset-input').value, 'existing-repo-feature');
  assert.equal(document.getElementById('project-phase-title-input').value, 'Project Intake');
  assert.equal(document.getElementById('bootstrap-project-docs').checked, false);
  assert.equal(document.getElementById('project-submit-btn').textContent, '권장: 프로젝트 + 첫 작업 생성');
  assert.equal(document.getElementById('project-create-only-btn').style.display, 'inline-flex');
  assert.match(document.getElementById('project-footer-hint').textContent, /바로 시작할 수 있습니다/);

  await vm.runInContext(`toggleProjectIntakeSpecRoot('docs/exec-plans')`, context);
  const secondIntakeRequest = fetchStub.requests.filter((entry) => entry.url === '/api/projects/intake').at(-1);
  assert.deepEqual(JSON.parse(String(secondIntakeRequest?.options?.body || '{}')).selectedSpecRoots, ['docs/product-specs', 'docs/exec-plans']);

  vm.runInContext('applyProjectIntakeDraft()', context);
  assert.equal(document.getElementById('project-charter-input').value, 'write_claw 프로젝트는 문서를 system of record로 삼는다.');
  assert.equal(document.getElementById('project-default-preset-input').value, 'existing-repo-feature');
  assert.equal(document.getElementById('project-phase-title-input').value, 'Project Intake');

  vm.runInContext('openStarterRunFromIntake()', context);
  assert.equal(document.getElementById('create-modal').style.display, 'flex');
  assert.equal(document.getElementById('run-title-input').value, 'write_claw-intake');
  assert.equal(document.getElementById('run-preset-input').value, 'docs-spec-first');
  assert.equal(document.getElementById('run-spec-files-input').value, 'D:/repos/write_claw/README.md\nD:/repos/write_claw/docs/exec-plans/phase-1.md');
  assert.match(document.getElementById('create-run-context').innerHTML, /프로젝트 분석 추천 초안/);
});

test('docs-first preset applies the higher parallel default in the create form', async () => {
  const { context, document } = await createUiHarness();

  document.getElementById('run-preset-input').value = 'docs-spec-first';
  vm.runInContext(`applyRunPresetDefaults('docs-spec-first')`, context);

  assert.equal(document.getElementById('run-max-parallel-input').value, '2');
  assert.equal(document.getElementById('run-max-task-attempts-input').value, '2');
  assert.equal(document.getElementById('run-max-goal-loops-input').value, '4');
});

test('settings modal can fill and save preset strategy templates', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  vm.runInContext(`
    projects = [{ id: 'project-alpha', title: 'Alpha', defaultPresetId: 'existing-repo-feature', rootPath: 'D:/alpha', phases: [] }];
    selectedProjectId = 'project-alpha';
  `, context);
  fetchStub.queue('/api/settings', {
    includeGlobalAgents: true,
    includeKarpathyGuidelines: true,
    customConstitution: '',
    plannerStrategy: '',
    teamStrategy: '',
    coordinationProvider: 'codex',
    workerProvider: 'codex',
    codexRuntimeProfile: 'yolo',
    uiLanguage: 'ko',
    agentLanguage: 'ko',
    codexNotes: '',
    claudeNotes: '',
    geminiNotes: '',
    claudeModel: '',
    geminiModel: '',
    geminiProjectId: ''
  });
  fetchStub.queue('/api/settings', {
    includeGlobalAgents: true,
    includeKarpathyGuidelines: true,
    customConstitution: 'saved constitution',
    plannerStrategy: 'saved planner',
    teamStrategy: 'saved team',
    coordinationProvider: 'codex',
    workerProvider: 'codex',
    codexRuntimeProfile: 'yolo',
    uiLanguage: 'ko',
    agentLanguage: 'ko',
    codexNotes: '',
    claudeNotes: '',
    geminiNotes: '',
    claudeModel: '',
    geminiModel: '',
    geminiProjectId: ''
  });

  await vm.runInContext('openSettingsModal()', context);
  assert.equal(document.getElementById('settings-strategy-template').value, 'existing-repo-feature');

  document.getElementById('settings-strategy-template').value = 'docs-spec-first';
  document.getElementById('apply-strategy-template-btn').dispatchEvent('click');

  assert.match(document.getElementById('custom-constitution').value, /source of record/i);
  assert.match(document.getElementById('planner-strategy').value, /scope-locking|doc-alignment/i);
  assert.match(document.getElementById('team-strategy').value, /spec-locker|verifier/i);

  document.getElementById('harness-settings-form').dispatchEvent('submit', {
    preventDefault() {}
  });
  await flush();
  await flush();

  const saveRequest = fetchStub.requests.find((entry) => entry.url === '/api/settings' && entry.options?.method === 'POST');
  const body = JSON.parse(String(saveRequest?.options?.body || '{}'));
  assert.match(body.customConstitution, /source of record/i);
  assert.match(body.plannerStrategy, /scope-locking|doc-alignment/i);
  assert.match(body.teamStrategy, /spec-locker|verifier/i);
});

test('parallel reason explains shared-workspace fallback and directory collisions', async () => {
  const { context } = await createUiHarness();

  const downgradedReason = vm.runInContext(`deriveParallelReason(${JSON.stringify({
    tasks: [],
    settings: { maxParallel: 2 },
    profile: { flowProfile: 'hybrid' },
    executionPolicy: { parallelMode: 'sequential' },
    preflight: { project: { worktreeEligible: false } }
  })})`, context);
  assert.match(downgradedReason, /공유 워크스페이스 상태라 병렬 실행을 잠시 끄고 1개씩 진행합니다/);

  const collisionReason = vm.runInContext(`deriveParallelReason(${JSON.stringify({
    tasks: [
      { id: 'T001', status: 'ready', dependsOn: [], filesLikely: ['docs/'], title: 'A' },
      { id: 'T002', status: 'ready', dependsOn: [], filesLikely: ['docs/guide.md'], title: 'B' }
    ],
    settings: { maxParallel: 2 },
    profile: { flowProfile: 'hybrid' },
    executionPolicy: { parallelMode: 'parallel' },
    preflight: { project: { worktreeEligible: true } }
  })})`, context);
  assert.match(collisionReason, /T001-T002/);

  const subsystemReason = vm.runInContext(`deriveParallelReason(${JSON.stringify({
    tasks: [
      { id: 'T003', status: 'ready', dependsOn: [], filesLikely: ['src/auth/login.ts'], title: 'Login' },
      { id: 'T004', status: 'ready', dependsOn: [], filesLikely: ['src/auth/session.ts'], title: 'Session' }
    ],
    settings: { maxParallel: 2 },
    profile: { flowProfile: 'hybrid' },
    executionPolicy: { parallelMode: 'parallel' },
    preflight: { project: { worktreeEligible: true } }
  })})`, context);
  assert.match(subsystemReason, /T003-T004/);

  const adaptiveReason = vm.runInContext(`deriveParallelReason(${JSON.stringify({
    tasks: [
      { id: 'T010', status: 'ready', dependsOn: [], filesLikely: ['src/a.ts'], title: 'A', attempts: 1 },
      { id: 'T011', status: 'failed', dependsOn: [], filesLikely: ['src/b.ts'], title: 'B', attempts: 1 }
    ],
    settings: { maxParallel: 2 },
    profile: { flowProfile: 'hybrid' },
    executionPolicy: { parallelMode: 'parallel' },
    memory: { failureAnalytics: { retryCount: 2, verificationFailures: 1, scopeDriftCount: 1 } },
    metrics: { replanHighDriftCount: 1 },
    preflight: { project: { worktreeEligible: true } }
  })})`, context);
  assert.match(adaptiveReason, /adaptive parallelism/i);
});

test('draft diagnostics shows autonomy trust level and stronger input warnings', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  document.getElementById('project-path-input').value = 'D:/repos/write_claw';
  document.getElementById('run-objective-input').value = '온보딩';
  document.getElementById('run-success-criteria-input').value = '';
  document.getElementById('run-protected-areas-input').value = '';
  document.getElementById('run-excluded-scope-input').value = '';

  fetchStub.queue('/api/diagnostics', {
    ready: true,
    project: { isGitRepo: true, worktreeEligible: false },
    blockers: [],
    warnings: [
      '성공 조건이 비어 있어 완료 판단이 애매해질 수 있습니다.',
      '변경 금지 영역이 비어 있습니다. 건드리면 안 되는 영역이 있으면 적어 두는 편이 안전합니다.'
    ],
    autonomy: {
      label: '사람 확인 필수',
      score: 42,
      tier: 'manual_required',
      summary: '실행은 가능하지만, 지금 상태는 자동으로 맡기기보다 먼저 사람이 확인하는 편이 안전합니다.'
    },
    actionPlan: [
      { title: '먼저 시작 전 정리로 좁히기', description: '구현보다 먼저 범위와 완료 기준을 정리하는 작업으로 시작하는 편이 안전합니다.' }
    ]
  });

  await vm.runInContext('diagnoseDraft()', context);

  const request = fetchStub.requests.find((entry) => entry.url === '/api/diagnostics');
  const body = JSON.parse(String(request?.options?.body || '{}'));
  assert.equal(body.objective, '온보딩');
  assert.equal(body.successCriteria, '');
  assert.equal(body.protectedAreas, '');

  const markup = document.getElementById('draft-diagnostics').innerHTML;
  assert.match(markup, /자동화 신뢰도/);
  assert.match(markup, /사람 확인 필수 \(42\)/);
  assert.match(markup, /성공 조건이 비어 있어 완료 판단이 애매해질 수 있습니다/);
  assert.match(markup, /변경 금지 영역이 비어 있습니다/);
  assert.match(markup, /먼저 시작 전 정리로 좁히기/);
});

test('project intake can create a project and first run in one flow', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  document.getElementById('project-root-input').value = 'D:/repos/write_claw';
  document.getElementById('project-title-input').value = 'write_claw';
  document.getElementById('project-charter-input').value = 'write_claw 프로젝트는 문서를 source of truth로 삼는다.';
  document.getElementById('project-default-preset-input').value = 'existing-repo-feature';
  document.getElementById('project-phase-title-input').value = '';
  document.getElementById('project-phase-goal-input').value = '';
  document.getElementById('bootstrap-project-docs').checked = true;

  vm.runInContext(`
    projectIntake = ${JSON.stringify({
      rootPath: 'D:/repos/write_claw',
      recommendedProject: {
        title: 'write_claw',
        defaultPresetId: 'existing-repo-feature',
        phaseTitle: 'Project Intake',
        phaseGoal: 'docs와 repo를 대조해 backlog를 고정한다.'
      },
      starterRunDraft: {
        title: 'write_claw-intake',
        presetId: 'docs-spec-first',
        objective: '현재 저장소와 docs를 분석해 phase/task backlog를 만든다.',
        successCriteria: '실행 가능한 backlog를 정리한다.',
        excludedScope: '넓은 구현은 하지 않는다.',
        specFilesText: 'D:/repos/write_claw/README.md'
      }
    })};
  `, context);

  fetchStub.queue('/api/projects', { id: 'project-write-claw', title: 'write_claw', rootPath: 'D:/repos/write_claw' });
  fetchStub.queue('/api/runs', { id: 'run-write-claw-intake', title: 'write_claw-intake' });
  fetchStub.queue('/api/projects', [{ id: 'project-write-claw', title: 'write_claw', rootPath: 'D:/repos/write_claw', phases: [] }]);
  fetchStub.queue('/api/runs', [{ id: 'run-write-claw-intake', title: 'write_claw-intake', status: 'draft', updatedAt: '2026-04-03T00:00:00Z', taskCounts: { total: 0, done: 0, skipped: 0, failed: 0 } }]);
  fetchStub.queue('/api/system', {});
  fetchStub.queue('/api/runs/run-write-claw-intake', { id: 'run-write-claw-intake', title: 'write_claw-intake', status: 'draft', updatedAt: '2026-04-03T00:00:00Z', tasks: [], logs: [] });
  fetchStub.queue('/api/runs/run-write-claw-intake/logs', []);

  await vm.runInContext('createProjectAndStarterRunFromIntake()', context);

  const projectRequest = fetchStub.requests.find((entry) => entry.url === '/api/projects' && entry.options?.method === 'POST');
  const runRequest = fetchStub.requests.find((entry) => entry.url === '/api/runs' && entry.options?.method === 'POST');
  const projectBody = JSON.parse(String(projectRequest?.options?.body || '{}'));
  const runBody = JSON.parse(String(runRequest?.options?.body || '{}'));

  assert.equal(projectBody.title, 'write_claw');
  assert.equal(projectBody.rootPath, 'D:/repos/write_claw');
  assert.equal(projectBody.phases?.[0]?.title, 'Project Intake');
  assert.equal(runBody.projectId, 'project-write-claw');
  assert.equal(runBody.presetId, 'docs-spec-first');
  assert.equal(runBody.settings?.maxParallel, 2);
  assert.equal(runBody.settings?.maxTaskAttempts, 2);
  assert.equal(runBody.settings?.maxGoalLoops, 4);
  assert.match(runBody.specText, /성공 조건/);
  assert.equal(vm.runInContext('selectedRunId', context), 'run-write-claw-intake');
});

test('project intake switches the footer primary action to create project and first run', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  document.getElementById('project-root-input').value = 'D:/repos/write_claw';
  document.getElementById('project-title-input').value = 'write_claw';

  fetchStub.queue('/api/projects/intake', {
    rootPath: 'D:/repos/write_claw',
    preflight: {
      ready: true,
      project: { isGitRepo: true, worktreeEligible: true },
      blockers: [],
      warnings: [],
      autonomy: { label: '안전 자동화', score: 90, tier: 'safe_auto', summary: '바로 맡겨도 되는 편입니다.' }
    },
    repo: { validationCommands: ['npm test'] },
    docs: { candidates: [], specFolderCandidates: [], recommendedSpecFiles: [], recommendedSpecDetails: [] },
    recommendedProject: {
      title: 'write_claw',
      defaultPresetId: 'docs-spec-first',
      phaseTitle: 'Project Intake',
      phaseGoal: 'docs를 읽고 첫 backlog를 고정한다.'
    },
    starterRunDraft: {
      title: 'write_claw-intake',
      presetId: 'docs-spec-first',
      objective: '현재 repo와 docs를 분석해 첫 backlog를 만든다.',
      successCriteria: '첫 backlog와 검증 기준을 고정한다.',
      excludedScope: '넓은 구현은 하지 않는다.',
      specFilesText: 'D:/repos/write_claw/README.md'
    }
  });

  await vm.runInContext('analyzeProjectIntakeDraft()', context);

  assert.equal(document.getElementById('project-submit-btn').textContent, '권장: 프로젝트 + 첫 작업 생성');
  assert.equal(document.getElementById('project-create-only-btn').style.display, 'inline-flex');
  assert.match(document.getElementById('project-footer-hint').textContent, /권장 버튼/);
});

test('unrelated SSE run events do not refresh the selected project overview', async () => {
  const { context, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-alpha', {
    project: { id: 'project-alpha', title: 'Alpha', currentPhaseId: 'phase-a' },
    phases: [],
    maintenance: {}
  });
  vm.runInContext(`
    projects = [{ id: 'project-alpha', title: 'Alpha', rootPath: 'D:/alpha', phases: [{ id: 'phase-a', title: 'Alpha Phase' }], currentPhaseId: 'phase-a' }];
  `, context);
  await vm.runInContext(`selectProject('project-alpha')`, context);
  fetchStub.calls.length = 0;

  const eventSource = context.__lastEventSource;
  await eventSource.onmessage({
    data: JSON.stringify({
      runId: 'run-foreign',
      type: 'state',
      summary: {
        id: 'run-foreign',
        title: 'Foreign Run',
        status: 'running',
        updatedAt: '2026-04-03T10:00:00Z',
        projectId: 'project-other',
        taskCounts: { ready: 0, in_progress: 1, done: 0, failed: 0, skipped: 0, total: 1 }
      }
    })
  });
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 180));
  await flush();

  assert.equal(fetchStub.calls.includes('/api/projects/project-alpha'), false);
});

test('manual project create can omit the first phase and keep phases empty', async () => {
  const { context, document } = await createUiHarness();
  document.getElementById('project-title-input').value = 'write_claw';
  document.getElementById('project-root-input').value = 'D:/repos/write_claw';
  document.getElementById('project-charter-input').value = '문서와 코드 분석을 함께 본다.';
  document.getElementById('project-default-preset-input').value = 'docs-spec-first';
  document.getElementById('project-phase-title-input').value = '';
  document.getElementById('project-phase-goal-input').value = '';
  document.getElementById('bootstrap-project-docs').checked = true;

  const payload = vm.runInContext(`
    buildProjectPayloadFromForm(new FormData(document.getElementById('project-form')))
  `, context);

  assert.equal(payload.title, 'write_claw');
  assert.equal(payload.rootPath, 'D:/repos/write_claw');
  assert.equal(payload.defaultPresetId, 'docs-spec-first');
  assert.equal(Array.isArray(payload.phases), true);
  assert.equal(payload.phases.length, 0);
});

test('project detail can append and activate a new phase', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-alpha', {
    project: { id: 'project-alpha', title: 'Alpha', status: 'completed', currentPhaseId: '', rootPath: 'D:/alpha', defaultSettings: {}, retention: {} },
    phases: []
  });
  vm.runInContext(`
    projects = [{ id: 'project-alpha', title: 'Alpha', status: 'completed', rootPath: 'D:/alpha', phases: [], currentPhaseId: '' }];
  `, context);
  await vm.runInContext(`selectProject('project-alpha')`, context);

  document.getElementById('project-new-phase-title').value = 'Phase 2';
  document.getElementById('project-new-phase-goal').value = 'Add the next feature slice.';

  fetchStub.queue('/api/projects/project-alpha', {
    id: 'project-alpha',
    title: 'Alpha',
    status: 'active',
    currentPhaseId: 'P001',
    rootPath: 'D:/alpha',
    phases: [{ id: 'P001', title: 'Phase 2', goal: 'Add the next feature slice.', status: 'active' }]
  });
  fetchStub.queue('/api/projects/project-alpha', {
    project: { id: 'project-alpha', title: 'Alpha', status: 'active', currentPhaseId: 'P001', rootPath: 'D:/alpha', defaultSettings: {}, retention: {} },
    phases: [{ id: 'P001', title: 'Phase 2', goal: 'Add the next feature slice.', status: 'active', runCounts: {}, carryOverTasks: [], pendingReview: [], backlogLineage: [], openRisks: [], cleanupLane: [], recentRuns: [], phaseContract: { goal: 'Add the next feature slice.', deliverables: [], verification: [], nonNegotiables: [], outOfScope: [], carryOverRules: [] } }]
  });
  fetchStub.queue('/api/projects', [{ id: 'project-alpha', title: 'Alpha', status: 'active', rootPath: 'D:/alpha', phases: [{ id: 'P001', title: 'Phase 2' }], currentPhaseId: 'P001' }]);

  await vm.runInContext('addProjectPhase(true)', context);

  const requestEntry = fetchStub.requests.find((entry) => entry.url === '/api/projects/project-alpha' && entry.options?.method === 'POST');
  const body = JSON.parse(String(requestEntry?.options?.body || '{}'));
  assert.equal(body.phases?.[0]?.title, 'Phase 2');
  assert.equal(body.phases?.[0]?.status, 'active');
  assert.equal(document.getElementById('project-new-phase-title').value, '');
  assert.equal(document.getElementById('project-new-phase-goal').value, '');
});

test('project detail can reanalyze an existing project into a first-run draft', async () => {
  const { context, document, fetchStub } = await createUiHarness();
  fetchStub.queue('/api/projects/project-alpha', {
    project: { id: 'project-alpha', title: 'Alpha', status: 'active', currentPhaseId: 'P001', rootPath: 'D:/alpha', defaultSettings: {}, retention: {} },
    phases: [{ id: 'P001', title: 'Foundation', status: 'active', runCounts: {}, carryOverTasks: [], pendingReview: [], backlogLineage: [], openRisks: [], cleanupLane: [], recentRuns: [], phaseContract: { goal: 'Initial', deliverables: [], verification: [], nonNegotiables: [], outOfScope: [], carryOverRules: [] } }]
  });
  vm.runInContext(`
    projects = [{ id: 'project-alpha', title: 'Alpha', status: 'active', rootPath: 'D:/alpha', phases: [{ id: 'P001', title: 'Foundation' }], currentPhaseId: 'P001' }];
  `, context);
  await vm.runInContext(`selectProject('project-alpha')`, context);

  fetchStub.queue('/api/projects/intake', {
    rootPath: 'D:/alpha',
    preflight: { ready: true, project: { isGitRepo: true, worktreeEligible: true }, blockers: [], warnings: [] },
    repo: { titleSuggestion: 'Alpha', validationCommands: ['npm run test'], summary: 'repo summary' },
    docs: {
      candidates: [{ relativePath: 'README.md', kind: 'overview', sourceRoot: '', snippet: 'overview' }],
      specFolderCandidates: [],
      selectedSpecRoots: [],
      recommendedSpecFiles: ['D:/alpha/README.md']
    },
    recommendedProject: {
      title: 'Alpha',
      defaultPresetId: 'existing-repo-feature',
      phaseTitle: 'Project Intake',
      phaseGoal: 'Reconcile docs and repo.',
      charterText: 'Alpha uses docs as system of record.'
    },
    starterRunDraft: {
      title: 'alpha-intake',
      presetId: 'docs-spec-first',
      objective: 'Analyze docs and repo again.',
      successCriteria: 'Lock the next backlog.',
      excludedScope: 'No wide implementation.',
      specFilesText: 'D:/alpha/README.md'
    }
  });

  await vm.runInContext('reintakeProjectUi()', context);

  assert.equal(document.getElementById('create-modal').style.display, 'flex');
  assert.equal(document.getElementById('run-title-input').value, 'alpha-intake');
  assert.equal(document.getElementById('run-preset-input').value, 'docs-spec-first');
  assert.equal(document.getElementById('run-spec-files-input').value, 'D:/alpha/README.md');
});
