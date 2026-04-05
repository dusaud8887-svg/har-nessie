import { promises as fs } from 'node:fs';

export async function recoverPersistedRunsAfterRestart({
  RUNS_DIR,
  runtimeObservability,
  readJson,
  statePath,
  writeJson,
  serializeState,
  writeRunCheckpoint,
  taskWorkspaceDir,
  resolveGitProject,
  runGit,
  uniqueBy,
  now
}) {
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const state = await readJson(statePath(runId)).catch(() => null);
    if (!state) continue;

    let changed = false;
    if (state.status === 'running') {
      state.status = 'stopped';
      changed = true;
    }

    for (const task of Array.isArray(state.tasks) ? state.tasks : []) {
      if (task.status === 'in_progress') {
        task.status = 'ready';
        task.reviewSummary = task.reviewSummary || 'Recovered after harness restart.';
        task.findings = uniqueBy([...(task.findings || []), 'Recovered after harness restart.'], (item) => item);
        changed = true;
      }
      const workspaceDir = taskWorkspaceDir(runId, task.id);
      const workspaceExists = await fs.access(workspaceDir).then(() => true).catch(() => false);
      if (task.lastExecution?.workspaceMode === 'git-worktree' || workspaceExists) {
        const gitRoot = await runtimeObservability.withObservedFallback(
          () => resolveGitProject(state.projectPath || ''),
          { scope: 'run-recovery.resolve-git-project', context: { runId, taskId: task.id }, fallback: null }
        );
        if (gitRoot) {
          await runtimeObservability.withObservedFallback(
            () => runGit(gitRoot, ['worktree', 'remove', '--force', workspaceDir], null, false),
            { scope: 'run-recovery.remove-worktree', context: { runId, taskId: task.id, workspaceDir }, fallback: null }
          );
        }
        await runtimeObservability.withObservedFallback(
          () => fs.rm(workspaceDir, { recursive: true, force: true }),
          { scope: 'run-recovery.remove-workspace-dir', context: { runId, taskId: task.id, workspaceDir }, fallback: null }
        );
      }
    }

    if (changed) {
      await writeJson(statePath(runId), serializeState({ ...state, updatedAt: now() }));
      await runtimeObservability.withObservedFallback(
        () => writeRunCheckpoint(runId, 'recovered-after-restart'),
        { scope: 'run-recovery.write-checkpoint', context: { runId }, fallback: null }
      );
    }
  }
}
