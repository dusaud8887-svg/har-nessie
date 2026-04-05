(function attachHarnessModalActions(global) {
  function buildStructuredSpecText(form) {
    const sections = [
      ['성공 조건', form.get('successCriteria')],
      ['제외 범위', form.get('excludedScope')],
      ['대상 사용자', form.get('targetUsers')],
      ['예시 입력 / 출력', form.get('exampleIO')],
      ['변경 금지 영역', form.get('protectedAreas')]
    ].filter(([, value]) => String(value || '').trim());
    return sections.map(([title, value]) => `## ${title}\n\n${String(value || '').trim()}`).join('\n\n');
  }

  function buildStructuredSpecTextFromDraft(draft = {}) {
    const sections = [
      ['성공 조건', draft.successCriteria],
      ['제외 범위', draft.excludedScope]
    ].filter(([, value]) => String(value || '').trim());
    return sections.map(([title, value]) => `## ${title}\n\n${String(value || '').trim()}`).join('\n\n');
  }

  function buildProjectPayloadFromForm(form, options = {}) {
    const draft = options?.draft || {};
    const title = String(form.get('title') || '').trim() || String(draft.title || '').trim();
    const rootPath = String(form.get('rootPath') || '').trim() || String(draft.rootPath || '').trim();
    const charterText = String(form.get('charterText') || '').trim() || String(draft.charterText || '').trim();
    const defaultPresetId = String(form.get('defaultPresetId') || '').trim() || String(draft.defaultPresetId || '').trim() || 'auto';
    const phaseTitle = String(form.get('phaseTitle') || '').trim() || String(options?.preferDraftPhase ? draft.phaseTitle || '' : '').trim();
    const phaseGoal = String(form.get('phaseGoal') || '').trim() || String(options?.preferDraftPhase ? draft.phaseGoal || '' : '').trim();
    return {
      title,
      rootPath,
      charterText,
      defaultPresetId,
      bootstrapRepoDocs: Boolean(form.get('bootstrapRepoDocs')),
      phases: phaseTitle || phaseGoal
        ? [{ id: 'P001', title: phaseTitle || 'Foundation', goal: phaseGoal, status: 'active' }]
        : []
    };
  }

  function buildStarterRunPayload(project, intake, deps = {}) {
    const getRunPresetFormDefaults = deps?.getRunPresetFormDefaults || (() => ({ maxParallel: 1, maxTaskAttempts: 2, maxGoalLoops: 3 }));
    const draft = intake?.starterRunDraft || {};
    const presetId = draft.presetId || project?.defaultPresetId || 'auto';
    const defaults = getRunPresetFormDefaults(presetId);
    return {
      title: draft.title || `${project?.title || 'project'}-intake`,
      projectId: project?.id || '',
      projectPath: intake?.rootPath || project?.rootPath || '',
      presetId,
      objective: draft.objective || '',
      specText: buildStructuredSpecTextFromDraft(draft),
      specFiles: draft.specFilesText || '',
      settings: {
        maxParallel: defaults.maxParallel,
        maxTaskAttempts: defaults.maxTaskAttempts,
        maxGoalLoops: defaults.maxGoalLoops
      }
    };
  }

  function buildProjectSettingsPayload(doc, deps = {}) {
    const normalizeMaxChainDepth = deps?.normalizeMaxChainDepth || ((value) => Number(value) || 0);
    const toolActions = String(doc.getElementById('project-settings-tool-actions')?.value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const payload = {
      charterText: doc.getElementById('project-settings-charter')?.value || '',
      defaultPresetId: doc.getElementById('project-settings-preset')?.value || 'auto',
      providerProfile: {
        coordinationProvider: doc.getElementById('project-settings-coordination-provider')?.value || 'codex',
        workerProvider: doc.getElementById('project-settings-worker-provider')?.value || 'codex'
      },
      toolProfile: {
        id: doc.getElementById('project-settings-tool-id')?.value || 'default',
        label: doc.getElementById('project-settings-tool-label')?.value || 'Default',
        allowedActionClasses: toolActions
      },
      browserVerification: {
        url: doc.getElementById('project-settings-browser-url')?.value || ''
      },
      devServer: {
        command: doc.getElementById('project-settings-dev-command')?.value || ''
      },
      continuationPolicy: {
        mode: doc.getElementById('project-settings-continuation-mode')?.value || 'guided',
        autoChainOnComplete: doc.getElementById('project-settings-auto-chain')?.checked === true,
        autoQualitySweepOnPhaseComplete: doc.getElementById('project-settings-auto-sweep')?.checked === true,
        keepDocsInSync: doc.getElementById('project-settings-doc-sync')?.checked !== false,
        maxChainDepth: normalizeMaxChainDepth(doc.getElementById('project-settings-max-chain-depth')?.value || '')
      },
      autoProgress: {
        enabled: doc.getElementById('project-settings-supervisor-enabled')?.checked === true,
        scheduleEnabled: doc.getElementById('project-settings-schedule-enabled')?.checked === true,
        scheduleCron: doc.getElementById('project-settings-schedule-cron')?.value?.trim() || '',
        pollIntervalMs: Math.max(5000, Number(doc.getElementById('project-settings-poll-interval')?.value || 30000) || 30000)
      }
    };
    const runLoopEnabled = doc.getElementById('project-settings-run-loop-enabled')?.checked === true;
    if (runLoopEnabled) {
      payload.continuationPolicy.runLoop = {
        enabled: true,
        mode: doc.getElementById('project-settings-run-loop-mode')?.value || 'repeat-count',
        maxRuns: Math.max(1, Number(doc.getElementById('project-settings-run-loop-max-runs')?.value || 3) || 3),
        maxConsecutiveFailures: Math.max(1, Number(doc.getElementById('project-settings-run-loop-max-failures')?.value || 3) || 3)
      };
    }
    const pauseOnRepeatedFailures = doc.getElementById('project-settings-pause-on-failures')?.checked !== false;
    const maxConsecutiveFailures = Math.max(1, Number(doc.getElementById('project-settings-max-failures')?.value || 3) || 3);
    if (!pauseOnRepeatedFailures || maxConsecutiveFailures !== 3) {
      payload.autoProgress.pauseOnRepeatedFailures = pauseOnRepeatedFailures;
      payload.autoProgress.maxConsecutiveFailures = maxConsecutiveFailures;
    }
    return payload;
  }

  function createModalActions(deps) {
    const pickText = global.HarnessUiHelpers?.pickText || ((ko, en = '') => String(ko || en || ''));
    const t = (ko, en = '') => pickText(ko, en);
    const {
      request,
      runUiAction,
      setBanner,
      normalizeAgentModel,
      normalizePlanAgent,
      normalizePlanTask,
      renderPlanEditCollections,
      canEditPlan,
      getRuns,
      getSelectedRunId,
      setHarnessSettings,
      getPlanEditAgents,
      setPlanEditAgents,
      getPlanEditTasks,
      setPlanEditTasks,
      getSelectedTaskId,
      setSkipTaskTargetId,
      getSkipTaskTargetId,
      getProjectIntake,
      setProjectIntake,
      getProjectIntakeSelectedRoots,
      setProjectIntakeSelectedRoots,
      renderProjectIntake,
      projectIntakeRootSelected,
      setFieldValue,
      projectIntakeSummaryLine,
      setCreateRunDraftContext,
      getSelectedProjectSummary,
      describePreset,
      resolveProjectDisplayPhase,
      browserReadinessLabel,
      getProjectOverview,
      getSelectedProjectId,
      applyRunPresetDefaults,
      renderCreateRunContext,
      renderDraftDiagnostics,
      setDraftDiagnostics,
      getRunPresetFormDefaults,
      normalizeMaxChainDepth,
      refreshProjects,
      refreshProjectOverview,
      refreshRuns,
      selectRun,
      selectProject
    } = deps || {};
    let projectIntakeBusy = false;
    const presetStrategyTemplates = {
      'docs-spec-first': {
        customConstitution: 'Treat docs and acceptance criteria as the source of record for docs/spec-first phases. Prefer doc alignment before broad implementation.',
        plannerStrategy: 'Start with the smallest scope-locking or doc-alignment slice. Group tightly related docs only when they must move together.',
        teamStrategy: 'Lean on spec-locker and verifier before treating the phase as ready for implementation.'
      },
      'existing-repo-bugfix': {
        customConstitution: 'Do not change behavior until the failing path is reproduced or the exact before-state is pinned down.',
        plannerStrategy: 'Make reproduction explicit before the fix. Prefer sequential bugfix graphs unless the validation path is clearly independent.',
        teamStrategy: 'Use a strong bug reproducer and verifier pairing. Avoid broad implementation fan-out in the same subsystem.'
      },
      'existing-repo-feature': {
        customConstitution: 'Extend the current repo in bounded slices. Preserve adjacent behavior and docs contracts while landing only the requested feature scope.',
        plannerStrategy: 'Split work by clearly disjoint subsystems or file groups. Keep explicit verification on every behavior-changing slice.',
        teamStrategy: 'Keep planning and review conservative, and parallelize implementation only for truly disjoint slices.'
      },
      'refactor-stabilize': {
        customConstitution: 'Preserve observable behavior while restructuring. Prefer reversible slices and keep verification close to each refactor step.',
        plannerStrategy: 'Use smaller sequential tasks than feature work and keep acceptance focused on unchanged behavior.',
        teamStrategy: 'Bias toward verifier-heavy loops and avoid wide parallel refactors inside the same subsystem.'
      },
      'greenfield-app': {
        customConstitution: 'Lock architecture and boundaries before broad build-out. Grow the app in staged slices with explicit validation per slice.',
        plannerStrategy: 'Insert scaffold-locking or diagnosis work before broad implementation when the subsystem map is still uncertain.',
        teamStrategy: 'Use planner and integrator structure to keep greenfield fan-out coherent, but do not skip the initial scoping pass.'
      },
      auto: {
        customConstitution: 'Keep the run scoped to the current objective with the smallest safe diff and explicit verification.',
        plannerStrategy: 'Prefer dependency-aware task graphs over speculative breadth. Parallelize only when the scope is clearly disjoint.',
        teamStrategy: 'Keep planning and review conservative by default, and let implementation fan out only when file boundaries are stable.'
      }
    };

    function normalizeStrategyTemplateId(value) {
      const id = String(value || '').trim();
      return presetStrategyTemplates[id] ? id : 'auto';
    }

    function applyStrategyTemplatePreset(templateId = null) {
      const selectedId = normalizeStrategyTemplateId(templateId || document.getElementById('settings-strategy-template')?.value || 'auto');
      const template = presetStrategyTemplates[selectedId] || presetStrategyTemplates.auto;
      document.getElementById('settings-strategy-template').value = selectedId;
      document.getElementById('custom-constitution').value = template.customConstitution;
      document.getElementById('planner-strategy').value = template.plannerStrategy;
      document.getElementById('team-strategy').value = template.teamStrategy;
      setBanner(t('선택한 preset 기준으로 로컬 전략 메모를 채웠습니다.', 'Filled the local strategy notes from the selected preset baseline.'), 'info');
      return template;
    }

    async function openSettingsModal() {
      document.getElementById('settings-modal').style.display = 'flex';
      const harnessSettings = await request('/api/settings');
      const selectedProject = typeof getSelectedProjectSummary === 'function' ? getSelectedProjectSummary() : null;
      setHarnessSettings(harnessSettings);
      document.getElementById('include-global-agents').checked = harnessSettings.includeGlobalAgents !== false;
      document.getElementById('include-karpathy').checked = harnessSettings.includeKarpathyGuidelines !== false;
      document.getElementById('custom-constitution').value = harnessSettings.customConstitution || '';
      document.getElementById('planner-strategy').value = harnessSettings.plannerStrategy || '';
      document.getElementById('team-strategy').value = harnessSettings.teamStrategy || '';
      document.getElementById('coordination-provider').value = normalizeAgentModel(harnessSettings.coordinationProvider, 'codex');
      document.getElementById('worker-provider').value = normalizeAgentModel(harnessSettings.workerProvider, 'codex');
      document.getElementById('codex-runtime-profile').value = String(harnessSettings.codexRuntimeProfile || 'yolo').trim() || 'yolo';
      document.getElementById('codex-model').value = String(harnessSettings.codexModel || 'gpt-5.4').trim() || 'gpt-5.4';
      document.getElementById('codex-fast-mode').checked = harnessSettings.codexFastMode !== false;
      document.getElementById('ui-language').value = String(harnessSettings.uiLanguage || 'en').trim() || 'en';
      document.getElementById('agent-language').value = String(harnessSettings.agentLanguage || 'en').trim() || 'en';
      document.getElementById('codex-notes').value = harnessSettings.codexNotes || '';
      document.getElementById('claude-notes').value = harnessSettings.claudeNotes || '';
      document.getElementById('gemini-notes').value = harnessSettings.geminiNotes || '';
      document.getElementById('claude-model').value = harnessSettings.claudeModel || '';
      document.getElementById('gemini-model').value = harnessSettings.geminiModel || '';
      document.getElementById('gemini-project-id').value = harnessSettings.geminiProjectId || '';
      document.getElementById('settings-strategy-template').value = normalizeStrategyTemplateId(selectedProject?.defaultPresetId || 'auto');
    }

    function closeSettingsModal() {
      document.getElementById('settings-modal').style.display = 'none';
    }

    async function openPlanEditModal() {
      const run = (getRuns() || []).find((item) => item.id === getSelectedRunId());
      if (!run || !canEditPlan(run)) return;
      document.getElementById('plan-edit-summary').value = run.planSummary || '';
      document.getElementById('plan-edit-execution-model').value = run.executionModel || '';
      setPlanEditAgents((run.agents || []).map(normalizePlanAgent));
      setPlanEditTasks((run.tasks || []).map((task) => normalizePlanTask({
        id: task.id,
        title: task.title,
        goal: task.goal,
        dependsOn: task.dependsOn || [],
        filesLikely: task.filesLikely || [],
        constraints: task.constraints || [],
        acceptanceChecks: task.acceptanceChecks || []
      })));
      document.getElementById('plan-edit-modal').style.display = 'flex';
      renderPlanEditCollections();
    }

    function closePlanEditModal() {
      document.getElementById('plan-edit-modal').style.display = 'none';
    }

    function openRejectPlanModal() {
      document.getElementById('reject-plan-feedback').value = '';
      document.getElementById('reject-plan-modal').style.display = 'flex';
    }

    function closeRejectPlanModal() {
      document.getElementById('reject-plan-modal').style.display = 'none';
    }

    function openSkipTaskModal() {
      setSkipTaskTargetId(getSelectedTaskId());
      document.getElementById('skip-task-reason').value = t('사용자 판단으로 건너뜀', 'Skipped by operator decision');
      document.getElementById('skip-task-modal').style.display = 'flex';
    }

    function closeSkipTaskModal() {
      setSkipTaskTargetId('');
      document.getElementById('skip-task-modal').style.display = 'none';
    }

    async function pickFolder(inputId) {
      try {
        const result = await request('/api/pick-folder', {
          method: 'POST',
          body: JSON.stringify({
            initialPath: document.getElementById(inputId)?.value || '',
            uiLanguage: document?.documentElement?.lang || 'en'
          })
        });
        if (result.path) {
          document.getElementById(inputId).value = result.path;
        }
      } catch (error) {
        setBanner(error.message || t('폴더 선택 창을 열지 못했습니다.', 'Failed to open the folder picker.'));
      }
    }

    async function pickProjectFolder() {
      await pickFolder('project-path-input');
    }

    async function pickProjectRootFolder() {
      await pickFolder('project-root-input');
    }

    async function analyzeProjectIntakeDraft(selectedRootsOverride = null) {
      const rootPath = document.getElementById('project-root-input')?.value || '';
      const title = document.getElementById('project-title-input')?.value || '';
      if (!String(rootPath || '').trim()) {
        setBanner(t('프로젝트 루트 폴더를 먼저 입력하거나 선택하세요.', 'Enter or choose the project root folder first.'));
        return;
      }
      if (projectIntakeBusy) return;
      projectIntakeBusy = true;
      renderProjectIntake();
      try {
        const selectedRoots = Array.isArray(selectedRootsOverride) ? selectedRootsOverride : getProjectIntakeSelectedRoots();
        const projectIntake = await request('/api/projects/intake', {
          method: 'POST',
          body: JSON.stringify({ rootPath, title, selectedSpecRoots: selectedRoots })
        });
        setProjectIntake(projectIntake);
        setProjectIntakeSelectedRoots(Array.isArray(projectIntake?.docs?.selectedSpecRoots) ? projectIntake.docs.selectedSpecRoots : []);
        const autoApplied = applyProjectIntakeDraft({ onlyEmpty: true, silent: true });
        const bootstrap = document.getElementById('bootstrap-project-docs');
        if (bootstrap) bootstrap.checked = recommendBootstrapDocs(projectIntake);
        renderProjectIntake();
        setBanner(
          autoApplied
            ? t(
              `프로젝트 분석을 마쳤습니다. 비어 있던 칸은 자동으로 채웠고, 기본 문서 틀 만들기는 ${recommendBootstrapDocs(projectIntake) ? '켜기' : '끄기'}로 추천했습니다.`,
              `Project analysis is complete. Empty fields were auto-filled, and starter docs are recommended as ${recommendBootstrapDocs(projectIntake) ? 'on' : 'off'}.`
            )
            : t('프로젝트 분석을 마쳤습니다.', 'Project analysis is complete.'),
          'success'
        );
      } catch (error) {
        setProjectIntake(null);
        setProjectIntakeSelectedRoots([]);
        renderProjectIntake();
        setBanner(error.message || t('프로젝트 분석 중 오류가 발생했습니다.', 'An error occurred during project analysis.'));
      } finally {
        projectIntakeBusy = false;
        renderProjectIntake();
      }
    }

    async function toggleProjectIntakeSpecRoot(root) {
      const value = String(root || '').trim();
      if (!value) return;
      const next = projectIntakeRootSelected(value)
        ? getProjectIntakeSelectedRoots().filter((item) => item !== value)
        : [...getProjectIntakeSelectedRoots(), value];
      setProjectIntakeSelectedRoots(next);
      await analyzeProjectIntakeDraft(next);
    }

    function recommendBootstrapDocs(projectIntake) {
      const candidateCount = Array.isArray(projectIntake?.docs?.candidates) ? projectIntake.docs.candidates.length : 0;
      return candidateCount === 0;
    }

    function applyProjectIntakeDraft(options = {}) {
      const projectIntake = getProjectIntake();
      if (!projectIntake) return;
      const projectDraft = projectIntake.recommendedProject || {};
      const onlyEmpty = options.onlyEmpty === true;
      const silent = options.silent === true;
      const assignments = [
        ['project-title-input', projectDraft.title || ''],
        ['project-root-input', projectIntake.rootPath || ''],
        ['project-charter-input', projectDraft.charterText || ''],
        ['project-default-preset-input', projectDraft.defaultPresetId || 'auto'],
        ['project-phase-title-input', projectDraft.phaseTitle || ''],
        ['project-phase-goal-input', projectDraft.phaseGoal || '']
      ];
      let appliedCount = 0;
      for (const [fieldId, value] of assignments) {
        const currentValue = String(document.getElementById(fieldId)?.value || '').trim();
        if (onlyEmpty && currentValue) continue;
        setFieldValue(fieldId, value);
        appliedCount += 1;
      }
      if (!silent) {
        setBanner(t('추천 프로젝트 초안을 입력했습니다.', 'Applied the recommended project draft.'), 'success');
      }
      return appliedCount;
    }

    function populateRunFormFromDraft(intake) {
      const draft = intake?.starterRunDraft || {};
      setCreateRunDraftContext({
        title: intake?.recommendedProject?.title || '',
        phaseTitle: intake?.recommendedProject?.phaseTitle || '',
        summary: projectIntakeSummaryLine(intake)
      });
      setFieldValue('project-path-input', intake?.rootPath || '');
      setFieldValue('run-title-input', draft.title || '');
      setFieldValue('run-objective-input', draft.objective || '');
      setFieldValue('run-success-criteria-input', draft.successCriteria || '');
      setFieldValue('run-excluded-scope-input', draft.excludedScope || '');
      setFieldValue('run-spec-files-input', draft.specFilesText || '');
      setFieldValue('run-preset-input', draft.presetId || 'auto');
      applyRunPresetDefaults(draft.presetId || 'auto');
      renderCreateRunContext();
    }

    function openStarterRunFromIntake() {
      const intake = getProjectIntake();
      if (!intake) return;
      closeCreateProjectModal();
      openCreateModal();
      populateRunFormFromDraft(intake);
      setBanner(t('추천 첫 작업 초안을 열었습니다.', 'Opened the recommended first run draft.'), 'info');
    }

    async function createProjectAndStarterRunFromIntake() {
      const projectIntake = getProjectIntake();
      if (!projectIntake) return;
      await runUiAction('create-project-and-run', async () => {
        const projectForm = new FormData(document.getElementById('project-form'));
        const projectPayload = buildProjectPayloadFromForm(projectForm, {
          draft: {
            ...(projectIntake.recommendedProject || {}),
            rootPath: projectIntake.rootPath || projectIntake.recommendedProject?.rootPath || ''
          },
          preferDraftPhase: true
        });
        const project = await request('/api/projects', { method: 'POST', body: JSON.stringify(projectPayload) });
        const run = await request('/api/runs', {
          method: 'POST',
          body: JSON.stringify(buildStarterRunPayload(project, projectIntake, { getRunPresetFormDefaults }))
        });
        closeCreateProjectModal();
        await refreshProjects();
        await refreshRuns(true);
        await selectRun(run.id);
        }, t('프로젝트와 첫 작업을 만들었습니다. 다음으로 현재 단계 목표와 첫 계획을 확인하세요.', 'Created the project and first run. Check the current phase goal and the first plan next.'));
    }

    function openCreateModal() {
      document.getElementById('create-modal').style.display = 'flex';
      setDraftDiagnostics(null);
      const project = getSelectedProjectSummary();
      if (project) {
        const pathInput = document.getElementById('project-path-input');
        if (pathInput) pathInput.value = project.rootPath || '';
      }
      const presetId = project?.defaultPresetId || document.getElementById('run-preset-input')?.value || 'auto';
      setFieldValue('run-preset-input', presetId);
      applyRunPresetDefaults(presetId);
      renderCreateRunContext();
      renderDraftDiagnostics();
    }

    function closeCreateModal() {
      document.getElementById('create-modal').style.display = 'none';
      setDraftDiagnostics(null);
      setCreateRunDraftContext(null);
      renderCreateRunContext();
      document.getElementById('run-form')?.reset?.();
      renderDraftDiagnostics();
    }

    function openCreateProjectModal(options = {}) {
      document.getElementById('create-project-modal').style.display = 'flex';
      if (options.rootPath) setFieldValue('project-root-input', options.rootPath);
      if (options.title) setFieldValue('project-title-input', options.title);
      if (options.charterText) setFieldValue('project-charter-input', options.charterText);
      if (options.defaultPresetId) setFieldValue('project-default-preset-input', options.defaultPresetId);
      if (options.phaseTitle) setFieldValue('project-phase-title-input', options.phaseTitle);
      if (options.phaseGoal) setFieldValue('project-phase-goal-input', options.phaseGoal);
      const bootstrap = document.getElementById('bootstrap-project-docs');
      if (bootstrap) bootstrap.checked = options.bootstrapRepoDocs === true;
      const createOnlyBtn = document.getElementById('project-create-only-btn');
      if (createOnlyBtn) {
        createOnlyBtn.onclick = async () => {
          await runUiAction('create-project', async () => {
            const form = new FormData(document.getElementById('project-form'));
            const data = buildProjectPayloadFromForm(form);
            const project = await request('/api/projects', { method: 'POST', body: JSON.stringify(data) });
            closeCreateProjectModal();
            await refreshProjects();
            if (typeof selectProject === 'function') await selectProject(project.id);
          }, t('프로젝트를 만들었습니다.', 'Project created.'));
        };
      }
      renderProjectIntake();
    }

    function closeCreateProjectModal() {
      document.getElementById('create-project-modal').style.display = 'none';
      setProjectIntake(null);
      setProjectIntakeSelectedRoots([]);
      document.getElementById('project-form')?.reset?.();
      const bootstrap = document.getElementById('bootstrap-project-docs');
      if (bootstrap) bootstrap.checked = false;
      renderProjectIntake();
    }

    async function saveProjectSettings() {
      const selectedProjectId = typeof getSelectedProjectId === 'function' ? getSelectedProjectId() : '';
      if (!selectedProjectId) return;
      const payload = buildProjectSettingsPayload(document, { normalizeMaxChainDepth });
      await runUiAction('save-project-settings', async () => {
        await request(`/api/projects/${selectedProjectId}`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        if (typeof refreshProjectOverview === 'function') {
          await refreshProjectOverview(selectedProjectId, { render: false });
        }
        await refreshProjects();
        if (typeof global.renderDetail === 'function') {
          global.renderDetail();
        }
      }, t('프로젝트 기본 설정을 저장했습니다.', 'Saved the project defaults.'));
    }

    function attachFormHandlers() {
      document.getElementById('apply-strategy-template-btn').addEventListener('click', () => {
        applyStrategyTemplatePreset();
      });

      document.getElementById('harness-settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await runUiAction('save-settings', async () => {
          const settings = {
            includeGlobalAgents: document.getElementById('include-global-agents').checked,
            includeKarpathyGuidelines: document.getElementById('include-karpathy').checked,
            customConstitution: document.getElementById('custom-constitution').value,
            plannerStrategy: document.getElementById('planner-strategy').value,
            teamStrategy: document.getElementById('team-strategy').value,
            coordinationProvider: document.getElementById('coordination-provider').value,
            workerProvider: document.getElementById('worker-provider').value,
            codexRuntimeProfile: document.getElementById('codex-runtime-profile').value,
            codexModel: document.getElementById('codex-model').value,
            codexFastMode: document.getElementById('codex-fast-mode').checked,
            uiLanguage: document.getElementById('ui-language').value,
            agentLanguage: document.getElementById('agent-language').value,
            codexNotes: document.getElementById('codex-notes').value,
            claudeNotes: document.getElementById('claude-notes').value,
            geminiNotes: document.getElementById('gemini-notes').value,
            claudeModel: document.getElementById('claude-model').value,
            geminiModel: document.getElementById('gemini-model').value,
            geminiProjectId: document.getElementById('gemini-project-id').value
          };
          const savedSettings = await request('/api/settings', { method: 'POST', body: JSON.stringify(settings) });
          setHarnessSettings(savedSettings, true);
          closeSettingsModal();
        }, t('설정을 저장했습니다.', 'Settings saved.'));
      });

      document.getElementById('plan-edit-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await runUiAction('save-plan-edit', async () => {
          const payload = {
            summary: document.getElementById('plan-edit-summary').value,
            executionModel: document.getElementById('plan-edit-execution-model').value,
            agents: getPlanEditAgents().map(normalizePlanAgent),
            tasks: getPlanEditTasks().map(normalizePlanTask)
          };
          await request('/api/runs/' + getSelectedRunId() + '/plan-edit', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          closePlanEditModal();
          await refreshRuns();
        }, t('계획을 저장했습니다.', 'Plan saved.'));
      });

      document.getElementById('reject-plan-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await runUiAction('reject-plan', async () => {
          const feedback = document.getElementById('reject-plan-feedback').value.trim();
          await request('/api/runs/' + getSelectedRunId() + '/reject-plan', {
            method: 'POST',
            body: JSON.stringify({ feedback })
          });
          closeRejectPlanModal();
          await refreshRuns();
        }, t('계획을 반려했습니다.', 'Requested plan changes.'));
      });

      document.getElementById('skip-task-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await runUiAction('skip-task', async () => {
          if (!getSelectedRunId() || !getSkipTaskTargetId()) return;
          const reason = document.getElementById('skip-task-reason').value.trim();
          await request(`/api/runs/${getSelectedRunId()}/tasks/${getSkipTaskTargetId()}/skip`, {
            method: 'POST',
            body: JSON.stringify({ reason })
          });
          closeSkipTaskModal();
          await refreshRuns();
        }, t('태스크를 건너뛰었습니다.', 'Task skipped.'));
      });
    }

    return {
      attachFormHandlers,
      openSettingsModal,
      closeSettingsModal,
      openPlanEditModal,
      closePlanEditModal,
      openRejectPlanModal,
      closeRejectPlanModal,
      openSkipTaskModal,
      closeSkipTaskModal,
      pickProjectFolder,
      pickProjectRootFolder,
      analyzeProjectIntakeDraft,
      toggleProjectIntakeSpecRoot,
      applyProjectIntakeDraft,
      openStarterRunFromIntake,
      createProjectAndStarterRunFromIntake,
      applyStrategyTemplatePreset,
      buildStructuredSpecText,
      buildStructuredSpecTextFromDraft,
      buildProjectPayloadFromForm,
      buildStarterRunPayload: (project, intake) => buildStarterRunPayload(project, intake, { getRunPresetFormDefaults }),
      buildProjectSettingsPayload: () => buildProjectSettingsPayload(document, { normalizeMaxChainDepth }),
      saveProjectSettings,
      openCreateModal,
      closeCreateModal,
      openCreateProjectModal,
      closeCreateProjectModal
    };
  }

  global.HarnessUiModalActions = {
    createModalActions,
    buildStructuredSpecText,
    buildStructuredSpecTextFromDraft,
    buildProjectPayloadFromForm,
    buildStarterRunPayload,
    buildProjectSettingsPayload
  };
})(window);
