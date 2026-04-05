export function createProjectHealth(deps) {
  const {
    buildCarryOverTaskEntry,
    clipText,
    isTaskSatisfiedStatus,
    localizedText,
    normalizeAcceptanceCheckResults,
    normalizeLanguage,
    normalizeContinuationPolicy,
    uniqueBy
  } = deps;

  function t(language, ko, en) {
    return localizedText
      ? localizedText(language, ko, en)
      : (normalizeLanguage?.(language, 'en') === 'en' ? String(en || ko || '') : String(ko || en || ''));
  }

  function compareNewest(left, right) {
    const a = String(left?.updatedAt || '').trim();
    const b = String(right?.updatedAt || '').trim();
    if (a === b) return 0;
    return a < b ? 1 : -1;
  }

  function isDocLikeProjectPath(filePath = '') {
    const value = String(filePath || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!value) return false;
    if (value.startsWith('docs/')) return true;
    return /\.(md|mdx|txt|json|pdf)$/i.test(value);
  }

  function normalizeProjectSignalText(value = '') {
    return String(value || '')
      .toLowerCase()
      .replace(/\b[tp]\d+\b/g, 'task')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collectRunChangedPaths(run) {
    return uniqueBy(
      (Array.isArray(run?.tasks) ? run.tasks : []).flatMap((task) => {
        const changedFiles = Array.isArray(task?.lastExecution?.changedFiles) ? task.lastExecution.changedFiles : [];
        return changedFiles.map((filePath) => String(filePath || '').trim()).filter(Boolean);
      }),
      (item) => item
    );
  }

  function buildProjectRepeatedFailureSummary(runs = [], language = 'en') {
    const grouped = new Map();
    let totalSignals = 0;
    let consecutiveFailedRuns = 0;
    for (const run of runs) {
      const failedTasks = (Array.isArray(run?.tasks) ? run.tasks : []).filter((task) => String(task?.status || '') === 'failed');
      const isFailedRun = ['failed', 'partial_complete'].includes(String(run?.status || ''))
        && (failedTasks.length > 0 || run?.result?.goalAchieved !== true);
      if (!isFailedRun) break;
      consecutiveFailedRuns += 1;
    }
    for (const run of runs.slice(0, 8)) {
      for (const task of (Array.isArray(run?.tasks) ? run.tasks : [])) {
        const signals = [];
        if (task?.status === 'failed') {
          signals.push(normalizeAcceptanceCheckResults(task?.lastExecution?.acceptanceCheckResults).find((item) => item.status === 'fail')?.check || '');
          signals.push(task?.findings?.[0] || '');
          signals.push(task?.reviewSummary || '');
          signals.push(task?.lastExecution?.verification?.stderr || '');
        }
        for (const signal of signals.map((item) => normalizeProjectSignalText(item)).filter(Boolean)) {
          totalSignals += 1;
          grouped.set(signal, {
            label: clipText(String(signal || '').replace(/#/g, '0'), 120),
            count: (grouped.get(signal)?.count || 0) + 1
          });
          break;
        }
      }
    }
    const patterns = [...grouped.values()].filter((item) => item.count >= 2).sort((left, right) => right.count - left.count).slice(0, 4);
    return {
      totalSignals,
      consecutiveFailedRuns,
      repeatedCount: patterns.reduce((sum, item) => sum + item.count, 0),
      patterns,
      warning: patterns.length > 0,
      summary: patterns.length
        ? t(language, `${patterns[0].label} 패턴이 ${patterns[0].count}번 반복되었습니다.`, `The pattern "${patterns[0].label}" repeated ${patterns[0].count} times.`)
        : t(language, '최근 반복 실패 패턴은 아직 뚜렷하지 않습니다.', 'There is no strong repeated failure pattern yet.')
    };
  }

  function buildProjectDocsDriftSummary(project, phaseRuns = [], language = 'en') {
    const continuationPolicy = normalizeContinuationPolicy(project?.defaultSettings?.continuationPolicy);
    const docsPriority = continuationPolicy.keepDocsInSync !== false || String(project?.defaultPresetId || '') === 'docs-spec-first';
    const recentRuns = phaseRuns.slice(0, 6);
    const runSignals = recentRuns.map((run) => {
      const changedPaths = collectRunChangedPaths(run);
      const docPaths = changedPaths.filter((filePath) => isDocLikeProjectPath(filePath));
      const codePaths = changedPaths.filter((filePath) => !isDocLikeProjectPath(filePath));
      return {
        runId: run.id,
        runTitle: run.title || '',
        updatedAt: run.updatedAt || run.createdAt || '',
        docPaths,
        codePaths
      };
    });
    const latestDocRun = runSignals.find((item) => item.docPaths.length > 0) || null;
    const codeOnlyAfterLatestDoc = latestDocRun
      ? runSignals.filter((item) => item.codePaths.length > 0 && item.docPaths.length === 0 && String(item.updatedAt || '') > String(latestDocRun.updatedAt || ''))
      : runSignals.filter((item) => item.codePaths.length > 0 && item.docPaths.length === 0);
    const recentDocPaths = uniqueBy(runSignals.flatMap((item) => item.docPaths), (item) => item).slice(0, 5);

    let level = 'low';
    let summary = docsPriority
      ? t(language, '최근 문서와 구현이 크게 어긋난 신호는 아직 없습니다.', 'There is no strong sign of docs and implementation drifting apart yet.')
      : t(language, '이 프로젝트는 문서 우선 운영이 기본은 아닙니다.', 'Docs-first is not the default operating mode for this project.');
    let recommendedAction = docsPriority
      ? t(language, '큰 흐름이 바뀌면 docs도 같은 run 안에서 함께 갱신합니다.', 'When the implementation direction changes in a meaningful way, update the docs in the same run.')
      : t(language, '문서가 기준인 범위가 생길 때만 docs-first나 intake를 다시 고려하면 됩니다.', 'Only reconsider docs-first or intake when the scope becomes document-driven again.');
    if (docsPriority && codeOnlyAfterLatestDoc.length >= 2) {
      level = 'high';
      summary = t(language, '최근 구현 변경이 문서 반영 없이 누적되어 docs drift 가능성이 높습니다.', 'Recent implementation changes have piled up without doc updates, so docs drift is likely.');
      recommendedAction = t(language, '재분석 후 docs-first maintenance run으로 문서와 backlog를 다시 맞추는 편이 안전합니다.', 'Re-analyze and run a docs-first maintenance pass to realign docs and backlog.');
    } else if (docsPriority && (codeOnlyAfterLatestDoc.length === 1 || (!latestDocRun && runSignals.some((item) => item.codePaths.length > 0)))) {
      level = 'medium';
      summary = t(language, '최근 구현 변경 중 일부가 문서 갱신보다 앞서 있어 docs drift를 점검하는 편이 좋습니다.', 'Some recent implementation changes are ahead of the docs, so a docs-drift check is recommended.');
      recommendedAction = t(language, '다음 run에서 바뀐 구현과 source-of-record 문서를 함께 점검하세요.', 'In the next run, review the changed implementation together with the source-of-record docs.');
    }
    return {
      level,
      docsPriority,
      latestDocRunAt: latestDocRun?.updatedAt || '',
      codeOnlyRunCountAfterLatestDoc: codeOnlyAfterLatestDoc.length,
      recentDocPaths,
      summary,
      recommendedAction,
      reintakeRecommended: docsPriority && (level === 'high' || recentDocPaths.length >= 4)
    };
  }

  function buildProjectContinuationContext(project, phase, phaseRuns = [], language = 'en') {
    const continuationPolicy = normalizeContinuationPolicy(project?.defaultSettings?.continuationPolicy);
    const recentRunSummaries = phaseRuns.slice(0, 4).map((run) => ({
      runId: run.id,
      runTitle: run.title || '',
      status: run.status || '',
      summary: run.result?.summary || run.planSummary || ''
    }));
    const carryOverFocus = phaseRuns
      .flatMap((run) => (Array.isArray(run.tasks) ? run.tasks : []).filter((task) => !isTaskSatisfiedStatus(task.status)).map((task) => buildCarryOverTaskEntry(run, phase, task)))
      .slice(0, 4);
    const recentDocUpdates = uniqueBy(
      phaseRuns.flatMap((run) => (Array.isArray(run.tasks) ? run.tasks : []).flatMap((task) => {
        const changedFiles = Array.isArray(task?.lastExecution?.changedFiles) ? task.lastExecution.changedFiles : [];
        return changedFiles
          .filter((filePath) => isDocLikeProjectPath(filePath))
          .map((filePath) => ({
            path: String(filePath || '').trim(),
            runId: run.id,
            runTitle: run.title || '',
            note: task.reviewSummary || task.goal || ''
          }));
      })),
      (item) => `${item.runId}:${item.path}`
    ).slice(0, 6);
    const latestQualitySweep = (Array.isArray(project?.maintenance?.qualitySweeps) ? project.maintenance.qualitySweeps : []).find((entry) => String(entry?.phaseId || '') === String(phase?.id || '')) || null;
    return {
      mode: continuationPolicy.mode,
      policyLabel: continuationPolicy.mode === 'guided'
        ? t(language, '권장 초안 자동 준비', 'Auto-prepare suggested draft')
        : t(language, '수동', 'Manual'),
      autoQualitySweepOnPhaseComplete: continuationPolicy.autoQualitySweepOnPhaseComplete === true,
      keepDocsInSync: continuationPolicy.keepDocsInSync !== false,
      docsSyncExpectation: continuationPolicy.keepDocsInSync !== false
        ? t(language, '이번 run이 source-of-record 문서나 spec를 바꾸면 같은 run 안에서 repo 문서도 함께 갱신하고, 다음 run은 갱신된 문서를 기준으로 이어간다.', 'If this run changes source-of-record docs or specs, update the repo docs in the same run and let the next run continue from those updated docs.')
        : '',
      carryOverCount: carryOverFocus.length,
      recentRunCount: phaseRuns.length,
      carryOverFocus,
      recentRunSummaries,
      recentDocUpdates,
      latestQualitySweep: latestQualitySweep
        ? {
            sweepId: latestQualitySweep.sweepId || '',
            grade: latestQualitySweep.grade || '',
            summary: `grade ${latestQualitySweep.grade || '-'} · finding ${latestQualitySweep.findingCount || 0} · max score ${latestQualitySweep.highestSeverityScore || 0}`
          }
        : null
    };
  }

  function buildProjectRuntimeObservability(project, phaseRuns = [], browserReadiness = null, language = 'en') {
    const recentSignals = [];
    for (const run of phaseRuns.slice(0, 4)) {
      for (const task of (Array.isArray(run?.tasks) ? run.tasks : []).slice(0, 8)) {
        const verification = task?.lastExecution?.verification || null;
        if (verification?.ok === false) {
          recentSignals.push({
            kind: 'verification',
            detail: `${run.title || run.id}: ${clipText((verification.failingChecks || [verification.stderr || verification.stdout || t(language, '검증 실패', 'Verification failed')])[0], 140)}`
          });
        }
        if (verification?.browser && verification.browser.ok === false) {
          recentSignals.push({
            kind: 'browser',
            detail: `${run.title || run.id}: ${clipText(verification.browser.note || t(language, '브라우저 확인 실패', 'Browser check failed'), 140)}`
          });
        }
      }
      for (const log of (Array.isArray(run?.logs) ? run.logs : []).slice(-10)) {
        const level = String(log?.level || '').toLowerCase();
        const message = String(log?.message || '').trim();
        if (!message) continue;
        if (level === 'error' || level === 'warning' || /(fail|error|timeout|healthy|browser|verification)/i.test(message)) {
          recentSignals.push({
            kind: level || 'log',
            detail: `${run.title || run.id}: ${clipText(message, 140)}`
          });
        }
      }
    }
    const warning = Boolean((browserReadiness?.configured && !browserReadiness?.ready) || recentSignals.length > 0);
    return {
      warning,
      headline: warning
        ? t(language, '주의해서 볼 런타임 신호가 있습니다.', 'There are runtime signals worth checking.')
        : t(language, '최근 런타임 신호는 안정적입니다.', 'Recent runtime signals look stable.'),
      detail: browserReadiness?.configured
        ? (browserReadiness?.note || '')
        : t(language, '브라우저 검증은 선택 사항이며, 최근 run 기준으로 큰 런타임 경고는 많지 않습니다.', 'Browser verification is optional, and recent runs do not show major runtime warnings.'),
      highlights: recentSignals.slice(0, 5).map((item) => item.detail),
      browserPolicyLabel: browserReadiness?.policyLabel || t(language, '선택적', 'Optional'),
      devServerCommand: browserReadiness?.devServerCommand || ''
    };
  }

  function isAutomatedRun(run) {
    const loop = run?.chainMeta?.loop || null;
    return loop?.enabled === true
      || Boolean(String(run?.chainedFromRunId || '').trim())
      || Number(run?.chainDepth || 0) > 0
      || Boolean(String(run?.chainMeta?.trigger || '').trim());
  }

  function isTerminalRunStatus(status = '') {
    return ['completed', 'failed', 'partial_complete', 'stopped'].includes(String(status || '').trim());
  }

  function isSuccessfulTerminalRun(run) {
    return String(run?.status || '').trim() === 'completed' && run?.result?.goalAchieved === true;
  }

  function buildAutomationScorecard(runs = [], docsDrift = null, repeatedFailures = null, supervisorRuntime = null, language = 'en') {
    const recentRuns = [...(Array.isArray(runs) ? runs : [])].sort(compareNewest).slice(0, 12);
    const automatedRuns = recentRuns.filter(isAutomatedRun);
    const terminalRuns = automatedRuns.filter((run) => isTerminalRunStatus(run?.status));
    const successfulRuns = terminalRuns.filter(isSuccessfulTerminalRun);
    const interruptedRuns = terminalRuns.filter((run) => !isSuccessfulTerminalRun(run));
    const chronological = [...terminalRuns].sort((left, right) =>
      (Date.parse(left?.updatedAt || left?.createdAt || '') || 0) - (Date.parse(right?.updatedAt || right?.createdAt || '') || 0)
    );
    let pendingRecoveries = 0;
    let recoveredRuns = 0;
    for (const run of chronological) {
      if (isSuccessfulTerminalRun(run)) {
        if (pendingRecoveries > 0) {
          recoveredRuns += 1;
          pendingRecoveries -= 1;
        }
      } else {
        pendingRecoveries += 1;
      }
    }
    const successRate = terminalRuns.length ? Number((successfulRuns.length / terminalRuns.length).toFixed(3)) : 0;
    const recoveryRate = interruptedRuns.length ? Number((recoveredRuns / interruptedRuns.length).toFixed(3)) : 1;
    const avgChainDepth = automatedRuns.length
      ? Number((automatedRuns.reduce((sum, run) => sum + Math.max(0, Number(run?.chainDepth || 0)), 0) / automatedRuns.length).toFixed(2))
      : 0;
    const loopedRuns = automatedRuns.filter((run) => run?.chainMeta?.loop?.enabled === true).length;
    const supervisorPauses = (Array.isArray(supervisorRuntime?.history) ? supervisorRuntime.history : [])
      .filter((entry) => /paused|auto-paused/i.test(String(entry?.detail || '')))
      .length + (String(supervisorRuntime?.pausedReason || '').trim() ? 1 : 0);
    const evidenceScore = Math.min(15, terminalRuns.length * 5);
    const stabilityScore = repeatedFailures?.warning ? 0 : 10;
    const docsScore = docsDrift?.level === 'high' ? 0 : (docsDrift?.level === 'medium' ? 5 : 10);
    const score = Math.max(0, Math.min(100, Math.round((successRate * 55) + (recoveryRate * 15) + evidenceScore + stabilityScore + docsScore)));
    const status = score >= 80
      ? 'healthy'
      : (score >= 60 ? 'watch' : 'attention');
    return {
      status,
      statusLabel: status === 'healthy'
        ? t(language, '안정권', 'Healthy')
        : (status === 'watch' ? t(language, '관찰 필요', 'Watch') : t(language, '주의 필요', 'Attention')),
      score,
      recentAutomatedRuns: automatedRuns.length,
      terminalRuns: terminalRuns.length,
      successfulRuns: successfulRuns.length,
      interruptedRuns: interruptedRuns.length,
      recoveredRuns,
      loopedRuns,
      avgChainDepth,
      supervisorPauses,
      successRate,
      recoveryRate,
      proofReady: terminalRuns.length >= 3,
      summary: terminalRuns.length >= 3
        ? t(language, `최근 자동화 run ${terminalRuns.length}개 기준 성공률 ${Math.round(successRate * 100)}%, 복구율 ${Math.round(recoveryRate * 100)}%입니다.`, `Across the latest ${terminalRuns.length} automated runs, success is ${Math.round(successRate * 100)}% and recovery is ${Math.round(recoveryRate * 100)}%.`)
        : t(language, `자동화 burn-in 증거가 아직 ${terminalRuns.length}개뿐이므로 운영 점수는 보수적으로 계산합니다.`, `Only ${terminalRuns.length} automated burn-in proof point(s) exist so far, so the operating score stays conservative.`),
      recommendedAction: terminalRuns.length < 3
        ? t(language, '최소 3개 이상의 자동화 terminal run을 더 쌓아 burn-in 증거를 보강하세요.', 'Accumulate at least 3 automated terminal runs to strengthen burn-in evidence.')
        : (status === 'attention'
          ? t(language, '반복 실패 또는 문서 drift를 먼저 줄인 뒤 자동화를 다시 넓히는 편이 안전합니다.', 'Reduce repeated failures or docs drift before widening automation again.')
          : (status === 'watch'
            ? t(language, '자동화는 작동하지만 아직 관찰 구간입니다. 연속 성공 run을 더 확보하세요.', 'Automation is working, but still in watch mode. Gather a few more consecutive successful runs.')
            : t(language, '현재 자동화 burn-in은 안정권입니다. 새 phase에도 같은 guardrail을 유지하세요.', 'The current automation burn-in is healthy. Keep the same guardrails in the next phase.')))
    };
  }

  function buildProjectHealthDashboard(project, phases = [], runs = [], browserReadiness = null, language = 'en', codeIntelligence = null, supervisorRuntime = null) {
    const activePhase = phases.find((phase) => String(phase?.id || '') === String(project?.currentPhaseId || ''))
      || phases.find((phase) => String(phase?.status || '') === 'active')
      || phases[0]
      || null;
    const activePhaseRuns = activePhase ? runs.filter((run) => String(run?.project?.phaseId || '') === String(activePhase.id || '')).sort(compareNewest) : runs.slice(0, 6);
    const docsDrift = buildProjectDocsDriftSummary(project, activePhaseRuns, language);
    const repeatedFailures = buildProjectRepeatedFailureSummary(activePhaseRuns, language);
    const runtimeObservability = buildProjectRuntimeObservability(project, activePhaseRuns, browserReadiness, language);
    const automationScorecard = buildAutomationScorecard(runs, docsDrift, repeatedFailures, supervisorRuntime, language);
    const latestSweep = activePhase?.latestQualitySweep || null;
    const successor = activePhase
      ? (activePhase.pendingReview?.length
        ? { ready: false, source: 'blocked-review', title: t(language, '검토 대기 먼저 해소', 'Clear pending review first'), detail: t(language, '사람 확인이 필요한 계획/질문이 남아 있어 다음 run 자동 연결보다 검토 해소가 먼저입니다.', 'Human review is still needed, so clearing review items comes before auto-linking the next run.') }
        : activePhase.carryOverTasks?.length
          ? { ready: true, source: 'carry-over', title: t(language, '이어받을 작업 기준으로 다음 run 초안 준비됨', 'Next run draft is ready from carry-over work'), detail: t(language, `${activePhase.carryOverTasks[0].taskId || 'carry-over'}를 먼저 닫는 흐름이 가장 자연스럽습니다.`, `The most natural next step is to close ${activePhase.carryOverTasks[0].taskId || 'carry-over'} first.`) }
          : activePhase.cleanupLane?.length
            ? { ready: true, source: 'cleanup', title: t(language, '정리 작업 기준으로 다음 run 초안 준비됨', 'Next run draft is ready from cleanup work'), detail: t(language, 'cleanup lane을 먼저 정리하고 다음 기능 run으로 넘어가는 편이 안전합니다.', 'It is safer to clear the cleanup lane before moving on to the next feature run.') }
            : { ready: true, source: 'next-slice', title: t(language, '현재 단계 목표 기준 다음 slice 초안 준비됨', 'Next slice draft is ready from the current phase goal'), detail: t(language, '열린 큐가 없으면 현재 단계 goal과 contract를 기준으로 다음 run을 이어갈 수 있습니다.', 'With no open queue, the next run can continue from the current phase goal and contract.') })
      : { ready: false, source: 'no-phase', title: t(language, '활성 단계 없음', 'No active phase'), detail: t(language, '새 단계를 추가하거나 재분석으로 현재 목표를 먼저 고정해야 합니다.', 'Add a phase or re-analyze first to lock the current goal.') };
    const reminder = docsDrift.reintakeRecommended
      ? { title: t(language, '재분석 권장', 'Re-analysis recommended'), detail: docsDrift.recommendedAction }
      : ((Array.isArray(codeIntelligence?.criticalSymbols) && codeIntelligence.criticalSymbols.length)
        ? { title: t(language, '고영향 심볼 주의', 'Critical symbols active'), detail: t(language, '다음 run 전 critical-risk 심볼과 고영향 파일의 scope boundary를 먼저 확인하는 편이 안전합니다.', 'Before the next run, confirm the scope boundary around the critical-risk symbols and high-impact files.') }
      : (!latestSweep && activePhaseRuns.length >= 3
        ? { title: t(language, '정리 점검 권장', 'Quality sweep recommended'), detail: t(language, '최근 run이 누적됐으므로 quality sweep으로 cleanup lane과 열린 위험을 한 번 정리하는 편이 좋습니다.', 'Recent runs have piled up, so it is a good moment to use a quality sweep to clean up the cleanup lane and open risks.') }
        : (repeatedFailures.warning
          ? { title: t(language, '반복 실패 패턴 점검 권장', 'Review repeated failure pattern'), detail: t(language, '같은 실패 원인이 반복되므로 범위를 줄여 다시 계획하거나 docs 기준을 다시 맞추는 편이 좋습니다.', 'The same failure cause is repeating, so it is better to narrow the scope and replan or realign the docs baseline.') }
          : { title: t(language, '현재 cadence 양호', 'Cadence looks healthy'), detail: t(language, '지금은 권장 다음 작업 초안으로 현재 단계를 이어가면 됩니다.', 'You can continue the current phase with the suggested next-run draft now.') })));
    const docsFlow = docsDrift.docsPriority
      ? { label: t(language, '문서 기준 프로젝트', 'Docs-first project'), detail: t(language, '다음 run도 docs/source-of-record와 구현을 함께 맞추는 흐름이 권장됩니다.', 'For the next run, keep docs/source-of-record aligned with implementation.') }
      : { label: t(language, '구현 중심 프로젝트', 'Implementation-first project'), detail: t(language, '문서는 필요할 때만 보강하고, 기본은 구현 slice 중심으로 이어가면 됩니다.', 'Only update docs when needed. The default flow can stay implementation-slice driven.') };
    const symbolAttention = Array.isArray(codeIntelligence?.criticalSymbols) && codeIntelligence.criticalSymbols.length > 0;
    const status = docsDrift.level === 'high' || repeatedFailures.warning || symbolAttention || automationScorecard.status === 'attention'
      ? 'attention'
      : ((runtimeObservability.warning || automationScorecard.status === 'watch') ? 'watch' : 'healthy');
    return {
      status,
      statusLabel: status === 'attention'
        ? t(language, '운영 주의', 'Attention needed')
        : (status === 'watch' ? t(language, '관찰 필요', 'Watch closely') : t(language, '정상 진행', 'Healthy')),
      headline: successor.title,
      successor,
      docsDrift,
      repeatedFailures,
      runtimeObservability,
      automationScorecard,
      codeIntelligence: codeIntelligence
        ? {
            indexedFileCount: codeIntelligence.indexedFileCount || 0,
            truncated: codeIntelligence.truncated === true,
            thresholds: codeIntelligence.thresholds || null,
            criticalSymbols: (codeIntelligence.criticalSymbols || []).slice(0, 4),
            topSymbols: (codeIntelligence.topSymbols || []).slice(0, 4),
            topFiles: (codeIntelligence.topFiles || []).slice(0, 4),
            topEdges: (codeIntelligence.topEdges || []).slice(0, 3),
            cache: codeIntelligence.cache || null
          }
        : null,
      reminder,
      docsFlow
    };
  }

  return { buildProjectContinuationContext, buildProjectHealthDashboard, buildProjectRuntimeObservability };
}
