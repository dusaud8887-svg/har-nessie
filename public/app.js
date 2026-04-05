    if (!window.HarnessUiState?.createUiState || !window.HarnessUiState?.bindGlobalState) {
      throw new Error('Harness UI state module failed to load.');
    }
    const uiState = window.HarnessUiState.createUiState();
    window.HarnessUiState.bindGlobalState(uiState, [
      'runs',
      'projects',
      'selectedRunId',
      'selectedProjectId',
      'selectedTab',
      'selectedTaskId',
      'artifactState',
      'projectOverviewState',
      'clarifyDraftAnswers',
      'harnessSettings',
      'systemInfo',
      'draftDiagnostics',
      'refreshTimer',
      'projectOverviewRefreshTimer',
      'busyActions',
      'planEditAgents',
      'planEditTasks',
      'skipTaskTargetId',
      'artifactLoadingKey',
      'detailUiStateByView',
      'currentDetailViewKey',
      'runSelectionSeq',
      'projectSearchQuery',
      'runSearchQuery',
      'projectFilterMode',
      'projectIntake',
      'projectIntakeSelectedRoots',
      'createRunDraftContext',
      'recentPhaseTransitionsByProjectId',
      'bannerState',
      'toastState',
      'bannerTimer',
      'toastTimer'
    ]);

    function currentUiText(ko, en = '') {
      const picker = window.HarnessUiHelpers?.pickText;
      return picker ? picker(ko, en) : String(ko || en || '');
    }

    function safeParseJson(text) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    function buildResponseError(response, text) {
      const parsed = safeParseJson(text);
      const statusCode = Number(response?.status || 0);
      if (parsed) {
        const message = parsed?.error?.message || parsed?.error || parsed?.message || response.statusText;
        const requestId = parsed?.requestId ? ` [${parsed.requestId}]` : '';
        const error = new Error(`${message}${requestId}`);
        error.statusCode = statusCode;
        error.status = statusCode;
        return error;
      }
      const error = new Error(text || response.statusText);
      error.statusCode = statusCode;
      error.status = statusCode;
      return error;
    }

    async function request(url, options = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const headers = options.body ? { 'content-type': 'application/json' } : {};
        const response = await fetch(url, { headers, signal: controller.signal, ...options });
        if (!response.ok) {
          const text = await response.text();
          throw buildResponseError(response, text);
        }
        return response.json();
      } catch (err) {
        if (err.name === 'AbortError') throw new Error(currentUiText('요청 시간이 초과되었습니다 (30초). 서버가 바쁠 수 있습니다.', 'The request timed out after 30 seconds. The server may be busy.'));
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    function noticePalette(tone = 'error') {
      return tone === 'success'
        ? { bg: '#dcfce7', fg: '#166534', edge: 'rgba(22,101,52,0.16)' }
        : (tone === 'info'
          ? { bg: '#e0e7ff', fg: '#3730a3', edge: 'rgba(55,48,163,0.16)' }
          : { bg: '#fee2e2', fg: '#991b1b', edge: 'rgba(153,27,27,0.16)' });
    }

    function renderGlobalNotices() {
      const root = document.getElementById('global-banner');
      if (!root) return;
      const bannerMarkup = bannerState?.message
        ? (() => {
            const palette = noticePalette(bannerState.tone);
            return `<div style="padding:12px 14px; border-radius:12px; background:${palette.bg}; color:${palette.fg}; box-shadow: var(--shadow); border:1px solid ${palette.edge};">${escapeHtml(bannerState.message)}</div>`;
          })()
        : '';
      const toastMarkup = toastState?.message
        ? (() => {
            const palette = noticePalette(toastState.tone);
            return `
              <div data-toast="true" style="display:flex; justify-content:flex-end; margin-top:${bannerMarkup ? '10px' : '0'};">
                <div style="max-width:420px; padding:10px 12px; border-radius:14px; background:${palette.bg}; color:${palette.fg}; box-shadow:0 18px 38px rgba(15,23,42,0.14); border:1px solid ${palette.edge};">
                  <div style="font-size:11px; letter-spacing:0.08em; text-transform:uppercase; opacity:0.72;">${escapeHtml(t('자동화 알림', 'Automation notice'))}</div>
                  <div style="margin-top:4px;">${escapeHtml(toastState.message)}</div>
                </div>
              </div>
            `;
          })()
        : '';
      if (!bannerMarkup && !toastMarkup) {
        root.style.display = 'none';
        root.innerHTML = '';
        return;
      }
      root.style.display = 'block';
      root.innerHTML = `${bannerMarkup}${toastMarkup}`;
    }

    function setBanner(message = '', tone = 'error') {
      bannerState = { message: String(message || '').trim(), tone };
      if (bannerTimer) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
      }
      renderGlobalNotices();
      if (tone !== 'error') {
        bannerTimer = setTimeout(() => {
          bannerState = { message: '', tone: 'info' };
          renderGlobalNotices();
          bannerTimer = null;
        }, 2800);
      }
    }

    function setToast(message = '', tone = 'info') {
      toastState = { message: String(message || '').trim(), tone };
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      renderGlobalNotices();
      if (toastState.message) {
        toastTimer = setTimeout(() => {
          toastState = { message: '', tone: 'info' };
          renderGlobalNotices();
          toastTimer = null;
        }, 2400);
      }
    }

    function captureDetailUiState() {
      return {
        contentScrollTop: document.getElementById('content-area')?.scrollTop || 0,
        logScrollTop: document.querySelector('.log-panel')?.scrollTop || 0,
        artifactListScrollTop: document.querySelector('.artifact-list')?.scrollTop || 0,
        viewerScrollTop: document.querySelector('.viewer-content')?.scrollTop || 0
      };
    }

    function restoreDetailUiState(snapshot) {
      const content = document.getElementById('content-area');
      const logPanel = document.querySelector('.log-panel');
      const artifactList = document.querySelector('.artifact-list');
      const viewer = document.querySelector('.viewer-content');
      if (!snapshot) {
        if (content) content.scrollTop = 0;
        if (logPanel) logPanel.scrollTop = 0;
        if (artifactList) artifactList.scrollTop = 0;
        if (viewer) viewer.scrollTop = 0;
        return;
      }
      if (content) content.scrollTop = snapshot.contentScrollTop || 0;
      if (logPanel) logPanel.scrollTop = snapshot.logScrollTop || 0;
      if (artifactList) artifactList.scrollTop = snapshot.artifactListScrollTop || 0;
      if (viewer) viewer.scrollTop = snapshot.viewerScrollTop || 0;
    }

    function detailViewKey({ runId = selectedRunId, tab = selectedTab, taskId = selectedTaskId } = {}) {
      if (!runId) return '';
      return `${runId}:${tab}:${tab === 'technical' ? (taskId || '') : ''}`;
    }

    function rememberRenderedDetailUiState() {
      if (!currentDetailViewKey) return;
      detailUiStateByView.set(currentDetailViewKey, captureDetailUiState());
    }

    function restoreCurrentDetailUiState() {
      restoreDetailUiState(detailUiStateByView.get(detailViewKey()));
    }

    function clearDetailUiState(runId) {
      const prefix = `${runId}:`;
      for (const key of [...detailUiStateByView.keys()]) {
        if (key.startsWith(prefix)) {
          detailUiStateByView.delete(key);
        }
      }
      if (currentDetailViewKey.startsWith(prefix)) {
        currentDetailViewKey = '';
      }
    }

    function isBusy(action) {
      return busyActions.has(action);
    }

    async function runUiAction(action, work, successMessage = '') {
      if (isBusy(action)) return;
      busyActions.add(action);
      renderDetail();
      try {
        await work();
        if (successMessage) setBanner(successMessage, 'success');
      } catch (error) {
        setBanner(error.message || currentUiText('요청 처리 중 오류가 발생했습니다.', 'A request failed while processing your action.'));
      } finally {
        busyActions.delete(action);
        renderDetail();
      }
    }

    const {
      escapeHtml,
      clip,
      normalizeAgentModel,
      providerLabel,
      browserReadinessLabel,
      browserReadinessDetail,
      setUiLanguage,
      getUiLanguage,
      pickText
    } = window.HarnessUiHelpers || {};

    function t(ko, en = '') {
      return pickText ? pickText(ko, en) : String(ko || en || '');
    }

    function continuationModeLabel(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'manual' || value === '수동' || value === 'Manual') return t('수동', 'Manual');
      return t('권장 초안 자동 준비', 'Auto-prepare suggested draft');
    }

    function docsSyncChoiceLabel(enabled) {
      return enabled ? t('권장', 'Recommended') : t('선택', 'Optional');
    }

    function autoSweepChoiceLabel(enabled) {
      return enabled ? t('자동', 'Automatic') : t('수동', 'Manual');
    }

    function autoChainChoiceLabel(enabled) {
      return enabled ? t('활성', 'Enabled') : t('비활성', 'Disabled');
    }

    function normalizeMaxChainDepth(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }

    function browserPolicyLabelText(value, configured = false) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized.includes('baseline') || value === '이 프로젝트 baseline' || configured) return t('이 프로젝트 baseline', 'Project baseline');
      return t('선택적', 'Optional');
    }

    function renderAgentModelOptions(selected = 'codex') {
      const value = normalizeAgentModel(selected, 'codex');
      return [
        ['codex', 'Codex'],
        ['claude', 'Claude'],
        ['gemini', 'Gemini']
      ].map(([optionValue, label]) => `<option value="${optionValue}" ${value === optionValue ? 'selected' : ''}>${label}</option>`).join('');
    }

    function runProjectId(run) {
      return String(run?.projectId || run?.project?.id || '').trim();
    }

    function shouldRefreshSelectedProject(run) {
      return Boolean(selectedProjectId && runProjectId(run) && runProjectId(run) === selectedProjectId);
    }

    async function copyText(value, successMessage = '') {
      const text = String(value || '').trim();
      if (!text) return;
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error('Clipboard API unavailable');
        }
        setBanner(successMessage || t('복사했습니다.', 'Copied.'), 'success');
      } catch {
        setBanner(t(`복사할 값: ${text}`, `Copy this value: ${text}`), 'info');
      }
    }

    function renderCopyableText(value, successMessage = '') {
      const text = String(value || '').trim();
      if (!text) return `<div>${escapeHtml(t('없음', 'None'))}</div>`;
      return `
        <div class="copy-row">
          <div title="${escapeHtml(text)}">${escapeHtml(text)}</div>
          <button type="button" class="copy-btn" onclick="copyText(${JSON.stringify(text)}, ${JSON.stringify(successMessage || t('복사했습니다.', 'Copied.'))})">${escapeHtml(t('복사', 'Copy'))}</button>
        </div>
      `;
    }

    function parseStructuredSpecText(specText) {
      const text = String(specText || '').trim();
      if (!text) return [];
      const matches = [...text.matchAll(/^##\s+(.+?)\r?\n([\s\S]*?)(?=^##\s+.+|\s*$)/gm)];
      if (!matches.length) {
        return [{ title: t('추가 맥락', 'Extra context'), body: text }];
      }
      return matches
        .map((match) => ({ title: String(match[1] || '').trim(), body: String(match[2] || '').trim() }))
        .filter((section) => section.title || section.body);
    }

    function renderDetailItem(title, value, empty = '') {
      const text = clip(value || '', 500);
      return `
        <div class="detail-item">
          <strong>${escapeHtml(title)}</strong>
          <div style="white-space: pre-wrap;">${escapeHtml(text || empty || t('없음', 'None'))}</div>
        </div>
      `;
    }

    function normalizeExecutionPolicyRules(executionPolicy) {
      return window.HarnessRunRenderers?.normalizeExecutionPolicyRules
        ? window.HarnessRunRenderers.normalizeExecutionPolicyRules(executionPolicy)
        : [];
    }

    function renderExecutionPolicyRuleList(executionPolicy) {
      return window.HarnessRunRenderers?.renderExecutionPolicyRuleList
        ? window.HarnessRunRenderers.renderExecutionPolicyRuleList(executionPolicy, { escapeHtml, t })
        : '';
    }

    function renderListStack(title, items, empty = '') {
      const values = Array.isArray(items) ? items.filter(Boolean) : [];
      const content = values.length
        ? values.map((item) => `<div class="stack-item">${escapeHtml(item)}</div>`).join('')
        : `<div class="stack-item">${escapeHtml(empty || t('없음', 'None'))}</div>`;
      return `
        <div class="card">
          <h3>${escapeHtml(title)}</h3>
          <div class="stack-list">${content}</div>
        </div>
      `;
    }

    function renderPreflightCards(preflight) {
      if (!preflight) {
        return `<div class="preflight-card"><strong>${escapeHtml(t('상태', 'Status'))}</strong><div>${escapeHtml(t('진단 정보가 없습니다.', 'No diagnostic data yet.'))}</div></div>`;
      }
      const project = preflight.project || {};
      const tools = preflight.tools || preflight.environment || {};
      const scope = preflight.scope || {};
      const autonomy = preflight.autonomy || null;
      const cards = [
        [t('자동화 신뢰도', 'Autonomy trust'), autonomy ? `${autonomy.label} (${autonomy.score || 0})` : t('알 수 없음', 'Unknown')],
        [t('프로젝트', 'Project'), project.isGitRepo ? t('Git 저장소', 'Git repository') : t('일반 폴더', 'Regular folder')],
        [t('워크트리', 'Worktree'), project.worktreeEligible ? t('격리 가능', 'Isolated ready') : t('공유 모드', 'Shared mode')],
        [t('범위 안전', 'Scope guard'), scope.enforcement || project.scopeEnforcement || t('알 수 없음', 'Unknown')],
        [t('기본 계획/검토 담당', 'Default planning/review'), providerLabel(preflight.providerProfile?.coordinationProvider || harnessSettings?.coordinationProvider || 'codex')],
        [t('기본 구현 담당', 'Default implementation'), providerLabel(preflight.providerProfile?.workerProvider || harnessSettings?.workerProvider || 'codex')],
        ['Codex CLI', tools.codex?.ok ? t('정상', 'Ready') : t('없음', 'Missing')],
        ['Claude CLI', tools.claude?.ok ? t('정상', 'Ready') : t('없음', 'Missing')],
        ['Gemini CLI', tools.gemini?.ok ? t('정상', 'Ready') : t('없음', 'Missing')],
        [t('Gemini 프로젝트', 'Gemini project'), tools.geminiProject || harnessSettings?.geminiProjectId || t('미설정', 'Not set')],
        ['Git', tools.git?.ok ? t('정상', 'Ready') : t('없음', 'Missing')],
        ['Node', tools.node?.ok ? (tools.node.version || t('정상', 'Ready')) : t('없음', 'Missing')],
        ['Python', tools.python?.ok ? (tools.python.version || t('정상', 'Ready')) : t('선택사항', 'Optional')]
      ];
      return cards.map(([title, value]) => `
        <div class="preflight-card">
          <strong>${escapeHtml(title)}</strong>
          <div>${escapeHtml(value)}</div>
        </div>
      `).join('');
    }

    function classifyClientVerificationTypes(text) {
      const value = String(text || '').toLowerCase();
      const tags = [];
      if (/(playwright|browser|ui |ui$|dom|selector|preview|screenshot|page\.|dev server|localhost:|http:\/\/|https:\/\/)/i.test(value)) tags.push('BROWSER');
      if (/(eslint|lint|typecheck|tsc|static|format|prettier|compile|build)/i.test(value)) tags.push('STATIC');
      if (/(test|jest|vitest|pytest|mocha|ava|integration|e2e|unit)/i.test(value)) tags.push('TEST');
      if (/(manual|operator|visually|confirm|check in app|human|qa)/i.test(value)) tags.push('MANUAL');
      return [...new Set(tags)];
    }

    function deriveTaskEvidence(task, artifacts) {
      const verification = artifacts?.verificationJson || task?.lastExecution?.verification || {};
      const acceptanceMetadata = Array.isArray(task?.acceptanceMetadata)
        ? task.acceptanceMetadata
        : (Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks.map((check) => ({
            check,
            verificationTypes: classifyClientVerificationTypes(check)
          })) : []);
      const expectedTypes = [...new Set([
        ...acceptanceMetadata.flatMap((item) => Array.isArray(item?.verificationTypes) ? item.verificationTypes : []),
        ...(Array.isArray(verification?.verificationTypes) ? verification.verificationTypes : [])
      ])];
      const selectedCommands = Array.isArray(verification?.selectedCommands) ? verification.selectedCommands : [];
      const browser = artifacts?.browserVerification || verification?.browser || null;
      const shellOk = verification?.shellOk;
      const verificationOk = verification?.ok;
      const evidenceByType = {
        TEST: selectedCommands.filter((command) => classifyClientVerificationTypes(command).includes('TEST')),
        STATIC: selectedCommands.filter((command) => classifyClientVerificationTypes(command).includes('STATIC')),
        BROWSER: browser ? [browser.note || browser.status || t('브라우저 확인 기록', 'Browser check recorded')] : [],
        MANUAL: expectedTypes.includes('MANUAL')
          ? (Array.isArray(task?.findings) && task.findings.length ? [task.findings[0]] : [t('사람 확인이 필요한 항목', 'Needs human review')])
          : []
      };
      return ['TEST', 'STATIC', 'BROWSER', 'MANUAL'].map((type) => {
        const expected = expectedTypes.includes(type);
        let status = 'none';
        let note = t('필요 없음', 'Not needed');
        if (expected && type === 'MANUAL') {
          status = 'pending';
          note = t('사람이 직접 확인해야 닫을 수 있습니다.', 'A person must check this before it can be closed.');
        } else if (expected && type === 'BROWSER') {
          if (browser?.ok === true) {
            status = 'pass';
            note = browser.note || t('브라우저 자동 확인이 통과했습니다.', 'Browser automation passed.');
          } else if (browser) {
            status = 'fail';
            note = browser.note || t('브라우저 자동 확인이 실패했습니다.', 'Browser automation failed.');
          } else {
            status = 'pending';
            note = t('브라우저 자동 확인 기록이 아직 없습니다.', 'No browser automation record yet.');
          }
        } else if (expected && ['TEST', 'STATIC'].includes(type)) {
          const matchedCommands = evidenceByType[type];
          if (!matchedCommands.length) {
            status = 'pending';
            note = t('해당 검증 명령이 아직 기록되지 않았습니다.', 'That verification command has not been recorded yet.');
          } else if (shellOk === false || verificationOk === false) {
            status = 'fail';
            note = matchedCommands.join(' | ');
          } else {
            status = 'pass';
            note = matchedCommands.join(' | ');
          }
        }
        return {
          type,
          expected,
          status,
          note
        };
      });
    }

    function summarizeTaskEvidence(evidence = []) {
      const items = Array.isArray(evidence) ? evidence : [];
      return {
        autoExpected: items.filter((item) => ['TEST', 'STATIC', 'BROWSER'].includes(item.type) && item.expected).length,
        autoPassed: items.filter((item) => ['TEST', 'STATIC', 'BROWSER'].includes(item.type) && item.status === 'pass').length,
        autoPending: items.filter((item) => ['TEST', 'STATIC', 'BROWSER'].includes(item.type) && item.status === 'pending').length,
        autoFailed: items.filter((item) => ['TEST', 'STATIC', 'BROWSER'].includes(item.type) && item.status === 'fail').length,
        manualPending: items.filter((item) => item.type === 'MANUAL' && item.status === 'pending').length
      };
    }

    function deriveRunRuntimeSignals(run) {
      return window.HarnessRunRenderers?.deriveRunRuntimeSignals
        ? window.HarnessRunRenderers.deriveRunRuntimeSignals(run, { t })
        : { warning: false, headline: t('최근 런타임 경고는 크지 않습니다.', 'Recent runtime warnings are minor.'), highlights: [] };
    }

    function renderRuntimeSignals(run) {
      return window.HarnessRunRenderers?.renderRuntimeSignals
        ? window.HarnessRunRenderers.renderRuntimeSignals(run, { escapeHtml, t })
        : '';
    }

    function runtimeProfileLabel(profileId) {
      const value = String(profileId || 'yolo').trim().toLowerCase();
      if (value === 'safe') return t('읽기 전용', 'Read-only');
      if (value === 'full-auto') return t('승인 요청', 'Approval requested');
      return t('즉시 진행', 'Go now');
    }

    function deriveControlPlaneSnapshot() {
      const projectItems = Array.isArray(projects) ? projects : [];
      const runItems = Array.isArray(runs) ? runs : [];
      const activeProjects = projectItems.filter((project) => String(project?.status || 'active') !== 'completed').length;
      const docsFirstProjects = projectItems.filter((project) => String(project?.defaultPresetId || '') === 'docs-spec-first').length;
      const runningRuns = runItems.filter((run) => String(run?.status || '') === 'running').length;
      const blockedRuns = runItems.filter((run) => ['needs_input', 'needs_approval', 'failed'].includes(String(run?.status || ''))).length;
      const codexRuntimeProfile = runtimeProfileLabel(harnessSettings?.codexRuntimeProfile || 'yolo');
      let headline = t('첫 프로젝트를 만들면 연속 작업 운영이 시작됩니다.', 'Create your first project to start long-running agent ops.');
      let detail = t('프로젝트를 기준으로 다음 작업 초안, 문서 문맥, 메모리, 정리 점검이 이어집니다.', 'Runs, docs context, memory, and cleanup cadence keep chaining from the project.');
      if (activeProjects > 0 && runningRuns === 0 && blockedRuns === 0) {
        headline = t('지금은 안정된 대기 상태입니다.', 'Everything is calm right now.');
        detail = t('다음 작업을 열거나 기존 프로젝트를 이어서 진행하기 좋은 상태입니다.', 'Good time to open the next run or continue an existing project.');
      } else if (runningRuns > 0) {
        headline = t(`지금 ${runningRuns}개 작업이 진행 중입니다.`, `${runningRuns} run(s) are active right now.`);
        detail = t('사람이 없는 시간에도 계속 굴릴 수 있게, 현재 흐름과 증거를 바로 읽을 수 있도록 정리합니다.', 'The harness keeps work moving and keeps the proof legible while you are away.');
      } else if (blockedRuns > 0) {
        headline = t(`먼저 확인이 필요한 작업이 ${blockedRuns}개 있습니다.`, `${blockedRuns} run(s) need attention first.`);
        detail = t('질문 답변, 계획 승인, 실패 복구가 필요한 작업부터 보는 편이 좋습니다.', 'Start with clarifications, approvals, or failure recovery before opening new work.');
      }
      return {
        activeProjects,
        runningRuns,
        blockedRuns,
        docsFirstProjects,
        codexRuntimeProfile,
        headline,
        detail
      };
    }

    function renderSidebarLiveSnapshot() {
      const root = document.getElementById('sidebar-live-snapshot');
      if (!root) return;
      const snapshot = deriveControlPlaneSnapshot();
      root.innerHTML = `
          <div class="signal-card">
            <div class="signal-label">Control Plane</div>
            <div class="signal-headline">${escapeHtml(snapshot.headline)}</div>
            <div class="signal-detail">${escapeHtml(snapshot.detail)}</div>
          <div class="signal-grid">
            <div><strong>${escapeHtml(snapshot.activeProjects)}</strong><span>${escapeHtml(t('활성 프로젝트', 'Active projects'))}</span></div>
            <div><strong>${escapeHtml(snapshot.runningRuns)}</strong><span>${escapeHtml(t('진행 중 작업', 'Running runs'))}</span></div>
            <div><strong>${escapeHtml(snapshot.blockedRuns)}</strong><span>${escapeHtml(t('확인 필요', 'Needs attention'))}</span></div>
          </div>
          <div class="signal-pill-row">
            <span class="signal-pill">${escapeHtml(snapshot.codexRuntimeProfile)}</span>
            <span class="signal-pill">${escapeHtml(t(`${snapshot.docsFirstProjects}개 문서 우선`, `${snapshot.docsFirstProjects} docs-first`))}</span>
          </div>
        </div>
      `;
    }

    function renderCommandCenterEmptyState() {
      const snapshot = deriveControlPlaneSnapshot();
      return `
        <div class="empty-state mission-shell">
          <div class="mission-hero">
            <div class="mission-kicker">Har-Nessie</div>
            <h3>${escapeHtml(t('문서와 메모리를 바탕으로 장기 작업을 운영하는 로컬 하네스', 'A local harness for long-running work built on docs and memory.'))}</h3>
            <p>${escapeHtml(t('기존 저장소나 문서가 있다면 보통 프로젝트부터 만들고, 분석 결과를 바탕으로 첫 작업을 여는 편이 더 안정적입니다.', 'If you already have a repo or docs, start from a project and open the first run from intake results.'))}</p>
            <div class="mission-manifesto">
              <span>Surfacing your deep issues.</span>
              <span>${escapeHtml(t('검증 근거를 보고 판단합니다.', 'Proof over vibes.'))}</span>
              <span>${escapeHtml(t('문서가 다음 작업으로 이어집니다.', 'Docs become the next run.'))}</span>
            </div>
            <div class="mission-actions">
              <button class="primary" onclick="openCreateProjectModal()">${escapeHtml(t('프로젝트부터 시작', 'Start with a project'))}</button>
              <button class="secondary-btn" onclick="openCreateModal()">${escapeHtml(t('짧게 요청하고 바로 시작', 'Quick start with a short brief'))}</button>
            </div>
          </div>
          <div class="mission-grid">
            <div class="mission-card">
              <strong>${escapeHtml(t('자동화 신뢰도', 'Autonomy trust'))}</strong>
              <span>${escapeHtml(snapshot.blockedRuns ? t('막힌 작업이나 확인이 필요한 작업을 먼저 드러내고, 그다음 자동화를 이어갑니다.', 'It surfaces blocked work first, then continues automation in a safer order.') : t('문서와 현재 상태를 보고 자동화 강도를 조절하며 다음 작업을 준비합니다.', 'It tunes automation strength from docs and current state before opening the next run.'))}</span>
            </div>
            <div class="mission-card">
              <strong>${escapeHtml(t('누적 프로젝트 메모리', 'Compounding project memory'))}</strong>
              <span>${escapeHtml(t('프로젝트를 기준으로 다음 작업 초안, 이어받을 backlog, 메모리, 문서 문맥을 계속 연결합니다.', 'It keeps chaining the next run draft, carry-over backlog, memory, and docs context from the project.'))}</span>
            </div>
            <div class="mission-card">
              <strong>${escapeHtml(t('검증 근거', 'Proof of work'))}</strong>
              <span>${escapeHtml(t('테스트, 정적 점검, 브라우저 확인, 사람 확인을 구분해 무엇이 끝났고 무엇이 남았는지 보여줍니다.', 'It separates tests, static checks, browser checks, and manual checks so you can see what is actually done.'))}</span>
            </div>
          </div>
          <div class="mission-usecases">
            <div class="mission-usecase">
              <strong>${escapeHtml(t('문서 많은 제품/서비스', 'Docs-heavy products and services'))}</strong>
              <span>${escapeHtml(t('기획서, 운영 문서, 요구사항 PDF를 읽고 다음 작업과 검증 기준을 묶습니다.', 'It reads specs, ops docs, and requirements PDFs to shape the next run and its proof.'))}</span>
            </div>
            <div class="mission-usecase">
              <strong>${escapeHtml(t('리서치/콘텐츠 프로젝트', 'Research and content projects'))}</strong>
              <span>${escapeHtml(t('참고 문서와 누적 메모리를 바탕으로 후속 작업 초안을 계속 이어갑니다.', 'It keeps building the next draft of work from source docs and accumulated memory.'))}</span>
            </div>
            <div class="mission-usecase">
              <strong>${escapeHtml(t('운영팀용 내부 repo', 'Internal ops repositories'))}</strong>
              <span>${escapeHtml(t('체크리스트, 정책, 매뉴얼이 많은 저장소도 단계별 project container로 다룹니다.', 'It treats checklist-heavy, policy-heavy repositories as long-running project containers.'))}</span>
            </div>
          </div>
        </div>
      `;
    }

    function renderActionPlan(items) {
      const values = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!values.length) return `<div class="stack-item">${escapeHtml(t('추천 액션 없음', 'No recommended action right now'))}</div>`;
      return values.map((item) => `
        <div class="stack-item">
          <strong>${escapeHtml(item.title || item.kind || t('추천 작업', 'Recommended action'))}</strong>
          <div>${escapeHtml(item.description || '-')}</div>
        </div>
      `).join('');
    }

    function setTextContent(selector, ko, en = '') {
      const element = document.querySelector(selector);
      if (element) element.textContent = t(ko, en);
    }

    function setInnerHtml(selector, ko, en = '') {
      const element = document.querySelector(selector);
      if (element) element.innerHTML = t(ko, en);
    }

    function setPlaceholder(inputId, ko, en = '') {
      const element = document.getElementById(inputId);
      if (element) element.placeholder = t(ko, en);
    }

    function setFieldLabel(inputId, ko, en = '') {
      const element = document.getElementById(inputId);
      const group = element && typeof element.closest === 'function' ? element.closest('.form-group') : null;
      const label = group?.querySelector?.('label') || null;
      if (label) label.childNodes[0].textContent = t(ko, en);
    }

    function setFieldHelper(inputId, ko, en = '') {
      const element = document.getElementById(inputId);
      const group = element && typeof element.closest === 'function' ? element.closest('.form-group') : null;
      const helper = group?.querySelector?.('.helper-text') || null;
      if (helper) helper.textContent = t(ko, en);
    }

    function setButtonText(selector, ko, en = '') {
      const button = document.querySelector(selector);
      if (button) button.textContent = t(ko, en);
    }

    function setSelectOptionText(selectId, value, ko, en = '') {
      const option = document.querySelector(`#${selectId} option[value="${value}"]`);
      if (option) option.textContent = t(ko, en);
    }

    function applyStaticTranslations() {
      document.title = 'Har-Nessie';
      setTextContent('.sidebar-header h1 span', 'Har-Nessie', 'Har-Nessie');
      setTextContent('.sidebar-subtitle', 'Surfacing your deep issues.', 'Surfacing your deep issues.');
      setTextContent('.btn-create span', '새 프로젝트 시작', 'Start a project');
      setTextContent('.sidebar-content > .btn-secondary span', '간단히 바로 시작', 'Quick start');
      setTextContent('.sidebar-content .run-list-title:nth-of-type(1)', '프로젝트', 'Projects');
      setTextContent('.sidebar-content .run-list-title:nth-of-type(2)', '최근 작업', 'Recent runs');
      setPlaceholder('project-search-input', '프로젝트 검색', 'Search projects');
      setPlaceholder('run-search-input', '런 검색', 'Search runs');
      setTextContent('.btn-settings span', '전역 설정', 'Global settings');

      setTextContent('#create-modal .modal-header h3', '새 작업 만들기', 'Create a run');
      setTextContent('#create-modal .form-note', '처음에는 프로젝트 폴더와 "무엇을 만들고 싶은지"만 적어도 됩니다. 나머지가 비어 있어도 Codex가 시작 후 쉬운 질문으로 범위를 좁혀 줍니다. 자세히 적고 싶을 때만 아래 펼침 항목을 채우세요.', 'At first, a project folder and a short description of what you want is enough. Codex can narrow the scope with simple follow-up questions. Fill the advanced fields only when you want more control.');
      setFieldLabel('run-title-input', '작업 이름 (비워도 자동)', 'Run title (auto if empty)');
      setFieldHelper('run-title-input', '비워두면 폴더 이름이나 목표를 바탕으로 자동 이름을 만듭니다.', 'If left empty, the harness builds a title from the folder and goal.');
      setPlaceholder('run-title-input', '예: onboarding-flow', 'Example: onboarding-flow');
      setFieldLabel('project-path-input', '프로젝트 폴더', 'Project folder');
      setButtonText('#create-modal .picker-row .secondary-btn', '찾아보기', 'Browse');
      setPlaceholder('project-path-input', 'C:\\path\\to\\repo', '/path/to/repo');
      setFieldLabel('run-objective-input', '무엇을 만들거나 바꾸고 싶은가요?', 'What do you want to build or change?');
      setFieldHelper('run-objective-input', '예: 누가 쓰는지, 최종적으로 어떤 화면이나 결과가 나와야 하는지 한두 문장으로 쓰면 충분합니다.', 'A sentence or two is enough. Say who it is for and what outcome should exist at the end.');
      setPlaceholder('run-objective-input', '무엇을 바꾸고 싶은지, 최종 결과를 한 문단으로 적으세요.', 'Describe the desired end result in a short paragraph.');
      setTextContent('#create-modal details.advanced-settings summary', '원하면 더 자세히 적기', 'Add more detail if you want');
      setTextContent('#create-modal details.advanced-settings:nth-of-type(1) .advanced-body .form-note', '아래 항목은 비워도 됩니다. 더 자세히 적을수록 첫 계획이 더 정확해질 뿐입니다.', 'Everything below is optional. More detail just helps the first plan land more accurately.');
      setFieldLabel('run-success-criteria-input', '성공 조건', 'Success criteria');
      setFieldLabel('run-excluded-scope-input', '제외 범위', 'Out of scope');
      setFieldLabel('run-target-users-input', '대상 사용자', 'Target users');
      setFieldLabel('run-example-io-input', '예시 입력 / 출력', 'Example input / output');
      setFieldLabel('run-protected-areas-input', '변경 금지 영역', 'Protected areas');
      setFieldLabel('run-spec-files-input', '명세 파일 경로들 (한 줄에 하나씩)', 'Spec file paths (one per line)');
      setPlaceholder('run-success-criteria-input', '예: 사용자가 가입 후 첫 화면까지 3단계 안에 도달', 'Example: user reaches the first screen within three steps after sign-up');
      setPlaceholder('run-excluded-scope-input', '예: 디자인 리뉴얼 제외, 관리자 기능 제외', 'Example: no design refresh, no admin features');
      setPlaceholder('run-target-users-input', '예: 처음 쓰는 운영팀, 일반 사용자', 'Example: first-time operators, general users');
      setPlaceholder('run-example-io-input', '예: CSV 업로드 → 검증된 고객 리스트', 'Example: CSV upload -> validated customer list');
      setPlaceholder('run-protected-areas-input', '예: 로그인, 결제, 기존 공개 API 형식', 'Example: login, payments, public API contract');
      setPlaceholder('run-spec-files-input', 'md, txt, json, pdf 지원 시도', 'md, txt, json, pdf supported when possible');
      setTextContent('#create-modal details.advanced-settings:nth-of-type(2) summary', '고급: 실행 세부 설정', 'Advanced: execution settings');
      setTextContent('#create-modal details.advanced-settings:nth-of-type(2) .advanced-body .form-note', '대부분은 기본값 그대로 두면 됩니다. 특별히 병렬 수나 재시도 정책을 조절하고 싶을 때만 바꾸세요.', 'Most people should leave these at the defaults. Change them only if you want to tune parallelism or retry policy.');
      setFieldLabel('run-preset-input', '작업 방식', 'Work style');
      setSelectOptionText('run-preset-input', 'auto', '자동 선택 (권장)', 'Auto (recommended)');
      setSelectOptionText('run-preset-input', 'existing-repo-feature', '기존 프로젝트 기능 추가', 'Existing repo feature');
      setSelectOptionText('run-preset-input', 'existing-repo-bugfix', '기존 프로젝트 버그 수정', 'Existing repo bugfix');
      setSelectOptionText('run-preset-input', 'greenfield-app', '새 프로젝트 시작', 'Greenfield app');
      setSelectOptionText('run-preset-input', 'refactor-stabilize', '리팩터링 / 안정화', 'Refactor / stabilize');
      setSelectOptionText('run-preset-input', 'docs-spec-first', '문서 / 명세 먼저', 'Docs / spec first');
      setFieldLabel('run-max-parallel-input', '동시에 진행할 작업 수', 'Parallel task count');
      setFieldLabel('run-max-task-attempts-input', '태스크 최대 재시도', 'Max task retries');
      setFieldLabel('run-max-goal-loops-input', '최대 목표 재판정', 'Max goal loops');
      setFieldLabel('run-loop-enabled-input', '런-레벨 자동 루프', 'Run-level automation loop');
      setFieldHelper('run-loop-enabled-input', '이 런을 짧은 체인으로 이어서 반복 실행합니다.', 'Repeat this run as a short continuation chain.');
      setFieldLabel('run-loop-mode-input', '루프 방식', 'Loop mode');
      setSelectOptionText('run-loop-mode-input', 'repeat-count', '정해진 횟수만 반복', 'Repeat N runs');
      setSelectOptionText('run-loop-mode-input', 'until-goal', '목표 달성까지 반복', 'Repeat until goal achieved');
      setFieldLabel('run-loop-max-runs-input', '최대 루프 횟수', 'Max loop runs');
      setFieldLabel('run-loop-max-failures-input', '연속 실패 자동 중단', 'Auto-stop after consecutive failed runs');
      setButtonText('#run-form .modal-footer button:nth-of-type(1)', '취소', 'Cancel');
      setButtonText('#run-form .modal-footer button:nth-of-type(2)', '입력 진단', 'Check input');
      setButtonText('#run-form .modal-footer button:nth-of-type(3)', '작업 만들기', 'Create run');

      setTextContent('#create-project-modal .modal-header h3', '새 프로젝트 생성', 'Create project');
      setTextContent('#create-project-modal .form-note', '프로젝트는 큰 작업을 오래 관리하는 작업 상자입니다. 기존 저장소나 `docs/`가 있다면 아래를 많이 적기보다 먼저 `프로젝트 분석`을 눌러 추천값과 첫 작업 초안을 받는 편이 더 쉽습니다.', 'A project is the long-running container for big work. If you already have a repo or docs, use Project Analysis first instead of filling everything by hand.');
      setFieldLabel('project-title-input', '프로젝트 이름', 'Project name');
      setFieldLabel('project-root-input', '프로젝트 루트 폴더', 'Project root folder');
      setPlaceholder('project-title-input', '예: write_claw', 'Example: write_claw');
      setPlaceholder('project-root-input', 'C:\\path\\to\\repo', '/path/to/repo');
      setFieldLabel('project-charter-input', '프로젝트 헌장 / 목적', 'Project charter / purpose');
      setPlaceholder('project-charter-input', '이 프로젝트가 무엇을 만들고, 어떤 원칙을 지키는지 한 문단으로 적으세요.', 'Describe what this project is building and the rules it should keep.');
      setFieldLabel('project-default-preset-input', '기본 작업 방식', 'Default work style');
      setSelectOptionText('project-default-preset-input', 'auto', '자동 선택 (권장)', 'Auto (recommended)');
      setSelectOptionText('project-default-preset-input', 'existing-repo-feature', '기존 프로젝트 기능 추가', 'Existing repo feature');
      setSelectOptionText('project-default-preset-input', 'existing-repo-bugfix', '기존 프로젝트 버그 수정', 'Existing repo bugfix');
      setSelectOptionText('project-default-preset-input', 'greenfield-app', '새 프로젝트 시작', 'Greenfield app');
      setSelectOptionText('project-default-preset-input', 'refactor-stabilize', '리팩터링 / 안정화', 'Refactor / stabilize');
      setSelectOptionText('project-default-preset-input', 'docs-spec-first', '문서 / 명세 먼저', 'Docs / spec first');
      const bootstrapLabel = document.querySelector("label[for='bootstrap-project-docs']");
      if (bootstrapLabel) bootstrapLabel.textContent = t('기본 문서 틀 같이 만들기', 'Create starter docs');
      const bootstrapHelper = document.querySelector('#bootstrap-project-docs + label + .helper-text');
      if (bootstrapHelper) bootstrapHelper.textContent = t('체크하면 AGENTS/ARCHITECTURE/docs 기본 파일을 실제 저장소에 씁니다. 기존 repo/docs가 있으면 보통 끄는 편이 맞습니다.', 'If checked, the harness writes starter AGENTS/ARCHITECTURE/docs files into the repo. Leave it off when the repo already has docs.');
      setTextContent('#create-project-modal details.advanced-settings summary', '첫 단계 직접 지정 (선택)', 'Set the first phase manually (optional)');
      setTextContent('#create-project-modal details.advanced-settings .advanced-body .helper-text', '새 프로젝트를 바로 쪼개 시작할 때만 적으세요. 기존 저장소나 문서가 있으면 비워 두고 `프로젝트 분석` 결과를 따르는 편이 더 안전합니다.', 'Use this only when you want to split a new project immediately. For an existing repo or doc set, leaving it blank and following Project Analysis is safer.');
      setFieldLabel('project-phase-title-input', '첫 단계 이름', 'First phase name');
      setFieldLabel('project-phase-goal-input', '첫 단계 목표', 'First phase goal');
      setPlaceholder('project-phase-title-input', '예: 1단계 · 기반 정리', 'Example: Phase 1 · foundation cleanup');
      setPlaceholder('project-phase-goal-input', '예: 다시 시작 흐름, 기본 문서, 검증 기준을 먼저 안정화', 'Example: stabilize restart flow, base docs, and verification contract first');
      setButtonText('#project-form .modal-footer button:nth-of-type(1)', '취소', 'Cancel');
      setButtonText('#project-analyze-btn', '프로젝트 분석', 'Analyze project');
      setButtonText('#project-create-only-btn', '프로젝트만 생성', 'Create project only');
      setButtonText('#project-submit-btn', '프로젝트만 생성', 'Create project only');

      setTextContent('#settings-modal .modal-header h3', '로컬 하네스 설정', 'Local harness settings');
      setTextContent('#settings-modal .modal-body > .form-note', '이 설정은 현재 PC의 .harness-web/settings.json 에만 저장됩니다. 저장소 파일은 건드리지 않고, 앞으로 만드는 run의 기본 성향만 정합니다. 처음에는 대부분 기본값 그대로 두고 시작해도 충분합니다.', 'These settings are stored only in this machine’s .harness-web/settings.json. They do not change repo files. They only shape the default behavior of future runs.');
      const includeGlobalLabel = document.querySelector("label[for='include-global-agents']");
      if (includeGlobalLabel) includeGlobalLabel.textContent = t('내 PC의 전역 작업 원칙 함께 참고', 'Use this machine’s global guidance');
      const includeKarpathyLabel = document.querySelector("label[for='include-karpathy']");
      if (includeKarpathyLabel) includeKarpathyLabel.textContent = t('기본 코딩 안전 규칙 함께 참고', 'Use the base coding safety guidance');
      setFieldLabel('custom-constitution', '이 PC에서 항상 지킬 추가 원칙', 'Extra rules this machine should always keep');
      setFieldLabel('planner-strategy', '고급: 계획 세우는 기본 성향', 'Advanced: planning style');
      setFieldLabel('team-strategy', '고급: 역할 분담 기본 성향', 'Advanced: team strategy');
      setFieldLabel('coordination-provider', '기본 계획/검토 담당', 'Default planning/review provider');
      setFieldLabel('worker-provider', '기본 구현 담당', 'Default implementation provider');
      setFieldLabel('codex-runtime-profile', 'Codex 실행 프로필', 'Codex runtime profile');
      setSelectOptionText('codex-runtime-profile', 'yolo', '즉시 진행 · 승인 없이 전체 접근', 'Go now · full access without approval');
      setSelectOptionText('codex-runtime-profile', 'full-auto', '승인 요청 · 작업 폴더 쓰기', 'Approval requested · workspace write');
      setSelectOptionText('codex-runtime-profile', 'safe', '읽기 전용 · 안전 모드', 'Read-only · safe mode');
      setFieldLabel('codex-model', 'Codex 모델', 'Codex model');
      setSelectOptionText('codex-model', 'gpt-5.4', 'GPT-5.4', 'GPT-5.4');
      setSelectOptionText('codex-model', 'gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', 'GPT-5.3-Codex-Spark');
      const codexFastModeLabel = document.querySelector('#codex-fast-mode')?.closest('.form-group')?.querySelector('label');
      if (codexFastModeLabel) {
        codexFastModeLabel.childNodes[codexFastModeLabel.childNodes.length - 1].textContent = ` ${t('Codex 빠른 모드', 'Codex fast mode')}`;
      }
      setFieldHelper('codex-fast-mode', '켜면 fast service tier를 유지하고, 끄면 default service tier로 내립니다.', 'On keeps the fast service tier. Off falls back to the default service tier.');
      setFieldLabel('ui-language', '화면 언어', 'UI language');
      setFieldLabel('agent-language', 'AI 응답 언어', 'Agent response language');
      setSelectOptionText('ui-language', 'ko', '한국어', 'Korean');
      setSelectOptionText('ui-language', 'en', 'English', 'English');
      setSelectOptionText('agent-language', 'ko', '한국어', 'Korean');
      setSelectOptionText('agent-language', 'en', 'English', 'English');
      setTextContent('#settings-modal details.advanced-settings summary', '고급: AI별 메모와 모델 설정', 'Advanced: notes and model settings by AI');
      setFieldLabel('codex-notes', 'Codex 메모', 'Codex notes');
      setFieldLabel('claude-notes', 'Claude 메모', 'Claude notes');
      setFieldLabel('gemini-notes', 'Gemini 메모', 'Gemini notes');
      setFieldLabel('claude-model', 'Claude 모델', 'Claude model');
      setFieldLabel('gemini-model', 'Gemini 모델', 'Gemini model');
      setFieldLabel('gemini-project-id', 'Gemini 프로젝트 ID', 'Gemini project ID');
      setButtonText('#harness-settings-form .modal-footer button:nth-of-type(1)', '닫기', 'Close');
      setButtonText('#harness-settings-form .modal-footer button:nth-of-type(2)', '설정 저장', 'Save settings');

      setTextContent('#plan-edit-modal .modal-header h3', '계획 직접 수정', 'Edit plan directly');
      setTextContent('#plan-edit-modal .modal-body .form-note', '목표 자체는 잠그고, 실행 전 계획 요약·에이전트·태스크만 수정합니다.', 'The goal stays locked. You only edit the plan summary, agents, and tasks before execution.');
      setFieldLabel('plan-edit-summary', '계획 요약', 'Plan summary');
      setFieldLabel('plan-edit-execution-model', '실행 모델', 'Execution model');
      setButtonText('#plan-edit-modal .modal-footer button:nth-of-type(1)', '닫기', 'Close');
      setButtonText('#plan-edit-modal .modal-footer button:nth-of-type(2)', '계획 저장', 'Save plan');

      setTextContent('#reject-plan-modal .modal-header h3', '계획 반려', 'Request plan changes');
      setTextContent('#reject-plan-modal .form-note', '왜 반려하는지, 무엇을 바꾸면 되는지 적어주세요.', 'Explain why this plan should change and what should be different.');
      setFieldLabel('reject-plan-feedback', '반려 피드백', 'Feedback');
      setButtonText('#reject-plan-modal .modal-footer button:nth-of-type(1)', '취소', 'Cancel');
      setButtonText('#reject-plan-modal .modal-footer button:nth-of-type(2)', '계획 반려', 'Send back for changes');

      setTextContent('#skip-task-modal .modal-header h3', '태스크 건너뛰기', 'Skip task');
      setTextContent('#skip-task-modal .form-note', '왜 이 태스크를 건너뛰는지 기록해 두면 이후 판단과 로그 확인에 도움이 됩니다.', 'Leaving a short reason helps later review and recovery.');
      setFieldLabel('skip-task-reason', '건너뛰는 이유', 'Reason for skipping');
      setButtonText('#skip-task-modal .modal-footer button:nth-of-type(1)', '취소', 'Cancel');
      setButtonText('#skip-task-modal .modal-footer button:nth-of-type(2)', '태스크 건너뛰기', 'Skip task');

      setTextContent('#addreq-modal .modal-header h3', '추가 요구사항 (선택)', 'Extra requirements (optional)');
      setTextContent('#addreq-modal .form-note', '이전 런에서 이어서 실행합니다. 이번에 추가할 요구사항이나 변경 사항을 입력하면 spec에 반영됩니다. 없으면 그냥 시작할 수 있습니다.', 'This continues from the previous run. Add extra requirements or changes if needed. If not, you can start as-is.');
      setFieldLabel('addreq-text', '추가 요구사항', 'Extra requirements');
      setButtonText('#addreq-modal .modal-footer button:nth-of-type(1)', '취소', 'Cancel');
      setButtonText('#addreq-modal .modal-footer button:nth-of-type(2)', '시작/재개', 'Start / resume');
    }

    function renderProjectList() {
      const root = document.getElementById('project-list');
      if (!root) return;
      const allProjects = Array.isArray(projects) ? projects : [];
      const summaries = allProjects.map((project) => {
        const overview = projectOverviewState.get(project.id);
        const phases = Array.isArray(overview?.phases) ? overview.phases : [];
        const cleanupCount = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.cleanupLane) ? phase.cleanupLane.length : 0), 0)
          || (Array.isArray(project?.maintenance?.cleanupTasks) ? project.maintenance.cleanupTasks.length : 0);
        const pendingReviewCount = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.pendingReview) ? phase.pendingReview.length : 0), 0);
        const riskCount = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.openRisks) ? phase.openRisks.length : 0), 0);
        const docsFirst = String(project?.defaultPresetId || '') === 'docs-spec-first';
        return {
          project,
          cleanupCount,
          pendingReviewCount,
          riskCount,
          docsFirst,
          attentionCount: cleanupCount + pendingReviewCount + riskCount
        };
      });
      const chipDefs = [
        { id: 'all', label: t('전체', 'All'), count: summaries.length },
        { id: 'attention', label: t('주의 필요', 'Needs attention'), count: summaries.filter((item) => item.attentionCount > 0).length },
        { id: 'review', label: t('리뷰 대기', 'Pending review'), count: summaries.filter((item) => item.pendingReviewCount > 0).length },
        { id: 'cleanup', label: t('정리 필요', 'Needs cleanup'), count: summaries.filter((item) => item.cleanupCount > 0).length },
        { id: 'docs', label: t('문서 우선', 'Docs first'), count: summaries.filter((item) => item.docsFirst).length },
        { id: 'completed', label: t('완료됨', 'Completed'), count: summaries.filter((item) => String(item.project?.status || '') === 'completed').length }
      ];
      const filterBar = `
        <div class="filter-chip-row">
          ${chipDefs.map((chip) => `
            <button
              type="button"
              class="filter-chip ${projectFilterMode === chip.id ? 'active' : ''}"
              onclick="setProjectFilter('${chip.id}')"
            >
              <span>${escapeHtml(chip.label)}</span>
              <span class="filter-chip-count">${escapeHtml(chip.count)}</span>
            </button>
          `).join('')}
        </div>
      `;
      if (!allProjects.length) {
        root.innerHTML = `${filterBar}<div class="empty-state" style="padding: 20px;">${escapeHtml(t('프로젝트가 없습니다.', 'No projects yet.'))}</div>`;
        renderSidebarLiveSnapshot();
        return;
      }
      const query = projectSearchQuery.trim().toLowerCase();
      const visibleProjects = summaries
        .filter(({ project, cleanupCount, pendingReviewCount, attentionCount, docsFirst }) => {
          if (projectFilterMode === 'attention') return attentionCount > 0;
          if (projectFilterMode === 'review') return pendingReviewCount > 0;
          if (projectFilterMode === 'cleanup') return cleanupCount > 0;
          if (projectFilterMode === 'docs') return docsFirst;
          if (projectFilterMode === 'completed') return String(project?.status || '') === 'completed';
          return true;
        })
        .filter(({ project }) => {
          if (!query) return true;
          const phaseNames = (Array.isArray(project.phases) ? project.phases : []).map((phase) => phase?.title || phase?.id || '').join(' ');
          const haystack = [project.title, project.id, project.rootPath, phaseNames].join(' ').toLowerCase();
          return haystack.includes(query);
        })
        .map((item) => item.project);
      if (!visibleProjects.length) {
        root.innerHTML = `${filterBar}<div class="empty-state" style="padding: 20px;">${escapeHtml(t('검색 조건에 맞는 프로젝트가 없습니다.', 'No projects match this search.'))}</div>`;
        renderSidebarLiveSnapshot();
        return;
      }
      root.innerHTML = filterBar + visibleProjects.map((project) => {
        const phaseCount = Array.isArray(project.phases) ? project.phases.length : 0;
        const activePhase = resolveProjectDisplayPhase(project.phases, project.currentPhaseId);
        return `
          <div class="run-item ${project.id === selectedProjectId ? 'active' : ''}" data-status="${escapeHtml(project.status || 'active')}" onclick="selectProject('${project.id}')">
            <strong>${escapeHtml(project.title || project.id)}</strong>
            <small>${escapeHtml(activePhase?.title || t('활성 단계 없음', 'No active phase'))} · ${escapeHtml(t(`단계 ${phaseCount}개`, `${phaseCount} phase(s)`))}</small>
            <small>${escapeHtml(clip(project.rootPath || '', 48) || t('root 미지정', 'No root path'))}</small>
          </div>
        `;
      }).join('');
      renderSidebarLiveSnapshot();
    }

    function setProjectFilter(mode) {
      projectFilterMode = String(mode || 'all');
      renderProjectList();
    }

    function phaseContractFieldId(phaseId, field) {
      return `phase-contract-${field}-${phaseId}`;
    }

    function parseContractTextarea(value) {
      return String(value || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function describePreset(preset) {
      const id = String(preset?.id || preset || '').trim();
      const title = String(preset?.title || '').trim();
      const labels = {
        auto: t('자동 선택', 'Auto'),
        'existing-repo-feature': t('기존 프로젝트 기능 추가', 'Existing repo feature'),
        'existing-repo-bugfix': t('기존 프로젝트 버그 수정', 'Existing repo bugfix'),
        'greenfield-app': t('새 프로젝트 시작', 'Greenfield app'),
        'refactor-stabilize': t('리팩터링 / 안정화', 'Refactor / stabilize'),
        'docs-spec-first': t('문서 / 명세 먼저', 'Docs / spec first')
      };
      return title || labels[id] || id || t('자동 선택', 'Auto');
    }

    function describePattern(pattern) {
      const key = String(pattern || '').trim();
      const labels = {
        pipeline: t('순차 진행', 'Sequential'),
        'fan-out-fan-in': t('병렬 구현 후 통합', 'Parallel build then merge'),
        'producer-reviewer': t('구현 후 검토', 'Implement then review'),
        supervisor: t('감독형 진행', 'Supervisor-led'),
        'expert-pool': t('전문가 풀 병렬', 'Expert pool in parallel')
      };
      return labels[key] || key || t('자동', 'Auto');
    }

    function summarizeRisk(run) {
      const failedTask = (run.tasks || []).find((task) => task.status === 'failed');
      if (failedTask) {
        return {
          tone: 'danger',
          title: t(`${failedTask.id} 점검 필요`, `${failedTask.id} needs review`),
          detail: failedTask.findings?.[0] || failedTask.reviewSummary || t('실패 원인을 확인해 주세요.', 'Check the failure reason.')
        };
      }
      const blockers = run.preflight?.blockers || [];
      if (blockers.length) {
        return {
          tone: 'warning',
          title: t('실행 전 확인 필요', 'Needs confirmation before start'),
          detail: blockers[0]
        };
      }
      const warnings = run.preflight?.warnings || [];
      if (warnings.length) {
        return {
          tone: 'warning',
          title: t('주의할 점', 'Watch item'),
          detail: warnings[0]
        };
      }
      return {
        tone: 'safe',
        title: t('현재 큰 위험 없음', 'No major risk'),
        detail: t('현재 기준으로는 계획된 흐름대로 진행할 수 있습니다.', 'The planned flow can continue as-is.')
      };
    }

    function summarizeExecution(run) {
      const activeTask = (run.tasks || []).find((task) => task.status === 'in_progress');
      const readyCount = (run.tasks || []).filter((task) => task.status === 'ready').length;
      if (activeTask) {
        return {
          title: t(`${activeTask.id} 진행 중`, `${activeTask.id} in progress`),
          detail: t(`${activeTask.title} 작업을 수행하고 있습니다.`, `Working on ${activeTask.title}.`)
        };
      }
      if (run.status === 'needs_approval') {
        return {
          title: t('계획 승인 대기', 'Waiting for plan approval'),
          detail: t('계획을 확인한 뒤 승인하면 바로 실행을 시작합니다.', 'Execution starts right after the plan is approved.')
        };
      }
      if (run.status === 'needs_input') {
        return {
          title: t('질문 답변 대기', 'Waiting for answers'),
          detail: t('질문에 답하면 계획을 구체화해 이어서 진행합니다.', 'Answer the questions and the run will continue with a clearer plan.')
        };
      }
      return {
        title: readyCount ? t(`대기 태스크 ${readyCount}개`, `${readyCount} task(s) ready`) : t('대기 중인 태스크 없음', 'No ready tasks'),
        detail: readyCount ? t('실행 조건이 맞으면 다음 루프에서 진행합니다.', 'The next loop will pick them up when conditions are ready.') : t('현재는 새 작업을 기다리거나 정리 단계입니다.', 'The run is waiting for new work or wrapping up.')
      };
    }

    function renderOverviewHighlights(run, stats) {
      const execution = summarizeExecution(run);
      const risk = summarizeRisk(run);
      const completion = stats.total ? Math.round((stats.done / Math.max(stats.total, 1)) * 100) : 0;
      return `
        <div class="overview-grid">
          <div class="focus-card">
            <span class="eyebrow">${escapeHtml(t('다음 액션', 'Next action'))}</span>
            <h4>${escapeHtml(execution.title)}</h4>
            <p>${escapeHtml(execution.detail)}</p>
          </div>
          <div class="focus-card ${risk.tone}">
            <span class="eyebrow">${escapeHtml(t('현재 리스크', 'Current risk'))}</span>
            <h4>${escapeHtml(risk.title)}</h4>
            <p>${escapeHtml(risk.detail)}</p>
          </div>
          <div class="focus-card compact">
            <span class="eyebrow">${escapeHtml(t('진행률', 'Progress'))}</span>
            <h4>${completion}%</h4>
            <p>${escapeHtml(t(`전체 ${stats.total}개 중 ${stats.done}개 완료, ${stats.failed}개 실패`, `${stats.done} of ${stats.total} done, ${stats.failed} failed`))}</p>
          </div>
        </div>
      `;
    }

    function aggregateRunEvidence(run) {
      const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
      return tasks.reduce((acc, task) => {
        const summary = summarizeTaskEvidence(deriveTaskEvidence(task, null));
        acc.autoExpected += summary.autoExpected;
        acc.autoPassed += summary.autoPassed;
        acc.autoPending += summary.autoPending;
        acc.autoFailed += summary.autoFailed;
        acc.manualPending += summary.manualPending;
        return acc;
      }, {
        autoExpected: 0,
        autoPassed: 0,
        autoPending: 0,
        autoFailed: 0,
        manualPending: 0
      });
    }

    function deriveRunSignalRail(run, stats) {
      const autonomy = run?.preflight?.autonomy || {};
      const evidence = aggregateRunEvidence(run);
      const specCount = Array.isArray(run?.input?.specFiles) ? run.input.specFiles.length : 0;
      const memoryHits = Array.isArray(run?.memory?.searchResults) ? run.memory.searchResults.length : 0;
      const openQuestions = Array.isArray(run?.humanLoop?.clarifyPending) ? run.humanLoop.clarifyPending.length : 0;
      const cards = [
        {
          label: '자동화 신뢰도',
          value: autonomy.score ?? '-',
          detail: autonomy.summary || '현재 작업을 얼마나 자동으로 맡길 수 있는지 보여줍니다.'
        },
        {
          label: '검증 근거',
          value: evidence.autoExpected ? `${evidence.autoPassed}/${evidence.autoExpected}` : `${stats.done}`,
          detail: evidence.autoExpected
            ? `자동 검증 통과 ${evidence.autoPassed} · 대기 ${evidence.autoPending} · 실패 ${evidence.autoFailed}`
            : `완료 태스크 ${stats.done} · 실패 ${stats.failed}`
        },
        {
          label: '문맥 엔진',
          value: specCount + memoryHits,
          detail: `문서 ${specCount}개 · 메모리 히트 ${memoryHits}개`
        },
        {
          label: '복구 루프',
          value: openQuestions || stats.failed || 0,
          detail: openQuestions
            ? `먼저 답해야 할 질문 ${openQuestions}개`
            : (stats.failed ? `복구가 필요한 실패 태스크 ${stats.failed}개` : '즉시 복구가 필요한 항목은 크지 않습니다.')
        }
      ];
      return `
        <div class="signal-rail">
          ${cards.map((card) => `
            <div class="signal-rail-card">
              <span class="eyebrow">${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.value)}</strong>
              <p>${escapeHtml(card.detail)}</p>
            </div>
          `).join('')}
        </div>
      `;
    }

    function renderPromptSourceSummary(run) {
      const report = run?.harnessConfig?.promptSourceReport || {};
      const activeSources = Array.isArray(report.activeSources) ? report.activeSources : [];
      const shadowedSources = Array.isArray(report.shadowedSources) ? report.shadowedSources : [];
      const describeSource = (source) => {
        const label = String(source?.label || '').trim();
        const scope = String(source?.scope || '').trim();
        if (scope === 'project-local') return '이 프로젝트 안의 지침';
        if (label.includes('.harness-web/settings.json#customConstitution')) return '이 PC의 로컬 헌법';
        if (label.toLowerCase().includes('karpathy')) return '기본 코딩 가이드';
        if (label.toLowerCase().includes('agents.md')) return '내 전역 AGENTS 요약';
        return label || '추가 지침';
      };
      if (!activeSources.length) {
        return '<div class="stack-item">현재 별도로 우선 적용되는 추가 지침은 없습니다. 기본 하네스 규칙으로 진행합니다.</div>';
      }
      return `
        <div class="stack-item warning-item" style="margin-bottom: 14px;">
          <strong>지금 가장 먼저 따르는 원칙</strong>
          <div style="margin-top: 6px;">${escapeHtml(describeSource(activeSources[0]))}</div>
          <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(activeSources[0]?.summary || '', 220) || '요약 없음')}</div>
        </div>
        <div class="detail-list">
          ${renderDetailItem('적용 순서', '프로젝트 안 원칙 -> 이 PC 설정 -> 내 전역 기본 원칙', '적용 순서 정보 없음')}
          ${renderDetailItem('쉽게 말해', shadowedSources.length ? '위 원칙이 가장 우선이고, 나머지는 참고용으로만 덧붙습니다.' : '현재는 겹치는 추가 원칙이 없습니다.')}
        </div>
        <div class="stack-list">
          ${activeSources.map((source) => `
            <div class="stack-item">
              <strong>${escapeHtml(describeSource(source))}</strong>
              <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(source.summary || '', 220) || '요약 없음')}</div>
            </div>
          `).join('')}
        </div>
        ${shadowedSources.length ? `
          <details class="advanced-settings" style="margin-top: 16px;">
            <summary>추가로 참고하는 원칙 ${escapeHtml(String(shadowedSources.length))}개</summary>
            <div class="advanced-body">
              <div class="stack-list">
                ${shadowedSources.map((source) => `
                  <div class="stack-item warning-item">
                    <strong>${escapeHtml(describeSource(source))}</strong>
                    <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(source.summary || source.label || '', 220) || '요약 없음')}</div>
                  </div>
                `).join('')}
              </div>
            </div>
          </details>
        ` : ''}
      `;
    }

    function deriveProgressSummary(run) {
      const operatorSummary = run?.analytics?.operatorSummary || null;
      if (operatorSummary) {
        return {
          phase: operatorSummary.phase || 'idle',
          step: operatorSummary.step || '대기',
          detail: operatorSummary.detail || '',
          lastEvent: operatorSummary.lastAction?.summary || run?.analytics?.lastTraceEvent || '',
          elapsed: operatorSummary.elapsed || 0,
          lastAction: operatorSummary.lastAction?.capabilityId || operatorSummary.lastAction?.actionClass || '',
          rawPreserved: operatorSummary.rawPreserved || ''
        };
      }
      const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
      const logs = Array.isArray(run?.logs) ? run.logs : [];
      const lastLog = logs.at(-1) || null;
      const activeTask = tasks.find((task) => task.status === 'in_progress') || null;
      const recentTask = tasks
        .filter((task) => task.lastExecution?.lastRunAt)
        .sort((left, right) => String(right.lastExecution?.lastRunAt || '').localeCompare(String(left.lastExecution?.lastRunAt || '')))[0] || null;

      if (run.status === 'needs_input') {
        return {
          phase: '질문 정리',
          step: '질문 답변 대기',
          detail: '답변이 들어오면 바로 이어서 진행합니다.',
          lastEvent: lastLog?.message || '최근 이벤트 없음',
          elapsed: 0,
          lastAction: '',
          rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
        };
      }
      if (run.status === 'needs_approval') {
        return {
          phase: '계획 확인',
          step: '계획 승인 대기',
          detail: '목표, 제외 범위, 첫 작업만 확인한 뒤 시작 여부를 결정하면 됩니다.',
          lastEvent: lastLog?.message || '최근 이벤트 없음',
          elapsed: 0,
          lastAction: '',
          rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
        };
      }
      if (activeTask) {
        return {
          phase: '실행 중',
          step: `${activeTask.id} ${activeTask.title}`,
          detail: activeTask.lastExecution?.lastRunAt
            ? `시작 시각 ${activeTask.lastExecution.lastRunAt}`
            : '현재 태스크를 수행 중입니다.',
          lastEvent: lastLog?.message || '최근 이벤트 없음',
          elapsed: 0,
          lastAction: activeTask.lastExecution?.lastAction?.capabilityId || '',
          rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
        };
      }
      if (run.status === 'failed') {
        return {
          phase: '복구 판단',
          step: '실패 원인 확인',
          detail: '다시 시도할지, 건너뛸지, 다음 작업으로 넘길지 결정해야 합니다.',
          lastEvent: lastLog?.message || '최근 이벤트 없음',
          elapsed: 0,
          lastAction: '',
          rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
        };
      }
      if (recentTask) {
        return {
          phase: '결과 확인',
          step: `${recentTask.id} ${recentTask.title}`,
          detail: recentTask.reviewSummary || '최근 태스크 결과를 확인할 수 있습니다.',
          lastEvent: lastLog?.message || '최근 이벤트 없음',
          elapsed: 0,
          lastAction: recentTask.lastExecution?.lastAction?.capabilityId || '',
          rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
        };
      }
      return {
        phase: '대기',
        step: '다음 태스크 대기',
        detail: '현재는 다음 루프나 사용자 입력을 기다립니다.',
        lastEvent: lastLog?.message || '최근 이벤트 없음',
        elapsed: 0,
        lastAction: '',
        rawPreserved: '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.'
      };
    }

    function renderProgressSummary(run) {
      return window.HarnessRunRenderers?.renderProgressSummary
        ? window.HarnessRunRenderers.renderProgressSummary(run, { deriveProgressSummary, escapeHtml, formatElapsedSeconds, renderDetailItem })
        : '';
    }

    function renderDecisionPanel(run) {
      const panel = run?.decisionPanel || null;
      if (!panel) return '';
      const lastRunAction = panel.lastRunAction || (Array.isArray(run?.runActionRecords) ? run.runActionRecords.at(-1) : null);
      return `
        <div class="card" style="margin-top: 16px;">
          <h3>운영자 결정 패널</h3>
          <div class="metric-row">
            <div class="mini-card"><span class="k">권장 조치</span><div class="v">${escapeHtml(panel.headline || panel.primaryAction?.label || '진행 관찰')}</div></div>
            <div class="mini-card"><span class="k">막힌 태스크</span><div class="v">${escapeHtml(panel.blockedTaskId || '-')}</div></div>
            <div class="mini-card"><span class="k">최근 런 액션</span><div class="v">${escapeHtml(lastRunAction?.capabilityId || lastRunAction?.phase || '-')}</div></div>
          </div>
          <div class="detail-list">
            ${renderDetailItem('근거', (panel.supportingSignals || []).join(' | '), '추가 근거 없음')}
            ${renderDetailItem('최근 런 액션 요약', lastRunAction?.summary || '', '없음')}
          </div>
          <div class="stack-list" style="margin-top: 14px;">
            ${(panel.actions || []).map((action) => `
              <div class="stack-item">
                <strong>${escapeHtml(action.label || action.id || 'action')}</strong>
                <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(action.description || '-')}</div>
              </div>
            `).join('') || '<div class="stack-item">추가 권장 조치 없음</div>'}
          </div>
        </div>
      `;
    }

    function deriveAutoReplanStatus(run) {
      return window.HarnessRunRenderers?.deriveAutoReplanStatus
        ? window.HarnessRunRenderers.deriveAutoReplanStatus(run, { t })
        : null;
    }

    function renderAutoReplanStatus(run) {
      return window.HarnessRunRenderers?.renderAutoReplanStatus
        ? window.HarnessRunRenderers.renderAutoReplanStatus(run, { deriveAutoReplanStatus, escapeHtml, renderDetailItem, t })
        : '';
    }

    function normalizeChangedFiles(changedFiles) {
      return window.HarnessRunRenderers?.normalizeChangedFiles
        ? window.HarnessRunRenderers.normalizeChangedFiles(changedFiles)
        : [];
    }

    function resolveChangedFiles(task, artifacts) {
      return window.HarnessRunRenderers?.resolveChangedFiles
        ? window.HarnessRunRenderers.resolveChangedFiles(task, artifacts)
        : [];
    }

    function renderTaskInsights(task, artifacts) {
      return window.HarnessRunRenderers?.renderTaskInsights
        ? window.HarnessRunRenderers.renderTaskInsights(task, artifacts, {
          deriveTaskEvidence,
          escapeHtml,
          renderDetailItem,
          renderListChips,
          summarizeTaskEvidence,
          t
        })
        : '';
    }

    function renderTaskActions(task) {
      return window.HarnessRunRenderers?.renderTaskActions
        ? window.HarnessRunRenderers.renderTaskActions(task, { escapeHtml, isBusy, t })
        : '';
    }

    function statusLabel(status) {
      const map = {
        running: t('실행 중', 'Running'),
        completed: t('완료', 'Completed'),
        partial_complete: t('일부 완료', 'Partial'),
        failed: t('실패', 'Failed'),
        needs_approval: t('승인 대기', 'Needs approval'),
        needs_input: t('답변 대기', 'Needs input'),
        skipped: t('건너뜀', 'Skipped'),
        stopped: t('정지됨', 'Stopped'),
        draft: t('초안', 'Draft'),
        ready: t('대기 중', 'Ready'),
        in_progress: t('진행 중', 'In progress'),
        done: t('완료', 'Done'),
        pending: t('미정', 'Pending'),
        active: t('진행 중', 'Active')
      };
      return map[status] || status;
    }

    function resolveProjectDisplayPhase(phases, currentPhaseId) {
      const list = Array.isArray(phases) ? phases : [];
      return list.find((phase) => String(phase?.id || '') === String(currentPhaseId || ''))
        || list.find((phase) => String(phase?.status || '') === 'active')
        || null;
    }

    function reviewRouteLabel(route) {
      const map = {
        'auto-approve-docs': t('자동 승인 (문서)', 'Auto approve (docs)'),
        'auto-approve-no-diff': t('자동 승인 (변경 없음)', 'Auto approve (no diff)'),
        'auto-approve-scope-safe': t('자동 승인 (범위 안전)', 'Auto approve (scope safe)'),
        'codex-review': t('에이전트 검토', 'Agent review'),
        'agent-review': t('에이전트 검토', 'Agent review'),
        'pending': t('미정', 'Pending')
      };
      return map[route] || route || t('미정', 'Pending');
    }

    const runPresetFormDefaults = {
      auto: { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 },
      'existing-repo-bugfix': { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 },
      'existing-repo-feature': { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 },
      'greenfield-app': { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 4 },
      'refactor-stabilize': { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 },
      'docs-spec-first': { maxParallel: 2, maxTaskAttempts: 2, maxGoalLoops: 4 }
    };

    function getRunPresetFormDefaults(presetId) {
      return runPresetFormDefaults[presetId] || runPresetFormDefaults.auto;
    }

    function applyRunPresetDefaults(presetId) {
      const defaults = getRunPresetFormDefaults(presetId);
      setFieldValue('run-max-parallel-input', defaults.maxParallel);
      setFieldValue('run-max-task-attempts-input', defaults.maxTaskAttempts);
      setFieldValue('run-max-goal-loops-input', defaults.maxGoalLoops);
    }

    function applyProjectRunLoopDefaults(project) {
      const loop = project?.defaultSettings?.continuationPolicy?.runLoop || {};
      const enabledField = document.getElementById('run-loop-enabled-input');
      const modeField = document.getElementById('run-loop-mode-input');
      const maxRunsField = document.getElementById('run-loop-max-runs-input');
      const maxFailuresField = document.getElementById('run-loop-max-failures-input');
      if (enabledField) enabledField.checked = loop.enabled === true;
      if (modeField) modeField.value = loop.mode === 'until-goal' ? 'until-goal' : 'repeat-count';
      if (maxRunsField) maxRunsField.value = String(Math.max(1, Number(loop.maxRuns || 3) || 3));
      if (maxFailuresField) maxFailuresField.value = String(Math.max(1, Number(loop.maxConsecutiveFailures || 3) || 3));
    }

    function applyProjectSchedulePreset(value) {
      const cronField = document.getElementById('project-settings-schedule-cron');
      if (!cronField || !value) return;
      cronField.value = value;
      syncProjectScheduleBuilder();
    }

    function updateProjectScheduleBuilderModeButtons(selectedMode) {
      ['weekdays', 'daily', 'hourly', 'every-30-min', 'custom'].forEach((mode) => {
        const button = document.getElementById(`project-settings-schedule-builder-mode-${mode}`);
        if (!button) return;
        const active = selectedMode === mode;
        button.style.background = active ? 'rgba(15,23,42,0.95)' : 'rgba(255,255,255,0.92)';
        button.style.color = active ? '#fff' : 'var(--text)';
        button.style.borderColor = active ? 'rgba(15,23,42,0.95)' : 'rgba(15,23,42,0.12)';
        button.style.boxShadow = active ? '0 14px 30px rgba(15,23,42,0.16)' : 'none';
      });
    }

    function applyProjectScheduleBuilderMode(mode) {
      const modeField = document.getElementById('project-settings-schedule-builder-mode');
      if (!modeField) return;
      modeField.value = String(mode || 'custom').trim() || 'custom';
      updateProjectScheduleBuilderModeButtons(modeField.value);
      updateProjectScheduleBuilderPreview();
    }

    function parseProjectScheduleBuilderCron(value) {
      const cron = String(value || '').trim();
      if (!cron) return { mode: 'custom', hour: '9', minute: '0' };
      if (cron === '*/30 * * * *') return { mode: 'every-30-min', hour: '9', minute: '0' };
      const hourlyMatch = cron.match(/^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
      if (hourlyMatch) return { mode: 'hourly', hour: '9', minute: hourlyMatch[1] };
      const weekdaysMatch = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/);
      if (weekdaysMatch) {
        return { mode: 'weekdays', minute: weekdaysMatch[1], hour: weekdaysMatch[2] };
      }
      const dailyMatch = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
      if (dailyMatch) {
        return { mode: 'daily', minute: dailyMatch[1], hour: dailyMatch[2] };
      }
      return { mode: 'custom', hour: '9', minute: '0' };
    }

    function buildProjectScheduleBuilderCron() {
      const mode = document.getElementById('project-settings-schedule-builder-mode')?.value || 'custom';
      const hour = Math.min(23, Math.max(0, Number(document.getElementById('project-settings-schedule-builder-hour')?.value || 9)));
      const minute = Math.min(59, Math.max(0, Number(document.getElementById('project-settings-schedule-builder-minute')?.value || 0)));
      if (mode === 'every-30-min') return '*/30 * * * *';
      if (mode === 'hourly') return `${minute} * * * *`;
      if (mode === 'daily') return `${minute} ${hour} * * *`;
      if (mode === 'weekdays') return `${minute} ${hour} * * 1-5`;
      return '';
    }

    function projectScheduleBuilderPreview(cron) {
      const value = String(cron || '').trim();
      if (!value) return t('직접 cron을 입력하거나 아래 빌더를 적용하세요.', 'Enter a cron expression or apply the builder below.');
      if (value === '*/30 * * * *') return t('30분마다 실행합니다.', 'Runs every 30 minutes.');
      const hourlyMatch = value.match(/^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
      if (hourlyMatch) return t(`매시간 ${String(hourlyMatch[1]).padStart(2, '0')}분에 실행합니다.`, `Runs every hour at minute ${String(hourlyMatch[1]).padStart(2, '0')}.`);
      const weekdaysMatch = value.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/);
      if (weekdaysMatch) return t(`평일 ${String(weekdaysMatch[2]).padStart(2, '0')}:${String(weekdaysMatch[1]).padStart(2, '0')}에 실행합니다.`, `Runs on weekdays at ${String(weekdaysMatch[2]).padStart(2, '0')}:${String(weekdaysMatch[1]).padStart(2, '0')}.`);
      const dailyMatch = value.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
      if (dailyMatch) return t(`매일 ${String(dailyMatch[2]).padStart(2, '0')}:${String(dailyMatch[1]).padStart(2, '0')}에 실행합니다.`, `Runs daily at ${String(dailyMatch[2]).padStart(2, '0')}:${String(dailyMatch[1]).padStart(2, '0')}.`);
      return t(`사용자 정의 cron: ${value}`, `Custom cron: ${value}`);
    }

    function updateProjectScheduleBuilderPreview() {
      const previewNode = document.getElementById('project-settings-schedule-preview');
      const cronField = document.getElementById('project-settings-schedule-cron');
      if (!previewNode || !cronField) return;
      const mode = document.getElementById('project-settings-schedule-builder-mode')?.value || 'custom';
      const built = buildProjectScheduleBuilderCron();
      const previewValue = mode !== 'custom' && built ? built : cronField.value;
      const suffix = mode !== 'custom' && built && String(built).trim() !== String(cronField.value || '').trim()
        ? t(' · 아직 위 cron 입력란에는 적용되지 않았습니다.', ' · not yet applied to the cron field above.')
        : '';
      previewNode.textContent = `${projectScheduleBuilderPreview(previewValue)}${suffix}`;
    }

    function syncProjectScheduleBuilder(projectOverview = null) {
      const cronField = document.getElementById('project-settings-schedule-cron');
      const modeField = document.getElementById('project-settings-schedule-builder-mode');
      const hourField = document.getElementById('project-settings-schedule-builder-hour');
      const minuteField = document.getElementById('project-settings-schedule-builder-minute');
      if (!cronField || !modeField || !hourField || !minuteField) {
        updateProjectScheduleBuilderPreview();
        return;
      }
      const sourceCron = cronField.value || projectOverview?.project?.defaultSettings?.autoProgress?.scheduleCron || '';
      const parsed = parseProjectScheduleBuilderCron(sourceCron);
      modeField.value = parsed.mode;
      hourField.value = String(parsed.hour);
      minuteField.value = String(parsed.minute);
      updateProjectScheduleBuilderModeButtons(parsed.mode);
      updateProjectScheduleBuilderPreview();
    }

    function applyProjectScheduleBuilder() {
      const cronField = document.getElementById('project-settings-schedule-cron');
      if (!cronField) return;
      const built = buildProjectScheduleBuilderCron();
      if (built) cronField.value = built;
      updateProjectScheduleBuilderModeButtons(document.getElementById('project-settings-schedule-builder-mode')?.value || 'custom');
      updateProjectScheduleBuilderPreview();
    }

    function onProjectScheduleCronInput() {
      syncProjectScheduleBuilder();
    }

    function syncProjectSettingsFormControls(projectOverview) {
      const continuationPolicy = projectOverview?.project?.defaultSettings?.continuationPolicy || {};
      const autoProgress = projectOverview?.project?.defaultSettings?.autoProgress || {};
      const setChecked = (id, checked) => {
        const node = document.getElementById(id);
        if (node) node.checked = checked === true;
      };
      const setValue = (id, value) => {
        const node = document.getElementById(id);
        if (node) node.value = String(value ?? '');
      };
      setChecked('project-settings-run-loop-enabled', continuationPolicy.runLoop?.enabled === true);
      setValue('project-settings-run-loop-mode', continuationPolicy.runLoop?.mode === 'until-goal' ? 'until-goal' : 'repeat-count');
      setValue('project-settings-run-loop-max-runs', Math.max(1, Number(continuationPolicy.runLoop?.maxRuns || 3) || 3));
      setValue('project-settings-run-loop-max-failures', Math.max(1, Number(continuationPolicy.runLoop?.maxConsecutiveFailures || 3) || 3));
      setChecked('project-settings-pause-on-failures', autoProgress.pauseOnRepeatedFailures !== false);
      setValue('project-settings-max-failures', Math.max(1, Number(autoProgress.maxConsecutiveFailures || 3) || 3));
      syncProjectScheduleBuilder(projectOverview);
    }

    function renderTaskMeta(task, artifacts) {
      if (!task) {
        return '<div class="mini-card"><span class="k">선택 상태</span><div class="v">태스크를 선택하세요</div></div>';
      }
      const changedCount = resolveChangedFiles(task, artifacts).length;
      const reviewRoute = task.lastExecution?.reviewRoute || 'pending';
      const actionCount = Object.values(task.lastExecution?.actionCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      const verification = artifacts?.verificationJson || task.lastExecution?.verification || {};
      const verificationKinds = [...new Set([
        ...(Array.isArray(verification?.verificationTypes) ? verification.verificationTypes : []),
        ...((Array.isArray(task?.acceptanceMetadata) ? task.acceptanceMetadata : []).flatMap((item) => Array.isArray(item?.verificationTypes) ? item.verificationTypes : []))
      ])].join(', ');
      return `
        <div class="artifact-meta">
          <div class="mini-card"><span class="k">상태</span><div class="v">${escapeHtml(statusLabel(task.status))}</div></div>
          <div class="mini-card"><span class="k">시도 횟수</span><div class="v">${escapeHtml(task.attempts ?? 0)}</div></div>
          <div class="mini-card"><span class="k">검토 방식</span><div class="v">${escapeHtml(reviewRouteLabel(reviewRoute))}</div></div>
          <div class="mini-card"><span class="k">변경 파일</span><div class="v">${escapeHtml(changedCount)}</div></div>
          <div class="mini-card"><span class="k">Action 기록</span><div class="v">${escapeHtml(actionCount)}</div></div>
          <div class="mini-card"><span class="k">증거 종류</span><div class="v">${escapeHtml(verificationKinds || '미정')}</div></div>
        </div>
      `;
    }

    function renderListChips(items, empty = '없음') {
      const values = Array.isArray(items) ? items.map((item) => String(item || '').trim()).filter(Boolean) : [];
      if (!values.length) {
        return `<div class="stack-item">${escapeHtml(empty)}</div>`;
      }
      return `<div class="chip-list">${values.map((item) => `<span class="inline-chip">${escapeHtml(item)}</span>`).join('')}</div>`;
    }

    if (!window.HarnessUiArtifactRenderers?.createArtifactRenderers) {
      throw new Error('Harness artifact renderer module failed to load.');
    }

    const artifactRenderers = window.HarnessUiArtifactRenderers.createArtifactRenderers({
      escapeHtml,
      renderDetailItem,
      renderListChips
    });

    if (!window.HarnessUiProjectRenderers?.createProjectRenderers) {
      throw new Error('Harness project renderer module failed to load.');
    }

    const projectRenderers = window.HarnessUiProjectRenderers.createProjectRenderers({
      escapeHtml,
      clip,
      formatTimestamp,
      statusLabel,
      phaseCompletionSummary,
      renderCopyableText,
      phaseContractFieldId,
      isBusy,
      projectLaneLabel,
      deriveProjectOperatorAction,
      deriveProjectDecisionQueue,
      deriveProjectBulkActions,
      resolveProjectDisplayPhase,
      describePreset,
      providerLabel,
      browserReadinessLabel,
      browserReadinessDetail,
      getSelectedProjectId: () => selectedProjectId,
      getProjectOverview: (projectId) => projectOverviewState.get(projectId),
      getRecentPhaseTransition: (projectId) => recentPhaseTransitionsByProjectId.get(projectId) || null
    });

    if (!window.HarnessUiModalActions?.createModalActions) {
      throw new Error('Harness modal action module failed to load.');
    }

    const modalActions = window.HarnessUiModalActions.createModalActions({
      request,
      runUiAction,
      setBanner,
      normalizeAgentModel,
      normalizePlanAgent,
      normalizePlanTask,
      renderPlanEditCollections,
      canEditPlan,
      getRuns: () => runs,
      getSelectedRunId: () => selectedRunId,
      setHarnessSettings: (next, merge = false) => {
        harnessSettings = merge ? { ...(harnessSettings || {}), ...next } : next;
        if (setUiLanguage) {
          setUiLanguage(harnessSettings?.uiLanguage || getUiLanguage?.() || 'en');
        }
        applyStaticTranslations();
        renderSidebarLiveSnapshot();
        renderRunList();
        renderProjectList();
        renderDetail();
      },
      getPlanEditAgents: () => planEditAgents,
      setPlanEditAgents: (next) => {
        planEditAgents = next;
      },
      getPlanEditTasks: () => planEditTasks,
      setPlanEditTasks: (next) => {
        planEditTasks = next;
      },
      getSelectedTaskId: () => selectedTaskId,
      setSkipTaskTargetId: (next) => {
        skipTaskTargetId = next;
      },
      getSkipTaskTargetId: () => skipTaskTargetId,
      getProjectIntake: () => projectIntake,
      setProjectIntake: (next) => {
        projectIntake = next;
      },
      getProjectIntakeSelectedRoots: () => projectIntakeSelectedRoots,
      setProjectIntakeSelectedRoots: (next) => {
        projectIntakeSelectedRoots = next;
      },
      renderProjectIntake,
      projectIntakeRootSelected,
      setFieldValue,
      projectIntakeSummaryLine,
      setCreateRunDraftContext: (next) => {
        createRunDraftContext = next;
      },
      getSelectedProjectSummary: () => selectedProjectSummary(),
      describePreset,
      resolveProjectDisplayPhase,
      browserReadinessLabel,
      getProjectOverview: (projectId) => projectOverviewState.get(projectId),
      getSelectedProjectId: () => selectedProjectId,
      applyRunPresetDefaults,
      renderCreateRunContext,
      renderDraftDiagnostics,
      setDraftDiagnostics: (next) => {
        draftDiagnostics = next;
      },
      getRunPresetFormDefaults,
      normalizeMaxChainDepth,
      refreshProjects,
      refreshProjectOverview,
      refreshRuns,
      selectRun,
      selectProject
    });

    modalActions.attachFormHandlers();
    applyStaticTranslations();

    function renderTaskDefinition(task, options = {}) {
      return window.HarnessRunRenderers?.renderTaskDefinition
        ? window.HarnessRunRenderers.renderTaskDefinition(task, options, { escapeHtml, renderDetailItem, renderListChips, statusLabel })
        : '';
    }

    function renderAgentBlueprint(run) {
      const agents = Array.isArray(run.agents) ? run.agents : [];
      if (!agents.length) {
        return '<div class="stack-item">에이전트 구성이 아직 없습니다.</div>';
      }
      const labels = {
        planner: '계획 정리',
        implementer: '구현',
        verifier: '검토',
        'goal-judge': '완료 판단',
        'bug-reproducer': '문제 재현 확인',
        'spec-locker': '범위 고정',
        integrator: '통합 정리',
        'producer-reviewer-loop': '구현-검토 조정'
      };
      return `
        <div class="agent-row">
          ${agents.map((agent) => `
            <div class="agent-chip">
              <strong>${escapeHtml(labels[String(agent.name || '').trim()] || agent.name || '에이전트')}</strong>
              <div>${escapeHtml(agent.role || agent.responsibility || '')}</div>
              <small>${escapeHtml(providerLabel(agent.model || 'codex'))}${agent.name ? ` · 역할 코드 ${escapeHtml(agent.name || '')}` : ''}</small>
            </div>
          `).join('')}
        </div>
      `;
    }

    function canEditPlan(run) {
      return ['draft', 'needs_approval'].includes(run?.status);
    }

    function normalizePlanAgent(agent = {}) {
      return {
        name: String(agent.name || '').trim(),
        role: String(agent.role || '').trim(),
        model: normalizeAgentModel(agent.model, 'codex'),
        responsibility: String(agent.responsibility || '').trim()
      };
    }

    function normalizePlanTask(task = {}) {
      return {
        id: String(task.id || '').trim(),
        title: String(task.title || '').trim(),
        goal: String(task.goal || '').trim(),
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : String(task.dependsOn || '').split(',').map((item) => item.trim()).filter(Boolean),
        filesLikely: Array.isArray(task.filesLikely) ? task.filesLikely : String(task.filesLikely || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        constraints: Array.isArray(task.constraints) ? task.constraints : String(task.constraints || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        acceptanceChecks: Array.isArray(task.acceptanceChecks) ? task.acceptanceChecks : String(task.acceptanceChecks || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      };
    }

    function renderPlanEditCollections() {
      const agentsRoot = document.getElementById('plan-edit-agents-list');
      const tasksRoot = document.getElementById('plan-edit-tasks-list');
      if (agentsRoot) {
        agentsRoot.innerHTML = planEditAgents.map((agent, index) => `
          <div class="stack-item">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
              <strong>에이전트 ${index + 1}</strong>
              <button type="button" class="secondary-btn" onclick="removePlanAgent(${index})">삭제</button>
            </div>
            <div class="form-grid">
              <div class="form-group"><label>이름</label><input value="${escapeHtml(agent.name)}" oninput="updatePlanAgent(${index}, 'name', this.value)"></div>
              <div class="form-group"><label>모델</label><select onchange="updatePlanAgent(${index}, 'model', this.value)">${renderAgentModelOptions(agent.model)}</select></div>
              <div class="form-group full"><label>역할</label><input value="${escapeHtml(agent.role)}" oninput="updatePlanAgent(${index}, 'role', this.value)"></div>
              <div class="form-group full"><label>책임</label><textarea oninput="updatePlanAgent(${index}, 'responsibility', this.value)">${escapeHtml(agent.responsibility)}</textarea></div>
            </div>
          </div>
        `).join('') || '<div class="stack-item">에이전트가 없습니다.</div>';
      }
      if (tasksRoot) {
        tasksRoot.innerHTML = planEditTasks.map((task, index) => `
          <div class="stack-item">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
              <strong>태스크 ${index + 1}</strong>
              <button type="button" class="secondary-btn" onclick="removePlanTask(${index})">삭제</button>
            </div>
            <div class="form-grid">
              <div class="form-group"><label>ID</label><input value="${escapeHtml(task.id)}" oninput="updatePlanTask(${index}, 'id', this.value)"></div>
              <div class="form-group"><label>선행 태스크</label><input value="${escapeHtml((task.dependsOn || []).join(', '))}" oninput="updatePlanTaskList(${index}, 'dependsOn', this.value, 'comma')"></div>
              <div class="form-group full"><label>제목</label><input value="${escapeHtml(task.title)}" oninput="updatePlanTask(${index}, 'title', this.value)"></div>
              <div class="form-group full"><label>목표</label><textarea oninput="updatePlanTask(${index}, 'goal', this.value)">${escapeHtml(task.goal)}</textarea></div>
              <div class="form-group"><label>예상 변경 파일</label><textarea oninput="updatePlanTaskList(${index}, 'filesLikely', this.value, 'lines')">${escapeHtml((task.filesLikely || []).join('\\n'))}</textarea></div>
              <div class="form-group"><label>제약</label><textarea oninput="updatePlanTaskList(${index}, 'constraints', this.value, 'lines')">${escapeHtml((task.constraints || []).join('\\n'))}</textarea></div>
              <div class="form-group full"><label>완료 조건</label><textarea oninput="updatePlanTaskList(${index}, 'acceptanceChecks', this.value, 'lines')">${escapeHtml((task.acceptanceChecks || []).join('\\n'))}</textarea></div>
            </div>
          </div>
        `).join('') || '<div class="stack-item">태스크가 없습니다.</div>';
      }
    }

    function addPlanAgent() {
      planEditAgents.push(normalizePlanAgent({ name: '새 에이전트', model: harnessSettings?.workerProvider || 'codex' }));
      renderPlanEditCollections();
    }

    function removePlanAgent(index) {
      planEditAgents.splice(index, 1);
      renderPlanEditCollections();
    }

    function updatePlanAgent(index, field, value) {
      planEditAgents[index] = { ...planEditAgents[index], [field]: value };
    }

    function addPlanTask() {
      planEditTasks.push(normalizePlanTask({ id: '', title: '새 태스크', goal: '' }));
      renderPlanEditCollections();
    }

    function removePlanTask(index) {
      planEditTasks.splice(index, 1);
      renderPlanEditCollections();
    }

    function updatePlanTask(index, field, value) {
      planEditTasks[index] = { ...planEditTasks[index], [field]: value };
    }

    function updatePlanTaskList(index, field, value, mode) {
      const items = mode === 'comma'
        ? String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
        : String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      planEditTasks[index] = { ...planEditTasks[index], [field]: items };
    }

    function deriveParallelReason(run) {
      const tasks = Array.isArray(run.tasks) ? run.tasks : [];
      const doneIds = new Set(tasks.filter((task) => task.status === 'done' || task.status === 'skipped').map((task) => task.id));
      const ready = tasks.filter((task) => task.status === 'ready' && (task.dependsOn || []).every((dep) => doneIds.has(dep)));
      const worktreeEligible = run.preflight?.project?.worktreeEligible !== false;
      const failureAnalytics = run.memory?.failureAnalytics || {};
      const failedCount = tasks.filter((task) => task.status === 'failed').length;
      const retryReadyCount = ready.filter((task) => Number(task.attempts || 0) > 0).length;
      const highDriftCount = Number(run.metrics?.replanHighDriftCount || 0);
      if ((run.executionPolicy?.parallelMode || 'sequential') !== 'parallel') {
        if (!worktreeEligible && ((run.profile?.flowProfile || 'sequential') === 'hybrid' || Number(run.settings?.maxParallel || 0) > 1)) {
          return '공유 워크스페이스 상태라 병렬 실행을 잠시 끄고 1개씩 진행합니다.';
        }
        return '현재 계획 패턴이 순차 실행이라 한 번에 1개씩 진행합니다.';
      }
      if (failedCount > 0 || retryReadyCount > 0 || highDriftCount > 0 || Number(failureAnalytics.scopeDriftCount || 0) > 0) {
        return '최근 실패·재시도·drift 신호가 있어 adaptive parallelism이 현재 배치를 1개씩으로 줄였습니다.';
      }
      if (Number(failureAnalytics.verificationFailures || 0) > 1 || Number(failureAnalytics.retryCount || 0) > 2) {
        return '최근 verification 실패 패턴이 누적돼 adaptive parallelism이 병렬 폭을 보수적으로 낮췄습니다.';
      }
      if (ready.length <= 1) {
        return ready.length ? '현재는 바로 실행 가능한 태스크가 1개뿐입니다.' : '현재는 선행 태스크나 실패 태스크 때문에 바로 실행 가능한 태스크가 없습니다.';
      }
      const codeLikeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php']);
      const codeDomainRoots = new Set(['src', 'app', 'server', 'lib', 'components', 'features', 'packages', 'tests']);
      const normalizeFiles = (list) => [...new Set((Array.isArray(list) ? list : []).map((item) => String(item || '').trim().replace(/\\\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()).filter(Boolean))];
      const overlaps = (leftPath, rightPath) => {
        if (!leftPath || !rightPath) return false;
        if (leftPath === rightPath) return true;
        return rightPath.startsWith(`${leftPath}/`) || leftPath.startsWith(`${rightPath}/`);
      };
      const extname = (value) => {
        const normalized = String(value || '');
        const index = normalized.lastIndexOf('.');
        return index >= 0 ? normalized.slice(index).toLowerCase() : '';
      };
      const isCodeLike = (value) => {
        const normalized = String(value || '').trim();
        if (!normalized) return false;
        const parts = normalized.split('/').filter(Boolean);
        if (codeDomainRoots.has(parts[0] || '')) return true;
        return codeLikeExtensions.has(extname(normalized));
      };
      const collisionDomainRoot = (value) => {
        const normalized = String(value || '').trim();
        if (!normalized || !isCodeLike(normalized)) return '';
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length >= 2 && codeDomainRoots.has(parts[0])) {
          return `${parts[0]}/${parts[1]}`;
        }
        return parts[0] || '';
      };
      const collide = (left, right) => {
        const a = normalizeFiles(left.filesLikely);
        const b = normalizeFiles(right.filesLikely);
        if (a.includes('*') || b.includes('*')) return true;
        if (a.some((item) => b.some((candidate) => overlaps(item, candidate)))) return true;
        const aDomains = new Set(a.map(collisionDomainRoot).filter(Boolean));
        const bDomains = new Set(b.map(collisionDomainRoot).filter(Boolean));
        return [...aDomains].some((domain) => bDomains.has(domain));
      };
      const blockedPairs = [];
      for (let i = 0; i < ready.length; i += 1) {
        for (let j = i + 1; j < ready.length; j += 1) {
          if (collide(ready[i], ready[j])) {
            blockedPairs.push(`${ready[i].id}-${ready[j].id}`);
          }
        }
      }
      return blockedPairs.length
        ? `병렬 모드지만 filesLikely가 겹쳐 동시에 못 도는 조합이 있습니다: ${blockedPairs.join(', ')}`
        : `병렬 실행 가능 태스크가 ${ready.length}개 있습니다.`;
    }

    function renderPlanPreview(run, limit = 4) {
      return window.HarnessRunRenderers?.renderPlanPreview
        ? window.HarnessRunRenderers.renderPlanPreview(run, limit, {
            canEditPlan,
            clip,
            describePattern,
            describePreset,
            escapeHtml,
            renderAgentBlueprint,
            renderDetailItem,
            renderListChips,
            t
          })
        : '';
    }

    function getRecoveryFocusTask(run) {
      const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
      return tasks.find((task) => task.id === selectedTaskId && ['failed', 'ready'].includes(String(task?.status || '')))
        || tasks.find((task) => task.status === 'failed')
        || tasks.find((task) => task.status === 'ready')
        || null;
    }

    function renderRecoveryActions(run) {
      const focusTask = getRecoveryFocusTask(run);
      const canReplan = canEditPlan(run);
      const canSkip = Boolean(focusTask && ['failed', 'ready'].includes(String(focusTask?.status || '')));
      const canRetry = Boolean(focusTask && String(focusTask?.status || '') === 'failed');
      if (!canRetry && !canSkip && !canReplan) return '';
      return `
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top: 14px;">
          ${canRetry ? `<button class="primary" onclick="recoveryRetryTask()" ${isBusy('retry-task') ? 'disabled' : ''}>${isBusy('retry-task') ? '재시도 중...' : '같은 계획으로 다시 시도'}</button>` : ''}
          ${canReplan ? `<button class="secondary-btn" onclick="openRecoveryReplan()">범위를 줄여 다시 계획</button>` : ''}
          ${canSkip ? `<button class="secondary-btn" onclick="recoverySkipTask()" ${isBusy('skip-task') ? 'disabled' : ''}>${isBusy('skip-task') ? '처리 중...' : '이번 목표에서 제외'}</button>` : ''}
        </div>
      `;
    }

    function renderRecoveryGuide(run) {
      const guide = run?.recoveryGuide || null;
      if (!guide) return '';
      return `
        <div class="card" style="margin-top: 16px;">
          <h3>${escapeHtml(guide.title || t('복구 안내', 'Recovery guide'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('상태', 'Status'), guide.status, t('없음', 'None'))}
            ${renderDetailItem(t('원본 기록 보존', 'Raw evidence kept'), guide.rawPreserved, t('없음', 'None'))}
            ${renderDetailItem(t('수동 안내 문서', 'Manual runbook'), guide.manualRunbookPath, t('없음', 'None'))}
          </div>
          ${renderRecoveryActions(run)}
          <div class="stack-list" style="margin-top: 14px;">
            ${(guide.steps || []).map((step) => `<div class="stack-item">${escapeHtml(step)}</div>`).join('') || `<div class="stack-item">${escapeHtml(t('추가 복구 안내 없음', 'No extra recovery guidance'))}</div>`}
          </div>
        </div>
      `;
    }

    function deriveRestartRecovery(run) {
      return window.HarnessRunRenderers?.deriveRestartRecovery
        ? window.HarnessRunRenderers.deriveRestartRecovery(run, { t })
        : null;
    }

    function renderRestartRecoveryNotice(run) {
      return window.HarnessRunRenderers?.renderRestartRecoveryNotice
        ? window.HarnessRunRenderers.renderRestartRecoveryNotice(run, { deriveRestartRecovery, escapeHtml, renderDetailItem, t })
        : '';
    }

    function buildStructuredSpecText(form) {
      return modalActions.buildStructuredSpecText(form);
    }

    function buildStructuredSpecTextFromDraft(draft = {}) {
      return modalActions.buildStructuredSpecTextFromDraft(draft);
    }

    function buildProjectPayloadFromForm(form, options = {}) {
      return modalActions.buildProjectPayloadFromForm(form, options);
    }

    function buildStarterRunPayload(project, intake) {
      return modalActions.buildStarterRunPayload(project, intake);
    }

    function setFieldValue(id, value) {
      const node = document.getElementById(id);
      if (node) node.value = value == null ? '' : String(value);
    }

    function inferRunTitle(explicitTitle, projectPath, objective) {
      const explicit = String(explicitTitle || '').trim();
      if (explicit) return explicit;
      const objectiveText = String(objective || '').trim().replace(/\s+/g, ' ');
      if (objectiveText) return objectiveText.slice(0, 40);
      const folderName = String(projectPath || '').trim().split(/[\\/]/).filter(Boolean).pop();
      return folderName || '새 작업';
    }

    function projectIntakeSummaryLine(intake) {
      const docs = Array.isArray(intake?.docs?.recommendedSpecFiles) ? intake.docs.recommendedSpecFiles.length : 0;
      const commands = Array.isArray(intake?.repo?.validationCommands) ? intake.repo.validationCommands.length : 0;
      return `추천 spec ${docs}개 · 검증 명령 ${commands}개`;
    }

    function projectIntakeRootSelected(root) {
      return projectIntakeSelectedRoots.includes(String(root || ''));
    }

    function renderIntakeHandoffChecklist(intake) {
      const starterRun = intake?.starterRunDraft || {};
      const projectDraft = intake?.recommendedProject || {};
      const validationCommands = Array.isArray(intake?.repo?.validationCommands) ? intake.repo.validationCommands : [];
      const steps = [
        `프로젝트를 만든 뒤 첫 작업으로 ${starterRun.objective || '현재 저장소와 문서를 비교해 해야 할 일을 정리'} 작업을 시작합니다.`,
        `${projectDraft.phaseTitle ? `추천 시작 단계는 ${projectDraft.phaseTitle}이며` : '필요하면 시작 단계를 만들고'} 이번 단계에서 어디까지 할지부터 먼저 확인합니다.`,
        validationCommands.length
          ? `초기 검증 경로는 ${validationCommands.slice(0, 2).join(' / ')} 기준으로 잡습니다.`
          : '검증 명령은 repo 분석 결과를 보고 첫 런에서 확정합니다.'
      ];
      return `
        <div class="card" style="margin:14px 0 0;">
          <h3>생성 후 바로 할 일</h3>
          <div class="project-handoff-list">
            ${steps.map((step, index) => `
              <div class="project-handoff-step">
                <strong>${index + 1}</strong>
                <div>${escapeHtml(step)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    function projectIntakeOperatingMode(intake) {
      const specCount = Array.isArray(intake?.docs?.recommendedSpecFiles) ? intake.docs.recommendedSpecFiles.length : 0;
      if (specCount > 0) {
        return {
          label: '기존 repo + docs 기반',
          detail: '이미 있는 코드와 문서를 대조해서 첫 작업에서 해야 할 일과 검증 방법을 먼저 고정하는 흐름이 맞습니다.'
        };
      }
      return {
        label: '새 프로젝트 / 문서 적음',
        detail: '프로젝트를 먼저 만들고, 첫 단계와 첫 작업에서 기본 구조와 작업 범위를 세우는 흐름이 맞습니다.'
      };
    }

    function renderProjectIntake() {
      const root = document.getElementById('project-intake-results');
      const submitBtn = document.getElementById('project-submit-btn');
      const createOnlyBtn = document.getElementById('project-create-only-btn');
      const footerHint = document.getElementById('project-footer-hint');
      if (!root) return;
      if (!projectIntake) {
        root.style.display = 'none';
        root.innerHTML = '';
        if (submitBtn) submitBtn.textContent = '프로젝트만 생성';
        if (createOnlyBtn) createOnlyBtn.style.display = 'none';
        if (footerHint) {
          footerHint.style.display = 'none';
          footerHint.textContent = '';
        }
        return;
      }
      const candidates = Array.isArray(projectIntake.docs?.candidates) ? projectIntake.docs.candidates : [];
      const specFolderCandidates = Array.isArray(projectIntake.docs?.specFolderCandidates) ? projectIntake.docs.specFolderCandidates : [];
      const recommendedSpecFiles = Array.isArray(projectIntake.docs?.recommendedSpecFiles) ? projectIntake.docs.recommendedSpecFiles : [];
      const recommendedSpecDetails = Array.isArray(projectIntake.docs?.recommendedSpecDetails) ? projectIntake.docs.recommendedSpecDetails : [];
      const validationCommands = Array.isArray(projectIntake.repo?.validationCommands) ? projectIntake.repo.validationCommands : [];
      const starterRun = projectIntake.starterRunDraft || {};
      const recommendedProject = projectIntake.recommendedProject || {};
      const blockers = Array.isArray(projectIntake.preflight?.blockers) ? projectIntake.preflight.blockers : [];
      const warnings = Array.isArray(projectIntake.preflight?.warnings) ? projectIntake.preflight.warnings : [];
      const autonomy = projectIntake.preflight?.autonomy || null;
      const operatingMode = projectIntakeOperatingMode(projectIntake);
      if (submitBtn) submitBtn.textContent = '권장: 프로젝트 + 첫 작업 생성';
      if (createOnlyBtn) createOnlyBtn.style.display = 'inline-flex';
      if (footerHint) {
        footerHint.style.display = 'block';
        footerHint.textContent = '분석을 마쳤습니다. 스크롤을 더 내리지 않아도 아래 권장 버튼으로 바로 시작할 수 있습니다.';
      }
      root.style.display = 'grid';
      root.innerHTML = `
        <div class="project-intake-shell">
          <div class="section-head" style="align-items:flex-start; margin-bottom: 14px;">
            <div>
              <span class="eyebrow">프로젝트 분석</span>
              <h3 style="margin: 0;">현재 저장소 분석 결과</h3>
              <p style="margin-top: 8px; text-align: left;">${escapeHtml(projectIntake.rootPath || '')}</p>
            </div>
            <div class="status-badge ${projectIntake.preflight?.ready ? 'completed' : 'failed'}">${escapeHtml(autonomy?.label || (projectIntake.preflight?.ready ? '분석 준비됨' : '확인 필요'))}</div>
          </div>
          ${autonomy ? `<div class="stack-list" style="margin-bottom: 12px;"><div class="stack-item ${autonomy.tier === 'manual_required' ? 'warning-item' : ''}"><strong>자동화 신뢰도 ${escapeHtml(autonomy.label)} (${escapeHtml(String(autonomy.score || 0))})</strong><div>${escapeHtml(autonomy.summary || '')}</div></div></div>` : ''}
          <div class="card" style="margin: 0 0 14px;">
            <h3>지금 가장 추천하는 다음 행동</h3>
            <div class="detail-list">
              ${renderDetailItem('권장 경로', '대부분은 `권장: 프로젝트 + 첫 작업 생성`만 누르면 바로 시작하면 됩니다.', '권장 경로 정보 없음')}
              ${renderDetailItem('왜 이 경로인가', `${operatingMode.label} · ${operatingMode.detail}`, '이유 정보 없음')}
              ${renderDetailItem('프로젝트만 먼저 만들 때', '첫 작업 문구를 아직 더 손보거나, 프로젝트 상자만 먼저 만든 뒤 나중에 시작하고 싶을 때만 씁니다.', '설명 없음')}
            </div>
            <div class="intake-actions" style="margin-top: 12px;">
              <button type="button" class="primary" onclick="createProjectAndStarterRunFromIntake()" ${isBusy('create-project-and-run') ? 'disabled' : ''}>${isBusy('create-project-and-run') ? '생성 중...' : '권장: 프로젝트 + 첫 작업 생성'}</button>
              <button type="button" class="secondary-btn" onclick="openStarterRunFromIntake()">첫 작업 초안만 열기</button>
              <button type="button" class="secondary-btn" onclick="applyProjectIntakeDraft()">추천값 채우기</button>
            </div>
          </div>
          <div class="diag-grid">
            <div class="diag-card"><strong>저장소</strong><div>${escapeHtml(projectIntake.preflight?.project?.isGitRepo ? 'Git 저장소' : '일반 폴더')}</div></div>
            <div class="diag-card"><strong>워크트리</strong><div>${escapeHtml(projectIntake.preflight?.project?.worktreeEligible ? '격리 가능' : '공유 모드')}</div></div>
            <div class="diag-card"><strong>자동화 신뢰도</strong><div>${escapeHtml(autonomy?.label || '알 수 없음')}</div></div>
            <div class="diag-card"><strong>추천 작업 방식</strong><div>${escapeHtml(describePreset(recommendedProject.defaultPresetId || 'auto'))}</div></div>
            <div class="diag-card"><strong>요약</strong><div>${escapeHtml(projectIntakeSummaryLine(projectIntake))}</div></div>
          </div>
          ${blockers.length ? `<div class="stack-list" style="margin-top: 12px;">${blockers.map((item) => `<div class="stack-item warning-item"><strong>오류</strong><div>${escapeHtml(item)}</div></div>`).join('')}</div>` : ''}
          ${warnings.length ? `<div class="stack-list" style="margin-top: 12px;">${warnings.slice(0, 4).map((item) => `<div class="stack-item"><strong>주의</strong><div>${escapeHtml(item)}</div></div>`).join('')}</div>` : ''}
          <div class="card" style="margin:14px 0 0;">
            <h3>이 화면은 이렇게 읽으면 됩니다</h3>
            <div class="stack-list">
              <div class="stack-item"><strong>프로젝트</strong><div>단계, 기본 작업 방식, 담당 AI, 정리 점검, 이어받을 작업, 공유 메모리를 오래 유지하는 작업 상자입니다.</div></div>
              <div class="stack-item"><strong>첫 작업</strong><div>그 프로젝트 안에서 가장 먼저 실행할 좁은 작업 단위입니다. 기존 저장소와 문서가 있으면 보통 구현보다 방향 정리가 먼저 옵니다.</div></div>
              <div class="stack-item"><strong>권장 시작 방식</strong><div>${escapeHtml(operatingMode.label)} · ${escapeHtml(operatingMode.detail)}</div></div>
            </div>
          </div>
          <div class="card" style="margin:14px 0 0;">
            <h3>명세로 볼 폴더 선택</h3>
            <div class="stack-list">
              ${specFolderCandidates.map((item) => `
                <div class="stack-item interactive" onclick="toggleProjectIntakeSpecRoot('${escapeHtml(item.root)}')">
                  <strong>${projectIntakeRootSelected(item.root) ? '선택됨' : '미선택'} · ${escapeHtml(item.root)}</strong>
                  <div>${escapeHtml((item.kinds || []).join(', '))} · 문서 ${escapeHtml(item.docCount)}</div>
                </div>
              `).join('') || '<div class="stack-item">선택 가능한 명세 폴더가 없습니다. 감지된 문서 목록에서 직접 판단합니다.</div>'}
            </div>
            <div style="margin-top:8px; color: var(--muted); font-size: 12px;">코드 구조 분석은 항상 유지되고, 여기서는 첫 run에 넣을 명세 문맥만 고릅니다.</div>
          </div>
          <div class="project-intake-grid" style="margin-top: 14px;">
            <div class="card" style="margin:0;">
              <h3>추천 프로젝트 초안</h3>
              <div class="stack-list">
                <div class="stack-item"><strong>이름</strong><div>${escapeHtml(recommendedProject.title || '-')}</div></div>
                <div class="stack-item"><strong>추천 시작 단계</strong><div>${escapeHtml(recommendedProject.phaseTitle || '필요 시 자동 생성')}</div></div>
                <div class="stack-item"><strong>시작 단계 목표</strong><div>${escapeHtml(clip(recommendedProject.phaseGoal || '', 220) || '첫 작업에서 먼저 정합니다.')}</div></div>
              </div>
            </div>
            <div class="card" style="margin:0;">
              <h3>추천 첫 작업</h3>
              <div class="stack-list">
                <div class="stack-item"><strong>작업 방식</strong><div>${escapeHtml(describePreset(starterRun.presetId || 'auto'))}</div></div>
                <div class="stack-item"><strong>목표</strong><div>${escapeHtml(clip(starterRun.objective || '', 220) || '-')}</div></div>
                <div class="stack-item"><strong>제외 범위</strong><div>${escapeHtml(clip(starterRun.excludedScope || '', 220) || '-')}</div></div>
              </div>
            </div>
          </div>
          <div class="card" style="margin:14px 0 0;">
            <h3>버튼 의미</h3>
            <div class="stack-list">
              <div class="stack-item"><strong>추천값 채우기</strong><div>분석 결과를 프로젝트 폼에 다시 반영합니다. 프로젝트 분석 직후 비어 있던 항목은 이미 자동으로 채워집니다.</div></div>
              <div class="stack-item"><strong>첫 작업 초안만 열기</strong><div>프로젝트는 아직 만들지 않고, 추천된 첫 작업 내용을 먼저 검토하거나 문구를 수정할 때 씁니다.</div></div>
              <div class="stack-item"><strong>권장: 프로젝트 + 첫 작업 생성</strong><div>대부분의 기존 저장소/문서 기반 작업은 이 버튼 하나로 바로 시작하면 됩니다.</div></div>
            </div>
          </div>
          <div class="card" style="margin:14px 0 0;">
            <h3>감지한 문서</h3>
            <div class="stack-list">
              ${candidates.slice(0, 8).map((item) => `
                <div class="stack-item">
                  <strong>${escapeHtml(item.relativePath || item.path || '-')}</strong>
                  <div>${escapeHtml(item.kind || 'doc')}</div>
                  <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(item.snippet || '', 180) || '미리보기 없음')}</div>
                </div>
              `).join('') || '<div class="stack-item">감지한 문서가 없습니다.</div>'}
            </div>
          </div>
          <div class="card" style="margin:14px 0 0;">
            <h3>추천 spec / 검증</h3>
            <div class="stack-list">
              <div class="stack-item">
                <strong>쉽게 말해 이렇게 고릅니다</strong>
                <div>전체 방향을 잡는 문서와, 이번 첫 작업에 직접 필요한 명세만 먼저 넣었습니다. 너무 많은 문서를 한 번에 넣지 않도록 추렸습니다.</div>
              </div>
              ${recommendedSpecDetails.slice(0, 6).map((item) => `
                <div class="stack-item">
                  ${renderCopyableText(item.path, '명세 경로를 복사했습니다.')}
                  <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(item.selectionReason || '')}</div>
                </div>
              `).join('') || recommendedSpecFiles.slice(0, 6).map((item) => `<div class="stack-item">${renderCopyableText(item, '명세 경로를 복사했습니다.')}</div>`).join('') || '<div class="stack-item">추천 spec 없음</div>'}
              ${validationCommands.slice(0, 4).map((item) => `<div class="stack-item"><strong>검증</strong><div>${escapeHtml(item)}</div></div>`).join('')}
            </div>
          </div>
          ${renderIntakeHandoffChecklist(projectIntake)}
          <div class="intake-actions">
            <button type="button" class="secondary-btn" onclick="applyProjectIntakeDraft()">추천값 채우기</button>
            <button type="button" class="secondary-btn" onclick="openStarterRunFromIntake()">첫 작업 초안만 열기</button>
            <button type="button" class="primary" onclick="createProjectAndStarterRunFromIntake()" ${isBusy('create-project-and-run') ? 'disabled' : ''}>${isBusy('create-project-and-run') ? '생성 중...' : '권장: 프로젝트 + 첫 작업 생성'}</button>
          </div>
        </div>
      `;
    }

    function renderDraftDiagnostics() {
      const root = document.getElementById('draft-diagnostics');
      if (!root) return;
      if (!draftDiagnostics) {
        root.style.display = 'none';
        root.innerHTML = '';
        return;
      }
      const blockers = (draftDiagnostics.blockers || []).map((item) => `<div class="stack-item"><strong>오류</strong><div>${escapeHtml(item)}</div></div>`).join('');
      const warnings = (draftDiagnostics.warnings || []).map((item) => `<div class="stack-item"><strong>경고</strong><div>${escapeHtml(item)}</div></div>`).join('');
      const actions = (draftDiagnostics.actionPlan || []).map((item) => `<div class="stack-item"><strong>${escapeHtml(item.title || item.kind || '권장 조치')}</strong><div>${escapeHtml(item.description || '-')}</div></div>`).join('');
      const autonomy = draftDiagnostics.autonomy || null;
      root.style.display = 'grid';
      root.innerHTML = `
        <div class="diag-grid">
          <div class="diag-card"><strong>준비됨</strong><div>${escapeHtml(draftDiagnostics.ready ? '예' : '아니오')}</div></div>
          <div class="diag-card"><strong>프로젝트</strong><div>${escapeHtml(draftDiagnostics.project?.isGitRepo ? 'Git 저장소' : '일반 폴더')}</div></div>
          <div class="diag-card"><strong>워크트리</strong><div>${escapeHtml(draftDiagnostics.project?.worktreeEligible ? '격리 가능' : '공유 모드')}</div></div>
          <div class="diag-card"><strong>자동화 신뢰도</strong><div>${escapeHtml(autonomy?.label || '알 수 없음')}</div></div>
        </div>
        ${autonomy ? `<div class="stack-list"><div class="stack-item ${autonomy.tier === 'manual_required' ? 'warning-item' : ''}"><strong>${escapeHtml(autonomy.label)} (${escapeHtml(String(autonomy.score || 0))})</strong><div>${escapeHtml(autonomy.summary || '')}</div></div></div>` : ''}
        ${blockers ? `<div class="stack-list">${blockers}</div>` : ''}
        ${warnings ? `<div class="stack-list">${warnings}</div>` : ''}
        ${actions ? `<div class="stack-list">${actions}</div>` : '<div class="stack-item">추가 액션 없음</div>'}
      `;
    }

    function formatTimestamp(value) {
      const date = new Date(value || '');
      if (Number.isNaN(date.getTime())) return String(value || '');
      return date.toLocaleString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function formatElapsedSeconds(value) {
      const total = Math.max(0, Number(value || 0));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    }

    function captureClarifyDrafts() {
      for (const node of document.querySelectorAll('textarea[data-clarify-question-id]')) {
        const questionId = node.getAttribute('data-clarify-question-id');
        if (!selectedRunId || !questionId) continue;
        clarifyDraftAnswers.set(`${selectedRunId}:${questionId}`, node.value || '');
      }
    }

    function getClarifyDraft(runId, questionId) {
      return clarifyDraftAnswers.get(`${runId}:${questionId}`) || '';
    }

    function scheduleRefreshRuns() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshRuns(selectedTab === 'diagnostics');
      }, 250);
    }

    function queueProjectOverviewRefresh(projectId) {
      const id = String(projectId || '').trim();
      if (!id) return;
      if (projectOverviewRefreshTimer) clearTimeout(projectOverviewRefreshTimer);
      projectOverviewRefreshTimer = setTimeout(async () => {
        projectOverviewRefreshTimer = null;
        try {
          await refreshProjectOverview(id, { render: false });
          if (selectedProjectId === id && !selectedRunId) {
            renderDetail();
          }
        } catch {}
      }, 120);
    }

    async function openSettingsModal() { return modalActions.openSettingsModal(); }

    function closeSettingsModal() { return modalActions.closeSettingsModal(); }

    async function openPlanEditModal() { return modalActions.openPlanEditModal(); }

    function closePlanEditModal() { return modalActions.closePlanEditModal(); }

    function openRejectPlanModal() { return modalActions.openRejectPlanModal(); }

    function closeRejectPlanModal() { return modalActions.closeRejectPlanModal(); }

    function openSkipTaskModal() { return modalActions.openSkipTaskModal(); }

    function closeSkipTaskModal() { return modalActions.closeSkipTaskModal(); }

    async function pickProjectFolder() { return modalActions.pickProjectFolder(); }

    async function pickProjectRootFolder() { return modalActions.pickProjectRootFolder(); }

    async function analyzeProjectIntakeDraft(selectedRootsOverride = null) {
      return modalActions.analyzeProjectIntakeDraft(selectedRootsOverride);
    }

    async function toggleProjectIntakeSpecRoot(root) { return modalActions.toggleProjectIntakeSpecRoot(root); }

    function applyProjectIntakeDraft() { return modalActions.applyProjectIntakeDraft(); }

    function openStarterRunFromIntake() { return modalActions.openStarterRunFromIntake(); }

    async function createProjectAndStarterRunFromIntake() { return modalActions.createProjectAndStarterRunFromIntake(); }

    function selectedProjectSummary() {
      return projects.find((project) => project.id === selectedProjectId) || null;
    }

    function normalizeProjectContinuationPolicy(policy = {}) {
      const source = policy && typeof policy === 'object' ? policy : {};
      const mode = ['manual', 'guided'].includes(String(source.mode || '').trim()) ? String(source.mode || '').trim() : 'guided';
      const maxChainDepth = normalizeMaxChainDepth(source.maxChainDepth);
      return {
        mode,
        autoChainOnComplete: source.autoChainOnComplete === true,
        autoQualitySweepOnPhaseComplete: source.autoQualitySweepOnPhaseComplete === true,
        keepDocsInSync: source.keepDocsInSync !== false,
        maxChainDepth
      };
    }

    function buildSuggestedProjectRunDraft(projectOverview) {
      const project = projectOverview?.project || null;
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      const currentPhase = resolveProjectDisplayPhase(phases, project?.currentPhaseId);
      const policy = normalizeProjectContinuationPolicy(project?.defaultSettings?.continuationPolicy);
      const pendingReview = phases.flatMap((phase) => Array.isArray(phase?.pendingReview) ? phase.pendingReview : []);
      if (pendingReview.length) {
        const first = pendingReview[0];
        return {
          ready: false,
          title: '검토 대기 먼저 처리',
          detail: `${first.runTitle || first.title || first.runId || '대기 중인 작업'}에서 사람 확인이 필요합니다.`,
          actionLabel: '검토 열기',
          action: first.runId ? `selectRun('${first.runId}')` : ''
        };
      }
      if (!project || !currentPhase) {
        return {
          ready: false,
          title: '먼저 단계부터 정리',
          detail: '활성 단계가 없어 바로 다음 작업을 추천하기 어렵습니다. 단계나 목표를 먼저 정하세요.',
          actionLabel: '',
          action: ''
        };
      }

      const docsRule = policy.keepDocsInSync
        ? '문서나 명세가 source of record라면 이번 작업에서 바뀐 내용도 repo 문서에 함께 반영합니다.'
        : '';
      const carryOver = Array.isArray(currentPhase?.carryOverTasks) ? currentPhase.carryOverTasks : [];
      const cleanupLane = Array.isArray(currentPhase?.cleanupLane) ? currentPhase.cleanupLane : [];
      const recentRuns = Array.isArray(currentPhase?.recentRuns) ? currentPhase.recentRuns : [];
      const openRisks = Array.isArray(currentPhase?.openRisks) ? currentPhase.openRisks : [];
      const phaseContract = currentPhase?.phaseContract || null;

      if (carryOver.length) {
        const first = carryOver[0];
        return {
          ready: true,
          title: `${project.title || 'project'}-${String(first.taskId || 'continue').toLowerCase()}`,
          phaseTitle: currentPhase.title || '현재 단계',
          summary: '이전 실행에서 남은 작업을 먼저 이어받습니다.',
          presetId: project?.defaultPresetId || 'auto',
          objective: `${currentPhase.title || '현재 단계'}에서 남아 있는 ${first.taskId || '이어받을 작업'} ${first.title || ''}을 정리하고 현재 단계 목표 안에서 마무리합니다.`.trim(),
          successCriteria: [
            `우선 ${first.taskId || '이어받을 작업'}를 닫을 수 있어야 합니다.`,
            ...((first.acceptanceChecks || []).slice(0, 3)),
            docsRule
          ].filter(Boolean).join('\n'),
          excludedScope: [
            `${currentPhase.title || '현재 단계'} 목표 밖 새 기능 확장은 이번 작업에서 제외합니다.`,
            phaseContract?.outOfScope?.[0] || ''
          ].filter(Boolean).join('\n')
        };
      }

      if (cleanupLane.length) {
        const first = cleanupLane[0];
        return {
          ready: true,
          title: `${project.title || 'project'}-cleanup`,
          phaseTitle: currentPhase.title || '현재 단계',
          summary: '정리 점검 결과를 먼저 정리하는 maintenance run입니다.',
          presetId: 'refactor-stabilize',
          objective: `${currentPhase.title || '현재 단계'}에서 정리 작업 "${first.title || 'cleanup'}"을 먼저 처리해 다음 기능 작업 전의 리스크를 줄입니다.`,
          successCriteria: [
            first.goal || first.summary || '',
            docsRule
          ].filter(Boolean).join('\n'),
          excludedScope: `${currentPhase.title || '현재 단계'}의 새 기능 확장은 이번 정리 작업에서 제외합니다.`
        };
      }

      return {
        ready: true,
        title: `${project.title || 'project'}-${String(currentPhase.title || 'phase').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'next'}`,
        phaseTitle: currentPhase.title || '현재 단계',
        summary: '현재 단계 목표를 기준으로 다음 작업 초안을 제안합니다.',
        presetId: project?.defaultPresetId || 'auto',
        objective: `${currentPhase.title || '현재 단계'} 목표를 기준으로 다음 작업 slice를 진행합니다.${openRisks.length ? ` 열린 위험 ${openRisks.length}개를 고려해 범위를 좁힙니다.` : ''}`,
        successCriteria: [
          ...(Array.isArray(phaseContract?.deliverables) ? phaseContract.deliverables.slice(0, 3) : []),
          ...(Array.isArray(phaseContract?.verification) ? phaseContract.verification.slice(0, 2) : []),
          docsRule
        ].filter(Boolean).join('\n'),
        excludedScope: [
          ...(Array.isArray(phaseContract?.outOfScope) ? phaseContract.outOfScope.slice(0, 3) : []),
          recentRuns[0]?.title ? `이번 작업은 최근 작업 "${recentRuns[0].title}"의 범위를 불필요하게 다시 넓히지 않습니다.` : ''
        ].filter(Boolean).join('\n')
      };
    }

    function applySuggestedProjectRunDraft(options = {}) {
      const projectOverview = projectOverviewState.get(selectedProjectId);
      const suggestion = buildSuggestedProjectRunDraft(projectOverview);
      if (!suggestion?.ready) {
        if (!options.silent) {
          setBanner(suggestion?.detail || '지금은 권장 다음 작업 초안을 만들 수 없습니다.');
        }
        return suggestion;
      }
      createRunDraftContext = {
        title: projectOverview?.project?.title || '',
        phaseTitle: suggestion.phaseTitle || '',
        summary: suggestion.summary || ''
      };
      setFieldValue('project-path-input', projectOverview?.project?.rootPath || '');
      setFieldValue('run-title-input', suggestion.title || '');
      setFieldValue('run-objective-input', suggestion.objective || '');
      setFieldValue('run-success-criteria-input', suggestion.successCriteria || '');
      setFieldValue('run-excluded-scope-input', suggestion.excludedScope || '');
      setFieldValue('run-spec-files-input', '');
      setFieldValue('run-preset-input', suggestion.presetId || 'auto');
      applyRunPresetDefaults(suggestion.presetId || 'auto');
      renderCreateRunContext();
      renderDraftDiagnostics();
      if (!options.silent) {
        setBanner('권장 다음 작업 초안을 열었습니다.', 'info');
      }
      return suggestion;
    }

    function openSuggestedProjectRun() {
      if (!selectedProjectId) return;
      const projectOverview = projectOverviewState.get(selectedProjectId);
      const suggestion = buildSuggestedProjectRunDraft(projectOverview);
      if (!suggestion?.ready) {
        if (suggestion?.action) {
          try {
            window.eval(String(suggestion.action));
          } catch {}
        } else {
          setBanner(suggestion?.detail || '지금은 권장 다음 작업 초안을 만들 수 없습니다.');
        }
        return;
      }
      modalActions.openCreateModal();
      applySuggestedProjectRunDraft({ silent: true });
      setBanner('권장 다음 작업 초안을 열었습니다.', 'info');
    }

    function renderCreateRunContext() {
      const root = document.getElementById('create-run-context');
      if (!root) return;
      const project = selectedProjectSummary();
      if (!project && createRunDraftContext) {
        root.style.display = 'block';
        root.innerHTML = `
          <strong style="display:block; margin-bottom:6px;">프로젝트 분석 추천 초안을 바탕으로 첫 작업을 생성합니다.</strong>
          <div>${escapeHtml(createRunDraftContext.title || '프로젝트')} · ${escapeHtml(createRunDraftContext.phaseTitle || '시작 전 정리')}</div>
          <div style="margin-top:6px; color: var(--muted);">${escapeHtml(createRunDraftContext.summary || '')}</div>
        `;
        return;
      }
      if (!project) {
        root.style.display = 'none';
        root.innerHTML = '';
        return;
      }
      const activePhase = resolveProjectDisplayPhase(project.phases, project.currentPhaseId);
      const toolProfile = project.defaultSettings?.toolProfile || null;
      const browserVerification = project.defaultSettings?.browserVerification || null;
      const devServer = project.defaultSettings?.devServer || null;
      const providerProfile = project.defaultSettings?.providerProfile || null;
      const continuationPolicy = normalizeProjectContinuationPolicy(project.defaultSettings?.continuationPolicy);
      const runtimeBrowser = projectOverviewState.get(selectedProjectId)?.project?.runtimeReadiness?.browser || null;
      const browserPolicyLabel = browserPolicyLabelText(
        runtimeBrowser?.policyLabel || '',
        Boolean(browserVerification?.url || browserVerification?.selector || devServer?.command || devServer?.url)
      );
      const providerSummary = providerProfile
        ? t(
          `${providerLabel(providerProfile.coordinationProvider || 'codex')}가 계획/검토 · ${providerLabel(providerProfile.workerProvider || 'codex')}가 구현`,
          `${providerLabel(providerProfile.coordinationProvider || 'codex')} handles planning/review · ${providerLabel(providerProfile.workerProvider || 'codex')} handles implementation`
        )
        : t(
          `${providerLabel(harnessSettings?.coordinationProvider || 'codex')}가 계획/검토 · ${providerLabel(harnessSettings?.workerProvider || 'codex')}가 구현 (이 PC 기본값 따름)`,
          `${providerLabel(harnessSettings?.coordinationProvider || 'codex')} handles planning/review · ${providerLabel(harnessSettings?.workerProvider || 'codex')} handles implementation (inherits this machine default)`
        );
      root.style.display = 'block';
      root.innerHTML = `
        <strong style="display:block; margin-bottom:6px;">${escapeHtml(t('현재 선택된 프로젝트로 작업을 생성합니다.', 'This new run will use the currently selected project.'))}</strong>
        <div>${escapeHtml(project.title || project.id)} · ${escapeHtml(activePhase?.title || t('활성 단계 없음', 'No active phase'))}</div>
        <div style="margin-top:6px; color: var(--muted);">${escapeHtml(clip(project.rootPath || '', 120) || t('root path 없음', 'No root path'))}</div>
        <div style="margin-top:8px; color: var(--muted);">${escapeHtml(t('기본 작업 방식', 'Default work style'))}: ${escapeHtml(describePreset(project.defaultPresetId || 'auto'))}</div>
        <div style="margin-top:4px; color: var(--muted);">${escapeHtml(t('기본 담당 AI', 'Default agents'))}: ${escapeHtml(providerSummary)}</div>
        <div style="margin-top:4px; color: var(--muted);">${escapeHtml(t('기본 도구 프로필', 'Default tool profile'))}: ${escapeHtml(toolProfile?.label || toolProfile?.id || 'default')} · ${escapeHtml(t('브라우저 확인 기본 정책', 'Browser policy'))}: ${escapeHtml(browserPolicyLabel)} · ${escapeHtml(t('브라우저 검증', 'Browser verification'))}: ${escapeHtml(browserReadinessLabel(browserVerification, runtimeBrowser))} · ${escapeHtml(t('개발 서버', 'Dev server'))}: ${escapeHtml(devServer?.command || t('미설정', 'Not set'))}</div>
        <div style="margin-top:4px; color: var(--muted);">${escapeHtml(t('연속 작업 운영', 'Continuation mode'))}: ${escapeHtml(continuationModeLabel(continuationPolicy.mode))} · ${escapeHtml(t('문서 동기화', 'Docs sync'))} ${escapeHtml(docsSyncChoiceLabel(continuationPolicy.keepDocsInSync))} · ${escapeHtml(t('단계 완료 시 정리 점검', 'Phase-close quality sweep'))} ${escapeHtml(autoSweepChoiceLabel(continuationPolicy.autoQualitySweepOnPhaseComplete))} · ${escapeHtml(t('자동 체이닝', 'Auto-chain after run'))} ${escapeHtml(autoChainChoiceLabel(continuationPolicy.autoChainOnComplete))} · ${escapeHtml(t('최대 연쇄 수', 'Max chain depth'))}: ${Math.max(continuationPolicy.maxChainDepth, 0)}</div>
        ${(continuationPolicy.runLoop?.enabled) ? `<div style="margin-top:4px; color: var(--muted);">${escapeHtml(t('기본 런 루프', 'Default run loop'))}: ${escapeHtml(continuationPolicy.runLoop.mode === 'until-goal' ? t('목표 달성까지 반복', 'Repeat until goal achieved') : t('정해진 횟수 반복', 'Repeat N runs'))} · ${escapeHtml(t('최대 반복', 'Max runs'))} ${escapeHtml(String(continuationPolicy.runLoop.maxRuns || 3))} · ${escapeHtml(t('실패 중단', 'Failure stop'))} ${escapeHtml(String(continuationPolicy.runLoop.maxConsecutiveFailures || 3))}</div>` : ''}
        <div style="margin-top:4px; color: var(--muted);">${escapeHtml(t('짧게 적어도 됩니다. Codex가 현재 단계, 이전 run, 문서 문맥을 보고 목표와 성공 조건 초안을 함께 다듬습니다.', 'A short prompt is enough. Codex will use the current phase, previous runs, and docs context to refine the goal and success criteria draft.'))}</div>
        `;
      }

    function switchTab(tab) {
      selectedTab = tab;
      if (tab === 'diagnostics') {
        refreshSystemInfo().then(renderDetail);
        return;
      }
      renderDetail();
    }

    function renderRunList() {
      const root = document.getElementById('run-list');
      if (!runs.length) {
        root.innerHTML = '<div class="empty-state" style="padding: 20px;">작업이 없습니다.</div>';
        renderSidebarLiveSnapshot();
        return;
      }
      const query = runSearchQuery.trim().toLowerCase();
      const visibleRuns = query
        ? runs.filter((run) => {
            const haystack = [run.title, run.id, run.status, run.projectTitle, run.projectId].join(' ').toLowerCase();
            return haystack.includes(query);
          })
        : runs;
      if (!visibleRuns.length) {
        root.innerHTML = '<div class="empty-state" style="padding: 20px;">검색 조건에 맞는 작업이 없습니다.</div>';
        renderSidebarLiveSnapshot();
        return;
      }
      root.innerHTML = visibleRuns.map((run) => `
        <div class="run-item ${run.id === selectedRunId ? 'active' : ''}" data-status="${escapeHtml(run.status)}" onclick="selectRun('${run.id}')">
          <strong>${escapeHtml(run.title)}</strong>
          <small>${statusLabel(run.status)} · ${escapeHtml(formatTimestamp(run.updatedAt))}</small>
          ${describeRunChainStatus(run) ? `<small>${escapeHtml(describeRunChainStatus(run))}</small>` : ''}
          <small>태스크 ${escapeHtml(run.taskCounts?.total ?? run.tasks?.length ?? 0)} · 완료 ${escapeHtml((run.taskCounts?.done ?? 0) + (run.taskCounts?.skipped ?? 0))} · 실패 ${escapeHtml(run.taskCounts?.failed ?? 0)}</small>
        </div>
      `).join('');
      renderSidebarLiveSnapshot();
    }

    function mergeRunRecord(existing, incoming) {
      if (!existing) return incoming;
      if (!incoming) return existing;
      return {
        ...existing,
        ...incoming,
        agents: incoming.agents ?? existing.agents,
        tasks: incoming.tasks ?? existing.tasks,
        input: incoming.input ?? existing.input,
        logs: incoming.logs ?? existing.logs,
        plan: incoming.plan ?? existing.plan,
        clarify: incoming.clarify ?? existing.clarify,
        humanLoop: incoming.humanLoop ?? existing.humanLoop,
        executionPolicy: incoming.executionPolicy ?? existing.executionPolicy,
        settings: incoming.settings ?? existing.settings,
        preset: incoming.preset ?? existing.preset,
        result: incoming.result ?? existing.result,
        preflight: incoming.preflight ?? existing.preflight
      };
    }

    async function hydrateRunDetail(runId, options = {}) {
      if (!runId) return null;
      const { selectFirstTask = true, fetchLogs = true, applySelectionIfCurrent = false } = options;
      const [detail, logsResult] = await Promise.all([
        request('/api/runs/' + runId),
        fetchLogs ? request('/api/runs/' + runId + '/logs') : Promise.resolve(null)
      ]);
      // Keep cached logs when fetchLogs is disabled.
      const existingLogs = runs.find(r => r.id === runId)?.logs;
      const logs = logsResult !== null
        ? (Array.isArray(logsResult) ? logsResult : [])
        : (existingLogs || []);
      const hydrated = { ...detail, logs };
      runs = runs.map((run) => run.id === runId ? mergeRunRecord(run, hydrated) : run);
      if (!runs.some((run) => run.id === runId)) {
        runs.unshift(hydrated);
      }
      if (selectFirstTask !== false && (!applySelectionIfCurrent || selectedRunId === runId)) {
        const currentTaskIds = new Set((hydrated.tasks || []).map((task) => task.id));
        selectedTaskId = currentTaskIds.has(selectedTaskId) ? selectedTaskId : (hydrated.tasks || [])[0]?.id || '';
      }
      return hydrated;
    }

    function openCreateModal() {
      const result = modalActions.openCreateModal();
      if (selectedProjectId && !createRunDraftContext) {
        const project = selectedProjectSummary();
        applyProjectRunLoopDefaults(project);
        const continuationPolicy = normalizeProjectContinuationPolicy(project?.defaultSettings?.continuationPolicy);
        if (continuationPolicy.mode === 'guided') {
          applySuggestedProjectRunDraft({ silent: true });
        } else {
          renderCreateRunContext();
        }
      }
      return result;
    }
    function closeCreateModal() { return modalActions.closeCreateModal(); }

    function openCreateProjectModal(options = {}) { return modalActions.openCreateProjectModal(options); }
    function closeCreateProjectModal() { return modalActions.closeCreateProjectModal(); }

    async function selectRun(id) {
      captureClarifyDrafts();
      const selectionSeq = ++runSelectionSeq;
      selectedProjectId = '';
      selectedRunId = id;
      artifactSubTab = 'summary';
      renderProjectList();
      renderRunList();
      renderDetail();
      await hydrateRunDetail(id, { applySelectionIfCurrent: true });  // hydrateRunDetail sets selectedTaskId
      if (selectionSeq !== runSelectionSeq || selectedRunId !== id) return;
      renderRunList();
      renderDetail();
      if (selectedRunId === id && selectedTaskId) {
        const taskId = selectedTaskId;
        const requestedKey = `${id}:${taskId}`;
        artifactLoadingKey = requestedKey;
        try {
          await fetchArtifacts(id, taskId);
        } finally {
          if (artifactLoadingKey === requestedKey) artifactLoadingKey = '';
        }
        if (selectedRunId === id && selectedTaskId === taskId) {
          renderDetail();
        }
      }
    }

    async function refreshProjects() {
      projects = await request('/api/projects');
      renderProjectList();
      renderCreateRunContext();
    }

    function updateProjectSearch(value) {
      projectSearchQuery = String(value || '');
      renderProjectList();
    }

    function updateRunSearch(value) {
      runSearchQuery = String(value || '');
      renderRunList();
    }

    async function refreshProjectOverview(projectId, options = {}) {
      if (!projectId) return null;
      const previousOverview = projectOverviewState.get(projectId);
      let overview;
      try {
        overview = await request('/api/projects/' + projectId);
      } catch (error) {
        const statusCode = Number(error?.statusCode || error?.status || 0);
        if (statusCode !== 404) throw error;
        projectOverviewState.delete(projectId);
        recentPhaseTransitionsByProjectId.delete(projectId);
        if (selectedProjectId === projectId) {
          selectedProjectId = '';
          renderProjectList();
          renderRunList();
          if (!selectedRunId) renderDetail();
          setBanner(
            t(
              '선택한 프로젝트를 찾을 수 없어 선택을 해제했습니다.',
              'The selected project no longer exists, so the selection was cleared.'
            ),
            'info'
          );
        }
        return null;
      }
      projectOverviewState.set(projectId, overview);
      const previousHealth = String(previousOverview?.project?.healthDashboard?.status || '').trim();
      const nextHealth = String(overview?.project?.healthDashboard?.status || '').trim();
      const previousPhaseId = String(previousOverview?.project?.currentPhaseId || '').trim();
      const nextPhaseId = String(overview?.project?.currentPhaseId || '').trim();
      const previousPauseReason = String(previousOverview?.project?.supervisorStatus?.runtime?.pausedReason || '').trim();
      const nextPauseReason = String(overview?.project?.supervisorStatus?.runtime?.pausedReason || '').trim();
      const severityRank = (value) => ({ healthy: 0, watch: 1, attention: 2 }[String(value || '').trim()] ?? -1);
      if (selectedProjectId === projectId && previousHealth && severityRank(nextHealth) > severityRank(previousHealth)) {
        const statusLabel = nextHealth === 'attention'
          ? t('운영 주의', 'Attention needed')
          : t('관찰 필요', 'Watch closely');
        const detail = overview?.project?.healthDashboard?.reminder?.detail
          || overview?.project?.healthDashboard?.repeatedFailures?.summary
          || overview?.project?.healthDashboard?.docsDrift?.summary
          || '';
        setBanner(`${statusLabel}: ${detail || t('프로젝트 자동화 상태를 다시 확인하세요.', 'Review the project automation state again.')}`, 'info');
        setToast(`${statusLabel}: ${detail || t('자동화 경로를 다시 확인하세요.', 'Review the automation path again.')}`, 'info');
      } else if (selectedProjectId === projectId && nextPauseReason && nextPauseReason !== previousPauseReason) {
        setBanner(t(`Supervisor 자동 일시중지: ${nextPauseReason}`, `Supervisor auto-paused: ${nextPauseReason}`), 'info');
        setToast(t(`Supervisor 정지 사유: ${nextPauseReason}`, `Supervisor stop reason: ${nextPauseReason}`), 'info');
      }
      if (selectedProjectId === projectId && previousPhaseId && nextPhaseId && previousPhaseId !== nextPhaseId) {
        recentPhaseTransitionsByProjectId.set(projectId, {
          phaseId: nextPhaseId,
          fromPhaseId: previousPhaseId,
          at: Date.now()
        });
        const nextPhase = (Array.isArray(overview?.phases) ? overview.phases : []).find((phase) => String(phase?.id || '').trim() === nextPhaseId);
        setToast(
          nextPhase?.title
            ? t(`자동으로 ${nextPhase.title} 단계로 전환했습니다.`, `Auto-advanced into phase ${nextPhase.title}.`)
            : t('프로젝트 단계가 자동 전환되었습니다.', 'The project phase advanced automatically.'),
          'success'
        );
      }
      if (options.render !== false && selectedProjectId === projectId && !selectedRunId) {
        renderDetail();
      }
      return overview;
    }

    async function selectProject(id) {
      selectedProjectId = id;
      selectedRunId = '';
      selectedTaskId = '';
      renderProjectList();
      renderRunList();
      renderDetail();
      await refreshProjectOverview(id);
    }

    async function selectRunTask(runId, taskId = '') {
      await selectRun(runId);
      if (taskId) {
        await openTaskDetails(taskId);
      }
    }

    async function rejectPlan() {
      openRejectPlanModal();
    }

    async function qualitySweepProject() {
      if (!selectedProjectId) return;
      await runUiAction('quality-sweep', async () => {
        await request(`/api/projects/${selectedProjectId}/quality-sweep`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        await refreshProjectOverview(selectedProjectId, { render: false });
        await refreshProjects();
        renderDetail();
      }, '프로젝트 정리 점검을 실행했습니다.');
    }

    async function reintakeProjectUi() {
      if (!selectedProjectId) return;
      await runUiAction('project-reintake', async () => {
        const project = selectedProjectSummary() || projectOverviewState.get(selectedProjectId)?.project || null;
        if (!project?.rootPath) {
          throw new Error(t('프로젝트 루트 경로가 없어 재분석할 수 없습니다.', 'Cannot re-analyze because the project has no root path.'));
        }
        const intake = await request('/api/projects/intake', {
          method: 'POST',
          body: JSON.stringify({
            rootPath: project.rootPath,
            title: project.title || project.id || ''
          })
        });
        projectIntake = intake;
        projectIntakeSelectedRoots = Array.isArray(intake?.docs?.selectedSpecRoots) ? intake.docs.selectedSpecRoots : [];
        openStarterRunFromIntake();
      }, t('프로젝트를 다시 분석해 첫 작업 초안을 열었습니다.', 'Re-analyzed the project and opened the first-run draft.'));
    }

    async function addProjectPhase(activate = false) {
      if (!selectedProjectId) return;
      const title = String(document.getElementById('project-new-phase-title')?.value || '').trim();
      const goal = String(document.getElementById('project-new-phase-goal')?.value || '').trim();
      if (!title && !goal) {
        setBanner('새 단계 이름이나 목표를 먼저 입력하세요.');
        return;
      }
      const project = selectedProjectSummary() || projectOverviewState.get(selectedProjectId)?.project || null;
      await runUiAction(activate ? 'add-project-phase-active' : 'add-project-phase', async () => {
        await request(`/api/projects/${selectedProjectId}`, {
          method: 'POST',
          body: JSON.stringify({
            phases: [{
              title: title || 'Next Phase',
              goal,
              status: activate || !String(project?.currentPhaseId || '').trim() ? 'active' : 'pending'
            }]
          })
        });
        document.getElementById('project-new-phase-title').value = '';
        document.getElementById('project-new-phase-goal').value = '';
        await refreshProjectOverview(selectedProjectId, { render: false });
        await refreshProjects();
        renderDetail();
      }, activate ? '새 단계를 추가하고 현재 단계로 전환했습니다.' : '새 단계를 backlog에 추가했습니다.');
    }

    async function deleteProjectUi() {
      if (!selectedProjectId) return;
      await runUiAction('delete-project', async () => {
        const projectId = selectedProjectId;
        const projectOverview = projectOverviewState.get(projectId);
        const project = projects.find((item) => item.id === projectId) || projectOverview?.project || null;
        if (!project) return;

        const confirmed = window.confirm(`"${project.title || projectId}" 프로젝트를 삭제할까요?`);
        if (!confirmed) return;

        const runCount = Number(projectOverview?.project?.retention?.runCounts?.total || 0);
        let deleteRuns = false;
        if (runCount > 0) {
          deleteRuns = window.confirm(`소속 작업 ${runCount}개도 함께 삭제할까요?\n취소를 누르면 작업은 남깁니다.`);
        }

        const sharedMemoryKey = String(projectOverview?.project?.retention?.sharedMemoryKey || '').trim();
        const hasSharedMemory = Boolean(projectOverview?.project?.retention?.sharedMemoryExists && sharedMemoryKey);
        let deleteMemory = false;
        if (hasSharedMemory) {
          deleteMemory = window.confirm(`공유 memory "${sharedMemoryKey}"도 함께 삭제할까요?\n취소를 누르면 memory는 남깁니다.`);
        }

        const result = await request(
          `/api/projects/${projectId}?deleteRuns=${deleteRuns ? 'true' : 'false'}&deleteMemory=${deleteMemory ? 'true' : 'false'}`,
          { method: 'DELETE' }
        );
        const deletedRunIds = new Set(Array.isArray(result?.deletedRuns) ? result.deletedRuns : []);
        if (deletedRunIds.size) {
          runs = runs.filter((run) => !deletedRunIds.has(run.id));
          for (const runId of deletedRunIds) {
            invalidateArtifacts(runId);
            clearDetailUiState(runId);
            if (selectedRunId === runId) {
              selectedRunId = '';
              selectedTaskId = '';
            }
          }
        }
        projectOverviewState.delete(projectId);
        selectedProjectId = '';
        await refreshProjects();
        await refreshRuns(true);
        renderDetail();
      }, '프로젝트를 삭제했습니다.');
    }

    async function saveProjectSettings() {
      return modalActions.saveProjectSettings();
    }

    async function saveProjectPhaseContract(phaseId) {
      if (!selectedProjectId || !phaseId) return;
      const payload = {
        phases: [{
          id: phaseId,
          goal: document.getElementById(phaseContractFieldId(phaseId, 'phase-goal'))?.value || '',
          phaseContract: {
            goal: document.getElementById(phaseContractFieldId(phaseId, 'goal'))?.value || '',
            deliverables: parseContractTextarea(document.getElementById(phaseContractFieldId(phaseId, 'deliverables'))?.value || ''),
            verification: parseContractTextarea(document.getElementById(phaseContractFieldId(phaseId, 'verification'))?.value || ''),
            nonNegotiables: parseContractTextarea(document.getElementById(phaseContractFieldId(phaseId, 'non-negotiables'))?.value || ''),
            outOfScope: parseContractTextarea(document.getElementById(phaseContractFieldId(phaseId, 'out-of-scope'))?.value || ''),
            carryOverRules: parseContractTextarea(document.getElementById(phaseContractFieldId(phaseId, 'carry-over-rules'))?.value || '')
          }
        }]
      };
      await runUiAction(`save-phase-contract:${phaseId}`, async () => {
        await request(`/api/projects/${selectedProjectId}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        await refreshProjectOverview(selectedProjectId, { render: false });
        await refreshProjects();
        renderDetail();
      }, '단계 계약을 저장했습니다.');
    }

    async function setProjectPhase(phaseId, mode = 'activate') {
      if (!selectedProjectId || !phaseId) return;
      const overview = projectOverviewState.get(selectedProjectId);
      const phases = Array.isArray(overview?.phases) ? overview.phases : [];
      const currentIndex = phases.findIndex((phase) => String(phase?.id || '') === String(phaseId || ''));
      const currentPhase = currentIndex >= 0 ? phases[currentIndex] : null;
      if (!currentPhase) return;
      const payload = { phases: [] };
      let successMessage = '단계 상태를 업데이트했습니다.';

      if (mode === 'complete') {
        payload.phases.push({ id: phaseId, status: 'done' });
        const nextPhase = phases.slice(currentIndex + 1).find((phase) => String(phase?.status || '') !== 'done')
          || phases.slice(0, currentIndex).find((phase) => String(phase?.status || '') !== 'done')
          || null;
        if (nextPhase?.id) {
          payload.currentPhaseId = nextPhase.id;
          payload.phases.push({ id: nextPhase.id, status: 'active' });
          successMessage = '현재 단계를 완료하고 다음 단계로 넘겼습니다.';
        } else {
          payload.currentPhaseId = '';
          successMessage = '현재 단계를 완료했습니다.';
        }
      } else {
        payload.currentPhaseId = phaseId;
        payload.phases.push({ id: phaseId, status: 'active' });
        successMessage = '현재 단계를 전환했습니다.';
      }

      await runUiAction(`project-phase:${mode}:${phaseId}`, async () => {
        await request(`/api/projects/${selectedProjectId}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const continuationPolicy = normalizeProjectContinuationPolicy(overview?.project?.defaultSettings?.continuationPolicy);
        if (mode === 'complete' && continuationPolicy.autoQualitySweepOnPhaseComplete) {
          await request(`/api/projects/${selectedProjectId}/quality-sweep`, {
            method: 'POST',
            body: JSON.stringify({ phaseId })
          });
          successMessage = '현재 단계를 완료했고 정리 점검도 자동으로 실행했습니다.';
        }
        await refreshProjectOverview(selectedProjectId, { render: false });
        await refreshProjects();
        renderDetail();
        if (successMessage) {
          setBanner(successMessage, 'success');
        }
      });
    }

    function deriveProjectOperatorAction(projectOverview) {
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      for (const phase of phases) {
        const pendingReview = Array.isArray(phase?.pendingReview) ? phase.pendingReview : [];
        if (pendingReview.length) {
          const first = pendingReview[0];
          return {
            title: t('계획/검토 대기 먼저 처리', 'Clear pending review first'),
            detail: t(`${first.runTitle || first.title || first.runId || '대기 중인 작업'}에서 사람 확인이 필요합니다.`, `${first.runTitle || first.title || first.runId || 'Waiting run'} needs human review.`),
            actionLabel: t('검토 대기로 이동', 'Open pending review'),
            action: first.runId ? `selectRun('${first.runId}')` : ''
          };
        }
      }
      for (const phase of phases) {
        const carryOver = Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks : [];
        if (carryOver.length) {
          const first = carryOver[0];
          return {
            title: t('이어받을 작업 먼저 정리', 'Clear carry-over first'),
            detail: t(`${first.taskId || ''} ${first.title || ''} 태스크가 다음 실행의 첫 후보입니다.`, `${first.taskId || ''} ${first.title || ''} is the best first candidate for the next run.`),
            actionLabel: t('태스크로 이동', 'Open task'),
            action: first.runId ? `selectRunTask('${first.runId}', '${first.taskId || ''}')` : ''
          };
        }
      }
      for (const phase of phases) {
        const cleanup = Array.isArray(phase?.cleanupLane) ? phase.cleanupLane : [];
        if (cleanup.length) {
          return {
            title: t('정리 작업 실행', 'Run cleanup'),
            detail: t(`${cleanup.length}개의 후속 정리 작업이 대기 중입니다.`, `${cleanup.length} cleanup follow-up item(s) are waiting.`),
            actionLabel: t('정리 점검 실행', 'Run quality sweep'),
            action: 'qualitySweepProject()'
          };
        }
      }
      return {
        title: t('다음 단계를 계속 진행', 'Continue the next slice'),
        detail: t('현재는 열린 검토 대기나 이어받을 작업 없이 계획된 흐름을 이어갈 수 있습니다.', 'There is no open review or carry-over blocking the planned flow.'),
        actionLabel: t('권장 다음 작업 초안', 'Suggested next run draft'),
        action: 'openSuggestedProjectRun()'
      };
    }

    function deriveProjectDecisionQueue(projectOverview) {
      const actions = [];
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      for (const phase of phases) {
        const pendingReview = Array.isArray(phase?.pendingReview) ? phase.pendingReview : [];
        for (const entry of pendingReview.slice(0, 2)) {
          actions.push({
            tone: 'warning',
            title: entry.runTitle || entry.title || t('검토 대기 런', 'Pending review run'),
            detail: entry.message || t(`${phase.title || phase.id || '단계'}에서 사람 확인이 필요합니다.`, `Human review is needed in ${phase.title || phase.id || 'this phase'}.`),
            meta: `${phase.title || phase.id || t('단계', 'Phase')} · ${projectLaneLabel(entry.kind)}`,
            actionLabel: t('검토 열기', 'Open review'),
            action: entry.runId ? `selectRun('${entry.runId}')` : ''
          });
        }
        const carryOver = Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks : [];
        for (const task of carryOver.slice(0, 2)) {
          actions.push({
            tone: 'danger',
            title: `${task.taskId || ''} ${task.title || ''}`.trim() || t('이어받을 작업', 'Carry-over task'),
            detail: task.summary || task.goal || t('다음 실행 전에 먼저 정리할 이어받을 작업입니다.', 'This carry-over task should be cleared before the next run.'),
            meta: `${phase.title || phase.id || t('단계', 'Phase')} · ${projectLaneLabel(task.lineageKind)}`,
            actionLabel: t('태스크 열기', 'Open task'),
            action: task.runId ? `selectRunTask('${task.runId}', '${task.taskId || ''}')` : ''
          });
        }
        const cleanup = Array.isArray(phase?.cleanupLane) ? phase.cleanupLane : [];
        if (cleanup.length) {
          const entry = cleanup[0];
          actions.push({
            tone: 'safe',
            title: entry.title || t('정리 작업', 'Cleanup task'),
            detail: entry.goal || entry.summary || t('정리 점검 결과를 바탕으로 처리할 후속 정리 작업이 있습니다.', 'There is a cleanup follow-up based on the latest quality sweep.'),
            meta: `${phase.title || phase.id || t('단계', 'Phase')} · ${projectLaneLabel('quality-cleanup')}`,
            actionLabel: t('정리 점검 실행', 'Run quality sweep'),
            action: 'qualitySweepProject()'
          });
        }
      }
      return actions.slice(0, 5);
    }

    function findFirstProjectQueueEntry(projectOverview, kind) {
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      for (const phase of phases) {
        if (kind === 'review') {
          const pendingReview = Array.isArray(phase?.pendingReview) ? phase.pendingReview : [];
          if (pendingReview.length) return pendingReview[0];
        }
        if (kind === 'carry-over') {
          const carryOver = Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks : [];
          if (carryOver.length) return carryOver[0];
        }
        if (kind === 'cleanup') {
          const cleanup = Array.isArray(phase?.cleanupLane) ? phase.cleanupLane : [];
          if (cleanup.length) return cleanup[0];
        }
      }
      return null;
    }

    function deriveProjectBulkActions(projectOverview) {
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      const totalPendingReview = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.pendingReview) ? phase.pendingReview.length : 0), 0);
      const totalCarryOver = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks.length : 0), 0);
      const totalCleanup = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.cleanupLane) ? phase.cleanupLane.length : 0), 0);
      const actions = [];

      const firstReview = findFirstProjectQueueEntry(projectOverview, 'review');
      if (totalPendingReview && firstReview?.runId) {
        actions.push({
          tone: 'warning',
          title: t(`리뷰 대기 ${totalPendingReview}건`, `${totalPendingReview} review item(s)`),
          detail: t('가장 먼저 열어야 할 검토 또는 승인 대기 항목부터 순서대로 처리합니다.', 'Open the oldest review or approval item first.'),
          actionLabel: t('첫 리뷰 열기', 'Open first review'),
          action: `selectRun('${firstReview.runId}')`
        });
      }

      const firstCarryOver = findFirstProjectQueueEntry(projectOverview, 'carry-over');
      if (totalCarryOver && firstCarryOver?.runId) {
        actions.push({
          tone: 'danger',
          title: t(`이어받을 작업 ${totalCarryOver}건`, `${totalCarryOver} carry-over item(s)`),
          detail: t('실패하거나 멈춘 뒤 남은 작업의 첫 항목으로 바로 내려가 다음 조치를 시작합니다.', 'Jump straight to the first unfinished carry-over item and continue there.'),
          actionLabel: t('첫 이어받을 작업 열기', 'Open first carry-over item'),
          action: `selectRunTask('${firstCarryOver.runId}', '${firstCarryOver.taskId || ''}')`
        });
      }

      if (totalCleanup) {
        actions.push({
          tone: 'safe',
          title: t(`정리 작업 ${totalCleanup}건`, `${totalCleanup} cleanup item(s)`),
          detail: t('정리 점검과 cleanup lane을 기준으로 maintenance 흐름을 먼저 정돈합니다.', 'Use the quality sweep and cleanup lane to tidy the maintenance work first.'),
          actionLabel: t('정리 점검 실행', 'Run quality sweep'),
          action: 'qualitySweepProject()'
        });
      }

      if (!actions.length) {
        actions.push({
          tone: 'safe',
          title: t('바로 실행 가능한 큐 없음', 'No urgent queue item'),
          detail: t('지금은 검토 대기나 후속 정리보다 새 작업을 열어 현재 단계를 이어가는 편이 낫습니다.', 'Right now it is better to open the next run than focus on review or cleanup.'),
          actionLabel: t('권장 다음 작업 초안', 'Suggested next run draft'),
          action: 'openSuggestedProjectRun()'
        });
      }
      return actions;
    }

    function taskStats(run) {
      if (run.taskCounts && !run.tasks) {
        return {
          total: run.taskCounts.total || 0,
          ready: run.taskCounts.ready || 0,
          progress: run.taskCounts.in_progress || 0,
          done: (run.taskCounts.done || 0) + (run.taskCounts.skipped || 0),
          failed: run.taskCounts.failed || 0
        };
      }
      const tasks = run.tasks || [];
      return {
        total: tasks.length,
        ready: tasks.filter(t => t.status === 'ready').length,
        progress: tasks.filter(t => t.status === 'in_progress').length,
        done: tasks.filter(t => t.status === 'done' || t.status === 'skipped').length,
        failed: tasks.filter(t => t.status === 'failed').length
      };
    }

    function deriveRunQueueInsights(run, stats) {
      const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
      const activeTasks = tasks.filter((task) => task.status === 'in_progress').slice(0, 2);
      const queuedTasks = tasks.filter((task) => task.status === 'ready').slice(0, 3);
      const done = Math.min(stats.done, stats.total);
      const remaining = Math.max(0, stats.total - done);
      const parallelism = Math.max(1, Number(run?.settings?.maxParallel || 1) || 1);
      const batchCount = remaining > 0 ? Math.max(1, Math.ceil(remaining / parallelism)) : 0;
      const completion = stats.total > 0 ? Math.round((done / stats.total) * 100) : 0;
      let eta = '';
      if (remaining > 0) {
        eta = activeTasks.length > 0
          ? t(`약 ${batchCount}개 배치 남음`, `About ${batchCount} batch(es) remaining`)
          : t(`대기 ${remaining}개`, `${remaining} queued`);
      }
      return {
        completion,
        remaining,
        activeTasks,
        queuedTasks,
        eta,
        batchCount
      };
    }

    function renderRunQueueProgress(run, stats) {
      const queue = deriveRunQueueInsights(run, stats);
      if (!stats.total) return '';
      const nextItems = queue.queuedTasks.length
        ? queue.queuedTasks.map((task) => `${task.id} ${clip(task.title || '', 40)}`.trim()).join(' | ')
        : t('추가 대기 태스크 없음', 'No queued follow-up tasks');
      const activeItems = queue.activeTasks.length
        ? queue.activeTasks.map((task) => `${task.id} ${clip(task.title || '', 40)}`.trim()).join(' | ')
        : t('현재 실행 중인 태스크 없음', 'No task is actively running');
      return `
        <div class="card" style="margin-bottom: 18px; border: 1px solid rgba(15,23,42,0.08); background: linear-gradient(180deg, rgba(248,250,252,0.96), rgba(255,255,255,1));">
          <div class="section-head" style="margin-bottom: 12px;">
            <div>
              <span class="eyebrow">${escapeHtml(t('런 큐 진행', 'Run queue progress'))}</span>
              <h3>${escapeHtml(t(`완료 ${queue.completion}% · 남은 배치 ${queue.batchCount || 0}`, `${queue.completion}% complete · ${queue.batchCount || 0} batch(es) left`))}</h3>
            </div>
            <p>${escapeHtml(t('실시간 태스크 큐와 남은 흐름을 한 장에서 읽습니다.', 'Read the live task queue and remaining flow in one place.'))}</p>
          </div>
          <div style="height:10px; border-radius:999px; background:rgba(15,23,42,0.08); overflow:hidden;">
            <div style="height:100%; width:${escapeHtml(String(queue.completion))}%; background:linear-gradient(90deg, rgba(15,23,42,0.92), rgba(59,130,246,0.82));"></div>
          </div>
          <div class="stats-grid" style="margin-top: 12px;">
            <div class="stat-card"><span class="label">${escapeHtml(t('실행 중', 'Active now'))}</span><div class="value">${escapeHtml(String(stats.progress || 0))}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('대기 큐', 'Queued'))}</span><div class="value">${escapeHtml(String(stats.ready || 0))}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('실패/검토', 'Failed / review'))}</span><div class="value">${escapeHtml(String(stats.failed || 0))}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('예상 남은 흐름', 'ETA'))}</span><div class="value">${escapeHtml(queue.eta || t('거의 마무리', 'Nearly done'))}</div></div>
          </div>
          <div class="stack-list" style="margin-top: 12px;">
            <div class="stack-item"><strong>${escapeHtml(t('현재 실행', 'Running now'))}</strong><div>${escapeHtml(activeItems)}</div></div>
            <div class="stack-item"><strong>${escapeHtml(t('다음 큐', 'Next up'))}</strong><div>${escapeHtml(nextItems)}</div></div>
          </div>
        </div>
      `;
    }

    function describeRunChainStatus(run) {
      const chainDepth = normalizeMaxChainDepth(run?.chainDepth);
      const chainedFromRunId = String(run?.chainedFromRunId || '').trim();
      const loop = run?.chainMeta?.loop || null;
      if (loop?.enabled) {
        const loopLabel = loop.mode === 'until-goal'
          ? t(`자동 루프 ${loop.currentRunIndex}/${loop.maxRuns} · 목표까지 반복`, `Auto loop ${loop.currentRunIndex}/${loop.maxRuns} · until goal`)
          : t(`자동 루프 ${loop.currentRunIndex}/${loop.maxRuns}`, `Auto loop ${loop.currentRunIndex}/${loop.maxRuns}`);
        if (run?.chainMeta?.chainStopped === true) {
          return `${loopLabel} · ${t('중단됨', 'Stopped')}`;
        }
        if (Number(loop.consecutiveFailures || 0) > 0) {
          return `${loopLabel} · ${t(`연속 실패 ${loop.consecutiveFailures}`, `${loop.consecutiveFailures} failed in a row`)}`;
        }
        return loopLabel;
      }
      if (run?.chainMeta?.chainStopped === true) {
        return t('자동 체인 중단됨', 'Auto-chain stopped');
      }
      if (chainedFromRunId || chainDepth > 0) {
        return t(`자동 체인 ${chainDepth}단계`, `Auto-chain depth ${chainDepth}`);
      }
      if (run?.chainMeta?.trigger) {
        return t('자동 체인 후보 있음', 'Auto-chain candidate');
      }
      return '';
    }

    function renderRunAutomationStatus(run) {
      const loop = run?.chainMeta?.loop || null;
      const chainSummary = describeRunChainStatus(run);
      if (!chainSummary && !loop) return '';
      const loopModeLabel = loop?.mode === 'until-goal'
        ? t('목표 달성까지 반복', 'Repeat until goal')
        : t('정해진 횟수 반복', 'Repeat fixed count');
      const chainDepth = normalizeMaxChainDepth(run?.chainDepth);
      const nextLoop = loop?.enabled && Number(loop.currentRunIndex || 1) < Number(loop.maxRuns || 1)
        ? `${Number(loop.currentRunIndex || 1) + 1}/${Number(loop.maxRuns || 1)}`
        : t('없음', 'None');
      return `
        <div class="card" style="margin-bottom: 18px;">
          <div class="section-head" style="margin-bottom: 12px;">
            <div>
              <span class="eyebrow">${escapeHtml(t('자동 진행', 'Automation'))}</span>
              <h3>${escapeHtml(chainSummary || t('수동 실행', 'Manual run'))}</h3>
              ${loop?.enabled ? `<div style="margin-top:6px; color:var(--muted); font-size:12px;">${escapeHtml(t(`전용 루프 진행 패널 · ${Number(loop.currentRunIndex || 1)} / ${Number(loop.maxRuns || 1)}회 | 체인 depth ${chainDepth} | 모드: ${loop.mode === 'until-goal' ? 'until-goal' : 'repeat-count'}`, `Loop progress panel · ${Number(loop.currentRunIndex || 1)} / ${Number(loop.maxRuns || 1)} | chain depth ${chainDepth} | mode: ${loop.mode === 'until-goal' ? 'until-goal' : 'repeat-count'}`))}</div>` : ''}
            </div>
            <p>${escapeHtml(loop?.enabled
              ? t('런 사이 자동 반복, 실패 중단 임계값, 계보를 함께 봅니다.', 'See run-to-run repetition, failure stop threshold, and lineage together.')
              : t('이 run은 자동 루프 없이 동작합니다.', 'This run is operating without a run-level loop.'))}</p>
          </div>
          <div class="stats-grid">
            <div class="stat-card"><span class="label">${escapeHtml(t('현재 반복', 'Current loop'))}</span><div class="value">${escapeHtml(loop?.enabled ? `${Number(loop.currentRunIndex || 1)}/${Number(loop.maxRuns || 1)}` : '-')}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('루프 방식', 'Loop mode'))}</span><div class="value">${escapeHtml(loop?.enabled ? loopModeLabel : t('꺼짐', 'Off'))}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('다음 반복', 'Next loop'))}</span><div class="value">${escapeHtml(nextLoop)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('실패 중단 임계값', 'Failure stop'))}</span><div class="value">${escapeHtml(loop?.enabled ? `${Number(loop.consecutiveFailures || 0)}/${Number(loop.maxConsecutiveFailures || 0)}` : '-')}</div></div>
          </div>
          <div class="stack-list" style="margin-top: 12px;">
            ${run.chainedFromRunId ? `<div class="stack-item"><strong>${escapeHtml(t('이전 run', 'Previous run'))}</strong><div>${escapeHtml(run.chainedFromRunId)}</div></div>` : ''}
            ${run.chainMeta?.originRunId ? `<div class="stack-item"><strong>${escapeHtml(t('루프 시작 run', 'Loop origin run'))}</strong><div>${escapeHtml(run.chainMeta.originRunId)}</div></div>` : ''}
            ${run.chainMeta?.reason ? `<div class="stack-item"><strong>${escapeHtml(t('자동 진행 이유', 'Automation reason'))}</strong><div>${escapeHtml(run.chainMeta.reason)}</div></div>` : ''}
          </div>
        </div>
      `;
    }

    function latestLog(run) {
      const logs = run.logs || [];
      return logs.length ? logs[logs.length - 1] : null;
    }

    function phaseCompletionSummary(phase) {
      const counts = phase?.runCounts || {};
      const totalRuns = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
      if (!totalRuns) return t('런 없음', 'No runs yet');
      const completed = Number(counts.completed || 0);
      const failed = Number(counts.failed || 0);
      if (failed) return t(`완료 ${completed} · 리스크 ${failed}`, `${completed} done · ${failed} at risk`);
      return t(`완료 ${completed} / 전체 ${totalRuns}`, `${completed} done / ${totalRuns} total`);
    }

    function projectLaneLabel(kind) {
      const labels = {
        'plan-approval': t('계획 승인 대기', 'Plan approval'),
        'replan-review': t('재계획 검토', 'Replan review'),
        'clarify-input': t('질문 답변 대기', 'Clarification needed'),
        'failed-task': t('실패 후 이어받기', 'Carry over after failure'),
        'retry-loop': t('재시도 대기', 'Retry loop'),
        'replanned-backlog': t('재계획 후 이어받기', 'Carry over after replan'),
        'stopped-run': t('정지 후 재개', 'Resume after stop'),
        'partial-complete': t('부분 완료 후속 작업', 'Follow-up after partial completion'),
        'quality-cleanup': t('정리 작업', 'Cleanup follow-up'),
        'carry-over': t('이어받을 작업', 'Carry-over work')
      };
      return labels[String(kind || '').trim()] || String(kind || t('backlog', 'backlog'));
    }

    function renderProjectPhaseCard(phase) {
      return projectRenderers.renderProjectPhaseCard(phase);
    }

    function renderProjectDetail(projectOverview) {
      return projectRenderers.renderProjectDetail(projectOverview);
    }

    function deriveRunHero(run) {
      const recentLog = latestLog(run);
      const failedTask = (run.tasks || []).find((task) => task.status === 'failed');

      if (run.status === 'needs_input') {
        const pendingCount = Array.isArray(run.humanLoop?.clarifyPending) ? run.humanLoop.clarifyPending.length : 0;
        return {
          title: pendingCount > 0 ? t(`작업 전에 ${pendingCount}가지만 확인하면 됩니다`, `There ${pendingCount === 1 ? 'is' : 'are'} ${pendingCount} thing${pendingCount === 1 ? '' : 's'} to confirm before work starts`) : t('작업 전에 몇 가지만 확인하면 됩니다', 'A few things need to be confirmed before work starts'),
          detail: t('질문에 짧게 답하면 Codex가 방향을 고정하고 이어서 진행합니다.', 'A short answer is enough. Codex will lock direction and continue.')
        };
      }
      if (run.status === 'needs_approval') {
        return {
          title: t('계획을 확인하고 시작 여부를 결정해 주세요', 'Review the plan and decide whether to start'),
          detail: run.planSummary
            ? t(`태스크 ${(run.tasks || []).length}개와 에이전트 ${(run.agents || []).length}개가 준비되었습니다. 아래 계획을 확인한 뒤 승인하세요.`, `${(run.tasks || []).length} tasks and ${(run.agents || []).length} agents are prepared. Review the plan below and approve when it looks right.`)
            : (recentLog?.message || t('계획이 준비되었고 사용자 승인을 기다리는 중입니다.', 'The plan is ready and waiting for approval.'))
        };
      }
      if (run.status === 'running') {
        const activeTask = (run.tasks || []).find((task) => task.status === 'in_progress');
        return {
          title: t('작업을 진행하고 있습니다', 'Work is in progress'),
          detail: activeTask
            ? t(`${activeTask.id} · ${activeTask.title} 작업을 진행 중입니다.`, `${activeTask.id} · ${activeTask.title} is currently running.`)
            : (recentLog?.message || t('현재 태스크를 실행 중입니다.', 'A task is currently running.'))
        };
      }
      if (run.status === 'failed') {
        return {
          title: t('진행 중 문제가 생겼습니다', 'Something went wrong during execution'),
          detail: failedTask?.findings?.[0] || recentLog?.message || t('실패 원인을 확인해 주세요.', 'Check the failure cause first.')
        };
      }
      if (run.status === 'partial_complete') {
        return {
          title: t('일부 작업은 끝났지만 아직 마무리가 필요합니다', 'Some work is done, but follow-up is still needed'),
          detail: recentLog?.message || t('완료된 작업과 남은 작업을 함께 확인해 주세요.', 'Review what finished and what still needs attention.')
        };
      }
      if (run.status === 'completed') {
        return {
          title: t('요청한 작업이 마무리되었습니다', 'The requested work is complete'),
          detail: recentLog?.message || t('최종 목표 달성으로 종료되었습니다.', 'The run ended after reaching its goal.')
        };
      }
      return {
        title: t('시작 준비가 끝났습니다', 'Ready to start'),
        detail: recentLog?.message || t('원할 때 실행을 시작할 수 있습니다.', 'You can start execution whenever you want.')
      };
    }

    function invalidateArtifacts(runId) {
      for (const key of [...artifactState.keys()]) {
        if (key.startsWith(runId + ':')) {
          artifactState.delete(key);
        }
      }
    }

    async function fetchArtifacts(runId, taskId, { force = false } = {}) {
      if (!runId || !taskId) return null;
      const key = `${runId}:${taskId}`;
      if (force || !artifactState.has(key)) {
        const result = await request(`/api/runs/${runId}/tasks/${taskId}/artifacts`);
        artifactState.set(key, result);
      }
      return artifactState.get(key);
    }

    function renderTaskCard(task) {
      const active = task.id === selectedTaskId;
      const filesCount = (task.filesLikely || []).length;
      return `
        <div class="task-card ${active ? 'active' : ''}" onclick="selectTask('${task.id}')">
          <div class="task-card-head">
            <span class="task-id">${escapeHtml(task.id)}</span>
            <span class="task-status">${escapeHtml(statusLabel(task.status))}</span>
          </div>
          <h4>${escapeHtml(task.title)}</h4>
          <p>${escapeHtml(clip(task.goal || '', 120) || t('목표 설명 없음', 'No goal description'))}</p>
          <div class="task-card-meta">${filesCount ? t(`예상 파일 ${filesCount}개`, `${filesCount} likely file(s)`) : t('예상 파일 미지정', 'Likely files not set')}</div>
        </div>
      `;
    }

    async function selectTask(id) {
      const snapRunId = selectedRunId;
      selectedTaskId = id;
      selectedTab = 'technical';
      artifactSubTab = 'summary';
      renderDetail();
      if (!snapRunId) return;
      const run = runs.find(r => r.id === snapRunId);
      const task = (run?.tasks || []).find(t => t.id === id);
      const forceRefresh = task?.status === 'in_progress' || task?.status === 'running';
      const requestedKey = `${snapRunId}:${id}`;
      artifactLoadingKey = requestedKey;
      try {
        await fetchArtifacts(snapRunId, id, { force: forceRefresh });
      } finally {
        if (artifactLoadingKey === requestedKey) artifactLoadingKey = '';
      }
      if (selectedRunId === snapRunId && selectedTaskId === id) {
        renderDetail();
      }
    }

    function renderStatusBadge(status) {
      let icon = '';
      if (status === 'running') {
        icon = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"></path></svg>`;
      } else if (status === 'completed') {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      } else if (status === 'partial_complete') {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h6l3 8 4-16 3 8h2"></path></svg>`;
      } else if (status === 'skipped') {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m13 5 7 7-7 7"></path></svg>`;
      } else if (status === 'failed') {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
      } else if (status === 'needs_approval' || status === 'needs_input') {
        icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
      }
      return `<span class="status-badge ${status}">${icon}${statusLabel(status)}</span>`;
    }

    async function renderDetail() {
      const main = document.getElementById('main-area');
      rememberRenderedDetailUiState();
      if (!selectedRunId && selectedProjectId) {
        const projectOverview = projectOverviewState.get(selectedProjectId);
        currentDetailViewKey = `project:${selectedProjectId}`;
        delete main.dataset.runId;
        main.innerHTML = projectOverview
          ? `
            <div class="content" id="content-area">
              ${renderProjectDetail(projectOverview)}
            </div>
          `
          : `
            <div class="content" id="content-area">
              <div class="empty-state">
                <div style="font-size: 80px; margin-bottom: 24px; opacity: 0.5;">🗂️</div>
                <h3>${escapeHtml(t('프로젝트 현황을 불러오는 중입니다', 'Loading project overview'))}</h3>
                <p style="max-width: 460px; margin: 0 auto 24px; color: var(--muted);">${escapeHtml(t('단계별 진행률, 이어받을 작업, 열린 위험, 최근 작업을 정리해 보여줍니다.', 'This view summarizes phase progress, carry-over work, open risks, and recent runs.'))}</p>
              </div>
            </div>
          `;
        if (projectOverview) {
          syncProjectSettingsFormControls(projectOverview);
        }
        restoreCurrentDetailUiState();
        return;
      }
      const run = runs.find(r => r.id === selectedRunId);
      if (!run) {
        currentDetailViewKey = '';
        delete main.dataset.runId;
        main.innerHTML = renderCommandCenterEmptyState();
        return;
      }

      const stats = taskStats(run);
      const hero = deriveRunHero(run);

      if (main.dataset.runId !== run.id) {
        main.dataset.runId = run.id;
        main.innerHTML = `
          <div class="header" id="run-header-shell"></div>
          <div class="tabs" id="run-tabs-shell"></div>
          <div class="content" id="content-area"></div>
        `;
      }

      const header = document.getElementById('run-header-shell');
      const tabs = document.getElementById('run-tabs-shell');
      const content = document.getElementById('content-area');

      header.innerHTML = `
        <div class="header-title">
          <div style="display: flex; align-items: center; gap: 16px;">
            <h2>${escapeHtml(run.title)}</h2>
            ${renderStatusBadge(run.status)}
            ${run.chainMeta?.chainStopped ? `<span class="status-badge warning">${escapeHtml(t('체인 중단', 'Chain stopped'))}</span>` : ''}
          </div>
        </div>
        <div class="header-actions">
          <button class="primary" onclick="startRun()" ${isBusy('start-run') ? 'disabled' : ''}>${escapeHtml(isBusy('start-run') ? t('처리 중...', 'Working...') : t('시작/재개', 'Start / resume'))}</button>
          <button class="danger" onclick="stopRun()" ${isBusy('stop-run') ? 'disabled' : ''}>${escapeHtml(isBusy('stop-run') ? t('처리 중...', 'Working...') : t('정지', 'Stop'))}</button>
          <button class="secondary-btn" onclick="stopAutoChainRun()" ${isBusy('stop-auto-chain') ? 'disabled' : ''}>${escapeHtml(t('자동 체인 중단', 'Stop auto-chain'))}</button>
          <button onclick="deleteRunUi()" ${isBusy('delete-run') ? 'disabled' : ''}>${escapeHtml(isBusy('delete-run') ? t('삭제 중...', 'Deleting...') : t('삭제', 'Delete'))}</button>
        </div>
      `;

      tabs.innerHTML = `
        <div class="tab ${selectedTab === 'dashboard' ? 'active' : ''}" onclick="switchTab('dashboard')">${escapeHtml(t('개요', 'Overview'))}</div>
        <div class="tab ${selectedTab === 'planning' ? 'active' : ''}" onclick="switchTab('planning')">${escapeHtml(t('계획과 역할', 'Plan and roles'))}</div>
        <div class="tab ${selectedTab === 'technical' ? 'active' : ''}" onclick="switchTab('technical')">${escapeHtml(t('태스크 상세', 'Task details'))}</div>
        <div class="tab ${selectedTab === 'diagnostics' ? 'active' : ''}" onclick="switchTab('diagnostics')">${escapeHtml(t('상태 확인', 'Diagnostics'))}</div>
      `;

      content.innerHTML = renderTabContent(run, stats, hero);
      currentDetailViewKey = detailViewKey();
      restoreCurrentDetailUiState();
    }

    function renderTabContent(run, stats, hero) {
      const tasks = run.tasks || [];

      if (selectedTab === 'dashboard') {
        const runtimeSignals = renderRuntimeSignals(run);
        return `
          <div class="hero-card ${String(run.status || '').startsWith('needs') ? 'alert' : ''}">
            <h3>${escapeHtml(t('현재 상태', 'Current status'))}</h3>
            <div class="next-action">${escapeHtml(hero.title)}</div>
            <div class="hero-detail">${escapeHtml(hero.detail)}</div>
            ${renderHumanGate(run)}
          </div>
          ${deriveRunSignalRail(run, stats)}
          ${renderRunQueueProgress(run, stats)}
          <div class="board-section">
            <div class="section-head">
              <div>
                <span class="eyebrow">${escapeHtml(t('작업 보드', 'Task board'))}</span>
                <h3>${escapeHtml(t('현재 흐름 한눈에 보기', 'See the current flow at a glance'))}</h3>
              </div>
              <p>${escapeHtml(t('카드를 누르면 바로 태스크 상세와 실패 이유, 산출물을 볼 수 있습니다.', 'Click a card to open task details, failure reasons, and artifacts.'))}</p>
            </div>
            <div class="board">
              ${renderBoardColumn(t('대기', 'Ready'), tasks.filter(t => t.status === 'ready'), 'ready')}
              ${renderBoardColumn(t('진행 중', 'In progress'), tasks.filter(t => t.status === 'in_progress'), 'progress')}
              ${renderBoardColumn(t('완료', 'Done'), tasks.filter(t => t.status === 'done' || t.status === 'skipped'), 'done')}
              ${renderBoardColumn(t('실패', 'Failed'), tasks.filter(t => t.status === 'failed'), 'failed')}
            </div>
          </div>
          ${renderOverviewHighlights(run, stats)}
          ${renderRunAutomationStatus(run)}
          ${renderProgressSummary(run)}
          ${renderRestartRecoveryNotice(run)}
          ${renderDecisionPanel(run)}
          ${renderAutoReplanStatus(run)}
          ${renderRecoveryGuide(run)}
          ${runtimeSignals ? `
            <details class="advanced-settings" style="margin-bottom: 18px;">
              <summary>${escapeHtml(t('자세한 런타임 신호 보기', 'Show detailed runtime signals'))}</summary>
              <div class="advanced-body">
                ${runtimeSignals}
              </div>
            </details>
          ` : ''}
          ${run.status === 'needs_approval' ? renderPlanPreview(run, 4) : ''}
          <div class="stats-grid">
            <div class="stat-card"><span class="label">${escapeHtml(t('전체 태스크', 'Total tasks'))}</span><div class="value">${stats.total}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('진행 중', 'In progress'))}</span><div class="value" style="color: var(--accent);">${stats.progress}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('완료', 'Done'))}</span><div class="value" style="color: var(--success);">${stats.done}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('실패', 'Failed'))}</span><div class="value" style="color: var(--danger);">${stats.failed}</div></div>
          </div>
        `;
      }
      
      if (selectedTab === 'planning') {
        const specSections = parseStructuredSpecText(run.input?.specText);
        const settings = run.settings || {};
        return `
          <div class="grid-2">
            <div class="stack">
              <div class="card">
                <h3>${escapeHtml(t('무엇을 만들거나 바꾸는가', 'What this run is trying to build or change'))}</h3>
                <div class="detail-list">
                  ${renderDetailItem(t('핵심 목표', 'Core objective'), run.input?.objective, t('입력된 목표가 없습니다.', 'No objective was entered.'))}
                  ${specSections.map((section) => renderDetailItem(section.title, section.body)).join('') || renderDetailItem(t('추가 맥락', 'Extra context'), '', t('추가 명세 없음', 'No extra spec text'))}
                  ${run.input?.additionalNotes ? renderDetailItem(t('재실행 추가 요구사항', 'Extra requirements for this rerun'), run.input.additionalNotes) : ''}
                </div>
              </div>
              <div class="card emphasis-card">
                <h3>${escapeHtml(t('어떻게 나눠서 진행할지', 'How the work is split'))}</h3>
                ${canEditPlan(run) ? `<div style="display:flex; justify-content:flex-end; margin-bottom: 12px;"><button class="secondary-btn" onclick="openPlanEditModal()">${escapeHtml(t('계획 내용 수정', 'Edit plan'))}</button></div>` : ''}
                <div class="stack-item warning-item" style="margin-bottom: 14px;">
                  <strong>${escapeHtml(t('여기서는 큰 그림만 확인하면 됩니다', 'At this stage, the big picture is enough'))}</strong>
                  <div style="margin-top: 6px;">${escapeHtml(t('목표가 맞는지, 순서가 이상하지 않은지, 한 번에 너무 많은 걸 하지는 않는지만 보면 충분합니다.', 'You only need to check whether the goal is right, the order makes sense, and the first pass is not too large.'))}</div>
                </div>
                <div class="metric-row">
                  <div class="mini-card"><span class="k">${escapeHtml(t('작업 방식', 'Preset'))}</span><div class="v">${escapeHtml(describePreset(run.preset))}</div></div>
                  <div class="mini-card"><span class="k">${escapeHtml(t('진행 순서', 'Pattern'))}</span><div class="v">${escapeHtml(describePattern(run.clarify?.architecturePattern || 'auto'))}</div></div>
                  <div class="mini-card"><span class="k">${escapeHtml(t('한 번에', 'Parallel'))}</span><div class="v">${escapeHtml(settings.maxParallel ?? '-')}</div></div>
                  <div class="mini-card"><span class="k">${escapeHtml(t('재시도 횟수', 'Retries'))}</span><div class="v">${escapeHtml(settings.maxTaskAttempts ?? '-')}</div></div>
                </div>
                <div class="detail-list">
                  ${renderDetailItem(t('한 줄 요약', 'Summary'), run.plan?.summary || run.planSummary, t('계획 요약이 아직 없습니다.', 'No plan summary yet.'))}
                  ${renderDetailItem(t('역할 분담', 'Role split'), run.executionModel || run.clarify?.executionModel, t('역할 분담 정보가 아직 없습니다.', 'No role split info yet.'))}
                  ${renderDetailItem(t('자동 진행 규칙', 'Automation policy'), (run.executionPolicy?.policyNotes || []).join(' | '), t('추가 규칙 없음', 'No extra policy notes'))}
                  ${renderDetailItem(t('동시 진행 여부', 'Parallelism'), deriveParallelReason(run), t('설명 없음', 'No explanation'))}
                </div>
                ${normalizeExecutionPolicyRules(run.executionPolicy).length ? `
                  <div style="margin-top: 14px;">
                    <strong>${escapeHtml(t('왜 이런 태스크가 추가됐는지', 'Why the harness changed this plan'))}</strong>
                    ${renderExecutionPolicyRuleList(run.executionPolicy)}
                  </div>
                ` : ''}
              </div>
              <div class="card">
                <h3>${escapeHtml(t('계획된 태스크', 'Planned tasks'))}</h3>
                <div class="stack-list">
                  ${tasks.map((task) => `
                    <div class="stack-item interactive" onclick="openTaskDetails('${task.id}')">
                      ${renderTaskDefinition(task, { compact: true })}
                    </div>
                  `).join('') || `<div class="stack-item">${escapeHtml(t('계획된 태스크가 아직 없습니다.', 'No planned tasks yet.'))}</div>`}
                </div>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <h3>${escapeHtml(t('누가 어떤 역할을 맡는가', 'Who does what'))}</h3>
                ${renderAgentBlueprint(run)}
              </div>
              <div class="card">
                <h3>${escapeHtml(t('지금 가장 먼저 따르는 원칙', 'Active instruction sources'))}</h3>
                ${renderPromptSourceSummary(run)}
              </div>
              <div class="card">
                <h3>${escapeHtml(t('현재 이해한 범위', 'Current scope understanding'))}</h3>
                <div class="detail-list">
                  ${renderDetailItem(t('지금 이해한 목표', 'Clarified objective'), run.clarify?.clarifiedObjective, t('명확화 결과가 아직 없습니다.', 'No clarify output yet.'))}
                  ${renderDetailItem(t('어디까지 하는지', 'Scope summary'), run.clarify?.scopeSummary, t('범위 요약이 아직 없습니다.', 'No scope summary yet.'))}
                  ${renderDetailItem(t('가정', 'Assumptions'), (run.clarify?.assumptions || []).join(' | '), t('가정 없음', 'No assumptions'))}
                </div>
              </div>
              ${renderAutoReplanStatus(run)}
            </div>
          </div>
        `;
      }

      if (selectedTab === 'technical') {
        const artifacts = artifactState.get(`${run.id}:${selectedTaskId}`);
        const selectedTask = tasks.find((task) => task.id === selectedTaskId);
        const isArtifactLoading = artifactLoadingKey === `${run.id}:${selectedTaskId}`;
        return `
          <div class="tech-layout">
            <div class="artifact-list">
              <h4 style="margin: 0 0 8px; font-size: 12px; color: var(--muted); text-transform: uppercase;">${escapeHtml(t('태스크 목록', 'Task list'))}</h4>
              ${tasks.map(t => `
                <div class="artifact-item ${t.id === selectedTaskId ? 'active' : ''}" onclick="selectTask('${t.id}')">
                  <h5>${t.id}</h5>
                  <small>${escapeHtml(clip(t.title, 48))}</small>
                  <div class="artifact-status-line">${escapeHtml(statusLabel(t.status))}</div>
                </div>
              `).join('') || `<div class="stack-item">${escapeHtml(t('태스크 정보를 불러오는 중입니다.', 'Loading task information.'))}</div>`}
            </div>
            <div class="artifact-viewer">
              <div class="viewer-header">${escapeHtml(t('태스크 상세', 'Task details'))}: ${escapeHtml(selectedTaskId || t('태스크를 선택하세요', 'Select a task'))}</div>
              <div class="viewer-content">
                ${isArtifactLoading ? `<div class="stack-item" style="margin-bottom: 16px;">${escapeHtml(t('태스크 산출물을 불러오는 중입니다...', 'Loading task artifacts...'))}</div>` : ''}
                ${renderTaskMeta(selectedTask, artifacts)}
                ${renderTaskInsights(selectedTask, artifacts)}
                ${renderTaskActions(selectedTask)}
                <div class="card" style="margin-bottom: 16px;">
                  <h3>${escapeHtml(t('태스크 정의', 'Task definition'))}</h3>
                  ${renderTaskDefinition(selectedTask)}
                </div>
                ${selectedTaskId ? renderArtifactTabs(artifacts, selectedTask) : escapeHtml(t('태스크를 선택하면 목표, 완료 조건, 실행 결과, 변경 내용, 검토 결과 등을 볼 수 있습니다.', 'Select a task to see its goal, acceptance criteria, execution result, diff, and review.'))}
              </div>
            </div>
          </div>
          <div class="card" style="margin-top: 24px;">
            <h3>${escapeHtml(t('실행 로그', 'Execution log'))}</h3>
            <div class="log-panel">
              ${(run.logs || []).slice().reverse().map((l) => `<div>[${escapeHtml(l?.at || '')}] ${escapeHtml(l?.message || '')}</div>`).join('')}
            </div>
          </div>
        `;
      }

      if (selectedTab === 'diagnostics') {
        const sys = systemInfo || {};
        const preflight = run.preflight || {};
        const blockers = preflight.blockers || [];
        const warnings = preflight.warnings || [];
        return `
          <div class="grid-2">
            <div class="stack">
              <div class="card">
                <h3>${escapeHtml(t('지금 확인할 상태', 'What to check now'))}</h3>
                <div class="preflight-grid">${renderPreflightCards(preflight)}</div>
                <div class="stack-list">${renderActionPlan(preflight.actionPlan)}</div>
              </div>
              ${renderListStack(t('막히는 요소', 'Blockers'), blockers, t('현재 blocker 없음', 'No blocker right now'))}
              ${renderListStack(t('주의할 점', 'Warnings'), warnings, t('현재 warning 없음', 'No warning right now'))}
              <div class="card">
                <h3>${escapeHtml(t('시스템 정보', 'System info'))}</h3>
                <div class="detail-list">
                  ${renderDetailItem(t('에이전트 루트', 'Agent root'), sys.rootDir)}
                  ${renderDetailItem(t('실행 데이터', 'Run data'), `${sys.runsDir || ''} (${sys.runCount ?? 0}${t('개', '',)})`)}
                  ${renderDetailItem(t('메모리 저장소', 'Memory store'), `${sys.memoryDir || ''} (${sys.memoryProjectCount ?? 0}${t('개 프로젝트', ' projects')})`)}
                  ${renderDetailItem(t('설정 파일', 'Settings file'), sys.settingsFile)}
                </div>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <h3>${escapeHtml(t('프로젝트 메모리 검색', 'Search project memory'))}</h3>
                <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                  <input id="mem-q" style="flex: 1; padding: 8px; border: 1px solid var(--line); border-radius: 6px;" placeholder="${escapeHtml(t('검색어 입력...', 'Enter a search query...'))}">
                  <button class="primary" onclick="searchMemory()">${escapeHtml(t('검색', 'Search'))}</button>
                </div>
                <div id="mem-results"></div>
              </div>
              <details class="advanced-settings" open>
                <summary>${escapeHtml(t('진단 원본 보기', 'Show raw diagnostics'))}</summary>
                <div class="advanced-body">
                  <pre style="max-height: 320px; overflow: auto; font-size: 11px;">${escapeHtml(JSON.stringify(preflight, null, 2))}</pre>
                </div>
              </details>
            </div>
          </div>
        `;
      }
    }

    function renderBoardColumn(title, tasks, tone = 'ready') {
      return `
        <div>
          <div class="column-title">${title} <span class="count">${tasks.length}</span></div>
          <div class="column ${tone}">
            ${tasks.map(renderTaskCard).join('') || `<div style="text-align:center; padding: 20px; color: #94a3b8; font-size: 12px;">${escapeHtml(t('없음', 'None'))}</div>`}
          </div>
        </div>
      `;
    }

    let artifactSubTab = 'summary';

    function renderArtifactTabs(artifacts, task) {
      return artifactRenderers.renderArtifactTabs(artifacts, task, artifactSubTab);
    }

    function setArtifactSubTab(tab) {
      artifactSubTab = tab;
      renderDetail();
    }

    async function diagnoseDraft() {
      const form = new FormData(document.getElementById('run-form'));
      draftDiagnostics = await request('/api/diagnostics', {
        method: 'POST',
        body: JSON.stringify({
          projectPath: form.get('projectPath'),
          objective: form.get('objective'),
          successCriteria: form.get('successCriteria'),
          excludedScope: form.get('excludedScope'),
          protectedAreas: form.get('protectedAreas'),
          specFiles: form.get('specFiles')
        })
      });
      renderDraftDiagnostics();
    }

    function renderHumanGate(run) {
      if (run.status === 'needs_input') {
        const questions = run.humanLoop?.clarifyPending || [];
        return `
          <div class="stack" style="margin-top: 16px; border-top: 1px solid #fcd34d; padding-top: 16px;">
            <div class="stack-item warning-item">
              <strong>${escapeHtml((run.preset?.id || '') === 'docs-spec-first' || /intake/i.test(String(run.title || '')) ? t('이 작업은 구현 전 정리 단계입니다', 'This run is an intake/alignment step before implementation.') : t('작업 전에 몇 가지만 확인하면 됩니다', 'A few quick answers will unblock the work.'))}</strong>
              <div style="margin-top: 6px; color: var(--muted);">${escapeHtml((run.preset?.id || '') === 'docs-spec-first' || /intake/i.test(String(run.title || '')) ? t('현재 코드와 문서를 맞춰 다음 작업 방향을 고정하는 단계라서, 아래 질문에 짧게 답하면 바로 이어서 진행합니다.', 'This step aligns the current code and docs first. A short answer below is enough to continue.') : t('모든 걸 자세히 쓸 필요는 없습니다. 원하는 결과를 짧게 적어도 충분합니다.', 'You do not need to explain everything. A short statement of the desired outcome is enough.'))}</div>
            </div>
            ${questions.map((q, i) => `
              <div class="form-group">
                <label>${escapeHtml(q.question || q)}</label>
                <div style="margin: 6px 0 8px; color: var(--muted); font-size: 13px;">${escapeHtml(q.helpText || t('이 답변이 있어야 Codex가 엉뚱한 방향으로 가지 않고 바로 다음 작업을 정할 수 있습니다.', 'This answer helps Codex avoid the wrong direction and choose the next step well.'))}</div>
                <div style="margin-bottom: 10px; padding: 10px 12px; border-radius: 10px; background: #f8fafc; color: var(--muted); font-size: 13px;">${escapeHtml(t('예시 답변', 'Example answer'))}: ${escapeHtml(q.exampleAnswer || t('잘 모르겠으면 "권장안으로 진행해 주세요" 또는 "문서 기준으로 맞춰 주세요"처럼 짧게 적어도 됩니다.', 'If you are unsure, something short like "Use the recommended path" is still fine.'))}</div>
                <textarea id="ans-${i}" data-clarify-question-id="${escapeHtml(q.id || q.question || q)}" placeholder="${escapeHtml(t('잘 모르겠으면 원하는 결과를 짧게 적어 주세요.', 'If unsure, just describe the result you want in a short sentence.'))}">${escapeHtml(getClarifyDraft(run.id, q.id || q.question || q))}</textarea>
              </div>
            `).join('')}
            <button class="primary" onclick="submitAnswers()">${escapeHtml(t('답변 제출 및 재개', 'Submit answers and continue'))}</button>
          </div>
        `;
      }
      if (run.status === 'needs_approval') {
        const focusTask = (run.tasks || [])[0] || null;
        return `
          <div class="stack" style="margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 16px;">
            <div class="stack-item warning-item">
              <strong>${escapeHtml(t('모르면 이렇게 판단하면 됩니다', 'If you are unsure, use this rule of thumb'))}</strong>
              <div style="margin-top: 6px;">${escapeHtml(t('목표가 맞고, 손대면 안 되는 영역만 안 건드리면 대부분 바로 시작해도 됩니다.', 'If the goal is right and protected areas are safe, it is usually okay to start.'))}</div>
              <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(t('반대로 목표가 다르거나 범위가 너무 넓으면 계획을 다시 조정하세요.', 'If the goal is off or the scope is too broad, request plan changes first.'))}</div>
            </div>
            <div class="grid-2">
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('바로 시작해도 되는 신호', 'Signals that it is safe to start'))}</h3>
                <div class="stack-list">
                  <div class="stack-item">${escapeHtml(t('목표와 한 줄 요약이 내가 원하는 결과와 거의 같다.', 'The goal and summary are very close to the result you want.'))}</div>
                  <div class="stack-item">${escapeHtml(t('첫 태스크가 너무 넓지 않고 현재 단계 안에 있다.', 'The first task is not too broad and stays inside the current phase.'))}</div>
                  <div class="stack-item">${escapeHtml(t('변경 금지 영역이나 제외 범위를 넘지 않는다.', 'It does not break protected areas or go past the excluded scope.'))}</div>
                </div>
              </div>
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('다시 조정해야 하는 신호', 'Signals that it should be adjusted'))}</h3>
                <div class="stack-list">
                  <div class="stack-item">${escapeHtml(t('목표가 다르거나 하고 싶은 일보다 훨씬 넓다.', 'The goal is wrong or much broader than intended.'))}</div>
                  <div class="stack-item">${escapeHtml(t('첫 태스크가 한 번에 너무 많은 파일이나 기능을 건드린다.', 'The first task touches too many files or behaviors at once.'))}</div>
                  <div class="stack-item">${escapeHtml(t('문서 기준 프로젝트인데 docs 반영 계획이 거의 없다.', 'It is a docs-first project, but the plan barely updates docs.'))}</div>
                </div>
              </div>
            </div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
              <button class="secondary-btn" onclick="switchTab('planning')">${escapeHtml(t('계획 전체 보기', 'View full plan'))}</button>
              <button class="secondary-btn" onclick="openTaskDetails('${focusTask?.id || ''}')">${escapeHtml(t('첫 작업 자세히 보기', 'Open first task details'))}</button>
              <button class="primary" onclick="approvePlan()" ${isBusy('approve-plan') ? 'disabled' : ''}>${escapeHtml(isBusy('approve-plan') ? t('처리 중...', 'Working...') : t('이 계획으로 시작', 'Start with this plan'))}</button>
              <button class="danger" onclick="rejectPlan()" ${isBusy('reject-plan') ? 'disabled' : ''}>${escapeHtml(isBusy('reject-plan') ? t('처리 중...', 'Working...') : t('계획 다시 조정', 'Request plan changes'))}</button>
            </div>
          </div>
        `;
      }
      return '';
    }

    async function openTaskDetails(taskId) {
      if (!taskId) return;
      const snapRunId = selectedRunId;
      selectedTaskId = taskId;
      selectedTab = 'technical';
      artifactSubTab = 'summary';
      renderDetail();
      if (!snapRunId) return;
      const run = runs.find(r => r.id === snapRunId);
      const task = (run?.tasks || []).find(t => t.id === taskId);
      const forceRefresh = task?.status === 'in_progress' || task?.status === 'running';
      const requestedKey = `${snapRunId}:${taskId}`;
      artifactLoadingKey = requestedKey;
      try {
        await fetchArtifacts(snapRunId, taskId, { force: forceRefresh });
      } finally {
        if (artifactLoadingKey === requestedKey) artifactLoadingKey = '';
      }
      if (selectedRunId === snapRunId && selectedTaskId === taskId) {
        renderDetail();
      }
    }

    const TERMINAL_STATUSES = new Set(['completed', 'failed', 'partial_complete', 'stopped']);

    function openAddReqModal() {
      document.getElementById('addreq-text').value = '';
      document.getElementById('addreq-modal').style.display = 'flex';
    }
    function closeAddReqModal() {
      document.getElementById('addreq-modal').style.display = 'none';
    }

    async function startRun() {
      const run = runs.find((item) => item.id === selectedRunId);
      if (run && TERMINAL_STATUSES.has(run.status)) {
        openAddReqModal();
        return;
      }
      await _doStartRun('');
    }

    async function _doStartRun(additionalRequirements) {
      await runUiAction('start-run', async () => {
        captureClarifyDrafts();
        const run = runs.find((item) => item.id === selectedRunId);
        const failedTasks = (run?.tasks || []).filter((task) => task.status === 'failed');
        if (run && ['failed', 'partial_complete', 'stopped'].includes(run.status) && failedTasks.length > 0) {
        const confirmed = window.confirm(t(`실패한 태스크 ${failedTasks.length}개를 다시 대기로 돌리고 재개할까요?`, `Move ${failedTasks.length} failed task(s) back to ready and resume?`));
          if (confirmed) {
            await request(`/api/runs/${selectedRunId}/requeue-failed`, { method: 'POST' });
          }
        }
        await request(`/api/runs/${selectedRunId}/start`, {
          method: 'POST',
          body: JSON.stringify({ additionalRequirements: additionalRequirements || '' })
        });
        await refreshRuns();
      });
    }
    async function stopRun() {
      await runUiAction('stop-run', async () => {
        await request(`/api/runs/${selectedRunId}/stop`, { method: 'POST' });
        await refreshRuns();
      });
    }
    async function stopAutoChainRun() {
      if (!selectedRunId) return;
      const run = runs.find((item) => item.id === selectedRunId);
      if (!run) return;
      await runUiAction('stop-auto-chain', async () => {
        await request(`/api/runs/${selectedRunId}/chain-stop`, {
          method: 'POST',
          body: JSON.stringify({ reason: t('사용자 요청으로 자동 체인 중단') })
        });
        await refreshRuns();
      }, run.chainMeta?.chainStopped === true ? t('체인 중단이 이미 적용되었습니다.', 'Auto-chain is already stopped.') : t('자동 체인을 중단했습니다.', 'Auto-chain stopped.'));
    }
    async function toggleProjectSupervisor() {
      if (!selectedProjectId) return;
      const overview = projectOverviewState.get(selectedProjectId);
      const supervisorStatus = overview?.project?.supervisorStatus || null;
      const isActive = supervisorStatus?.active === true;
      await runUiAction('supervisor-toggle', async () => {
        await request(`/api/projects/${selectedProjectId}/supervisor`, {
          method: 'POST',
          body: JSON.stringify({ action: isActive ? 'stop' : 'start' })
        });
        await refreshProjectOverview(selectedProjectId, { render: false });
        renderDetail();
      }, isActive ? t('Supervisor를 중지했습니다.', 'Supervisor stopped.') : t('Supervisor를 시작했습니다.', 'Supervisor started.'));
    }
    async function runSupervisorNow() {
      if (!selectedProjectId) return;
      await runUiAction('supervisor-run-now', async () => {
        await request(`/api/projects/${selectedProjectId}/supervisor`, {
          method: 'POST',
          body: JSON.stringify({ action: 'run-now' })
        });
        await refreshProjectOverview(selectedProjectId, { render: false });
        await refreshRuns();
        renderDetail();
      }, t('Supervisor 즉시 실행을 요청했습니다.', 'Supervisor run triggered.'));
    }
    async function retrySelectedTask() {
      if (!selectedRunId || !selectedTaskId) return;
      await runUiAction('retry-task', async () => {
        await request(`/api/runs/${selectedRunId}/tasks/${selectedTaskId}/retry`, { method: 'POST' });
        await refreshRuns();
      }, t('태스크를 다시 대기로 돌렸습니다.', 'Moved failed tasks back to ready.'));
    }
    async function recoveryRetryTask() {
      const run = runs.find((item) => item.id === selectedRunId);
      const focusTask = getRecoveryFocusTask(run);
      if (!focusTask) return;
      selectedTaskId = focusTask.id;
      await retrySelectedTask();
    }
    function openRecoveryReplan() {
      const run = runs.find((item) => item.id === selectedRunId);
      if (!run || !canEditPlan(run)) return;
      switchTab('planning');
      openPlanEditModal();
    }
    async function recoverySkipTask() {
      const run = runs.find((item) => item.id === selectedRunId);
      const focusTask = getRecoveryFocusTask(run);
      if (!focusTask) return;
      selectedTaskId = focusTask.id;
      openSkipTaskModal();
    }
    async function skipSelectedTask() {
      if (!selectedRunId || !selectedTaskId) return;
      openSkipTaskModal();
    }
    async function deleteRunUi() {
      await runUiAction('delete-run', async () => {
        const run = runs.find((item) => item.id === selectedRunId);
        if (!run) return;
        const confirmed = window.confirm(t(`"${run.title}" 런을 삭제할까요? runs 폴더의 해당 기록도 함께 삭제됩니다.`, `Delete the run "${run.title}"? Its record under runs/ will also be removed.`));
        if (!confirmed) return;
        await request(`/api/runs/${selectedRunId}`, { method: 'DELETE' });
        selectedRunId = '';
        selectedTaskId = '';
        await refreshRuns(true);
      });
    }
    async function approvePlan() {
      await runUiAction('approve-plan', async () => {
        await request(`/api/runs/${selectedRunId}/approve-plan`, { method: 'POST' });
        await refreshRuns();
      });
    }
    
    async function submitAnswers() {
      const run = runs.find(r => r.id === selectedRunId);
      const questions = run.humanLoop?.clarifyPending || [];
      const answers = {};
      questions.forEach((q, i) => {
        const id = q.id || q.question || q;
        answers[id] = document.getElementById(`ans-${i}`).value;
      });
      await request(`/api/runs/${selectedRunId}/clarify-answers`, {
        method: 'POST',
        body: JSON.stringify({ answers })
      });
      questions.forEach((q) => {
        const id = q.id || q.question || q;
        clarifyDraftAnswers.delete(`${selectedRunId}:${id}`);
      });
      await refreshRuns();
    }

    async function searchMemory() {
      const q = document.getElementById('mem-q').value;
      const res = await request(`/api/runs/${selectedRunId}/memory?q=${encodeURIComponent(q)}`);
      const graphEdges = Array.isArray(res.graphInsights?.topEdges) ? res.graphInsights.topEdges.slice(0, 3) : [];
      const graphSymbols = Array.isArray(res.graphInsights?.topSymbols) ? res.graphInsights.topSymbols.slice(0, 5) : [];
      const criticalRiskThreshold = Number(res.projectCodeIntelligence?.thresholds?.criticalRisk || 15);
      const criticalSymbols = graphSymbols.filter((item) => Number(item?.riskScore || 0) > criticalRiskThreshold).slice(0, 3);
      const highImpactFiles = Array.isArray(res.projectCodeIntelligence?.topFiles) ? res.projectCodeIntelligence.topFiles.slice(0, 3) : [];
      const temporalFiles = Array.isArray(res.temporalInsights?.activeFiles) ? res.temporalInsights.activeFiles.slice(0, 3) : [];
      const temporalRootCauses = Array.isArray(res.temporalInsights?.activeRootCauses) ? res.temporalInsights.activeRootCauses.slice(0, 2) : [];
      const graphMarkup = graphEdges.length || graphSymbols.length
        ? `
        <div style="margin-bottom: 12px; padding: 10px; background: #eef6ff; border-radius: 6px; font-size: 13px;">
          <strong>${t('그래프 메모리 힌트', 'Graph memory hints')}</strong>
          ${criticalSymbols.length ? `<div style="margin-top: 6px; color: #991b1b;"><strong>${escapeHtml(`CRITICAL-RISK >= ${criticalRiskThreshold.toFixed(1)}`)}</strong> ${escapeHtml(criticalSymbols.map((item) => `${item.symbol} (${Number(item.riskScore || 0).toFixed(1)})`).join(' | '))}</div>` : ''}
          ${graphEdges.length ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(graphEdges.map((item) => `${item.edge} [risk ${Number(item.riskScore || 0).toFixed(1)}]`).join(' | '))}</div>` : ''}
          ${graphSymbols.length ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(graphSymbols.map((item) => `${item.symbol} (risk ${Number(item.riskScore || 0).toFixed(1)}, importers ${Number(item.importerCount || 0)}, callers ${Number(item.callerCount || 0)}${Array.isArray(item.definedIn) && item.definedIn.length ? `, defined in ${item.definedIn[0]}` : ''})`).join(' | '))}</div>` : ''}
          ${highImpactFiles.length ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(`${t('고영향 파일', 'High-impact files')}: ${highImpactFiles.map((item) => `${item.path} (importedBy ${Number(item.importedByCount || 0)}, calledBy ${Number(item.calledByCount || 0)})`).join(' | ')}`)}</div>` : ''}
        </div>
      `
        : '';
      const temporalMarkup = temporalFiles.length || temporalRootCauses.length || Number(res.temporalInsights?.recentShare || 0) > 0
        ? `
        <div style="margin-bottom: 12px; padding: 10px; background: #f5f7eb; border-radius: 6px; font-size: 13px;">
          <strong>${t('시간축 메모리 힌트', 'Temporal memory hints')}</strong>
          <div style="color: var(--muted); margin-top: 4px;">${escapeHtml(`${t('최근 비중', 'Recent share')}: ${Number(res.temporalInsights?.recentShare || 0).toFixed(3)}`)}</div>
          ${temporalFiles.length ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(temporalFiles.map((item) => item.filePath).join(' | '))}</div>` : ''}
          ${temporalRootCauses.length ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(temporalRootCauses.map((item) => item.reason).join(' | '))}</div>` : ''}
        </div>
      `
        : '';
      const resultMarkup = (res.searchResults || []).map(h => `
        <div style="margin-bottom: 12px; padding: 10px; background: #f8fafc; border-radius: 6px; font-size: 13px;">
          <strong>${escapeHtml(h.title)}</strong>
          ${Number(h?.rankingMeta?.occurrenceCount || 0) > 1 ? `<div style="color: var(--muted); margin-top: 4px;">${escapeHtml(`${t('반복도', 'Occurrence')}: ${Number(h.rankingMeta.occurrenceCount)}`)}</div>` : ''}
          <div style="color: var(--muted); margin-top: 4px;">${escapeHtml(h.snippet)}</div>
        </div>
      `).join('') || t('결과 없음', 'No results');
      document.getElementById('mem-results').innerHTML = `${graphMarkup}${temporalMarkup}${resultMarkup}`;
    }

    async function refreshSystemInfo() {
      systemInfo = await request('/api/system');
    }

    async function refreshRuns(includeSystemInfo = false) {
      captureClarifyDrafts();
      const previousSelectedRunId = selectedRunId;
      const previousRuns = runs;
      runs = await request('/api/runs');
      if (includeSystemInfo) {
        await refreshSystemInfo();
      }
      if (selectedRunId) {
        const selectedSummary = runs.find((item) => item.id === selectedRunId);
        if (selectedSummary) {
          const previousSummary = previousRuns.find((item) => item.id === selectedRunId);
          const shouldRefreshArtifacts = previousSummary?.updatedAt !== selectedSummary.updatedAt;
          if (shouldRefreshArtifacts) {
            invalidateArtifacts(selectedRunId);
          }
          const selectedRun = await hydrateRunDetail(selectedRunId, { selectFirstTask: false });
          const stillExists = selectedRun?.tasks?.some((task) => task.id === selectedTaskId);
          if (!stillExists) {
            selectedTaskId = (selectedRun?.tasks || [])[0]?.id || '';
          }
          const artifactKey = `${selectedRunId}:${selectedTaskId}`;
          if (selectedTaskId && (shouldRefreshArtifacts || !artifactState.has(artifactKey))) {
            await fetchArtifacts(selectedRunId, selectedTaskId, { force: shouldRefreshArtifacts });
          }
        } else {
          invalidateArtifacts(previousSelectedRunId);
          clearDetailUiState(previousSelectedRunId);
          selectedRunId = '';
          selectedTaskId = '';
        }
      }
      if (selectedProjectId) {
        await refreshProjectOverview(selectedProjectId, { render: false });
      }
      renderRunList();
      renderProjectList();
      if (selectedRunId) renderDetail();
      if (!selectedRunId && selectedProjectId) renderDetail();
    }

    document.getElementById('run-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await runUiAction('create-run', async () => {
        const form = new FormData(e.target);
        const data = {
          title: inferRunTitle(form.get('title'), form.get('projectPath'), form.get('objective')),
          projectPath: form.get('projectPath'),
          projectId: selectedProjectId || '',
          presetId: form.get('presetId'),
          objective: form.get('objective'),
          specText: buildStructuredSpecText(form),
          specFiles: form.get('specFiles'),
          settings: {
            maxParallel: Number(form.get('maxParallel')),
            maxTaskAttempts: Number(form.get('maxTaskAttempts') || 2),
            maxGoalLoops: Number(form.get('maxGoalLoops') || 3)
          },
          runLoop: {
            enabled: form.get('runLoopEnabled') === 'on',
            mode: String(form.get('runLoopMode') || 'repeat-count'),
            maxRuns: Math.max(1, Number(form.get('runLoopMaxRuns') || 3) || 3),
            maxConsecutiveFailures: Math.max(1, Number(form.get('runLoopMaxFailures') || 3) || 3)
          }
        };
        const run = await request('/api/runs', { method: 'POST', body: JSON.stringify(data) });
        closeCreateModal();
        await refreshRuns(true);
        await refreshProjects();
        await selectRun(run.id);
      }, t('작업을 만들었습니다. 비어 있던 정보는 시작 후 질문으로 다시 좁혀갈 수 있습니다.', 'Run created. Missing details can be narrowed down with follow-up questions after start.'));
    });

    document.getElementById('run-preset-input')?.addEventListener('change', (event) => {
      applyRunPresetDefaults(event?.target?.value || 'auto');
    });

    document.getElementById('project-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitterId = e.submitter?.id || '';
      if (projectIntake && submitterId !== 'project-create-only-btn') {
        await createProjectAndStarterRunFromIntake();
        return;
      }
      await runUiAction('create-project', async () => {
        const form = new FormData(e.target);
        const data = buildProjectPayloadFromForm(form);
        const project = await request('/api/projects', { method: 'POST', body: JSON.stringify(data) });
        closeCreateProjectModal();
        await refreshProjects();
        await selectProject(project.id);
      }, t('프로젝트를 만들었습니다.', 'Project created.'));
    });

    // Refresh selected task artifacts in the background and re-render on completion.
    function bgRefreshArtifacts(snapRunId, snapTaskId, { force = false } = {}) {
      fetchArtifacts(snapRunId, snapTaskId, { force })
        .then(() => {
          if (selectedRunId === snapRunId && selectedTaskId === snapTaskId) renderDetail();
        })
        .catch((error) => {
          if (selectedRunId === snapRunId && selectedTaskId === snapTaskId) {
            setBanner(error.message || t('실행 산출물을 새로고침하지 못했습니다.', 'Failed to refresh execution artifacts.'), 'info');
            renderDetail();
          }
        });
    }

    let sseInflight = false;
    const events = new EventSource('/api/events');
    events.onmessage = async (event) => {
      if (sseInflight) {
        scheduleRefreshRuns();
        return;
      }
      sseInflight = true;
      try {
        const payload = JSON.parse(event.data || '{}');

        // --- Initial sync right after the SSE connection opens ---
        if (payload.type === 'sync') {
          if (Array.isArray(payload.runs)) {
            runs = payload.runs.map((incoming) => mergeRunRecord(runs.find((run) => run.id === incoming.id), incoming));
            if (selectedRunId && runs.some((run) => run.id === selectedRunId)) {
              // Sync also hydrates logs during the initial load.
              await hydrateRunDetail(selectedRunId, { selectFirstTask: false, fetchLogs: true });
            } else if (selectedRunId) {
              selectedRunId = '';
              selectedTaskId = '';
            }
            if (selectedProjectId && runs.some((run) => shouldRefreshSelectedProject(run))) {
              queueProjectOverviewRefresh(selectedProjectId);
            }
            renderRunList();
            renderDetail();
            // Refresh artifacts in the background.
            if (selectedRunId && selectedTab === 'technical' && selectedTaskId) {
              bgRefreshArtifacts(selectedRunId, selectedTaskId);
            }
            return;
          }
          scheduleRefreshRuns();
          return;
        }

        // --- Run deletion ---
        if (payload.type === 'deleted' && payload.runId) {
          const deletedRun = runs.find((run) => run.id === payload.runId);
          runs = runs.filter((run) => run.id !== payload.runId);
          invalidateArtifacts(payload.runId);
          clearDetailUiState(payload.runId);
          if (selectedRunId === payload.runId) {
            selectedRunId = '';
            selectedTaskId = '';
          }
          if (shouldRefreshSelectedProject(deletedRun)) {
            queueProjectOverviewRefresh(selectedProjectId);
          }
          renderRunList();
          renderDetail();
          return;
        }

        if (!payload.runId) { scheduleRefreshRuns(); return; }

        // Update the run list immediately when a summary is included.
        if (payload.summary) {
          runs = runs.map((run) => run.id === payload.runId ? mergeRunRecord(run, payload.summary) : run);
          if (!runs.some((run) => run.id === payload.runId)) runs.unshift(payload.summary);
        }

        // --- Log events: append inline and keep artifact cache intact ---
        if (payload.type === 'log' && selectedRunId === payload.runId && payload.entry) {
          runs = runs.map((run) => {
            if (run.id !== payload.runId) return run;
            const logs = [...(run.logs || []), payload.entry].slice(-300);
            return { ...run, logs };
          });
          renderDetail();
          return;
        }

        // --- State and other events ---
        if (payload.type !== 'log') {
          invalidateArtifacts(payload.runId);
          const affectedRun = payload.summary || runs.find((run) => run.id === payload.runId);
          if (shouldRefreshSelectedProject(affectedRun)) {
            queueProjectOverviewRefresh(selectedProjectId);
          }
        }

        if (selectedRunId === payload.runId) {
          // Capture the previous status for the selected task.
          const prevTaskStatus = (runs.find(r => r.id === payload.runId)?.tasks || [])
            .find(t => t.id === selectedTaskId)?.status;

          // Only fetch run detail here; log events manage log updates.
          await hydrateRunDetail(payload.runId, { selectFirstTask: false, fetchLogs: false });

          const newTaskStatus = (runs.find(r => r.id === payload.runId)?.tasks || [])
            .find(t => t.id === selectedTaskId)?.status;

          renderRunList();
          renderDetail(); // Render immediately.

          // Refresh artifacts in the background when status changes or cache is missing.
          if (selectedTab === 'technical' && selectedTaskId) {
            const cacheGone = !artifactState.has(`${payload.runId}:${selectedTaskId}`);
            const statusChanged = prevTaskStatus !== newTaskStatus;
            if (cacheGone || statusChanged) {
              bgRefreshArtifacts(selectedRunId, selectedTaskId, { force: statusChanged });
            }
          }
          return;
        }

        renderRunList();
      } catch {
        scheduleRefreshRuns();
      } finally {
        sseInflight = false;
      }
    };

    document.getElementById('addreq-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const additionalRequirements = document.getElementById('addreq-text').value.trim();
      closeAddReqModal();
      await _doStartRun(additionalRequirements);
    });

    window.addEventListener('click', (event) => {
      if (event.target?.id === 'create-modal') closeCreateModal();
      if (event.target?.id === 'create-project-modal') closeCreateProjectModal();
      if (event.target?.id === 'settings-modal') closeSettingsModal();
      if (event.target?.id === 'plan-edit-modal') closePlanEditModal();
      if (event.target?.id === 'reject-plan-modal') closeRejectPlanModal();
      if (event.target?.id === 'skip-task-modal') closeSkipTaskModal();
      if (event.target?.id === 'addreq-modal') closeAddReqModal();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeCreateModal();
      closeCreateProjectModal();
      closeSettingsModal();
      closePlanEditModal();
      closeRejectPlanModal();
      closeSkipTaskModal();
      closeAddReqModal();
    });

    Promise.allSettled([refreshRuns(true), refreshProjects(), request('/api/settings')])
      .then((results) => {
        const [runsResult, projectsResult, settingsResult] = results;
        const bootFailure = [runsResult, projectsResult]
          .find((result) => result.status === 'rejected');
        if (bootFailure?.status === 'rejected') {
          throw bootFailure.reason;
        }
        if (settingsResult?.status === 'fulfilled' && settingsResult.value) {
          harnessSettings = settingsResult.value;
          if (setUiLanguage) {
            setUiLanguage(settingsResult.value.uiLanguage || 'en');
          }
        } else if (settingsResult?.status === 'rejected') {
          setBanner(t(
            '설정 로드에 실패해 기본값으로 시작했습니다. 필요하면 Settings에서 다시 저장해 주세요.',
            'Settings failed to load, so the UI started with defaults. Re-save them in Settings if needed.'
          ));
        }
        applyStaticTranslations();
        renderSidebarLiveSnapshot();
        renderRunList();
        renderProjectList();
        renderDetail();
      })
      .catch((error) => {
        setBanner(error.message || t('초기 데이터를 불러오지 못했습니다. 서버 상태를 확인해 주세요.', 'Failed to load initial data. Check whether the server is healthy.'));
      });
