(function attachHarnessModalActions(global) {
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
      buildProjectPayloadFromForm,
      buildStarterRunPayload,
      refreshProjects,
      refreshRuns,
      selectRun,
      selectProject
    } = deps || {};
    let projectIntakeBusy = false;

    async function openSettingsModal() {
      document.getElementById('settings-modal').style.display = 'flex';
      const harnessSettings = await request('/api/settings');
      setHarnessSettings(harnessSettings);
      document.getElementById('include-global-agents').checked = harnessSettings.includeGlobalAgents !== false;
      document.getElementById('include-karpathy').checked = harnessSettings.includeKarpathyGuidelines !== false;
      document.getElementById('custom-constitution').value = harnessSettings.customConstitution || '';
      document.getElementById('planner-strategy').value = harnessSettings.plannerStrategy || '';
      document.getElementById('team-strategy').value = harnessSettings.teamStrategy || '';
      document.getElementById('coordination-provider').value = normalizeAgentModel(harnessSettings.coordinationProvider, 'codex');
      document.getElementById('worker-provider').value = normalizeAgentModel(harnessSettings.workerProvider, 'codex');
      document.getElementById('codex-runtime-profile').value = String(harnessSettings.codexRuntimeProfile || 'yolo').trim() || 'yolo';
      document.getElementById('ui-language').value = String(harnessSettings.uiLanguage || 'en').trim() || 'en';
      document.getElementById('agent-language').value = String(harnessSettings.agentLanguage || 'en').trim() || 'en';
      document.getElementById('codex-notes').value = harnessSettings.codexNotes || '';
      document.getElementById('claude-notes').value = harnessSettings.claudeNotes || '';
      document.getElementById('gemini-notes').value = harnessSettings.geminiNotes || '';
      document.getElementById('claude-model').value = harnessSettings.claudeModel || '';
      document.getElementById('gemini-model').value = harnessSettings.geminiModel || '';
      document.getElementById('gemini-project-id').value = harnessSettings.geminiProjectId || '';
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
          body: JSON.stringify(buildStarterRunPayload(project, projectIntake))
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

    function attachFormHandlers() {
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
      openCreateModal,
      closeCreateModal,
      openCreateProjectModal,
      closeCreateProjectModal
    };
  }

  global.HarnessUiModalActions = {
    createModalActions
  };
})(window);
