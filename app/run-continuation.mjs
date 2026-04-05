function isTaskTerminalStatus(status) {
  return status === 'done' || status === 'skipped' || status === 'failed';
}

function clipContinuationText(text, maxChars = 1200) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function taskHasFailedAcceptanceCheck(task) {
  const results = Array.isArray(task?.lastExecution?.acceptanceCheckResults)
    ? task.lastExecution.acceptanceCheckResults
    : [];
  return results.some((item) => String(item?.status || '').trim().toLowerCase() === 'fail');
}

function taskHistoryRank(task) {
  const lastRunAt = Date.parse(task?.lastExecution?.lastRunAt || '') || 0;
  const statusWeight = task?.status === 'failed'
    ? 3
    : (task?.status === 'in_progress' ? 2 : (task?.status === 'ready' ? 1 : 0));
  return lastRunAt + (Number(task?.attempts || 0) * 1000) + statusWeight;
}

function compactTaskLedgerLine(task, focusTaskId = '') {
  const bits = [`${task.id} ${task.status || 'unknown'}`];
  if (focusTaskId && task.id === focusTaskId) bits.push('FOCUS');
  if (task.attempts) bits.push(`attempts=${task.attempts}`);
  if (taskHasFailedAcceptanceCheck(task)) bits.push('acceptance=failed');
  if (task.reviewSummary) {
    bits.push(clipContinuationText(task.reviewSummary, 120));
  } else if (task.goal) {
    bits.push(clipContinuationText(task.goal, 120));
  }
  return bits.join(' | ');
}

export function buildContinuationPromptLines(run, focusTaskId = '') {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const activeTask = tasks.find((task) => task.id === focusTaskId)
    || tasks.find((task) => task.status === 'in_progress')
    || tasks.find((task) => task.status === 'ready')
    || tasks.find((task) => task.status === 'failed')
    || null;
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    ready: tasks.filter((task) => task.status === 'ready').length,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length
  };
  const recentTasks = tasks
    .filter((task) => task.attempts || isTaskTerminalStatus(task.status) || task.status === 'in_progress' || task.id === focusTaskId)
    .sort((left, right) => taskHistoryRank(right) - taskHistoryRank(left))
    .slice(0, 5)
    .map((task) => compactTaskLedgerLine(task, focusTaskId));

  const summaryParts = [];
  if (!counts.total) {
    summaryParts.push('No prior task execution is recorded yet.');
  } else {
    summaryParts.push(`tasks=${counts.total}`);
    summaryParts.push(`done=${counts.done}`);
    summaryParts.push(`failed=${counts.failed}`);
    if (counts.inProgress) summaryParts.push(`in_progress=${counts.inProgress}`);
    if (counts.ready) summaryParts.push(`ready=${counts.ready}`);
  }
  if (run?.goalLoops) summaryParts.push(`goalLoops=${run.goalLoops}`);
  if (run?.result?.summary) summaryParts.push(`latestResult=${clipContinuationText(run.result.summary, 140)}`);
  if (run?.autoReplan?.latest?.summary) summaryParts.push(`latestReplan=${clipContinuationText(run.autoReplan.latest.summary, 140)}`);

  const lines = [
    'Continuation context:',
    `- Summary: ${summaryParts.join(' | ')}`,
    activeTask ? `- Current focus: ${activeTask.id} ${activeTask.title}` : '- Current focus: none',
    run?.profile
      ? `- Active profile: flow=${run.profile.flowProfile || 'sequential'} | taskBudget=${run.profile.taskBudget ?? '-'} | fileBudget=${run.profile.fileBudget ?? '-'} | diagnosisFirst=${run.profile.diagnosisFirst === false ? 'optional' : 'required'}`
      : '- Active profile: default',
    run?.profile?.freshSessionThreshold
      ? `- Fresh session policy: ${run.profile.freshSessionThreshold}. If this threshold is crossed, stop and recommend a fresh session instead of forcing more replans.`
      : '- Fresh session policy: none',
    run?.project?.phaseTitle
      ? `- Current phase boundary: stay inside ${run.project.phaseTitle}${run.project.phaseGoal ? ` | ${run.project.phaseGoal}` : ''}`
      : '- Current phase boundary: current run objective only',
    '- Direct resume rule: Continue from the latest unresolved task, failed check, or review decision. Do not restate the entire run history unless it changes the next action.'
  ];
  if (recentTasks.length) {
    lines.push('- Compact task ledger:');
    for (const item of recentTasks) {
      lines.push(`  - ${item}`);
    }
  }
  return lines;
}
