export function createSupervisorLoop(deps) {
  const {
    PROJECT_AUTOMATION_TICK_MS,
    buildProjectHealthDashboard,
    buildSupervisorDraftFromPhase,
    createRun,
    DEFAULT_HARNESS_SETTINGS,
    findNextCronOccurrence,
    getProject,
    getSupervisorRuntimeState,
    listRuns,
    loadState,
    maybeAutoAdvanceProjectPhase,
    minuteKeyFromDate,
    normalizeContinuationPolicy,
    normalizeProjectAutoProgress,
    now,
    runningProjectSupervisors,
    saveState,
    shouldRunScheduledAutoPass,
    runtimeObservability,
    updateProject,
    withLock,
    compareNewest,
    setSupervisorRuntimeState,
    startRun
  } = deps;

  let projectSupervisorTickHandle = null;
  let isProjectSupervisorTicking = false;

  async function stopProjectSupervisor(projectIdValue, { reason = '' } = {}) {
    const projectId = String(projectIdValue || '').trim();
    if (!projectId) throw new Error('projectId is required');
    setSupervisorRuntimeState(projectId, {
      running: false,
      pausedReason: String(reason || '').trim(),
      nextScheduledAt: '',
      lastAction: reason ? `stopped: ${reason}` : 'stopped',
      lastActionAt: now()
    });
    const anyStillRunning = [...runningProjectSupervisors.values()].some((rt) => rt && rt.running !== false);
    if (!anyStillRunning) stopGlobalSupervisorTick();
    await runtimeObservability.withObservedFallback(
      () => updateProject(projectId, { autoProgress: { enabled: false } }),
      { scope: 'supervisor.stop.update-project', context: { projectId, reason }, fallback: null }
    );
    return { projectId, stopped: true };
  }

  async function runProjectSupervisorPass(projectId, { force = false } = {}) {
    let project = await runtimeObservability.withObservedFallback(
      () => getProject(projectId),
      { scope: 'supervisor.pass.get-project', context: { projectId }, fallback: null }
    );
    if (!project) return;

    const autoProgress = normalizeProjectAutoProgress(project);
    if (!autoProgress.enabled && !force) return;

    const runtime = getSupervisorRuntimeState(projectId);
    if (runtime?.inFlight) return;

    setSupervisorRuntimeState(projectId, { inFlight: true, lastPolledAt: Date.now() });
    try {
      const allRuns = await listRuns();
      const activeRun = allRuns.find((run) =>
        String(run?.project?.id || '') === projectId && run.status === 'running'
      );
      if (activeRun) {
        setSupervisorRuntimeState(projectId, { inFlight: false, lastPassAt: now(), lastAction: 'skipped-run-active', lastActionAt: now(), lastRunId: activeRun.id });
        return;
      }

      const lastScheduledAt = getSupervisorRuntimeState(projectId)?.lastScheduledAt || '';
      if (!force && !shouldRunScheduledAutoPass(autoProgress, lastScheduledAt)) {
        setSupervisorRuntimeState(projectId, { inFlight: false, lastPassAt: now(), lastAction: 'idle', lastActionAt: now() });
        return;
      }

      const phaseAdvance = await maybeAutoAdvanceProjectPhase(project, allRuns);
      project = phaseAdvance.project || project;
      const phaseId = String(project.currentPhaseId || '').trim();
      const phase = phaseId
        ? (Array.isArray(project.phases) ? project.phases : []).find((p) => String(p?.id || '').trim() === phaseId)
        : null;
      if (!phase) {
        setSupervisorRuntimeState(projectId, { inFlight: false, lastPassAt: now(), lastAction: 'skipped-no-phase', lastActionAt: now() });
        return;
      }

      const continuationPolicy = normalizeContinuationPolicy(project?.defaultSettings?.continuationPolicy);
      const phaseRuns = allRuns
        .filter((run) => String(run?.project?.id || '') === projectId && String(run?.project?.phaseId || '') === phaseId)
        .sort(compareNewest);
      const healthDashboard = buildProjectHealthDashboard(
        project,
        Array.isArray(project.phases) ? project.phases : [],
        phaseRuns,
        null,
        DEFAULT_HARNESS_SETTINGS.uiLanguage,
        null
      );
      if (autoProgress.pauseOnRepeatedFailures !== false
        && Number(healthDashboard?.repeatedFailures?.consecutiveFailedRuns || 0) >= Number(autoProgress.maxConsecutiveFailures || 3)) {
        await stopProjectSupervisor(projectId, {
          reason: `auto-paused after ${healthDashboard.repeatedFailures.consecutiveFailedRuns} consecutive failed runs`
        });
        setSupervisorRuntimeState(projectId, {
          inFlight: false,
          running: false,
          pausedReason: `auto-paused after ${healthDashboard.repeatedFailures.consecutiveFailedRuns} consecutive failed runs`,
          lastPassAt: now(),
          lastAction: 'paused-repeated-failures',
          lastActionAt: now(),
          nextScheduledAt: ''
        });
        return;
      }
      const { draft } = await buildSupervisorDraftFromPhase(project, phase, continuationPolicy, phaseRuns);

      if (!draft?.title || !draft?.objective) {
        setSupervisorRuntimeState(projectId, { inFlight: false, lastPassAt: now(), lastAction: 'skipped-no-draft', lastActionAt: now() });
        return;
      }

      const nextRun = await createRun({
        projectId,
        phaseId,
        title: draft.title,
        objective: draft.objective,
        specText: draft.specText || '',
        specFiles: '',
        presetId: String(phase.presetId || project.defaultPresetId || 'auto').trim() || 'auto',
        settings: { maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 },
        chainMeta: { trigger: 'scheduled', reason: `Supervisor scheduled pass: ${autoProgress.scheduleCron}` }
      });
      try {
        await startRun(nextRun.id);
      } catch (startErr) {
        await withLock(nextRun.id, async () => {
          const orphan = await loadState(nextRun.id);
          orphan.status = 'failed';
          orphan.result = { goalAchieved: false, summary: `Supervisor failed to start: ${startErr.message || String(startErr)}`, findings: [] };
          orphan.updatedAt = now();
          await saveState(orphan);
        });
        throw startErr;
      }

      const minuteKey = minuteKeyFromDate(new Date());
      setSupervisorRuntimeState(projectId, {
        inFlight: false,
        lastPassAt: now(),
        lastAction: 'run-started',
        lastActionAt: now(),
        lastRunId: nextRun.id,
        lastScheduledAt: minuteKey,
        pausedReason: '',
        nextScheduledAt: autoProgress.scheduleEnabled ? findNextCronOccurrence(autoProgress.scheduleCron) : ''
      });
      await runtimeObservability.withObservedFallback(
        () => updateProject(projectId, { autoProgress: { ...autoProgress, lastScheduledAt: minuteKey } }),
        { scope: 'supervisor.pass.persist-last-scheduled', context: { projectId, minuteKey }, fallback: null }
      );
    } catch (error) {
      await runtimeObservability.recordHarnessError('supervisor.pass', error, { projectId, force });
      setSupervisorRuntimeState(projectId, {
        inFlight: false,
        lastError: error.message || String(error || ''),
        lastErrorAt: now(),
        nextScheduledAt: autoProgress.scheduleEnabled ? findNextCronOccurrence(autoProgress.scheduleCron) : ''
      });
    }
  }

  function startGlobalSupervisorTick() {
    if (projectSupervisorTickHandle) return;
    projectSupervisorTickHandle = setInterval(async () => {
      if (isProjectSupervisorTicking) return;
      isProjectSupervisorTicking = true;
      try {
        const projectIds = [...runningProjectSupervisors.keys()].filter((id) => {
          const rt = runningProjectSupervisors.get(id);
          return rt && rt.running !== false;
        });
        await Promise.allSettled(projectIds.map((id) => runProjectSupervisorPass(id)));
      } finally {
        isProjectSupervisorTicking = false;
      }
    }, PROJECT_AUTOMATION_TICK_MS);
  }

  function stopGlobalSupervisorTick() {
    if (projectSupervisorTickHandle) {
      clearInterval(projectSupervisorTickHandle);
      projectSupervisorTickHandle = null;
    }
    isProjectSupervisorTicking = false;
  }

  async function startProjectSupervisor(projectIdValue, { immediate = false } = {}) {
    const projectId = String(projectIdValue || '').trim();
    if (!projectId) throw new Error('projectId is required');
    const project = await runtimeObservability.withObservedFallback(
      () => getProject(projectId),
      { scope: 'supervisor.start.get-project', context: { projectId }, fallback: null }
    );
    const autoProgress = normalizeProjectAutoProgress(project);
    setSupervisorRuntimeState(projectId, {
      running: true,
      pausedReason: '',
      lastAction: 'started',
      lastActionAt: now(),
      nextScheduledAt: autoProgress.scheduleEnabled ? findNextCronOccurrence(autoProgress.scheduleCron) : ''
    });
    startGlobalSupervisorTick();
    await runtimeObservability.withObservedFallback(
      () => updateProject(projectId, { autoProgress: { enabled: true } }),
      { scope: 'supervisor.start.update-project', context: { projectId }, fallback: null }
    );
    if (immediate) {
      await runtimeObservability.withObservedFallback(
        () => runProjectSupervisorPass(projectId),
        { scope: 'supervisor.start.immediate-pass', context: { projectId }, fallback: null }
      );
    }
    return { projectId, started: true, pollIntervalMs: PROJECT_AUTOMATION_TICK_MS };
  }

  async function triggerProjectSupervisorPass(projectIdValue) {
    const projectId = String(projectIdValue || '').trim();
    if (!projectId) throw new Error('projectId is required');
    await runProjectSupervisorPass(projectId, { force: true });
    return { projectId, triggered: true };
  }

  function getProjectSupervisorStatus(projectIdValue) {
    const projectId = String(projectIdValue || '').trim();
    const runtime = getSupervisorRuntimeState(projectId);
    return {
      projectId,
      running: runtime ? runtime.running !== false : false,
      lastPolledAt: runtime?.lastPolledAt || 0,
      lastPassAt: runtime?.lastPassAt || '',
      lastAction: runtime?.lastAction || '',
      lastActionAt: runtime?.lastActionAt || '',
      lastError: runtime?.lastError || '',
      lastErrorAt: runtime?.lastErrorAt || '',
      lastRunId: runtime?.lastRunId || ''
    };
  }

  return {
    runProjectSupervisorPass,
    startGlobalSupervisorTick,
    stopGlobalSupervisorTick,
    startProjectSupervisor,
    stopProjectSupervisor,
    triggerProjectSupervisorPass,
    getProjectSupervisorStatus
  };
}
