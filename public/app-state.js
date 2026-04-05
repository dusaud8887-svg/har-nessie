(function () {
  function createUiState(initial = {}) {
    return {
      runs: [],
      projects: [],
      selectedRunId: '',
      selectedProjectId: '',
      selectedTab: 'dashboard',
      selectedTaskId: '',
      artifactState: new Map(),
      projectOverviewState: new Map(),
      clarifyDraftAnswers: new Map(),
      harnessSettings: null,
      systemInfo: null,
      draftDiagnostics: null,
      refreshTimer: null,
      projectOverviewRefreshTimer: null,
      busyActions: new Set(),
      planEditAgents: [],
      planEditTasks: [],
      skipTaskTargetId: '',
      artifactLoadingKey: '',
      detailUiStateByView: new Map(),
      currentDetailViewKey: '',
      runSelectionSeq: 0,
      projectSearchQuery: '',
      runSearchQuery: '',
      projectFilterMode: 'all',
      projectIntake: null,
      projectIntakeSelectedRoots: [],
      createRunDraftContext: null,
      recentPhaseTransitionsByProjectId: new Map(),
      bannerState: { message: '', tone: 'error' },
      toastState: { message: '', tone: 'info' },
      bannerTimer: null,
      toastTimer: null,
      ...initial
    };
  }

  function bindGlobalState(state, keys = []) {
    for (const key of keys) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: true,
        get() {
          return state[key];
        },
        set(value) {
          state[key] = value;
        }
      });
    }
    return state;
  }

  window.HarnessUiState = {
    createUiState,
    bindGlobalState
  };
})();
