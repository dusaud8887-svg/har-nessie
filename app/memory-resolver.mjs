export function createMemoryResolver(deps) {
  const {
    ROOT_DIR,
    loadState,
    saveState,
    searchProjectMemory,
    withLock
  } = deps;

  async function resolvePromptMemory(run, query, limit = 4, options = {}) {
    if (!run.memory?.projectKey) {
      return {
        memoryFile: '',
        dailyDir: '',
        recentSummary: '',
        searchQuery: '',
        searchResults: [],
        retrievedContext: 'No relevant project memory found.',
        searchBackend: 'none',
        failureAnalytics: null,
        traceSummary: null,
        graphInsights: { topEdges: [], topSymbols: [] },
        temporalInsights: { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
      };
    }
    return searchProjectMemory(ROOT_DIR, run.memory.projectKey, query, limit, {
      projectPath: run.projectPath || ''
    }, options);
  }

  async function applyMemorySnapshot(runId, snapshot) {
    await withLock(runId, async () => {
      const fresh = await loadState(runId);
      fresh.memory = {
        ...fresh.memory,
        dir: snapshot.baseDir,
        memoryFile: snapshot.memoryFile,
        dailyDir: snapshot.dailyDir,
        dailyFile: snapshot.dailyFile,
        indexFile: snapshot.indexFile,
        recentSummary: snapshot.recentSummary,
        searchQuery: snapshot.searchQuery,
        searchResults: snapshot.searchResults,
        retrievedContext: snapshot.retrievedContext,
        searchBackend: snapshot.searchBackend,
        failureAnalytics: snapshot.failureAnalytics || null,
        traceSummary: snapshot.traceSummary || null,
        graphInsights: snapshot.graphInsights || { topEdges: [], topSymbols: [] },
        temporalInsights: snapshot.temporalInsights || { activeDecisions: [], activeFiles: [], activeRootCauses: [], recentShare: 0 }
      };
      await saveState(fresh);
    });
  }

  async function refreshRunMemory(runId, query) {
    const run = await loadState(runId);
    const snapshot = await resolvePromptMemory(
      run,
      query || run.clarify?.clarifiedObjective || run.input.objective || run.title,
      4
    );
    await applyMemorySnapshot(runId, snapshot);
    return snapshot;
  }

  return {
    resolvePromptMemory,
    applyMemorySnapshot,
    refreshRunMemory
  };
}
