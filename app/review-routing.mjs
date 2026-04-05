function normalizeChangedPaths(changedFiles = []) {
  return changedFiles
    .map((item) => String(item?.path || item || '').trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function isDocsOnlyReviewCandidate(paths) {
  if (!paths.length || paths.length > 3) return false;
  return paths.every((filePath) => /\.(md|mdx|txt)$/i.test(filePath));
}

function isHighRiskReviewTask(run, task, changedPaths) {
  const haystack = [
    run.preset?.id || '',
    task.title,
    task.goal,
    ...(task.constraints || []),
    ...(task.acceptanceChecks || []),
    ...changedPaths
  ].join('\n').toLowerCase();
  const patterns = [
    'bugfix',
    'refactor',
    'auth',
    'security',
    'payment',
    'billing',
    'schema',
    'migration',
    'database',
    'public api',
    'breaking',
    'package.json',
    'pnpm-lock',
    'package-lock',
    'yarn.lock',
    '.env',
    'dockerfile'
  ];
  return patterns.some((pattern) => haystack.includes(pattern));
}

function buildPrescreenReview(decision, summary, findings, route) {
  return {
    decision,
    summary,
    findings,
    updatedTask: {},
    reviewer: 'rule-prescreen',
    route
  };
}

export function isReadOnlyVerificationTask(task) {
  const constraintText = Array.isArray(task?.constraints) ? task.constraints.join('\n') : '';
  return /read-only review|do not edit any files|read-only|읽기 전용|파일을 수정하지 않는다|파일을 수정하지 않음|수정하지 않는다|코드를 수정하지 않는다/i.test(constraintText);
}

function taskContainsText(task, patterns) {
  const haystack = [
    task?.title,
    task?.goal,
    ...(Array.isArray(task?.constraints) ? task.constraints : []),
    ...(Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks : [])
  ].join('\n').toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

function taskCanSucceedWithoutRepoDiff(task) {
  if (isReadOnlyVerificationTask(task)) return true;
  return taskContainsText(task, [
    'spec',
    'acceptance',
    'scope',
    'requirements',
    'verify',
    'verification',
    'read-only',
    'do not implement',
    'inspect',
    'analysis',
    'confirm',
    'reproduce'
  ]);
}

export function decideReviewRoute(run, task, changedFiles, scopeSummary, verification) {
  const changedPaths = normalizeChangedPaths(changedFiles);
  if (!changedPaths.length) {
    if (taskCanSucceedWithoutRepoDiff(task)) {
      return null;
    }
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because no file changes were detected.',
      ['No file changes were detected after Codex execution.'],
      'rule-blocked'
    );
  }
  if ((scopeSummary?.outOfScopeFiles || []).length > 0) {
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because out-of-scope files changed.',
      [`Out-of-scope files changed: ${scopeSummary.outOfScopeFiles.join(', ')}`],
      'rule-blocked'
    );
  }
  if (verification?.ok === false) {
    return buildPrescreenReview(
      'retry',
      'Rule-based prescreen blocked this task because automatic verification failed.',
      [`Automatic verification failed: ${(verification.selectedCommands || []).join(' | ') || 'No command recorded.'}`],
      'rule-blocked'
    );
  }
  if (!isHighRiskReviewTask(run, task, changedPaths) && isDocsOnlyReviewCandidate(changedPaths)) {
    return buildPrescreenReview(
      'approve',
      'Rule-based prescreen auto-approved this low-risk docs-only change.',
      [`Docs-only changed files: ${changedPaths.join(', ')}`],
      'rule-auto-approve'
    );
  }
  return null;
}
