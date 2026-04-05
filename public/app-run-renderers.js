(function registerHarnessRunRenderers(globalThis) {
  function normalizeExecutionPolicyRules(executionPolicy) {
    return Array.isArray(executionPolicy?.appliedRules)
      ? executionPolicy.appliedRules.filter((rule) => rule && (rule.title || rule.reason || rule.effect))
      : [];
  }

  function renderExecutionPolicyRuleList(executionPolicy, deps) {
    const rules = normalizeExecutionPolicyRules(executionPolicy);
    if (!rules.length) return '';
    const { escapeHtml, t } = deps;
    return `
      <div class="stack-list" style="margin-top: 14px;">
        ${rules.map((rule) => `
          <div class="stack-item">
            <strong>${escapeHtml(rule.title || t('자동 규칙', 'Automation rule'))}</strong>
            ${rule.effect ? `<div style="margin-top: 6px;">${escapeHtml(rule.effect)}</div>` : ''}
            ${rule.reason ? `<div style="margin-top: 6px; color: var(--muted);">${escapeHtml(t('이유', 'Why'))}: ${escapeHtml(rule.reason)}</div>` : ''}
            ${rule.syntheticTask?.title ? `<div style="margin-top: 6px; font-size: 12px;">${escapeHtml(t('추가된 태스크', 'Injected task'))}: ${escapeHtml(rule.syntheticTask.title)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderProgressSummary(run, deps) {
    const { deriveProgressSummary, escapeHtml, formatElapsedSeconds, renderDetailItem } = deps;
    const progress = deriveProgressSummary(run);
    return `
      <div class="card">
        <h3>운영 진행 요약</h3>
        <div class="metric-row">
          <div class="mini-card"><span class="k">현재 단계</span><div class="v">${escapeHtml(progress.phase)}</div></div>
          <div class="mini-card"><span class="k">현재 작업</span><div class="v">${escapeHtml(progress.step)}</div></div>
          <div class="mini-card"><span class="k">경과</span><div class="v">${escapeHtml(formatElapsedSeconds(progress.elapsed || 0))}</div></div>
          <div class="mini-card"><span class="k">마지막 행동</span><div class="v">${escapeHtml(progress.lastAction || '-')}</div></div>
        </div>
        <div class="detail-list">
          ${renderDetailItem('상세', progress.detail, '상세 없음')}
          ${renderDetailItem('최근 이벤트', progress.lastEvent, '최근 이벤트 없음')}
          ${renderDetailItem('원본 기록', progress.rawPreserved, '전체 로그와 원본 실행 기록은 아래 화면에서 다시 볼 수 있습니다.')}
        </div>
      </div>
    `;
  }

  function deriveAutoReplanStatus(run, deps) {
    const { t } = deps;
    const latest = run?.checkpoint?.autoReplan || run?.autoReplan?.latest || null;
    if (!latest) return null;
    if (latest.skipped) {
      return {
        title: t('자동 재계획 상태', 'Automatic replanning status'),
        label: t('이번 재계획 pass는 건너뜀', 'This replanning pass was skipped'),
        detail: latest.summary || t('구조화된 재계획 응답을 만들지 못해 현재 backlog를 유지합니다.', 'The current backlog is being preserved because the replanner did not return a valid structured response.'),
        evidence: [latest.parseError, latest.rawSnippet].filter(Boolean).join(' | ')
      };
    }
    if (latest.pauseForHuman || latest.freshSessionRecommended) {
      return {
        title: t('자동 재계획 상태', 'Automatic replanning status'),
        label: t('사람 확인 필요', 'Needs human review'),
        detail: latest.pauseReason || latest.summary || t('자동 재계획이 backlog 변경 대신 검토를 요청했습니다.', 'Automatic replanning requested review instead of changing the backlog.'),
        evidence: [latest.driftRisk ? `drift=${latest.driftRisk}` : '', latest.summary || ''].filter(Boolean).join(' | ')
      };
    }
    return null;
  }

  function renderAutoReplanStatus(run, deps) {
    const { escapeHtml, renderDetailItem, t } = deps;
    const status = deriveAutoReplanStatus(run, deps);
    if (!status) return '';
    return `
      <div class="card" style="margin-top: 16px;">
        <h3>${escapeHtml(status.title)}</h3>
        <div class="metric-row">
          <div class="mini-card"><span class="k">${escapeHtml(t('상태', 'Status'))}</span><div class="v">${escapeHtml(status.label)}</div></div>
        </div>
        <div class="detail-list">
          ${renderDetailItem(t('요약', 'Summary'), status.detail, t('없음', 'None'))}
          ${renderDetailItem(t('근거', 'Evidence'), status.evidence, t('없음', 'None'))}
        </div>
      </div>
    `;
  }

  function deriveRestartRecovery(run, deps) {
    const { t } = deps;
    const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
    const recoveredTasks = tasks.filter((task) => /recovered after harness restart/i.test(String(task?.reviewSummary || ''))
      || (Array.isArray(task?.findings) && task.findings.some((item) => /recovered after harness restart/i.test(String(item || '')))));
    const trigger = String(run?.checkpoint?.trigger || '').trim();
    if (trigger !== 'recovered-after-restart' && !recoveredTasks.length) return null;
    return {
      recoveredTaskCount: recoveredTasks.length,
      recoveredTaskIds: recoveredTasks.map((task) => task.id).filter(Boolean),
      summary: trigger === 'recovered-after-restart'
        ? t('서버 재시작 뒤 이 run을 자동 복구했습니다. 진행 중이던 태스크는 ready 상태로 되돌리고 다음 루프에서 다시 이어집니다.', 'This run was automatically recovered after a harness restart. In-progress tasks were moved back to ready so the next loop can resume safely.')
        : t('일부 태스크가 재시작 복구 흔적을 갖고 있습니다. 다음 시도 전 범위와 최근 checkpoint를 다시 확인하세요.', 'Some tasks show restart recovery traces. Re-check scope and the latest checkpoint before retrying them.'),
      nextAction: run?.checkpoint?.resumeHint || t('가장 최근 checkpoint를 확인한 뒤 현재 ready 태스크부터 다시 이어가면 됩니다.', 'Read the latest checkpoint and resume from the current ready task.')
    };
  }

  function deriveRunRuntimeSignals(run, deps) {
    const { t } = deps;
    const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
    const logs = Array.isArray(run?.logs) ? run.logs : [];
    const highlights = [];
    for (const task of tasks) {
      const verification = task?.lastExecution?.verification || {};
      if (verification?.ok === false) {
        const note = (Array.isArray(verification?.failingChecks) && verification.failingChecks.length
          ? verification.failingChecks[0]
          : (verification?.stderr || verification?.stdout || t('검증 실패', 'Verification failed')));
        highlights.push(`${task.id}: ${note}`);
      }
      if (verification?.browser && verification.browser.ok === false) {
        highlights.push(`${task.id}: ${verification.browser.note || t('브라우저 자동 확인 실패', 'Browser automation failed')}`);
      }
    }
    for (const log of logs.slice(-10)) {
      const level = String(log?.level || '').toLowerCase();
      const message = String(log?.message || '').trim();
      if (!message) continue;
      if (level === 'error' || level === 'warning' || /(fail|error|timeout|browser|verification|healthy)/i.test(message)) {
        highlights.push(message);
      }
    }
    return {
      warning: highlights.length > 0,
      headline: highlights.length
        ? t('최근 런타임 경고를 먼저 확인하는 편이 좋습니다.', 'Check the recent runtime warnings first.')
        : t('최근 런타임 경고는 크지 않습니다.', 'Recent runtime warnings are minor.'),
      highlights: highlights.slice(0, 5)
    };
  }

  function renderRuntimeSignals(run, deps) {
    const { escapeHtml } = deps;
    const runtime = deriveRunRuntimeSignals(run, deps);
    return `
      <div class="card" style="margin-top: 16px;">
        <h3>${escapeHtml(deps.t('런타임 관측', 'Runtime observability'))}</h3>
        <div class="detail-list">
          <div><strong>${escapeHtml(deps.t('요약', 'Summary'))}</strong><div>${escapeHtml(runtime.headline)}</div></div>
          <div><strong>${escapeHtml(deps.t('최근 신호', 'Recent signals'))}</strong><div>${escapeHtml(runtime.highlights.join(' | ') || deps.t('최근 경고 없음', 'No recent warnings'))}</div></div>
        </div>
      </div>
    `;
  }

  function normalizeChangedFiles(changedFiles) {
    if (Array.isArray(changedFiles)) {
      return changedFiles
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          return String(item?.path || '').trim();
        })
        .filter(Boolean);
    }
    if (typeof changedFiles === 'string') {
      const text = changedFiles.trim();
      if (!text) return [];
      try {
        return normalizeChangedFiles(JSON.parse(text));
      } catch {
        return [text];
      }
    }
    return [];
  }

  function resolveChangedFiles(task, artifacts) {
    const candidates = [
      artifacts?.changedFiles,
      artifacts?.executionSummary?.changedFiles,
      task?.lastExecution?.changedFiles
    ];
    for (const candidate of candidates) {
      const normalized = normalizeChangedFiles(candidate);
      if (normalized.length) return normalized;
    }
    return [];
  }

  function renderTaskInsights(task, artifacts, deps) {
    const { deriveTaskEvidence, escapeHtml, renderDetailItem, renderListChips, summarizeTaskEvidence, t } = deps;
    if (!task) {
      return `<div class="stack-item">${escapeHtml(t('태스크를 선택하면 현재 판단과 위험 요소를 먼저 볼 수 있습니다.', 'Select a task to see the current judgment and risks first.'))}</div>`;
    }
    const findings = (task.findings || []).filter(Boolean);
    const changedFiles = resolveChangedFiles(task, artifacts);
    const evidence = deriveTaskEvidence(task, artifacts);
    const evidenceSummary = summarizeTaskEvidence(evidence);
    const isSupersededFailure = task.status === 'failed' && task.replacementTaskId;
    const replacementLabel = [task.replacementTaskId, task.replacementTaskTitle].filter(Boolean).join(' ');
    return `
      <div class="grid-2 task-insight-grid">
        <div class="card">
          <h3>${escapeHtml(t('현재 판단', 'Current judgment'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('요약', 'Summary'), task.reviewSummary || (task.status === 'done' ? t('검토 완료', 'Review complete') : t('아직 검토 요약 없음', 'No review summary yet')), t('요약 없음', 'No summary'))}
            ${renderDetailItem(t('다음 액션', 'Next action'), isSupersededFailure
              ? t(`자동 승계 태스크 ${replacementLabel || task.replacementTaskId}이 이어서 처리 중이므로 이 실패 태스크를 수동으로 다시 시도하거나 건너뛸 필요가 없습니다.`, `Replacement task ${replacementLabel || task.replacementTaskId} is already carrying this forward, so you do not need to retry or skip the failed original manually.`)
              : task.status === 'failed'
              ? t('실패 원인을 보고 다시 시도할지, 이번 작업은 건너뛸지 결정하세요.', 'Review the failure and decide whether to retry or skip this task.')
              : (task.status === 'done'
                ? t('산출물과 검토 결과를 확인하면 됩니다.', 'Review the artifacts and review result.')
                : t('태스크 정의와 완료 조건을 먼저 확인하세요.', 'Check the task definition and acceptance criteria first.')))}
          </div>
        </div>
        <div class="card">
          <h3>${escapeHtml(t('핵심 체크', 'Key checks'))}</h3>
          ${renderListChips((task.acceptanceChecks || []).slice(0, 6), t('정의된 완료 조건 없음', 'No acceptance criteria defined'))}
          <div style="margin-top: 14px;">
            ${renderDetailItem(t('변경 파일', 'Changed files'), changedFiles.join(', '), t('아직 변경 파일 없음', 'No changed files yet'))}
          </div>
        </div>
      </div>
      <div class="card">
        <h3>${escapeHtml(t('검증 증거', 'Verification evidence'))}</h3>
        <div class="metric-row" style="margin-bottom: 14px;">
          <div class="mini-card"><span class="k">${escapeHtml(t('기계 검증', 'Automated checks'))}</span><div class="v">${escapeHtml(`${evidenceSummary.autoPassed}/${evidenceSummary.autoExpected || 0}`)}</div></div>
          <div class="mini-card"><span class="k">${escapeHtml(t('실패', 'Failed'))}</span><div class="v">${escapeHtml(evidenceSummary.autoFailed || 0)}</div></div>
          <div class="mini-card"><span class="k">${escapeHtml(t('추가 확인', 'Pending'))}</span><div class="v">${escapeHtml(evidenceSummary.autoPending || 0)}</div></div>
          <div class="mini-card"><span class="k">${escapeHtml(t('사람 확인', 'Manual review'))}</span><div class="v">${escapeHtml(evidenceSummary.manualPending || 0)}</div></div>
        </div>
        <div class="stack-list">
          ${evidence.map((item) => `
            <div class="stack-item ${item.status === 'fail' ? 'warning-item' : ''}">
              <strong>${escapeHtml(item.type)}</strong>
              <div>${escapeHtml(
                item.status === 'pass' ? t('통과', 'Passed')
                  : item.status === 'fail' ? t('실패', 'Failed')
                  : item.status === 'pending' ? t('사람 확인 또는 추가 검증 필요', 'Needs review or more verification')
                  : t('필요 없음', 'Not needed')
              )}</div>
              <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(item.note || '')}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ${findings.length ? `
        <div class="card">
          <h3>${escapeHtml(t('문제와 힌트', 'Issues and hints'))}</h3>
          <div class="stack-list">
            ${findings.map((finding) => `<div class="stack-item warning-item">${escapeHtml(finding)}</div>`).join('')}
          </div>
        </div>
      ` : ''}
    `;
  }

  function renderTaskActions(task, deps) {
    const { escapeHtml, isBusy, t } = deps;
    if (!task) return '';
    const isSupersededFailure = task.status === 'failed' && task.replacementTaskId;
    const canRetry = task.status === 'failed' && !isSupersededFailure;
    const canSkip = (task.status === 'failed' && !isSupersededFailure) || task.status === 'ready';
    if (!canRetry && !canSkip) return '';
    return `
      <div class="card" style="margin-bottom: 16px;">
        <h3>${escapeHtml(t('복구 작업', 'Recovery actions'))}</h3>
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          ${canRetry ? `<button class="primary" onclick="retrySelectedTask()" ${isBusy('retry-task') ? 'disabled' : ''}>${escapeHtml(isBusy('retry-task') ? t('재시도 중...', 'Retrying...') : t('이 태스크 다시 시도', 'Retry this task'))}</button>` : ''}
          ${canSkip ? `<button class="secondary-btn" onclick="skipSelectedTask()" ${isBusy('skip-task') ? 'disabled' : ''}>${escapeHtml(isBusy('skip-task') ? t('건너뛰는 중...', 'Skipping...') : t('이 태스크 건너뛰기', 'Skip this task'))}</button>` : ''}
        </div>
      </div>
    `;
  }

  function renderTaskDefinition(task, options = {}, deps) {
    const { escapeHtml, renderDetailItem, renderListChips, statusLabel } = deps;
    if (!task) {
      return '<div class="stack-item">태스크를 선택하면 목표와 완료 조건을 볼 수 있습니다.</div>';
    }
    const compact = options.compact === true;
    return `
      <div class="task-definition ${compact ? 'compact' : ''}">
        <div class="task-definition-head">
          <div>
            <strong>${escapeHtml(task.id)}</strong>
            <div style="margin-top: 4px; font-size: 15px;">${escapeHtml(task.title)}</div>
          </div>
          <span class="status-badge ${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span>
        </div>
        <div class="detail-list">
          ${renderDetailItem('목표', task.goal, '목표 미정')}
          ${renderDetailItem('선행 태스크', (task.dependsOn || []).join(', '), '없음')}
        </div>
        <div class="definition-grid">
          <div>
            <h4>예상 변경 파일</h4>
            ${renderListChips(task.filesLikely, '지정되지 않음')}
          </div>
          <div>
            <h4>완료 조건</h4>
            ${renderListChips(task.acceptanceChecks, '정의되지 않음')}
          </div>
        </div>
        ${compact ? '' : `
          <div>
            <h4 style="margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);">제약사항</h4>
            ${renderListChips(task.constraints, '추가 제약 없음')}
          </div>
        `}
      </div>
    `;
  }

  function renderRestartRecoveryNotice(run, deps) {
    const { escapeHtml, renderDetailItem, t } = deps;
    const recovery = deriveRestartRecovery(run, deps);
    if (!recovery) return '';
    return `
      <div class="card" style="margin-top: 16px;">
        <h3>${escapeHtml(t('재시작 복구', 'Restart recovery'))}</h3>
        <div class="metric-row">
          <div class="mini-card"><span class="k">${escapeHtml(t('상태', 'Status'))}</span><div class="v">${escapeHtml(t('자동 복구됨', 'Recovered automatically'))}</div></div>
          <div class="mini-card"><span class="k">${escapeHtml(t('복구 태스크', 'Recovered tasks'))}</span><div class="v">${escapeHtml(String(recovery.recoveredTaskCount || 0))}</div></div>
          <div class="mini-card"><span class="k">${escapeHtml(t('체크포인트', 'Checkpoint'))}</span><div class="v">${escapeHtml(run?.checkpoint?.trigger || '-')}</div></div>
        </div>
        <div class="detail-list">
          ${renderDetailItem(t('요약', 'Summary'), recovery.summary, t('없음', 'None'))}
          ${renderDetailItem(t('다음 행동', 'Next action'), recovery.nextAction, t('없음', 'None'))}
          ${renderDetailItem(t('복구된 태스크', 'Recovered task IDs'), recovery.recoveredTaskIds.join(', '), t('없음', 'None'))}
        </div>
      </div>
    `;
  }

  function renderPlanPreview(run, limit, deps) {
    const {
      canEditPlan,
      clip,
      describePattern,
      describePreset,
      escapeHtml,
      renderAgentBlueprint,
      renderDetailItem,
      renderListChips,
      t
    } = deps;
    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    const visibleTasks = tasks.slice(0, limit);
    const executionPolicy = run.executionPolicy || {};
    const rules = normalizeExecutionPolicyRules(executionPolicy);
    return `
      <div class="stack" style="margin-bottom: 24px;">
        <div class="card">
          <h3>승인할 계획</h3>
          <div class="stack-item warning-item" style="margin-bottom: 14px;">
            <strong>대부분은 아래 3가지만 보면 됩니다</strong>
            <div style="margin-top: 6px;">1. 목표가 맞는지 2. 제외 범위를 넘지 않는지 3. 첫 작업이 이상하지 않은지</div>
            <div style="margin-top: 6px; color: var(--muted);">문제가 없으면 바로 시작해도 됩니다. 목표 자체가 다르거나, 손대면 안 되는 영역을 건드리면 그때만 계획을 다시 조정하면 됩니다.</div>
          </div>
          <div class="metric-row">
            <div class="mini-card"><span class="k">태스크</span><div class="v">${escapeHtml(tasks.length)}</div></div>
            <div class="mini-card"><span class="k">에이전트</span><div class="v">${escapeHtml((run.agents || []).length)}</div></div>
            <div class="mini-card"><span class="k">진행 패턴</span><div class="v">${escapeHtml(describePattern(run.clarify?.architecturePattern || 'auto'))}</div></div>
            <div class="mini-card"><span class="k">작업 방식</span><div class="v">${escapeHtml(describePreset(run.preset))}</div></div>
          </div>
          <div class="detail-list">
            ${renderDetailItem(t('한 줄 요약', 'Summary'), run.planSummary, t('계획 요약이 아직 없습니다.', 'No plan summary yet.'))}
            ${renderDetailItem(t('역할 분담', 'Execution model'), run.executionModel || run.clarify?.executionModel, t('역할 분담 정보 없음', 'No execution model'))}
            ${renderDetailItem(t('자동 진행 규칙', 'Automation policy'), (executionPolicy.policyNotes || []).join(' | '), t('추가 규칙 없음', 'No extra policy notes'))}
          </div>
          ${rules.length ? `
            <div style="margin-top: 14px;">
              <strong>${escapeHtml(t('왜 이런 태스크가 추가됐는지', 'Why the harness changed this plan'))}</strong>
              ${renderExecutionPolicyRuleList(executionPolicy, deps)}
            </div>
          ` : ''}
        </div>
        <div class="card">
          <h3>${escapeHtml(t('생성된 에이전트', 'Generated agents'))}</h3>
          ${renderAgentBlueprint(run)}
        </div>
        <div class="card">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
            <h3 style="margin:0;">${escapeHtml(t('생성된 태스크', 'Generated tasks'))}</h3>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              ${canEditPlan(run) ? '<button class="secondary-btn" onclick="openPlanEditModal()">계획 내용 수정</button>' : ''}
              ${tasks.length > limit ? `<button class="secondary-btn" onclick="switchTab('planning')">전체 보기</button>` : ''}
            </div>
          </div>
          <div class="stack-list" style="margin-top: 12px;">
            ${visibleTasks.map((task) => `
              <div class="stack-item interactive" onclick="openTaskDetails('${task.id}')">
                <strong>${escapeHtml(task.id)} · ${escapeHtml(task.title)}</strong>
                <div style="margin-top: 6px;">${escapeHtml(clip(task.goal, 220) || t('목표 없음', 'No goal'))}</div>
                <div style="margin-top: 8px; font-size: 12px; color: var(--muted);">${escapeHtml(t('예상 파일', 'Likely files'))}: ${escapeHtml((task.filesLikely || []).join(', ') || t('미정', 'Not decided'))}</div>
                <div style="margin-top: 8px;">${renderListChips((task.acceptanceChecks || []).slice(0, 3), t('완료 조건 없음', 'No acceptance criteria'))}</div>
              </div>
            `).join('') || `<div class="stack-item">${escapeHtml(t('생성된 태스크가 없습니다.', 'No tasks were generated.'))}</div>`}
          </div>
        </div>
      </div>
    `;
  }

  globalThis.HarnessRunRenderers = {
    normalizeExecutionPolicyRules,
    renderExecutionPolicyRuleList,
    deriveRunRuntimeSignals,
    renderRuntimeSignals,
    renderProgressSummary,
    deriveAutoReplanStatus,
    renderAutoReplanStatus,
    deriveRestartRecovery,
    renderRestartRecoveryNotice,
    normalizeChangedFiles,
    resolveChangedFiles,
    renderTaskInsights,
    renderTaskActions,
    renderTaskDefinition,
    renderPlanPreview
  };
})(window);
