(function attachHarnessArtifactRenderers(global) {
  function createArtifactRenderers(deps) {
    const pickText = global.HarnessUiHelpers?.pickText || ((ko, en = '') => String(ko || en || ''));
    const t = (ko, en = '') => pickText(ko, en);
    const {
      escapeHtml,
      renderDetailItem,
      renderListChips
    } = deps || {};

    function formatStructuredArtifact(value, empty = '') {
      if (!value || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
        return escapeHtml(empty || t('(없음)', '(none)'));
      }
      return escapeHtml(JSON.stringify(value, null, 2));
    }

    function renderVerdictFindingSection(title, items) {
      if (!Array.isArray(items) || !items.length) return '';
      return `<div class="stack-list" style="margin-top: 14px;"><div class="stack-item"><strong>${escapeHtml(title)}</strong></div>${items.map((item) => `<div class="stack-item warning-item">${escapeHtml(item)}</div>`).join('')}</div>`;
    }

    function verificationLabel(summary) {
      if (!summary || typeof summary.verificationOk !== 'boolean') return '';
      return summary.verificationOk === false ? t('실패', 'Failed') : t('통과', 'Passed');
    }

    function renderArtifactSummary(artifacts) {
      const summary = artifacts?.executionSummary || null;
      const verdict = artifacts?.reviewVerdict || null;
      const retryPlan = artifacts?.retryPlan || null;
      if (!summary && !verdict && !retryPlan) {
        return `
          <div class="stack-item">
            ${escapeHtml(t('구조화된 요약 산출물이 아직 없습니다.', 'No structured summary artifacts yet.'))}
            <div style="margin-top: 8px; color: var(--muted);">${escapeHtml(t('실행 출력과 검토 raw 탭에서 기존 산출물을 확인할 수 있습니다.', 'You can still inspect the raw execution and review tabs.'))}</div>
          </div>
        `;
      }
      return `
        <div class="card" style="margin-bottom: 16px;">
          <h3>${escapeHtml(t('실행 요약', 'Execution summary'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('검토 결정', 'Review decision'), verdict?.decision || summary?.reviewDecision, t('없음', 'None'))}
            ${renderDetailItem(t('검토 경로', 'Review route'), verdict?.route || summary?.reviewRoute, t('없음', 'None'))}
            ${renderDetailItem(t('검증 결과', 'Verification'), verificationLabel(summary), t('없음', 'None'))}
            ${renderDetailItem(t('적용 결과', 'Apply result'), summary?.applyResult, t('없음', 'None'))}
            ${renderDetailItem(t('범위 이탈 파일', 'Out-of-scope files'), (summary?.outOfScopeFiles || []).join(', '), t('없음', 'None'))}
          </div>
        </div>
        ${verdict ? `
          <div class="card" style="margin-bottom: 16px;">
            <h3>${escapeHtml(t('검토 판단', 'Review verdict'))}</h3>
            <div class="detail-list">
              ${renderDetailItem(t('요약', 'Summary'), verdict.summary, t('없음', 'None'))}
              ${renderDetailItem(t('재시도 진단', 'Retry diagnosis'), verdict.retryDiagnosis, t('없음', 'None'))}
            </div>
            ${renderVerdictFindingSection(t('기능 / 구성 검토', 'Functional / behavior review'), verdict.functionalFindings)}
            ${renderVerdictFindingSection(t('구조 검토', 'Structural review'), verdict.structuralFindings)}
            ${renderVerdictFindingSection(t('코드 / 품질 검토', 'Code / quality review'), verdict.codeFindings)}
            ${renderVerdictFindingSection(t('정적 검증 검토', 'Static verification review'), verdict.staticVerificationFindings)}
            ${renderVerdictFindingSection(t('브라우저 UX 검토', 'Browser UX review'), verdict.browserUxFindings)}
            ${renderVerdictFindingSection(t('공통 메모', 'Shared notes'), verdict.findings)}
          </div>
        ` : ''}
        ${retryPlan ? `
          <div class="card">
            <h3>${escapeHtml(t('재시도 계획', 'Retry plan'))}</h3>
            <div class="detail-list">
              ${renderDetailItem(t('원인', 'Root cause'), retryPlan.rootCause || retryPlan.reason, t('없음', 'None'))}
              ${renderDetailItem(t('추가 검사', 'Extra checks'), (retryPlan.extraChecks || []).join(' | '), t('없음', 'None'))}
            </div>
            <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-top: 14px;">${formatStructuredArtifact(retryPlan)}</div>
          </div>
        ` : ''}
      `;
    }

    function renderArtifactHandoff(artifacts) {
      if (!artifacts?.handoff) {
        return `<div class="stack-item">${escapeHtml(t('handoff 산출물이 아직 없습니다.', 'No handoff artifact yet.'))}</div>`;
      }
      return `
        <div class="card" style="margin-bottom: 16px;">
          <h3>${escapeHtml(t('핵심 handoff', 'Key handoff'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('단계', 'Stage'), artifacts.handoff.stage, t('없음', 'None'))}
            ${renderDetailItem(t('목표', 'Goal'), artifacts.handoff.goal, t('없음', 'None'))}
            ${renderDetailItem(t('예상 변경 파일', 'Likely files'), (artifacts.handoff.filesLikely || []).join(', '), t('없음', 'None'))}
            ${renderDetailItem(t('예상 범위', 'Expected scope'), artifacts.handoff.expectedScope, t('없음', 'None'))}
          </div>
        </div>
        <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px;">${formatStructuredArtifact(artifacts.handoff)}</div>
      `;
    }

    function timelineEntrySummary(entry) {
      if (!entry || typeof entry !== 'object') return '';
      if (entry.event) {
        const bits = [];
        if (entry.meta?.decision) bits.push(`decision=${entry.meta.decision}`);
        if (entry.meta?.reviewRoute) bits.push(`route=${entry.meta.reviewRoute}`);
        if (entry.meta?.verificationOk !== undefined) bits.push(`verification=${entry.meta.verificationOk ? 'pass' : 'fail'}`);
        if (entry.meta?.message) bits.push(entry.meta.message);
        return bits.join(' | ');
      }
      const bits = [];
      if (entry.code !== undefined) bits.push(`code=${entry.code}`);
      if (entry.ok !== undefined) bits.push(`ok=${entry.ok}`);
      if (entry.reviewRoute) bits.push(`route=${entry.reviewRoute}`);
      if (entry.decision) bits.push(`decision=${entry.decision}`);
      if (entry.message) bits.push(entry.message);
      if (entry.note) bits.push(entry.note);
      return bits.join(' | ');
    }

    function renderArtifactTimeline(artifacts) {
      const traceEntries = Array.isArray(artifacts?.traceEntries) ? artifacts.traceEntries : [];
      const trajectoryEntries = Array.isArray(artifacts?.trajectoryEntries) ? artifacts.trajectoryEntries : [];
      const merged = [
        ...traceEntries.map((entry) => ({ source: 'trace', at: entry.at, label: entry.event || 'trace', detail: timelineEntrySummary(entry), raw: entry })),
        ...trajectoryEntries.map((entry) => ({ source: 'trajectory', at: entry.at, label: entry.kind || 'trajectory', detail: timelineEntrySummary(entry), raw: entry }))
      ]
        .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

      if (!merged.length) {
        return `<div class="stack-item">${escapeHtml(t('timeline 산출물이 아직 없습니다.', 'No timeline artifact yet.'))}</div>`;
      }
      return `
        <div class="stack-list">
          ${merged.map((entry) => `
            <div class="stack-item">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:center;">
                <strong>${escapeHtml(entry.label)}</strong>
                <span style="color: var(--muted); font-size: 11px;">${escapeHtml(entry.source)} · ${escapeHtml(entry.at || '')}</span>
              </div>
              ${entry.detail ? `<div style="margin-top:6px; color: var(--muted);">${escapeHtml(entry.detail)}</div>` : ''}
            </div>
          `).join('')}
        </div>
        <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-top: 16px;">${formatStructuredArtifact({ traceEntries, trajectoryEntries })}</div>
      `;
    }

    function renderArtifactActions(artifacts) {
      const actionRecords = Array.isArray(artifacts?.actionRecords) ? artifacts.actionRecords : [];
      if (!actionRecords.length) {
        return `<div class="stack-item">${escapeHtml(t('action 기록이 아직 없습니다.', 'No action records yet.'))}</div>`;
      }
      return `
        <div class="card" style="margin-bottom: 16px;">
          <h3>${escapeHtml(t('액션 인터페이스', 'Action interface'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('총 기록 수', 'Total records'), actionRecords.length, '0')}
            ${renderDetailItem(t('마지막 액션', 'Last action'), actionRecords.at(-1)?.capabilityId || '', t('없음', 'None'))}
          </div>
        </div>
        <div class="stack-list">
          ${actionRecords.slice().reverse().map((entry) => `
            <div class="stack-item">
              <div style="display:flex; justify-content:space-between; gap:12px;">
                <strong>${escapeHtml(entry.capabilityId || 'action')}</strong>
                <span style="color: var(--muted); font-size: 11px;">${escapeHtml(entry.status || '')} · ${escapeHtml(entry.at || '')}</span>
              </div>
              <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(entry.actionClass || '')} / ${escapeHtml(entry.provider || '')}</div>
              <div style="margin-top: 10px; white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px;">${escapeHtml(formatStructuredArtifact(entry))}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    function renderArtifactContext(artifacts) {
      if (!artifacts?.codeContext) {
        return `<div class="stack-item">${escapeHtml(t('code context 산출물이 아직 없습니다.', 'No code context artifact yet.'))}</div>`;
      }
      const criticalSymbols = Array.isArray(artifacts.codeContext?.projectGraph?.criticalSymbols)
        ? artifacts.codeContext.projectGraph.criticalSymbols.slice(0, 4)
        : [];
      const criticalRiskThreshold = Number(artifacts.codeContext?.projectGraph?.thresholds?.criticalRisk || 15);
      return `
        <div class="card" style="margin-bottom: 16px;">
          <h3>${escapeHtml(t('코드 문맥', 'Code context'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('요약', 'Summary'), artifacts.codeContext.summary, t('없음', 'None'))}
            ${renderDetailItem(t('토큰', 'Tokens'), (artifacts.codeContext.queryTokens || []).join(', '), t('없음', 'None'))}
            ${renderDetailItem(t('전역 인덱싱 파일 수', 'Indexed files'), artifacts.codeContext?.projectGraph?.indexedFileCount, '0')}
          </div>
        </div>
        ${criticalSymbols.length ? `
          <div class="card" style="margin-bottom: 16px;">
            <h3>${escapeHtml(`CRITICAL-RISK >= ${criticalRiskThreshold.toFixed(1)}`)}</h3>
            <div class="stack-list">
              ${criticalSymbols.map((item) => `<div class="stack-item"><strong>${escapeHtml(item.symbol || '')}</strong><div>${escapeHtml(`risk ${Number(item.riskScore || 0).toFixed(1)} | importers ${Number(item.importerCount || 0)} | callers ${Number(item.callerCount || 0)}${Array.isArray(item.definedIn) && item.definedIn.length ? ` | defined in ${item.definedIn[0]}` : ''}`)}</div></div>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="stack-list">
          ${(artifacts.codeContext.relatedFiles || []).map((item) => `
            <div class="stack-item">
              <strong>${escapeHtml(item.path || '')}</strong>
              <div style="margin-top: 6px; color: var(--muted);">score ${escapeHtml(item.score || 0)} | importedBy ${escapeHtml(item?.impact?.importedByCount || 0)} | calledBy ${escapeHtml(item?.impact?.calledByCount || 0)}</div>
              ${(item?.impact?.exportedSymbolImpact || [])[0] ? `<div style="margin-top: 6px; color: var(--muted);">${escapeHtml(`${(item.impact.exportedSymbolImpact[0].symbol || '')}: importers ${Number(item.impact.exportedSymbolImpact[0].importerCount || 0)}, callers ${Number(item.impact.exportedSymbolImpact[0].callerCount || 0)}, calls ${Number(item.impact.exportedSymbolImpact[0].callCount || 0)}`)}</div>` : ''}
              <div style="margin-top: 6px;">${renderListChips(item.symbols || [], t('심볼 없음', 'No symbols'))}</div>
            </div>
          `).join('') || `<div class="stack-item">${escapeHtml(t('관련 파일 없음', 'No related files'))}</div>`}
        </div>
        <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-top: 16px;">${formatStructuredArtifact(artifacts.codeContext)}</div>
      `;
    }

    function renderArtifactBrowser(artifacts) {
      const browser = artifacts?.browserVerification || artifacts?.verificationJson?.browser || null;
      if (!browser) {
        return `<div class="stack-item">${escapeHtml(t('브라우저 검증 산출물이 아직 없습니다.', 'No browser verification artifact yet.'))}</div>`;
      }
      return `
        <div class="card" style="margin-bottom: 16px;">
          <h3>${escapeHtml(t('브라우저 검증', 'Browser verification'))}</h3>
          <div class="detail-list">
            ${renderDetailItem(t('상태', 'Status'), browser.status, t('없음', 'None'))}
            ${renderDetailItem(t('대상 URL', 'Target URL'), browser.targetUrl, t('없음', 'None'))}
            ${renderDetailItem('Selector', browser.selector, t('없음', 'None'))}
            ${renderDetailItem(t('메모', 'Note'), browser.note, t('없음', 'None'))}
          </div>
          ${(browser.consoleSummary || []).length ? `<div class="stack-list" style="margin-top: 14px;">${browser.consoleSummary.map((item) => `<div class="stack-item">${escapeHtml(item)}</div>`).join('')}</div>` : ''}
          ${(browser.stepLog || []).length ? `<div class="stack-list" style="margin-top: 14px;">${browser.stepLog.map((item) => `<div class="stack-item">${escapeHtml(item)}</div>`).join('')}</div>` : ''}
        </div>
        ${artifacts.browserScreenshotDataUrl ? `
          <div class="card" style="margin-bottom: 16px;">
            <h3>${escapeHtml(t('스크린샷', 'Screenshot'))}</h3>
            <img src="${artifacts.browserScreenshotDataUrl}" alt="${escapeHtml(t('브라우저 검증 스크린샷', 'Browser verification screenshot'))}" style="max-width:100%; border-radius: 12px; border: 1px solid var(--line);" />
          </div>
        ` : ''}
        <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px;">${formatStructuredArtifact(browser)}</div>
      `;
    }

    function renderArtifactTabs(artifacts, task, artifactSubTab = 'summary') {
      if (!artifacts) {
        return `
          <div class="stack-item">
            ${escapeHtml(t('아직 실행 산출물이 없습니다. 이 태스크는 계획 단계이거나 아직 시작되지 않았습니다.', 'No execution artifact yet. This task is still in planning or has not started.'))}
            ${task ? `<div style="margin-top: 8px; color: var(--muted);">${escapeHtml(t('먼저 목표와 완료 조건을 검토한 뒤 실행하세요.', 'Review the goal and acceptance criteria before running it.'))}</div>` : ''}
          </div>
        `;
      }
      return `
        <div style="display: flex; gap: 12px; border-bottom: 1px solid var(--line); margin-bottom: 16px;">
          <div class="tab ${artifactSubTab === 'summary' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('summary')">${escapeHtml(t('요약', 'Summary'))}</div>
          <div class="tab ${artifactSubTab === 'handoff' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('handoff')">${escapeHtml(t('handoff', 'Handoff'))}</div>
          <div class="tab ${artifactSubTab === 'timeline' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('timeline')">${escapeHtml(t('타임라인', 'Timeline'))}</div>
          <div class="tab ${artifactSubTab === 'execution' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('execution')">${escapeHtml(t('실행 출력', 'Execution output'))}</div>
          <div class="tab ${artifactSubTab === 'verification' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('verification')">${escapeHtml(t('검증 결과', 'Verification'))}</div>
          <div class="tab ${artifactSubTab === 'browser' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('browser')">${escapeHtml(t('브라우저', 'Browser'))}</div>
          <div class="tab ${artifactSubTab === 'actions' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('actions')">${escapeHtml(t('액션', 'Actions'))}</div>
          <div class="tab ${artifactSubTab === 'context' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('context')">${escapeHtml(t('문맥', 'Context'))}</div>
          <div class="tab ${artifactSubTab === 'diff' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('diff')">${escapeHtml(t('변경점', 'Diff'))}</div>
          <div class="tab ${artifactSubTab === 'review' ? 'active' : ''}" style="padding: 8px 0; font-size: 12px;" onclick="setArtifactSubTab('review')">${escapeHtml(t('검토 원문', 'Review raw'))}</div>
        </div>
        <div style="white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 12px;">
          ${artifactSubTab === 'summary' ? renderArtifactSummary(artifacts) :
            artifactSubTab === 'handoff' ? renderArtifactHandoff(artifacts) :
            artifactSubTab === 'timeline' ? renderArtifactTimeline(artifacts) :
              artifactSubTab === 'execution' ? escapeHtml(artifacts.agentOutput || t('(없음)', '(none)')) :
            artifactSubTab === 'verification' ? escapeHtml(artifacts.verificationReport || t('(없음)', '(none)')) :
            artifactSubTab === 'browser' ? renderArtifactBrowser(artifacts) :
            artifactSubTab === 'actions' ? renderArtifactActions(artifacts) :
            artifactSubTab === 'context' ? renderArtifactContext(artifacts) :
              artifactSubTab === 'diff' ? escapeHtml(artifacts.diffPatch || t('(없음)', '(none)')) :
                escapeHtml(artifacts.agentReview || t('(없음)', '(none)'))}
        </div>
      `;
    }

    return {
      renderArtifactTabs
    };
  }

  global.HarnessUiArtifactRenderers = {
    createArtifactRenderers
  };
}(window));
