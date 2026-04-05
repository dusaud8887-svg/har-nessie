(function attachHarnessProjectRenderers(global) {
  function createProjectRenderers(deps) {
    const pickText = global.HarnessUiHelpers?.pickText || ((ko, en = '') => String(ko || en || ''));
    const t = (ko, en = '') => pickText(ko, en);
    const {
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
      getSelectedProjectId,
      getProjectOverview,
      getRecentPhaseTransition
    } = deps || {};

    function continuationModeLabel(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'manual' || value === '수동' || value === 'Manual') return t('수동', 'Manual');
      return t('권장 초안 자동 준비', 'Auto-prepare suggested draft');
    }

    function docsSyncChoiceLabel(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'optional' || value === '선택' || value === 'Optional') return t('선택', 'Optional');
      return t('권장', 'Recommended');
    }

    function autoSweepChoiceLabel(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'automatic' || value === '자동' || value === 'Automatic') return t('자동', 'Automatic');
      return t('수동', 'Manual');
    }

    function normalizeMaxChainDepth(value = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    }

    function autoChainChoiceLabel(value) {
      return value === true ? t('활성', 'Enabled') : t('비활성', 'Disabled');
    }

    function browserPolicyLabel(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized.includes('baseline') || value === '이 프로젝트 baseline') return t('이 프로젝트 baseline', 'Project baseline');
      return t('선택적', 'Optional');
    }

    function browserPolicyNote(value) {
      const text = String(value || '').trim();
      if (!text) return t('기본 하네스 운영에서는 브라우저 자동 확인이 선택 사항입니다.', 'Browser automation is optional in the default harness flow.');
      if (text === '이 프로젝트는 browser verification 또는 dev-server 설정이 있어 Playwright를 baseline dependency로 보는 편이 맞습니다.') {
        return t(text, 'This project has browser verification or dev-server settings, so Playwright should be treated as a baseline dependency.');
      }
      if (text === '기본 harness 운영에서는 Playwright optional 정책을 유지합니다.') {
        return t(text, 'The default harness flow keeps Playwright optional.');
      }
      return text;
    }

    function runtimeHeadline(value) {
      const text = String(value || '').trim();
      if (!text) return t('최근 런타임 신호 없음', 'No recent runtime signals');
      if (text === '주의해서 볼 런타임 신호가 있습니다.') return t(text, 'There are runtime signals worth checking.');
      if (text === '최근 런타임 신호는 안정적입니다.') return t(text, 'Recent runtime signals look stable.');
      return text;
    }

    function runtimeDetail(value) {
      const text = String(value || '').trim();
      if (!text) return t('브라우저 자동 확인은 기본적으로 선택 사항입니다.', 'Browser automation is optional by default.');
      if (text === '브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.') {
        return t(text, 'Browser verification is optional, and recent runs do not show major runtime warnings.');
      }
      return browserPolicyNote(text);
    }

    function projectHealthStatusLabel(value) {
      const text = String(value || '').trim();
      if (text === '운영 주의') return t(text, 'Attention needed');
      if (text === '관찰 필요') return t(text, 'Watch closely');
      if (text === '정상 진행') return t(text, 'Healthy');
      return text || t('정상 진행', 'Healthy');
    }

    function projectHealthText(value) {
      const text = String(value || '').trim();
      if (!text) return '';
      const repeatedPatternMatch = text.match(/^(.*)\s패턴이\s(\d+)번\s반복되었습니다\.$/);
      if (repeatedPatternMatch) {
        return t(text, `The pattern "${repeatedPatternMatch[1]}" repeated ${repeatedPatternMatch[2]} times.`);
      }
      const closeCarryOverMatch = text.match(/^(.+?)를 먼저 닫는 흐름이 가장 자연스럽습니다\.$/);
      if (closeCarryOverMatch) {
        return t(text, `The most natural next step is to close ${closeCarryOverMatch[1]} first.`);
      }
      const mappings = new Map([
        ['검토 대기 먼저 해소', 'Clear pending review first'],
        ['사람 확인이 필요한 계획/질문이 남아 있어 다음 run 자동 연결보다 검토 해소가 먼저입니다.', 'Human review is still needed, so clearing review items comes before auto-linking the next run.'],
        ['이어받을 작업 기준으로 다음 run 초안 준비됨', 'Next run draft is ready from carry-over work'],
        ['정리 작업 기준으로 다음 run 초안 준비됨', 'Next run draft is ready from cleanup work'],
        ['현재 단계 목표 기준 다음 slice 초안 준비됨', 'Next slice draft is ready from the current phase goal'],
        ['열린 큐가 없으면 현재 단계 goal과 contract를 기준으로 다음 run을 이어갈 수 있습니다.', 'With no open queue, the next run can continue from the current phase goal and contract.'],
        ['활성 단계 없음', 'No active phase'],
        ['새 단계를 추가하거나 재분석으로 현재 목표를 먼저 고정해야 합니다.', 'Add a phase or re-analyze first to lock the current goal.'],
        ['재분석 권장', 'Re-analysis recommended'],
        ['정리 점검 권장', 'Quality sweep recommended'],
        ['반복 실패 패턴 점검 권장', 'Review repeated failure pattern'],
        ['현재 cadence 양호', 'Cadence looks healthy'],
        ['문서 기준 프로젝트', 'Docs-first project'],
        ['구현 중심 프로젝트', 'Implementation-first project'],
        ['다음 run도 docs/source-of-record와 구현을 함께 맞추는 흐름이 권장됩니다.', 'For the next run, keep docs/source-of-record aligned with implementation.'],
        ['문서는 필요할 때만 보강하고, 기본은 구현 slice 중심으로 이어가면 됩니다.', 'Only update docs when needed. The default flow can stay implementation-slice driven.'],
        ['큰 흐름이 바뀌면 docs도 같은 run 안에서 함께 갱신합니다.', 'When the implementation direction changes in a meaningful way, update the docs in the same run.'],
        ['이번 run이 source-of-record 문서나 spec를 바꾸면 같은 run 안에서 repo 문서도 함께 갱신하고, 다음 run은 갱신된 문서를 기준으로 이어간다.', 'If this run changes source-of-record docs or specs, update the repo docs in the same run and let the next run continue from those updated docs.'],
        ['문서가 기준인 범위가 생길 때만 docs-first나 intake를 다시 고려하면 됩니다.', 'Only reconsider docs-first or intake when the scope becomes document-driven again.'],
        ['최근 문서와 구현이 크게 어긋난 신호는 아직 없습니다.', 'There is no strong sign of docs and implementation drifting apart yet.'],
        ['이 프로젝트는 문서 우선 운영이 기본은 아닙니다.', 'Docs-first is not the default operating mode for this project.'],
        ['최근 구현 변경이 문서 반영 없이 누적되어 docs drift 가능성이 높습니다.', 'Recent implementation changes have piled up without doc updates, so docs drift is likely.'],
        ['재분석 후 docs-first maintenance run으로 문서와 backlog를 다시 맞추는 편이 안전합니다.', 'Re-analyze and run a docs-first maintenance pass to realign docs and backlog.'],
        ['최근 구현 변경 중 일부가 문서 갱신보다 앞서 있어 docs drift를 점검하는 편이 좋습니다.', 'Some recent implementation changes are ahead of the docs, so a docs-drift check is recommended.'],
        ['다음 run에서 바뀐 구현과 source-of-record 문서를 함께 점검하세요.', 'In the next run, review the changed implementation together with the source-of-record docs.'],
        ['최근 반복 실패 패턴은 아직 뚜렷하지 않습니다.', 'There is no strong repeated failure pattern yet.'],
        ['최근 run이 누적됐으므로 quality sweep으로 cleanup lane과 열린 위험을 한 번 정리하는 편이 좋습니다.', 'Recent runs have piled up, so it is a good moment to use a quality sweep to clean up the cleanup lane and open risks.'],
        ['같은 실패 원인이 반복되므로 범위를 줄여 다시 계획하거나 docs 기준을 다시 맞추는 편이 좋습니다.', 'The same failure cause is repeating, so it is better to narrow the scope and replan or realign the docs baseline.'],
        ['지금은 권장 다음 작업 초안으로 현재 단계를 이어가면 됩니다.', 'You can continue the current phase with the suggested next-run draft now.'],
        ['주의해서 볼 런타임 신호가 있습니다.', 'There are runtime signals worth checking.'],
        ['최근 런타임 신호는 안정적입니다.', 'Recent runtime signals look stable.'],
        ['브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.', 'Browser verification is optional, and recent runs do not show major runtime warnings.'],
        ['검증 실패', 'Verification failed'],
        ['브라우저 확인 실패', 'Browser check failed']
      ]);
      return t(text, mappings.get(text) || text);
    }

    function formatCountdown(targetIso) {
      const targetMs = Date.parse(String(targetIso || '').trim());
      if (!Number.isFinite(targetMs)) return '';
      const diffMs = targetMs - Date.now();
      if (diffMs <= 0) return t('예정 시각이 지났습니다. 다음 tick에서 다시 계산됩니다.', 'The scheduled time has passed. It will be recalculated on the next tick.');
      const totalMinutes = Math.ceil(diffMs / 60000);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours <= 0) return t(`${minutes}분 남음`, `${minutes}m remaining`);
      if (minutes === 0) return t(`${hours}시간 남음`, `${hours}h remaining`);
      return t(`${hours}시간 ${minutes}분 남음`, `${hours}h ${minutes}m remaining`);
    }

    function renderProjectLoopPanel(phase) {
      const recentRuns = Array.isArray(phase?.recentRuns) ? phase.recentRuns : [];
      const automatedRun = recentRuns.find((run) => run?.chainMeta?.loop?.enabled) || null;
      if (!automatedRun) return '';
      const loop = automatedRun.chainMeta.loop || {};
      const chainDepth = normalizeMaxChainDepth(automatedRun.chainDepth);
      const modeLabel = loop.mode === 'until-goal'
        ? t('목표 달성까지', 'Until goal')
        : t('정해진 횟수', 'Repeat count');
      return `
        <div class="card" style="margin-bottom: 14px; border: 1px solid rgba(59,130,246,0.18); background: linear-gradient(180deg, rgba(239,246,255,0.92), rgba(255,255,255,1));">
          <div class="section-head" style="margin-bottom: 12px;">
            <div>
              <span class="eyebrow">${escapeHtml(t('루프 진행', 'Loop progress'))}</span>
              <h3>${escapeHtml(t(`${Number(loop.currentRunIndex || 1)} / ${Number(loop.maxRuns || 1)}회 | 체인 depth ${chainDepth} | 모드: ${loop.mode === 'until-goal' ? 'until-goal' : 'repeat-count'}`, `${Number(loop.currentRunIndex || 1)} / ${Number(loop.maxRuns || 1)} | chain depth ${chainDepth} | mode: ${loop.mode === 'until-goal' ? 'until-goal' : 'repeat-count'}`))}</h3>
            </div>
            <p>${escapeHtml(t('현재 단계의 자동 반복 run 계보와 실패 중단 한계를 따로 보여줍니다.', 'This isolates the active phase loop lineage and failure-stop boundary.'))}</p>
          </div>
          <div class="stats-grid">
            <div class="stat-card"><span class="label">${escapeHtml(t('현재 반복', 'Current loop'))}</span><div class="value">${escapeHtml(`${Number(loop.currentRunIndex || 1)}/${Number(loop.maxRuns || 1)}`)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('루프 모드', 'Loop mode'))}</span><div class="value">${escapeHtml(modeLabel)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('연속 실패', 'Consecutive failures'))}</span><div class="value">${escapeHtml(`${Number(loop.consecutiveFailures || 0)}/${Number(loop.maxConsecutiveFailures || 0)}`)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('기준 run', 'Origin run'))}</span><div class="value">${escapeHtml(automatedRun.chainMeta?.originRunId || automatedRun.id || '-')}</div></div>
          </div>
          <div class="stack-list" style="margin-top: 12px;">
            <div class="stack-item"><strong>${escapeHtml(t('최근 자동 run', 'Latest automated run'))}</strong><div>${escapeHtml(automatedRun.title || automatedRun.id || '-')} · ${escapeHtml(statusLabel(automatedRun.status || 'ready'))}</div></div>
            ${automatedRun.chainedFromRunId ? `<div class="stack-item"><strong>${escapeHtml(t('이전 계보', 'Previous lineage'))}</strong><div>${escapeHtml(automatedRun.chainedFromRunId)}</div></div>` : ''}
          </div>
        </div>
      `;
    }

    function renderProjectPhaseCard(phase) {
      const counts = phase?.runCounts || {};
      const phaseContract = phase?.phaseContract || null;
      const carryOverTasks = Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks : [];
      const pendingReview = Array.isArray(phase?.pendingReview) ? phase.pendingReview : [];
      const backlogLineage = Array.isArray(phase?.backlogLineage) ? phase.backlogLineage : [];
      const openRisks = Array.isArray(phase?.openRisks) ? phase.openRisks : [];
      const cleanupLane = Array.isArray(phase?.cleanupLane) ? phase.cleanupLane : [];
      const latestQualitySweep = phase?.latestQualitySweep || null;
      const recentRuns = Array.isArray(phase?.recentRuns) ? phase.recentRuns : [];
      const currentOverview = getProjectOverview ? getProjectOverview(getSelectedProjectId ? getSelectedProjectId() : '') : null;
      const recentTransition = getRecentPhaseTransition ? getRecentPhaseTransition(getSelectedProjectId ? getSelectedProjectId() : '') : null;
      const isCurrentPhase = String(currentOverview?.project?.currentPhaseId || '') === String(phase?.id || '');
      const isAutoAdvancedPhase = isCurrentPhase && String(recentTransition?.phaseId || '') === String(phase?.id || '');
      const cardTone = isAutoAdvancedPhase
        ? 'border:1px solid rgba(34,197,94,0.26); background:linear-gradient(180deg, rgba(240,253,244,0.98), rgba(255,255,255,1)); box-shadow:0 18px 34px rgba(34,197,94,0.08);'
        : '';
      return `
        <div class="card" style="${cardTone}">
          <div class="section-head" style="align-items: flex-start; margin-bottom: 18px;">
            <div>
              <span class="eyebrow">${escapeHtml(t('단계', 'Phase'))}</span>
              <h3>${escapeHtml(phase?.title || phase?.id || t('이름 없는 단계', 'Untitled phase'))}</h3>
              <p style="margin-top: 8px; max-width: 680px; text-align: left;">${escapeHtml(phase?.goal || t('아직 이 단계 목표가 적혀 있지 않습니다.', 'No goal has been written for this phase yet.'))}</p>
            </div>
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
              <span class="status-badge ${escapeHtml(String(phase?.status || 'ready'))}">${escapeHtml(statusLabel(phase?.status || 'ready'))}</span>
              ${isCurrentPhase ? `<span class="status-badge in_progress">${escapeHtml(t('현재 단계', 'Current phase'))}</span>` : ''}
              ${isAutoAdvancedPhase ? `<span class="status-badge running">${escapeHtml(t('자동 전환됨', 'Auto-advanced'))}</span>` : ''}
              <span class="status-badge">${escapeHtml(phaseCompletionSummary(phase))}</span>
            </div>
          </div>
          <div class="action-strip" style="margin-top: -4px;">
            ${!isCurrentPhase && String(phase?.status || '') !== 'done'
              ? `<button class="secondary-btn" onclick="setProjectPhase('${phase?.id || ''}', 'activate')">${escapeHtml(t('이 단계를 현재로', 'Make this the current phase'))}</button>`
              : ''}
            ${isCurrentPhase && String(phase?.status || '') !== 'done'
              ? `<button class="secondary-btn" onclick="setProjectPhase('${phase?.id || ''}', 'complete')">${escapeHtml(t('이 단계 완료', 'Complete this phase'))}</button>`
              : ''}
          </div>
          <div class="stats-grid" style="margin-bottom: 18px;">
            <div class="stat-card"><span class="label">${escapeHtml(t('실행 중', 'Running'))}</span><div class="value" style="color: var(--accent);">${escapeHtml(counts.running || 0)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('완료', 'Completed'))}</span><div class="value" style="color: var(--success);">${escapeHtml(counts.completed || 0)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('이어받을 작업', 'Carry-over'))}</span><div class="value">${escapeHtml(carryOverTasks.length)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('검토 대기', 'Pending review'))}</span><div class="value" style="color: var(--warning);">${escapeHtml(pendingReview.length)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('정리 작업', 'Cleanup'))}</span><div class="value" style="color: var(--warning);">${escapeHtml(cleanupLane.length)}</div></div>
            <div class="stat-card"><span class="label">${escapeHtml(t('열린 위험', 'Open risks'))}</span><div class="value" style="color: var(--danger);">${escapeHtml(openRisks.length)}</div></div>
          </div>
          <div class="card" style="margin: 0 0 18px;">
            <h3>${escapeHtml(t('단계 계약', 'Phase contract'))}</h3>
            ${phaseContract ? `
              <div class="grid-2">
                <div class="stack-list">
                  <div class="stack-item"><strong>${escapeHtml(t('목표', 'Goal'))}</strong><div>${escapeHtml(clip(phaseContract.goal || phase?.goal || '', 220) || t('목표 없음', 'No goal'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('이번 단계 산출물', 'Deliverables'))}</strong><div>${escapeHtml((phaseContract.deliverables || []).join(' | ') || t('없음', 'None'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('검증 기준', 'Verification'))}</strong><div>${escapeHtml((phaseContract.verification || []).join(' | ') || t('없음', 'None'))}</div></div>
                </div>
                <div class="stack-list">
                  <div class="stack-item"><strong>${escapeHtml(t('반드시 지킬 것', 'Non-negotiables'))}</strong><div>${escapeHtml((phaseContract.nonNegotiables || []).join(' | ') || t('없음', 'None'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('이번 범위 아님', 'Out of scope'))}</strong><div>${escapeHtml((phaseContract.outOfScope || []).join(' | ') || t('없음', 'None'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('다음으로 넘길 규칙', 'Carry-over rules'))}</strong><div>${escapeHtml((phaseContract.carryOverRules || []).join(' | ') || t('없음', 'None'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('계약 문서 경로', 'Contract path'))}</strong>${renderCopyableText(phaseContract.path || '', t('단계 계약 경로를 복사했습니다.', 'Copied phase contract path.'))}</div>
                </div>
              </div>
              <details class="advanced-settings" style="margin-top: 14px;">
                <summary>${escapeHtml(t('단계 계약 편집', 'Edit phase contract'))}</summary>
                <div class="advanced-body">
                  <div class="form-grid">
                    <div class="form-group full">
                      <label>${escapeHtml(t('단계 목표', 'Phase goal'))}</label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'phase-goal')}" placeholder="${escapeHtml(t('이 단계에서 실제로 끝내야 할 범위와 결과를 적으세요.', 'Describe the scope and result this phase must actually finish.'))}">${escapeHtml(phase?.goal || '')}</textarea>
                    </div>
                    <div class="form-group full">
                      <label>${escapeHtml(t('계약 목표', 'Contract goal'))}</label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'goal')}" placeholder="${escapeHtml(t('이 단계 계약이 지향하는 목표를 적으세요.', 'Describe what this phase contract is aiming for.'))}">${escapeHtml(phaseContract.goal || '')}</textarea>
                    </div>
                    <div class="form-group">
                      <label>${escapeHtml(t('이번 단계 산출물', 'Deliverables'))}
                        <span class="helper-text">${escapeHtml(t('한 줄에 하나씩', 'One per line'))}</span>
                      </label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'deliverables')}" placeholder="${escapeHtml(t('예: starter backlog 고정', 'Example: lock the starter backlog'))}">${escapeHtml((phaseContract.deliverables || []).join('\n'))}</textarea>
                    </div>
                    <div class="form-group">
                      <label>${escapeHtml(t('검증 기준', 'Verification'))}
                        <span class="helper-text">${escapeHtml(t('한 줄에 하나씩', 'One per line'))}</span>
                      </label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'verification')}" placeholder="${escapeHtml(t('예: npm run test', 'Example: npm run test'))}">${escapeHtml((phaseContract.verification || []).join('\n'))}</textarea>
                    </div>
                    <div class="form-group">
                      <label>${escapeHtml(t('반드시 지킬 것', 'Non-negotiables'))}
                        <span class="helper-text">${escapeHtml(t('한 줄에 하나씩', 'One per line'))}</span>
                      </label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'non-negotiables')}" placeholder="${escapeHtml(t('예: 단계 범위를 넘지 않는다', 'Example: do not go beyond the phase boundary'))}">${escapeHtml((phaseContract.nonNegotiables || []).join('\n'))}</textarea>
                    </div>
                    <div class="form-group">
                      <label>${escapeHtml(t('이번 범위 아님', 'Out of scope'))}
                        <span class="helper-text">${escapeHtml(t('한 줄에 하나씩', 'One per line'))}</span>
                      </label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'out-of-scope')}" placeholder="${escapeHtml(t('예: 다음 단계 기능', 'Example: features for the next phase'))}">${escapeHtml((phaseContract.outOfScope || []).join('\n'))}</textarea>
                    </div>
                    <div class="form-group full">
                      <label>${escapeHtml(t('다음으로 넘길 규칙', 'Carry-over rules'))}
                        <span class="helper-text">${escapeHtml(t('한 줄에 하나씩', 'One per line'))}</span>
                      </label>
                      <textarea id="${phaseContractFieldId(phase?.id || 'phase', 'carry-over-rules')}" placeholder="${escapeHtml(t('예: 미완료 태스크는 이 단계 약속과 함께 다음 작업으로 넘긴다', 'Example: unfinished tasks move to the next run with this phase contract'))}">${escapeHtml((phaseContract.carryOverRules || []).join('\n'))}</textarea>
                    </div>
                  </div>
                  <div class="action-strip" style="margin: 0;">
                    <button class="primary" onclick="saveProjectPhaseContract('${phase?.id || ''}')" ${isBusy(`save-phase-contract:${phase?.id || ''}`) ? 'disabled' : ''}>${escapeHtml(isBusy(`save-phase-contract:${phase?.id || ''}`) ? t('저장 중...', 'Saving...') : t('단계 계약 저장', 'Save phase contract'))}</button>
                  </div>
                </div>
              </details>
            ` : `<div class="stack-item">${escapeHtml(t('아직 단계 계약이 없습니다.', 'No phase contract yet.'))}</div>`}
          </div>
          <div class="grid-2">
            <div class="card" style="margin: 0;">
              <h3>${escapeHtml(t('이어받을 작업', 'Carry-over work'))}</h3>
                <div class="stack-list">
                  ${carryOverTasks.slice(0, 8).map((task) => `
                  <div class="stack-item interactive" onclick="selectRunTask('${task.runId || ''}', '${task.taskId || ''}')">
                    <strong>${escapeHtml(task.taskId)} ${escapeHtml(task.title || '')}</strong>
                    <div>${escapeHtml(task.runTitle || task.phaseTitle || '')} · ${escapeHtml(projectLaneLabel(task.lineageKind))}</div>
                    <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(task.summary || task.goal || '', 180) || t('요약 없음', 'No summary'))}</div>
                  </div>
                `).join('') || `<div class="stack-item">${escapeHtml(t('남은 태스크가 없습니다.', 'No remaining tasks.'))}</div>`}
              </div>
            </div>
            <div class="stack">
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('정리 작업 대기열', 'Cleanup queue'))}</h3>
                <div class="stack-list">
                  ${cleanupLane.map((entry) => `
                    <div class="stack-item warning-item">
                      <strong>${escapeHtml(entry.title || entry.id || 'cleanup')}</strong>
                      <div>${escapeHtml(projectLaneLabel('quality-cleanup'))} · ${escapeHtml(entry.category || '-')} · ${escapeHtml(entry.severity || '-')} · ${escapeHtml(entry.actionabilityLabel || '-')} · score ${escapeHtml(entry.severityScore || 0)}</div>
                      <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(entry.goal || entry.summary || '', 180) || t('요약 없음', 'No summary'))}</div>
                    </div>
                  `).join('') || `<div class="stack-item">${escapeHtml(t('대기 중인 후속 정리 작업이 없습니다.', 'No cleanup follow-ups waiting.'))}</div>`}
                </div>
              </div>
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('검토 대기', 'Pending review'))}</h3>
                <div class="stack-list">
                  ${pendingReview.map((entry) => `
                    <div class="stack-item interactive" onclick="selectRun('${entry.runId}')">
                      <strong>${escapeHtml(projectLaneLabel(entry.kind))}</strong>
                      <div>${escapeHtml(entry.runTitle || entry.title || entry.runId || '')}</div>
                      <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(entry.message || entry.title || '', 180) || t('요약 없음', 'No summary'))}</div>
                    </div>
                  `).join('') || `<div class="stack-item">${escapeHtml(t('대기 중인 검토가 없습니다.', 'No pending reviews.'))}</div>`}
                </div>
              </div>
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('열린 위험', 'Open risks'))}</h3>
                <div class="stack-list">
                  ${openRisks.slice(0, 6).map((risk) => `
                    <div class="stack-item warning-item">
                      <strong>${escapeHtml(risk.taskId || risk.kind || 'risk')}</strong>
                      <div>${escapeHtml(risk.message || t('요약 없음', 'No summary'))}</div>
                    </div>
                  `).join('') || `<div class="stack-item">${escapeHtml(t('열린 위험이 없습니다.', 'No open risks.'))}</div>`}
                </div>
              </div>
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('최근 작업', 'Recent runs'))}</h3>
                <div class="stack-list">
                  ${recentRuns.map((run) => `
                    <div class="stack-item interactive" onclick="selectRun('${run.id}')">
                      <strong>${escapeHtml(run.title || run.id)}</strong>
                      <div>${escapeHtml(statusLabel(run.status || 'ready'))} · ${escapeHtml(formatTimestamp(run.updatedAt))}</div>
                    </div>
                  `).join('') || `<div class="stack-item">${escapeHtml(t('최근 작업이 없습니다.', 'No recent runs.'))}</div>`}
                </div>
              </div>
              <div class="card" style="margin: 0;">
                <h3>${escapeHtml(t('최근 정리 점검', 'Latest quality sweep'))}</h3>
                <div class="stack-list">
                  ${latestQualitySweep ? `
                    <div class="stack-item">
                      <strong>${escapeHtml(latestQualitySweep.grade || 'unknown')}</strong>
                      <div>${escapeHtml(formatTimestamp(latestQualitySweep.createdAt))}</div>
                      <div style="margin-top: 6px; color: var(--muted);">${escapeHtml((latestQualitySweep.categories || []).join(', ') || t('분류 없음', 'No category'))}</div>
                      <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(`finding ${latestQualitySweep.findingCount || 0} · max score ${latestQualitySweep.highestSeverityScore || 0}`)}</div>
                    </div>
                  ` : `<div class="stack-item">${escapeHtml(t('아직 정리 점검 기록이 없습니다.', 'No quality sweep record yet.'))}</div>`}
                </div>
              </div>
            </div>
          </div>
          <div class="card" style="margin-top: 18px;">
            <h3>${escapeHtml(t('이어온 작업 기록', 'Carry-over history'))}</h3>
            <div class="stack-list">
              ${backlogLineage.map((entry) => `
                <div class="stack-item interactive" onclick="selectRunTask('${entry.runId || ''}', '${entry.taskId || ''}')">
                  <strong>${escapeHtml(entry.taskId)} ${escapeHtml(entry.title || '')}</strong>
                  <div>${escapeHtml(projectLaneLabel(entry.kind))} · ${escapeHtml(entry.runTitle || entry.phaseTitle || '')}</div>
                  <div style="margin-top: 6px; color: var(--muted);">${escapeHtml(clip(entry.summary || entry.checkpointNotes?.[0] || '', 220) || t('이어온 기록이 없습니다.', 'No carry-over record.'))}</div>
                </div>
              `).join('') || `<div class="stack-item">${escapeHtml(t('아직 이어온 작업 기록이 없습니다.', 'No carry-over history yet.'))}</div>`}
            </div>
          </div>
        </div>
      `;
    }

    function renderProjectDetail(projectOverview) {
      const project = projectOverview?.project || null;
      const phases = Array.isArray(projectOverview?.phases) ? projectOverview.phases : [];
      const totalCarryOver = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.carryOverTasks) ? phase.carryOverTasks.length : 0), 0);
      const totalPendingReview = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.pendingReview) ? phase.pendingReview.length : 0), 0);
      const totalCleanup = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.cleanupLane) ? phase.cleanupLane.length : 0), 0);
      const totalRisks = phases.reduce((sum, phase) => sum + (Array.isArray(phase?.openRisks) ? phase.openRisks.length : 0), 0);
      const totalRuns = phases.reduce((sum, phase) => {
        const counts = phase?.runCounts || {};
        return sum + Object.values(counts).reduce((bucketSum, value) => bucketSum + Number(value || 0), 0);
      }, 0);
      const defaultSettings = project?.defaultSettings || {};
      const toolProfile = defaultSettings.toolProfile || null;
      const browserVerification = defaultSettings.browserVerification || null;
      const devServer = defaultSettings.devServer || null;
      const providerProfile = defaultSettings.providerProfile || null;
      const bootstrap = project?.bootstrap || null;
      const runtimeBrowser = project?.runtimeReadiness?.browser || null;
      const retention = project?.retention || null;
      const health = project?.healthDashboard || null;
      const nextAction = deriveProjectOperatorAction(projectOverview);
      const decisionQueue = deriveProjectDecisionQueue(projectOverview);
      const bulkActions = deriveProjectBulkActions(projectOverview);
      const toolActionClasses = Array.isArray(toolProfile?.allowedActionClasses) ? toolProfile.allowedActionClasses : [];
      const currentPhase = resolveProjectDisplayPhase(phases, project?.currentPhaseId);
      const providerSummary = t(
        `${providerLabel(providerProfile?.coordinationProvider || 'codex')}가 계획/검토 · ${providerLabel(providerProfile?.workerProvider || 'codex')}가 구현`,
        `${providerLabel(providerProfile?.coordinationProvider || 'codex')} handles planning/review · ${providerLabel(providerProfile?.workerProvider || 'codex')} handles implementation`
      );
      const providerSummaryNote = providerProfile
        ? t('이 프로젝트에서 고정한 담당 AI 조합이 새 run 기본값으로 들어갑니다.', 'This project-level AI pairing becomes the default for new runs.')
        : t('프로젝트에 따로 정한 담당 AI가 없으면 이 PC의 기본값을 그대로 따릅니다.', 'If the project does not override providers, it inherits this machine’s defaults.');
      const continuationPolicy = defaultSettings.continuationPolicy || {};
      const continuationMode = continuationModeLabel(continuationPolicy.mode);
      const docsSyncLabel = docsSyncChoiceLabel(continuationPolicy.keepDocsInSync === false ? '선택' : '권장');
      const autoSweepLabel = autoSweepChoiceLabel(continuationPolicy.autoQualitySweepOnPhaseComplete === true ? '자동' : '수동');
      const autoChainLabel = autoChainChoiceLabel(continuationPolicy.autoChainOnComplete === true);
      const maxChainDepth = normalizeMaxChainDepth(continuationPolicy.maxChainDepth);
      const defaultRunLoop = continuationPolicy.runLoop || {};
      const autoProgress = defaultSettings.autoProgress || {};
      const supervisorStatus = project?.supervisorStatus || null;
      const supervisorActive = supervisorStatus?.active === true;
      const nextScheduledLabel = supervisorStatus?.runtime?.nextScheduledAt || supervisorStatus?.nextScheduledAt || '';
      const nextScheduledCountdown = formatCountdown(nextScheduledLabel);
      const supervisorPausedReason = String(supervisorStatus?.runtime?.pausedReason || '').trim();
      return `
        <div class="hero-card">
          <h3>${escapeHtml(t('프로젝트 운영 현황', 'Project operations'))}</h3>
          <div class="next-action">${escapeHtml(project?.title || (getSelectedProjectId ? getSelectedProjectId() : '') || t('프로젝트', 'Project'))}</div>
          <div class="hero-detail">${escapeHtml(project?.charterText || project?.rootPath || t('프로젝트 헌장 또는 root path가 없습니다.', 'No project charter or root path yet.'))}</div>
        </div>
        <div class="action-strip">
          <button class="secondary-btn" onclick="openSuggestedProjectRun()">${escapeHtml(t('권장 다음 작업 초안', 'Suggested next run draft'))}</button>
          <button class="primary" onclick="openCreateModal()">${escapeHtml(t('이 프로젝트로 새 작업 만들기', 'Create a new run in this project'))}</button>
          <button class="secondary-btn" onclick="reintakeProjectUi()" ${isBusy('project-reintake') ? 'disabled' : ''}>${escapeHtml(isBusy('project-reintake') ? t('재분석 중...', 'Re-analyzing...') : t('재분석 후 첫 작업 초안', 'Re-analyze and open draft'))}</button>
          <button class="secondary-btn" onclick="qualitySweepProject()" ${isBusy('quality-sweep') ? 'disabled' : ''}>${escapeHtml(isBusy('quality-sweep') ? t('정리 점검 실행 중...', 'Running quality sweep...') : t('정리 점검 실행', 'Run quality sweep'))}</button>
          ${supervisorStatus?.enabled ? `<button class="${supervisorActive ? 'secondary-btn' : 'primary'}" onclick="toggleProjectSupervisor()" ${isBusy('supervisor-toggle') ? 'disabled' : ''}>${escapeHtml(isBusy('supervisor-toggle') ? t('처리 중...', 'Working...') : supervisorActive ? t('Supervisor 중지', 'Stop supervisor') : t('Supervisor 시작', 'Start supervisor'))}</button>` : ''}
          ${supervisorStatus?.enabled ? `<button class="secondary-btn" onclick="runSupervisorNow()" ${isBusy('supervisor-run-now') ? 'disabled' : ''}>${escapeHtml(isBusy('supervisor-run-now') ? t('실행 중...', 'Running...') : t('지금 실행', 'Run now'))}</button>` : ''}
          <button class="danger" onclick="deleteProjectUi()" ${isBusy('delete-project') ? 'disabled' : ''}>${escapeHtml(isBusy('delete-project') ? t('삭제 중...', 'Deleting...') : t('프로젝트 삭제', 'Delete project'))}</button>
        </div>
        ${supervisorStatus?.enabled ? `
        <div class="card" style="margin-bottom: 14px; padding: 10px 14px; background: var(--surface-2, #f5f5f5);">
          <span style="font-weight:600;">${escapeHtml(t('Supervisor', 'Supervisor'))}</span>
          <span class="status-badge ${supervisorActive ? 'running' : 'stopped'}" style="margin-left:8px;">${escapeHtml(supervisorActive ? t('실행 중', 'Running') : t('중지됨', 'Stopped'))}</span>
          ${supervisorStatus.scheduleEnabled && supervisorStatus.scheduleCron ? `<span style="margin-left:8px; color:var(--muted); font-size:12px;">${escapeHtml(supervisorStatus.scheduleCron)}</span>` : ''}
          ${nextScheduledLabel ? `<div style="margin-top:4px; font-size:12px; color:var(--muted);">${escapeHtml(t('다음 실행', 'Next run'))}: ${escapeHtml(formatTimestamp(nextScheduledLabel))}${nextScheduledCountdown ? ` · ${escapeHtml(nextScheduledCountdown)}` : ''}</div>` : ''}
          ${supervisorPausedReason ? `
            <div style="margin-top:8px; padding:10px 12px; border-radius:10px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.16); color:var(--danger, #b91c1c);">
              <strong>${escapeHtml(t('Supervisor 정지 사유', 'Supervisor stop reason'))}</strong>
              <div style="margin-top:4px; font-size:12px;">${escapeHtml(supervisorPausedReason)}</div>
            </div>
          ` : ''}
          ${supervisorStatus.runtime?.lastAction ? `<div style="margin-top:4px; font-size:12px; color:var(--muted);">${escapeHtml(t('마지막 동작', 'Last action'))}: ${escapeHtml(supervisorStatus.runtime.lastAction)} ${supervisorStatus.runtime.lastActionAt ? `· ${escapeHtml(supervisorStatus.runtime.lastActionAt)}` : ''}</div>` : ''}
          ${supervisorStatus.runtime?.lastRunId ? `<div style="font-size:12px; color:var(--muted);">${escapeHtml(t('마지막 run', 'Last run'))}: <span style="cursor:pointer; text-decoration:underline;" onclick="selectRun('${escapeHtml(supervisorStatus.runtime.lastRunId)}')">${escapeHtml(supervisorStatus.runtime.lastRunId)}</span></div>` : ''}
          ${supervisorStatus.runtime?.lastError ? `<div style="font-size:12px; color:var(--danger, red);">${escapeHtml(t('오류', 'Error'))}: ${escapeHtml(supervisorStatus.runtime.lastError)}</div>` : ''}
          ${Array.isArray(supervisorStatus.runtime?.history) && supervisorStatus.runtime.history.length ? `<div style="margin-top:6px; font-size:12px; color:var(--muted);">${escapeHtml(t('최근 자동화 기록', 'Recent automation history'))}: ${escapeHtml(supervisorStatus.runtime.history.map((item) => `${item.kind} ${item.detail}`).join(' | '))}</div>` : ''}
        </div>` : ''}
        ${renderProjectLoopPanel(currentPhase)}
        <div class="overview-grid">
          <div class="focus-card">
            <span class="eyebrow">${escapeHtml(t('다음 우선 조치', 'Next best move'))}</span>
            <h4>${escapeHtml(nextAction.title)}</h4>
            <p>${escapeHtml(nextAction.detail)}</p>
            ${nextAction.action ? `<button class="secondary-btn" style="margin-top:14px;" onclick="${nextAction.action}">${escapeHtml(nextAction.actionLabel || t('열기', 'Open'))}</button>` : ''}
          </div>
          <div class="focus-card ${escapeHtml(health?.status === 'attention' ? 'danger' : (health?.status === 'watch' ? 'warning' : 'safe'))}">
            <span class="eyebrow">${escapeHtml(t('운영 건강도', 'Project health'))}</span>
            <h4>${escapeHtml(projectHealthStatusLabel(health?.statusLabel || ''))}</h4>
            <p>${escapeHtml(projectHealthText(health?.reminder?.detail || '') || t('지금은 권장 다음 작업 초안으로 이어가면 됩니다.', 'You can continue with the suggested next run draft now.'))}</p>
          </div>
          <div class="focus-card">
            <span class="eyebrow">${escapeHtml(t('현재 단계', 'Current phase'))}</span>
            <h4>${escapeHtml(currentPhase?.title || t('활성 단계 없음', 'No active phase'))}</h4>
            <p>${escapeHtml(project?.status === 'completed' ? t('현재는 완료 상태이며 새 단계 추가 또는 재분석으로 재개할 수 있습니다.', 'This project is completed. Add a phase or re-analyze to resume.') : (project?.rootPath || t('root path 없음', 'No root path')))}</p>
          </div>
          <div class="focus-card ${Array.isArray(project?.codeIntelligence?.criticalSymbols) && project.codeIntelligence.criticalSymbols.length ? 'danger' : 'safe'}">
            <span class="eyebrow">${escapeHtml(t('코드 인텔리전스', 'Code intelligence'))}</span>
            <h4>${escapeHtml(String(project?.codeIntelligence?.criticalSymbols?.length || 0))} / ${escapeHtml(String(project?.codeIntelligence?.topFiles?.length || 0))}</h4>
            <p>${escapeHtml((Array.isArray(project?.codeIntelligence?.criticalSymbols) && project.codeIntelligence.criticalSymbols.length)
              ? t('critical-risk 심볼과 고영향 파일이 감지됐습니다. 다음 run 전 scope boundary를 먼저 확인하세요.', 'Critical-risk symbols and high-impact files were detected. Confirm the scope boundary before the next run.')
              : t('현재 critical-risk 심볼은 크지 않습니다.', 'There are no major critical-risk symbols right now.'))}</p>
          </div>
          <div class="focus-card ${totalRisks ? 'danger' : 'safe'}">
            <span class="eyebrow">${escapeHtml(t('운영 리스크', 'Operational risk'))}</span>
            <h4>${escapeHtml(totalRisks)}</h4>
            <p>${escapeHtml(totalRisks ? t('열린 위험과 이어받을 작업을 먼저 정리해야 합니다.', 'Clear the open risks and carry-over items first.') : t('현재 큰 리스크 없이 단계를 진행할 수 있습니다.', 'You can continue this phase without major risk right now.'))}</p>
          </div>
          <div class="focus-card compact">
            <span class="eyebrow">${escapeHtml(t('검토 / 이월 / 정리', 'Review / carry-over / cleanup'))}</span>
            <h4>${escapeHtml(String(totalPendingReview || 0))} / ${escapeHtml(String(totalCarryOver || 0))} / ${escapeHtml(String(totalCleanup || 0))}</h4>
            <p>${escapeHtml(t(`검토 대기 ${String(totalPendingReview || 0)}개, 이어받을 작업 ${String(totalCarryOver || 0)}개, 정리 작업 ${String(totalCleanup || 0)}개, 최근 작업 ${String(totalRuns || 0)}개를 집계했습니다.`, `${String(totalPendingReview || 0)} pending reviews, ${String(totalCarryOver || 0)} carry-over items, ${String(totalCleanup || 0)} cleanup items, ${String(totalRuns || 0)} recent runs.`))}</p>
          </div>
        </div>
        <div class="priority-rail">
          <div class="priority-pill ${totalRisks ? 'danger' : 'safe'}">
            <strong>${escapeHtml(t('즉시 확인', 'Check now'))}</strong>
            <span>${escapeHtml(String(totalRisks + totalPendingReview + totalCarryOver))}</span>
            <small>${escapeHtml(totalRisks ? t('위험, 검토 대기, 이어받을 작업을 먼저 해소해야 합니다.', 'Clear risks, pending reviews, and carry-over work first.') : t('즉시 위험은 낮고 다음 실행으로 이어갈 수 있습니다.', 'Immediate risk is low and you can move to the next run.'))}</small>
          </div>
          <div class="priority-pill ${totalPendingReview ? 'warning' : 'safe'}">
            <strong>${escapeHtml(t('검토 대기', 'Pending review'))}</strong>
            <span>${escapeHtml(String(totalPendingReview || 0))}</span>
            <small>${escapeHtml(t('사람 확인이 필요한 검토 또는 승인 대기 작업 수', 'Runs waiting for human review or approval'))}</small>
          </div>
          <div class="priority-pill ${totalCarryOver ? 'danger' : 'safe'}">
            <strong>${escapeHtml(t('이어받을 작업', 'Carry-over work'))}</strong>
            <span>${escapeHtml(String(totalCarryOver || 0))}</span>
            <small>${escapeHtml(t('실패/정지 이후 다시 이어받아야 할 태스크 수', 'Tasks that need continuation after failure or stop'))}</small>
          </div>
          <div class="priority-pill ${totalCleanup ? 'warning' : 'safe'}">
            <strong>${escapeHtml(t('정리 작업', 'Cleanup items'))}</strong>
            <span>${escapeHtml(String(totalCleanup || 0))}</span>
            <small>${escapeHtml(t('정리 점검 뒤 남아 있는 후속 정리 작업 수', 'Cleanup follow-ups left after quality sweeps'))}</small>
          </div>
        </div>
        ${health ? `
          <div class="card" style="margin-bottom: 18px;">
            <div class="section-head" style="margin-bottom: 14px;">
              <div>
                <span class="eyebrow">${escapeHtml(t('운영 대시보드', 'Operations dashboard'))}</span>
                <h3>${escapeHtml(t('장기 운영 체크', 'Long-running checks'))}</h3>
              </div>
              <p>${escapeHtml(t('반복 실행 프로젝트에서 다음 run 연결, 문서 drift, 반복 실패, 런타임 신호를 한 번에 봅니다.', 'See next-run continuity, docs drift, repeated failures, and runtime signals in one place.'))}</p>
            </div>
            <div class="overview-grid">
              <div class="focus-card ${escapeHtml(health.successor?.ready ? 'safe' : 'warning')}">
                <span class="eyebrow">${escapeHtml(t('다음 run 연결', 'Next run continuity'))}</span>
                <h4>${escapeHtml(projectHealthText(health.successor?.title || '') || t('정보 없음', 'No data'))}</h4>
                <p>${escapeHtml(projectHealthText(health.successor?.detail || '') || t('다음 run 연결 정보가 아직 없습니다.', 'No continuity signal for the next run yet.'))}</p>
                ${health.successor?.ready ? `<button class="secondary-btn" style="margin-top:14px;" onclick="openSuggestedProjectRun()">${escapeHtml(t('권장 다음 작업 초안 열기', 'Open suggested next run draft'))}</button>` : ''}
              </div>
              <div class="focus-card ${escapeHtml(health.docsDrift?.level === 'high' ? 'danger' : (health.docsDrift?.level === 'medium' ? 'warning' : 'safe'))}">
                <span class="eyebrow">${escapeHtml(t('문서 drift', 'Docs drift'))}</span>
                <h4>${escapeHtml(health.docsDrift?.level === 'high' ? t('점검 필요', 'Needs review') : (health.docsDrift?.level === 'medium' ? t('주의', 'Watch') : t('안정', 'Stable')))}</h4>
                <p>${escapeHtml(projectHealthText(health.docsDrift?.summary || '') || t('문서 drift 정보 없음', 'No docs drift signal'))}</p>
                ${health.docsDrift?.reintakeRecommended ? `<button class="secondary-btn" style="margin-top:14px;" onclick="reintakeProjectUi()">${escapeHtml(t('재분석 후 첫 작업 초안', 'Re-analyze and open draft'))}</button>` : ''}
              </div>
              <div class="focus-card ${escapeHtml(health.repeatedFailures?.warning ? 'danger' : 'safe')}">
                <span class="eyebrow">${escapeHtml(t('반복 실패', 'Repeated failures'))}</span>
                <h4>${escapeHtml(health.repeatedFailures?.warning ? t('패턴 있음', 'Pattern detected') : t('특이 패턴 없음', 'No major pattern'))}</h4>
                <p>${escapeHtml(projectHealthText(health.repeatedFailures?.summary || '') || t('반복 실패 정보 없음', 'No repeated failure data'))}</p>
                ${(Number(health.repeatedFailures?.consecutiveFailedRuns || 0) > 0 || supervisorStatus?.maxConsecutiveFailures) ? `<div style="margin-top:6px; color:var(--muted); font-size:12px;">${escapeHtml(t('연속 실패', 'Consecutive failed runs'))}: ${escapeHtml(String(health.repeatedFailures?.consecutiveFailedRuns || 0))} / ${escapeHtml(String(supervisorStatus?.maxConsecutiveFailures || 0))}</div>` : ''}
              </div>
              <div class="focus-card ${escapeHtml(health.runtimeObservability?.warning ? 'warning' : 'safe')}">
                <span class="eyebrow">${escapeHtml(t('런타임 관측', 'Runtime observability'))}</span>
                <h4>${escapeHtml(browserPolicyLabel(health.runtimeObservability?.browserPolicyLabel || ''))}</h4>
                <p>${escapeHtml(runtimeHeadline(health.runtimeObservability?.headline || ''))}</p>
              </div>
              <div class="focus-card ${escapeHtml(health.automationScorecard?.status === 'attention' ? 'danger' : (health.automationScorecard?.status === 'watch' ? 'warning' : 'safe'))}">
                <span class="eyebrow">${escapeHtml(t('자동화 burn-in / SLO', 'Automation burn-in / SLO'))}</span>
                <h4>${escapeHtml(String(health.automationScorecard?.score || 0))} / 100</h4>
                <p>${escapeHtml(projectHealthText(health.automationScorecard?.summary || '') || t('자동화 scorecard 정보 없음', 'No automation scorecard yet.'))}</p>
                <div style="margin-top:6px; color:var(--muted); font-size:12px;">
                  ${escapeHtml(t('성공률', 'Success'))}: ${escapeHtml(String(Math.round(Number(health.automationScorecard?.successRate || 0) * 100)))}%
                  · ${escapeHtml(t('복구율', 'Recovery'))}: ${escapeHtml(String(Math.round(Number(health.automationScorecard?.recoveryRate || 0) * 100)))}%
                  · ${escapeHtml(t('증거 run', 'Proof runs'))}: ${escapeHtml(String(health.automationScorecard?.terminalRuns || 0))}
                </div>
              </div>
              <div class="focus-card ${escapeHtml((health.codeIntelligence?.criticalSymbols || []).length ? 'danger' : 'safe')}">
                <span class="eyebrow">${escapeHtml(t('전역 심볼 영향도', 'Global symbol impact'))}</span>
                <h4>${escapeHtml(String(health.codeIntelligence?.indexedFileCount || 0))}${health.codeIntelligence?.truncated ? '+' : ''}</h4>
                <p>${escapeHtml((health.codeIntelligence?.criticalSymbols || []).length
                  ? (`CRITICAL-RISK >= ${Number(health.codeIntelligence?.thresholds?.criticalRisk || 15).toFixed(1)} · ` + health.codeIntelligence.criticalSymbols.map((item) => `${item.symbol} (${Number(item.riskScore || 0).toFixed(1)})`).join(' | '))
                  : t('critical-risk 심볼 없음', 'No critical-risk symbols'))}</p>
              </div>
            </div>
            <div class="stack-list" style="margin-top: 14px;">
              <div class="stack-item"><strong>${escapeHtml(t('운영 리마인더', 'Reminder'))}</strong><div>${escapeHtml(projectHealthText(health.reminder?.title || '') || t('현재 cadence 양호', 'Cadence looks healthy'))} · ${escapeHtml(projectHealthText(health.reminder?.detail || ''))}</div></div>
              <div class="stack-item"><strong>${escapeHtml(t('자동화 운영 점수', 'Automation operating score'))}</strong><div>${escapeHtml(`${String(health.automationScorecard?.score || 0)}/100 · ${String(health.automationScorecard?.statusLabel || t('정보 없음', 'No data'))}`)} · ${escapeHtml(projectHealthText(health.automationScorecard?.recommendedAction || '') || t('추가 조치 없음', 'No extra action'))}</div></div>
              <div class="stack-item"><strong>${escapeHtml(t('문서 기준 운영', 'Docs-first flow'))}</strong><div>${escapeHtml(projectHealthText(health.docsFlow?.label || '') || t('정보 없음', 'No data'))} · ${escapeHtml(projectHealthText(health.docsFlow?.detail || ''))}</div></div>
              <div class="stack-item"><strong>${escapeHtml(t('문서 drift 대응', 'Docs drift response'))}</strong><div>${escapeHtml(projectHealthText(health.docsDrift?.recommendedAction || '') || t('추가 조치 없음', 'No extra action'))}</div></div>
              <div class="stack-item"><strong>${escapeHtml(t('런타임 하이라이트', 'Runtime highlights'))}</strong><div>${escapeHtml((health.runtimeObservability?.highlights || []).map((item) => projectHealthText(item)).join(' | ') || projectHealthText(health.runtimeObservability?.detail || '') || t('최근 경고 없음', 'No recent warnings'))}</div></div>
              <div class="stack-item"><strong>${escapeHtml(t('고영향 파일', 'High-impact files'))}</strong><div>${escapeHtml((health.codeIntelligence?.topFiles || []).map((item) => `${item.path} (importedBy ${item.importedByCount || 0}, calledBy ${item.calledByCount || 0})`).join(' | ') || t('정보 없음', 'No data'))}</div></div>
            </div>
          </div>
        ` : ''}
        <details class="advanced-settings" style="margin-bottom: 18px;">
          <summary>${escapeHtml(t('자세한 운영 정보와 기록 보기', 'Show detailed operations and history'))}</summary>
          <div class="advanced-body">
            <div class="project-summary-grid">
              <div class="summary-panel">
                <h4>${escapeHtml(t('기본 실행 설정', 'Default execution settings'))}</h4>
                <div class="stack-list">
                  <div class="stack-item"><strong>${escapeHtml(t('기본 작업 방식', 'Default work style'))}</strong><div>${escapeHtml(describePreset(project?.defaultPresetId || 'auto'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('기본 담당 AI', 'Default AI pairing'))}</strong><div>${escapeHtml(providerSummary)}</div><div style="color: var(--muted); margin-top: 4px;">${escapeHtml(providerSummaryNote)}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('연속 작업 운영', 'Continuation mode'))}</strong><div>${escapeHtml(continuationMode)}</div><div style="color: var(--muted); margin-top: 4px;">${escapeHtml(t('문서 동기화', 'Docs sync'))} ${escapeHtml(docsSyncLabel)} · ${escapeHtml(t('단계 완료 시 정리 점검', 'Phase-close quality sweep'))} ${escapeHtml(autoSweepLabel)} · ${escapeHtml(t('자동 체이닝', 'Auto-chain after run'))} ${escapeHtml(autoChainLabel)} · ${escapeHtml(t('최대 연쇄 수', 'Max chain depth'))} ${escapeHtml(String(maxChainDepth))}${defaultRunLoop?.enabled ? ` · ${escapeHtml(t('기본 루프', 'Default loop'))} ${escapeHtml(defaultRunLoop.mode === 'until-goal' ? t('목표 달성까지', 'Until goal') : t('정해진 횟수', 'Repeat count'))} ${escapeHtml(String(defaultRunLoop.maxRuns || 1))}` : ''}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('기본 도구 프로필', 'Default tool profile'))}</strong><div>${escapeHtml(toolProfile?.label || toolProfile?.id || 'default')}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('단계 수', 'Phase count'))}</strong><div>${escapeHtml(String(phases.length || 0))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('프로젝트 상태', 'Project status'))}</strong><div>${escapeHtml(project?.status === 'completed' ? t('완료됨', 'Completed') : t('운영 중', 'Active'))}</div></div>
                </div>
              </div>
              <div class="summary-panel">
                <h4>${escapeHtml(t('검증 / 런타임 연결', 'Verification / runtime links'))}</h4>
                <div class="stack-list">
                    <div class="stack-item"><strong>${escapeHtml(t('브라우저 확인 기본 정책', 'Browser policy'))}</strong><div>${escapeHtml(browserPolicyLabel(runtimeBrowser?.policyLabel || ''))}</div><div style="color: var(--muted); margin-top: 4px;">${escapeHtml(browserPolicyNote(runtimeBrowser?.policyNote || ''))}</div></div>
                    <div class="stack-item"><strong>${escapeHtml(t('브라우저 검증', 'Browser verification'))}</strong><div>${escapeHtml(browserReadinessLabel(browserVerification, runtimeBrowser))}</div><div style="color: var(--muted); margin-top: 4px;">${escapeHtml(browserReadinessDetail(runtimeBrowser, browserVerification))}</div></div>
                    <div class="stack-item"><strong>${escapeHtml(t('개발 서버', 'Dev server'))}</strong><div>${escapeHtml(devServer?.command || t('미설정', 'Not set'))}</div></div>
                    <div class="stack-item"><strong>${escapeHtml(t('기본 문서 부팅', 'Starter docs bootstrap'))}</strong><div>${escapeHtml(bootstrap?.enabled ? t(`사용 중 · 생성 ${bootstrap.generated?.length || 0}`, `Enabled · generated ${bootstrap.generated?.length || 0}`) : t('사용 안 함', 'Disabled'))}</div></div>
                  </div>
              </div>
              <div class="summary-panel">
                <h4>${escapeHtml(t('기록 보존 / 정리', 'Retention / cleanup'))}</h4>
                <div class="stack-list">
                  <div class="stack-item"><strong>${escapeHtml(t('보존 정책', 'Retention policy'))}</strong><div>${escapeHtml(retention?.policy || 'preview-only')}</div><div style="color: var(--muted); margin-top: 4px;">${escapeHtml(retention?.note || t('기록 정리는 실제 삭제보다 미리보기와 문맥 관리 계층에서 먼저 다룹니다.', 'Retention is handled as preview and context management first, before destructive cleanup.'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('작업 보존 현황', 'Run retention'))}</strong><div>${escapeHtml(t(`전체 ${retention?.runCounts?.total || 0} · active ${retention?.runCounts?.active || 0} · 완료 ${retention?.runCounts?.completed || 0} · stop/fail ${retention?.runCounts?.stoppedOrFailed || 0}`, `total ${retention?.runCounts?.total || 0} · active ${retention?.runCounts?.active || 0} · completed ${retention?.runCounts?.completed || 0} · stop/fail ${retention?.runCounts?.stoppedOrFailed || 0}`))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('공유 메모리', 'Shared memory'))}</strong><div>${escapeHtml(retention?.sharedMemoryExists ? t(`${retention?.sharedMemoryKey || '-'} · 파일 ${retention?.sharedMemoryFileCount || 0}`, `${retention?.sharedMemoryKey || '-'} · files ${retention?.sharedMemoryFileCount || 0}`) : t('없음', 'None'))}</div></div>
                  <div class="stack-item"><strong>${escapeHtml(t('정리 기록', 'Cleanup history'))}</strong><div>${escapeHtml(t(`정리 점검 ${retention?.qualitySweepCount || 0} · 후속 정리 작업 ${retention?.cleanupTaskCount || 0}`, `quality sweeps ${retention?.qualitySweepCount || 0} · cleanup tasks ${retention?.cleanupTaskCount || 0}`))}</div></div>
                </div>
              </div>
            </div>
            <div class="card" style="margin-bottom: 18px;">
              <div class="section-head" style="margin-bottom: 14px;">
                <div>
                  <span class="eyebrow">${escapeHtml(t('일괄 조치', 'Bulk actions'))}</span>
                  <h3>${escapeHtml(t('일괄 조치 바로가기', 'Bulk action shortcuts'))}</h3>
                </div>
                <p>${escapeHtml(t('가장 시간을 많이 쓰는 검토 대기, 이어받을 작업, 정리 후보로 바로 들어갑니다.', 'Jump straight into pending review, carry-over work, and cleanup candidates.'))}</p>
              </div>
              <div class="queue-matrix">
                ${bulkActions.map((item) => `
                  <div class="queue-action ${escapeHtml(item.tone || 'safe')}">
                    <div>
                      <strong>${escapeHtml(item.title || 'action')}</strong>
                      <p>${escapeHtml(item.detail || '')}</p>
                    </div>
                    <button class="secondary-btn" onclick="${item.action}">${escapeHtml(item.actionLabel || t('열기', 'Open'))}</button>
                  </div>
                `).join('')}
              </div>
            </div>
            <div class="card" style="margin-bottom: 0;">
              <div class="section-head" style="margin-bottom: 14px;">
                <div>
                  <span class="eyebrow">${escapeHtml(t('재시작 흐름', 'Re-entry flow'))}</span>
                  <h3>${escapeHtml(t('다음 단계 / 재진입', 'Next phase / re-entry'))}</h3>
                </div>
                <p>${escapeHtml(project?.status === 'completed'
                  ? t('완료된 프로젝트는 새 단계를 추가하거나 재분석 첫 작업으로 다시 열 수 있습니다.', 'A completed project can resume by adding a phase or reopening with a re-analysis draft.')
                  : t('현재 단계와 별개로 다음 단계 후보를 미리 추가하거나 바로 현재 단계로 전환할 수 있습니다.', 'You can queue the next phase in advance or switch into it right away.'))}</p>
              </div>
              <div class="form-grid">
                <div class="form-group">
                  <label>${escapeHtml(t('새 단계 이름', 'New phase name'))}</label>
                  <input id="project-new-phase-title" placeholder="${escapeHtml(t('예: 단계 2 · Retrieval Hardening', 'Example: Phase 2 · Retrieval hardening'))}">
                </div>
                <div class="form-group full">
                  <label>${escapeHtml(t('새 단계 목표', 'New phase goal'))}</label>
                  <textarea id="project-new-phase-goal" placeholder="${escapeHtml(t('예: retrieval miss를 줄이고 검증 기준을 다시 고정한다.', 'Example: reduce retrieval misses and lock the verification bar again.'))}"></textarea>
                </div>
              </div>
              <div class="action-strip" style="margin: 0;">
                <button class="secondary-btn" onclick="addProjectPhase(false)" ${isBusy('add-project-phase') ? 'disabled' : ''}>${escapeHtml(isBusy('add-project-phase') ? t('추가 중...', 'Adding...') : t('다음 단계 후보로 추가', 'Add as next phase candidate'))}</button>
                <button class="primary" onclick="addProjectPhase(true)" ${isBusy('add-project-phase-active') ? 'disabled' : ''}>${escapeHtml(isBusy('add-project-phase-active') ? t('전환 중...', 'Switching...') : (currentPhase ? t('추가 후 지금 단계로 전환', 'Add and switch now') : t('추가 후 바로 시작', 'Add and start now')))}</button>
              </div>
            </div>
          </div>
        </details>
        <details class="advanced-settings" style="margin-bottom: 18px;">
          <summary>${escapeHtml(t('프로젝트 기본값 편집', 'Edit project defaults'))}</summary>
          <div class="advanced-body">
            <div class="form-note" style="margin-bottom: 16px;">
              ${escapeHtml(t('대부분은 프로젝트 헌장, 기본 작업 방식, 기본 계획/검토 담당, 기본 구현 담당만 맞추면 충분합니다. 아래의 도구 제한, 브라우저, 개발 서버 항목은 필요한 경우에만 건드리세요.', 'Most teams only need the charter, default work style, default planning/review provider, and default implementation provider. Leave tool limits, browser, and dev server settings alone unless you really need them.'))}
            </div>
            <div class="form-grid">
              <div class="form-group full">
                <label>${escapeHtml(t('프로젝트 헌장 / 운영 메모', 'Project charter / operating notes'))}</label>
                <textarea id="project-settings-charter" placeholder="${escapeHtml(t('이 프로젝트가 지켜야 할 운영 원칙', 'Rules this project should keep'))}">${escapeHtml(project?.charterText || '')}</textarea>
                <div class="helper-text">${escapeHtml(t('이 프로젝트에서 계속 지키고 싶은 한두 줄만 적으면 충분합니다.', 'A line or two is enough if there are rules this project should keep every run.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 작업 방식', 'Default work style'))}</label>
                <select id="project-settings-preset">
                  <option value="auto" ${project?.defaultPresetId === 'auto' ? 'selected' : ''}>${escapeHtml(t('자동 선택 (권장)', 'Auto (recommended)'))}</option>
                  <option value="existing-repo-feature" ${project?.defaultPresetId === 'existing-repo-feature' ? 'selected' : ''}>${escapeHtml(t('기존 프로젝트 기능 추가', 'Existing repo feature'))}</option>
                  <option value="existing-repo-bugfix" ${project?.defaultPresetId === 'existing-repo-bugfix' ? 'selected' : ''}>${escapeHtml(t('기존 프로젝트 버그 수정', 'Existing repo bugfix'))}</option>
                  <option value="greenfield-app" ${project?.defaultPresetId === 'greenfield-app' ? 'selected' : ''}>${escapeHtml(t('새 프로젝트 시작', 'Greenfield app'))}</option>
                  <option value="refactor-stabilize" ${project?.defaultPresetId === 'refactor-stabilize' ? 'selected' : ''}>${escapeHtml(t('리팩터링 / 안정화', 'Refactor / stabilize'))}</option>
                  <option value="docs-spec-first" ${project?.defaultPresetId === 'docs-spec-first' ? 'selected' : ''}>${escapeHtml(t('문서 / 명세 먼저', 'Docs / spec first'))}</option>
                </select>
                <div class="helper-text">${escapeHtml(t('모르면 자동 선택 그대로 두면 됩니다.', 'If unsure, leave it on Auto.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 계획/검토 담당', 'Default planning/review provider'))}</label>
                <select id="project-settings-coordination-provider">
                  <option value="" ${providerProfile ? '' : 'selected'}>${escapeHtml(t('이 PC 기본값 따름', 'Machine default'))}</option>
                  <option value="codex" ${providerProfile?.coordinationProvider === 'codex' ? 'selected' : ''}>Codex</option>
                  <option value="claude" ${providerProfile?.coordinationProvider === 'claude' ? 'selected' : ''}>Claude Code CLI</option>
                  <option value="gemini" ${providerProfile?.coordinationProvider === 'gemini' ? 'selected' : ''}>Gemini CLI</option>
                </select>
                <div class="helper-text">${escapeHtml(t('비워 두면 이 PC 설정을 그대로 따릅니다. 프로젝트마다 따로 고정할 때만 선택하세요.', 'Leave this on Machine default to inherit the PC setting. Only choose an explicit provider when this project must pin its own default.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 구현 담당', 'Default implementation provider'))}</label>
                <select id="project-settings-worker-provider">
                  <option value="" ${providerProfile ? '' : 'selected'}>${escapeHtml(t('이 PC 기본값 따름', 'Machine default'))}</option>
                  <option value="codex" ${providerProfile?.workerProvider === 'codex' ? 'selected' : ''}>Codex</option>
                  <option value="claude" ${providerProfile?.workerProvider === 'claude' ? 'selected' : ''}>Claude Code CLI</option>
                  <option value="gemini" ${providerProfile?.workerProvider === 'gemini' ? 'selected' : ''}>Gemini CLI</option>
                </select>
                <div class="helper-text">${escapeHtml(t('비워 두면 이 PC 설정을 그대로 따릅니다. 프로젝트마다 따로 고정할 때만 선택하세요.', 'Leave this on Machine default to inherit the PC setting. Only choose an explicit provider when this project must pin its own default.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('연속 작업 운영 방식', 'Continuation mode'))}</label>
                <select id="project-settings-continuation-mode">
                  <option value="guided" ${continuationPolicy.mode === 'manual' ? '' : 'selected'}>${escapeHtml(t('권장 다음 작업 초안 자동 준비', 'Auto-prepare suggested next run'))}</option>
                  <option value="manual" ${continuationPolicy.mode === 'manual' ? 'selected' : ''}>${escapeHtml(t('수동으로 직접 입력', 'Manual entry'))}</option>
                </select>
                <div class="helper-text">${escapeHtml(t('크게 고민하지 않으려면 권장 초안 자동 준비를 그대로 두면 됩니다.', 'If you do not want to micromanage, leave suggested drafts on.'))}</div>
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-auto-chain" ${continuationPolicy.autoChainOnComplete === true ? 'checked' : ''}>
                  ${escapeHtml(t('run 완료 후 자동 체이닝', 'Auto-chain after run complete'))}
                </label>
                <div class="helper-text">${escapeHtml(t('완료/부분완료 후 제안된 다음 run 자동 생성을 허용합니다.', 'Enable automatic creation of the next run after complete/partial-complete states.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('최대 자동 체인 깊이', 'Maximum auto-chain depth'))}</label>
                <input type="number" id="project-settings-max-chain-depth" min="0" step="1" value="${escapeHtml(String(maxChainDepth))}">
                <div class="helper-text">${escapeHtml(t('0은 무제한입니다. 기본값은 3입니다.', '0 means unlimited. Default is 3.'))}</div>
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-run-loop-enabled" ${defaultRunLoop.enabled === true ? 'checked' : ''}>
                  ${escapeHtml(t('새 run 기본값으로 런 루프 사용', 'Use run loop as the default for new runs'))}
                </label>
                <div class="helper-text">${escapeHtml(t('프로젝트에서 새 run을 만들 때 반복 실행 기본값을 같이 채웁니다.', 'Pre-fill run-level repetition defaults when new runs are created in this project.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 런 루프 방식', 'Default run loop mode'))}</label>
                <select id="project-settings-run-loop-mode">
                  <option value="repeat-count" ${defaultRunLoop.mode === 'until-goal' ? '' : 'selected'}>${escapeHtml(t('정해진 횟수 반복', 'Repeat N runs'))}</option>
                  <option value="until-goal" ${defaultRunLoop.mode === 'until-goal' ? 'selected' : ''}>${escapeHtml(t('목표 달성까지 반복', 'Repeat until goal achieved'))}</option>
                </select>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 최대 루프 횟수', 'Default max loop runs'))}</label>
                <input type="number" id="project-settings-run-loop-max-runs" min="1" step="1" value="${escapeHtml(String(defaultRunLoop.maxRuns || 3))}">
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('기본 연속 실패 중단 횟수', 'Default failure-stop count'))}</label>
                <input type="number" id="project-settings-run-loop-max-failures" min="1" step="1" value="${escapeHtml(String(defaultRunLoop.maxConsecutiveFailures || 3))}">
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-doc-sync" ${continuationPolicy.keepDocsInSync === false ? '' : 'checked'}>
                  ${escapeHtml(t('docs 기반 작업이면 문서 갱신도 다음 작업에 이어받기', 'Carry docs updates into the next run for docs-based work'))}
                </label>
                <div class="helper-text">${escapeHtml(t('문서가 기준인 프로젝트라면 보통 켜 두는 편이 맞습니다.', 'For docs-first projects, this usually should stay on.'))}</div>
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-auto-sweep" ${continuationPolicy.autoQualitySweepOnPhaseComplete === true ? 'checked' : ''}>
                  ${escapeHtml(t('단계 완료 시 정리 점검 자동 실행', 'Run quality sweep automatically when a phase closes'))}
                </label>
                <div class="helper-text">${escapeHtml(t('단계를 닫을 때 cleanup 후보와 남은 위험을 자동으로 정리합니다.', 'When a phase closes, automatically surface cleanup items and remaining risks.'))}</div>
              </div>
              <div class="form-group" style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px;">
                <label style="display:flex; align-items:center; gap:8px; font-weight:600;">
                  <input type="checkbox" id="project-settings-supervisor-enabled" ${autoProgress.enabled === true ? 'checked' : ''}>
                  ${escapeHtml(t('Supervisor 자동 실행', 'Supervisor auto-run'))}
                </label>
                <div class="helper-text">${escapeHtml(t('활성화하면 서버가 cron 스케줄에 맞춰 이 프로젝트의 다음 run을 자동으로 시작합니다.', 'When enabled, the server automatically starts the next run for this project according to the cron schedule.'))}</div>
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-schedule-enabled" ${autoProgress.scheduleEnabled === true ? 'checked' : ''}>
                  ${escapeHtml(t('Cron 스케줄 사용', 'Use cron schedule'))}
                </label>
                <div class="helper-text">${escapeHtml(t('스케줄 기반 실행을 활성화합니다. Supervisor 자동 실행도 함께 켜야 합니다.', 'Enable schedule-based execution. Supervisor auto-run must also be enabled.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('Cron 표현식', 'Cron expression'))}</label>
                <input id="project-settings-schedule-cron" value="${escapeHtml(autoProgress.scheduleCron || '')}" placeholder="0 9 * * 1-5" oninput="onProjectScheduleCronInput()">
                <div class="helper-text">${escapeHtml(t('표준 5필드 cron 형식. 예: 0 9 * * 1-5 = 평일 오전 9시. 비워두면 스케줄 없이 supervisor만 대기합니다.', 'Standard 5-field cron. e.g. 0 9 * * 1-5 = weekdays at 9am. Leave blank to run supervisor without a schedule.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('빠른 스케줄 프리셋', 'Quick schedule preset'))}</label>
                <select id="project-settings-schedule-preset" onchange="applyProjectSchedulePreset(this.value)">
                  <option value="">${escapeHtml(t('직접 입력', 'Custom'))}</option>
                  <option value="0 9 * * 1-5">${escapeHtml(t('평일 오전 9시', 'Weekdays 9:00'))}</option>
                  <option value="0 14 * * 1-5">${escapeHtml(t('평일 오후 2시', 'Weekdays 14:00'))}</option>
                  <option value="0 10 * * *">${escapeHtml(t('매일 오전 10시', 'Daily 10:00'))}</option>
                  <option value="*/30 * * * *">${escapeHtml(t('30분마다', 'Every 30 minutes'))}</option>
                </select>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('시각적 Cron 빌더', 'Visual cron builder'))}</label>
                <div style="padding:14px; border-radius:18px; background:linear-gradient(180deg, rgba(248,250,252,0.98), rgba(255,255,255,1)); border:1px solid rgba(15,23,42,0.08); box-shadow:0 18px 34px rgba(15,23,42,0.06);">
                  <div style="font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin-bottom:10px;">${escapeHtml(t('빠른 cadence', 'Quick cadence'))}</div>
                  <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
                    <button type="button" id="project-settings-schedule-builder-mode-weekdays" class="secondary-btn" style="border-radius:999px;" onclick="applyProjectScheduleBuilderMode('weekdays')">${escapeHtml(t('평일', 'Weekdays'))}</button>
                    <button type="button" id="project-settings-schedule-builder-mode-daily" class="secondary-btn" style="border-radius:999px;" onclick="applyProjectScheduleBuilderMode('daily')">${escapeHtml(t('매일', 'Daily'))}</button>
                    <button type="button" id="project-settings-schedule-builder-mode-hourly" class="secondary-btn" style="border-radius:999px;" onclick="applyProjectScheduleBuilderMode('hourly')">${escapeHtml(t('매시간', 'Hourly'))}</button>
                    <button type="button" id="project-settings-schedule-builder-mode-every-30-min" class="secondary-btn" style="border-radius:999px;" onclick="applyProjectScheduleBuilderMode('every-30-min')">${escapeHtml(t('30분마다', 'Every 30 min'))}</button>
                    <button type="button" id="project-settings-schedule-builder-mode-custom" class="secondary-btn" style="border-radius:999px;" onclick="applyProjectScheduleBuilderMode('custom')">${escapeHtml(t('사용자 정의', 'Custom'))}</button>
                  </div>
                  <div style="display:grid; grid-template-columns: 1.3fr 1fr 1fr auto; gap:8px; align-items:end;">
                    <div>
                      <div style="font-size:12px; color:var(--muted); margin-bottom:6px;">${escapeHtml(t('빌더 모드', 'Builder mode'))}</div>
                      <select id="project-settings-schedule-builder-mode" onchange="applyProjectScheduleBuilderMode(this.value)">
                        <option value="custom">${escapeHtml(t('사용자 정의', 'Custom'))}</option>
                        <option value="weekdays">${escapeHtml(t('평일', 'Weekdays'))}</option>
                        <option value="daily">${escapeHtml(t('매일', 'Daily'))}</option>
                        <option value="hourly">${escapeHtml(t('매시간', 'Hourly'))}</option>
                        <option value="every-30-min">${escapeHtml(t('30분마다', 'Every 30 min'))}</option>
                      </select>
                    </div>
                    <div>
                      <div style="font-size:12px; color:var(--muted); margin-bottom:6px;">${escapeHtml(t('시각', 'Hour'))}</div>
                      <select id="project-settings-schedule-builder-hour" onchange="updateProjectScheduleBuilderPreview()">
                        ${Array.from({ length: 24 }, (_, index) => `<option value="${index}">${String(index).padStart(2, '0')}</option>`).join('')}
                      </select>
                    </div>
                    <div>
                      <div style="font-size:12px; color:var(--muted); margin-bottom:6px;">${escapeHtml(t('분', 'Minute'))}</div>
                      <select id="project-settings-schedule-builder-minute" onchange="updateProjectScheduleBuilderPreview()">
                        ${Array.from({ length: 60 }, (_, minute) => `<option value="${minute}">${String(minute).padStart(2, '0')}</option>`).join('')}
                      </select>
                    </div>
                    <button type="button" class="primary" onclick="applyProjectScheduleBuilder()">${escapeHtml(t('Cron 적용', 'Apply cron'))}</button>
                  </div>
                </div>
                <div class="helper-text">${escapeHtml(t('cadence 버튼 또는 드롭다운으로 주기를 고르고, 시간 드롭다운을 맞춘 뒤 Cron 적용을 누르세요.', 'Choose a cadence from the pills or dropdown, set the time dropdowns, then apply it into the cron field.'))}</div>
                <div id="project-settings-schedule-preview" class="helper-text">${escapeHtml(t('직접 cron을 입력하거나 아래 빌더를 적용하세요.', 'Enter a cron expression or apply the builder below.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('Supervisor 점검 주기 (ms)', 'Supervisor poll interval (ms)'))}</label>
                <input type="number" id="project-settings-poll-interval" min="5000" step="5000" value="${escapeHtml(String(autoProgress.pollIntervalMs || 30000))}">
                <div class="helper-text">${escapeHtml(t('Supervisor가 cron 일치 여부를 확인하는 주기. 최소 5000ms. 기본값 30000ms.', 'How often the supervisor checks whether the cron schedule matches. Min 5000ms, default 30000ms.'))}</div>
              </div>
              <div class="form-group">
                <label style="display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="project-settings-pause-on-failures" ${autoProgress.pauseOnRepeatedFailures === false ? '' : 'checked'}>
                  ${escapeHtml(t('반복 실패 시 자동 일시중지', 'Auto-pause on repeated failures'))}
                </label>
                <div class="helper-text">${escapeHtml(t('연속 실패 run이 누적되면 supervisor를 자동으로 멈추고 사람 개입을 기다립니다.', 'When failed runs pile up in a row, pause the supervisor automatically and wait for a human to intervene.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('자동 일시중지 기준 run 수', 'Pause after consecutive failed runs'))}</label>
                <input type="number" id="project-settings-max-failures" min="1" step="1" value="${escapeHtml(String(autoProgress.maxConsecutiveFailures || 3))}">
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('고급: 도구 제한 ID', 'Advanced: tool profile ID'))}</label>
                <input id="project-settings-tool-id" value="${escapeHtml(toolProfile?.id || 'default')}" placeholder="safe-default">
                <div class="helper-text">${escapeHtml(t('모르면 기본값 그대로 두세요.', 'Leave the default unless you already know why to change it.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('고급: 도구 제한 이름', 'Advanced: tool profile label'))}</label>
                <input id="project-settings-tool-label" value="${escapeHtml(toolProfile?.label || 'Default')}" placeholder="${escapeHtml(t('안전 기본값', 'Safe default'))}">
                <div class="helper-text">${escapeHtml(t('모르면 기본값 그대로 두세요.', 'Leave the default unless you already know why to change it.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('고급: 허용할 작업 종류', 'Advanced: allowed action classes'))}</label>
                <input id="project-settings-tool-actions" value="${escapeHtml(toolActionClasses.join(', '))}" placeholder="verification, git-write">
                <div class="helper-text">${escapeHtml(t('정말 특정 작업만 허용하고 싶을 때만 적으세요. 비워두면 지금처럼 제한 없이 사용합니다.', 'Only use this if you truly want to narrow the allowed action types. Leave it blank to keep the current unrestricted behavior.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('선택: 브라우저 확인 URL', 'Optional: browser verification URL'))}</label>
                <input id="project-settings-browser-url" value="${escapeHtml(browserVerification?.url || '')}" placeholder="http://127.0.0.1:4173">
                <div class="helper-text">${escapeHtml(t('웹 화면을 실제로 자동 확인해야 할 때만 적으면 됩니다.', 'Only fill this in when you want the harness to check a real browser flow.'))}</div>
              </div>
              <div class="form-group">
                <label>${escapeHtml(t('선택: 개발 서버 실행 명령', 'Optional: dev server command'))}</label>
                <input id="project-settings-dev-command" value="${escapeHtml(devServer?.command || '')}" placeholder="npm run dev">
                <div class="helper-text">${escapeHtml(t('브라우저 확인 전에 로컬 서버를 먼저 띄워야 할 때만 적으면 됩니다.', 'Only fill this in when a local server must start before browser verification.'))}</div>
              </div>
            </div>
            <div class="action-strip" style="margin: 0;">
              <button class="primary" onclick="saveProjectSettings()" ${isBusy('save-project-settings') ? 'disabled' : ''}>${escapeHtml(isBusy('save-project-settings') ? t('저장 중...', 'Saving...') : t('프로젝트 설정 저장', 'Save project settings'))}</button>
            </div>
          </div>
        </details>
        <div class="card" style="margin-bottom: 18px;">
          <div class="section-head" style="margin-bottom: 14px;">
            <div>
              <span class="eyebrow">${escapeHtml(t('운영 큐', 'Operations queue'))}</span>
              <h3>${escapeHtml(t('지금 바로 처리할 항목', 'Items to act on now'))}</h3>
            </div>
            <p>${escapeHtml(t('프로젝트 단위에서 검토 대기, 이어받을 작업, 정리 작업을 우선순위대로 정리합니다.', 'This queue sorts pending review, carry-over work, and cleanup items at the project level.'))}</p>
          </div>
          <div class="decision-queue">
            ${decisionQueue.map((item) => `
              <div class="decision-item ${escapeHtml(item.tone || 'safe')}">
                <div>
                  <strong>${escapeHtml(item.title || t('action', 'Action'))}</strong>
                  <div class="decision-meta">${escapeHtml(item.meta || t('project action', 'Project action'))}</div>
                  <div class="decision-detail">${escapeHtml(clip(item.detail || '', 220) || t('상세 없음', 'No detail'))}</div>
                </div>
                ${item.action ? `<button class="secondary-btn" onclick="${item.action}">${escapeHtml(item.actionLabel || t('열기', 'Open'))}</button>` : ''}
              </div>
            `).join('') || `<div class="stack-item">${escapeHtml(t('지금 바로 처리할 항목이 없습니다.', 'There is nothing urgent to act on right now.'))}</div>`}
          </div>
        </div>
        <details class="advanced-settings">
          <summary>${escapeHtml(t('단계별 상세 보기', 'Show per-phase details'))}</summary>
          <div class="advanced-body">
            <div class="stack">
              ${phases.map((phase) => renderProjectPhaseCard(phase)).join('') || `<div class="card"><div class="stack-item">${escapeHtml(t('정의된 단계가 없습니다.', 'No phases are defined yet.'))}</div></div>`}
            </div>
          </div>
        </details>
      `;
    }

    return {
      renderProjectPhaseCard,
      renderProjectDetail
    };
  }

  global.HarnessUiProjectRenderers = {
    createProjectRenderers
  };
})(window);
