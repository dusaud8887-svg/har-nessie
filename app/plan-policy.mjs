function normalizePolicyTaskFiles(filesLikely) {
  if (!Array.isArray(filesLikely)) return [];
  const seen = new Set();
  const normalized = [];
  for (const value of filesLikely) {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
  }
  return normalized;
}

export function defaultExecutionPolicy(profile = null) {
  return {
    pattern: 'pipeline',
    parallelMode: profile?.flowProfile || 'sequential',
    policyNotes: profile ? [
      `Task budget: ${profile.taskBudget}`,
      `File budget: ${profile.fileBudget}`,
      `Diagnosis-first: ${profile.diagnosisFirst === false ? 'optional' : 'required'}`,
      `Fresh session threshold: ${profile.freshSessionThreshold}`
    ] : [],
    appliedRules: [],
    syntheticTasks: [],
    verificationNudgeNeeded: false
  };
}

function recordExecutionPolicyRule(policy, rule = {}) {
  if (!policy) return;
  const title = String(rule.title || '').trim();
  const reason = String(rule.reason || '').trim();
  const effect = String(rule.effect || '').trim();
  if (!title && !reason && !effect) return;
  const syntheticTask = rule.syntheticTask && typeof rule.syntheticTask === 'object'
    ? {
        title: String(rule.syntheticTask.title || '').trim(),
        kind: String(rule.syntheticTask.kind || '').trim() || 'synthetic'
      }
    : null;
  policy.appliedRules.push({
    id: String(rule.id || '').trim() || `rule-${policy.appliedRules.length + 1}`,
    kind: String(rule.kind || '').trim() || 'note',
    title,
    reason,
    effect,
    syntheticTask
  });
}

function taskContainsText(task, patterns) {
  const haystack = [
    task.title,
    task.goal,
    ...(task.constraints || []),
    ...(task.acceptanceChecks || [])
  ].join('\n').toLowerCase();
  return patterns.some((pattern) => haystack.includes(pattern));
}

function injectSyntheticTask(rawTasks, taskShape, position = 'prepend') {
  return position === 'prepend' ? [taskShape, ...rawTasks] : [...rawTasks, taskShape];
}

function injectLeadingGateTask(rawTasks, taskShape) {
  return injectSyntheticTask(
    rawTasks.map((task) => ({
      ...task,
      dependsOn: Array.isArray(task?.dependsOn) && task.dependsOn.length
        ? task.dependsOn.map(String)
        : ['__RAW_0']
    })),
    {
      ...taskShape,
      dependsOn: Array.isArray(taskShape?.dependsOn) ? taskShape.dependsOn.map(String) : []
    },
    'prepend'
  );
}

function hasMultiDependencyTask(tasks) {
  return tasks.some((task) => Array.isArray(task.dependsOn) && task.dependsOn.length >= 2);
}

function isDocsOnlyPath(filePath) {
  return /^docs\//i.test(filePath) || /\.(md|mdx|txt)$/i.test(filePath);
}

function taskLooksDocsOnly(task) {
  const files = normalizePolicyTaskFiles(task?.filesLikely);
  if (files.length > 0 && files.every((filePath) => isDocsOnlyPath(filePath))) return true;
  return taskContainsText(task, ['readme', 'docs', 'spec', 'acceptance', 'requirements', 'architecture'])
    && !taskContainsText(task, ['test', 'verify', 'verification', 'bug', 'fix', 'feature', 'refactor', 'api', 'schema', 'migration']);
}

function planLooksDocsOnly(rawTasks) {
  return rawTasks.length > 0 && rawTasks.every((task) => taskLooksDocsOnly(task));
}

function taskHasVerificationIntent(task) {
  return taskContainsText(task, [
    'verify',
    'verification',
    'validated',
    'test',
    'tests',
    'lint',
    'typecheck',
    'build',
    'smoke',
    'reproduce',
    'regression',
    'pytest',
    'npm run',
    'pnpm ',
    'cargo test',
    'go test',
    'curl ',
    'returns ',
    'exits '
  ]);
}

function planNeedsVerificationNudge(run, rawTasks) {
  const validationCommands = Array.isArray(run?.projectContext?.validationCommands) ? run.projectContext.validationCommands : [];
  if (!rawTasks.length) return false;
  if (planLooksDocsOnly(rawTasks)) return false;
  if (!validationCommands.length && (run?.preset?.id || '') !== 'existing-repo-bugfix') return false;
  return !rawTasks.some((task) => taskHasVerificationIntent(task));
}

function taskNeedsDiagnosis(task, fileBudget = 0) {
  const files = normalizePolicyTaskFiles(task?.filesLikely);
  if (!files.length) return true;
  if (fileBudget && files.length > fileBudget) return true;
  return taskContainsText(task, ['foundation', 'architecture', 'wire', 'bootstrap', 'set up', 'scaffold'])
    && !taskContainsText(task, ['diagnose', 'analysis', 'inspect', 'map', 'audit', 'reproduce', 'verify']);
}

function planHasDiagnosisTask(rawTasks) {
  return rawTasks.some((task) => taskContainsText(task, ['diagnose', 'analysis', 'inspect', 'map', 'audit', 'reproduce', 'verify'])
    || /read-only|do not implement|do not edit/i.test((task?.constraints || []).join('\n')));
}

export function applyPlanPolicy(run, parsed) {
  let rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks.map((item) => ({ ...item })) : [];
  const pattern = String(run.clarify?.architecturePattern || 'pipeline').trim() || 'pipeline';
  const worktreeEligible = run?.preflight?.project?.worktreeEligible !== false;
  const policy = {
    ...defaultExecutionPolicy(run.profile),
    pattern
  };

  if (pattern === 'fan-out/fan-in' || pattern === 'expert-pool') {
    policy.parallelMode = 'parallel';
  }
  if (pattern === 'pipeline' || pattern === 'producer-reviewer' || pattern === 'supervisor') {
    policy.parallelMode = 'sequential';
  }
  if ((run?.profile?.flowProfile || 'sequential') === 'hybrid') {
    policy.parallelMode = 'parallel';
    policy.policyNotes.push('Hybrid flow profile keeps parallel execution available when filesLikely are clearly disjoint.');
    recordExecutionPolicyRule(policy, {
      id: 'hybrid-parallel',
      kind: 'parallelism',
      title: 'Hybrid flow kept parallel execution available',
      reason: 'The active flow profile is hybrid, so disjoint filesLikely slices can still run in parallel.',
      effect: 'The planner may keep parallel branches instead of forcing a pure sequential pipeline.'
    });
  } else {
    policy.parallelMode = 'sequential';
  }
  if (policy.parallelMode === 'parallel' && !worktreeEligible) {
    policy.parallelMode = 'sequential';
    policy.policyNotes.push('Parallel execution was downgraded because isolated worktrees are unavailable for this repo state.');
    recordExecutionPolicyRule(policy, {
      id: 'parallel-downgraded',
      kind: 'safety',
      title: 'Parallel execution was downgraded to sequential',
      reason: 'This repo state cannot safely isolate parallel file edits with worktrees.',
      effect: 'The harness will serialize the task queue to avoid overlapping writes.'
    });
  }

  if (run?.profile?.diagnosisFirst && !planLooksDocsOnly(rawTasks) && !planHasDiagnosisTask(rawTasks)) {
    const fileBudget = Number(run?.profile?.fileBudget || 0);
    const needsDiagnosis = (run?.preset?.id || '') === 'greenfield-app'
      || rawTasks.some((task) => taskNeedsDiagnosis(task, fileBudget));
    if (needsDiagnosis) {
      const diagnosisTask = {
        title: 'Diagnose current phase scope and lock implementation boundaries',
        goal: 'Narrow down the current phase goal, excluded scope, and concrete filesLikely before handing off to implementation tasks.',
        dependsOn: [],
        filesLikely: [],
        constraints: [
          'Read-only diagnosis.',
          'Do not implement changes yet.',
          'Do not expand scope beyond the current project phase.'
        ],
        acceptanceChecks: [
          `filesLikely for follow-on tasks is narrowed to within file budget ${fileBudget || '-'}.`,
          'Current phase goal and excluded scope are written back into the backlog.'
        ]
      };
      rawTasks = injectLeadingGateTask(rawTasks, { ...diagnosisTask });
      policy.syntheticTasks.push('diagnosis-first');
      policy.policyNotes.push('Diagnosis-first profile injected a read-only scoping task before implementation.');
      recordExecutionPolicyRule(policy, {
        id: 'diagnosis-first',
        kind: 'synthetic-task',
        title: 'A diagnosis-first gate task was injected',
        reason: `The plan looked broad for the current file budget (${fileBudget || '-'}) or lacked an explicit scoping pass.`,
        effect: 'Implementation tasks now wait for a read-only scope-lock pass before edits begin.',
        syntheticTask: { title: diagnosisTask.title, kind: 'gate' }
      });
    }
  }

  if (run?.profile?.taskBudget && rawTasks.length > Number(run.profile.taskBudget)) {
    policy.policyNotes.push(`Planned task count (${rawTasks.length}) exceeds the active task budget (${run.profile.taskBudget}). Keep this run scoped to the current phase slice.`);
    recordExecutionPolicyRule(policy, {
      id: 'task-budget-warning',
      kind: 'scope',
      title: 'The plan exceeded the active task budget',
      reason: `The planner proposed ${rawTasks.length} tasks while this profile is capped at ${run.profile.taskBudget}.`,
      effect: 'Operators should expect a narrower phase slice or an earlier replan if scope keeps drifting.'
    });
  }

  if ((run.preset?.id || 'auto') === 'existing-repo-bugfix') {
    policy.parallelMode = 'sequential';
    if (!rawTasks.some((task) => taskContainsText(task, ['reproduce', 'regression', 'failing', 'test']))) {
      const bugfixTask = {
        title: 'Reproduce the bug before implementation',
        goal: 'Identify a failing check, reproduction path, or precise before-state for the reported bug before changing behavior.',
        dependsOn: [],
        filesLikely: [],
        constraints: ['Do not implement the fix yet.', 'Capture a reproducible failing check or exact reproduction steps first.'],
        acceptanceChecks: ['A failing test, command, or explicit reproduction path is documented for later validation.']
      };
      rawTasks = injectLeadingGateTask(rawTasks, { ...bugfixTask });
      policy.syntheticTasks.push('bugfix-repro');
      policy.policyNotes.push('Bugfix preset injected a reproduction task before implementation.');
      recordExecutionPolicyRule(policy, {
        id: 'bugfix-repro',
        kind: 'synthetic-task',
        title: 'A bug reproduction gate task was injected',
        reason: 'Bugfix runs should capture a failing test, command, or explicit reproduction path before changing behavior.',
        effect: 'The harness inserted a reproducibility checkpoint ahead of implementation.',
        syntheticTask: { title: bugfixTask.title, kind: 'gate' }
      });
    }
  }

  if ((run.preset?.id || 'auto') === 'docs-spec-first') {
    if (!rawTasks.some((task) => taskContainsText(task, ['spec', 'acceptance', 'doc', 'docs', 'requirements']))) {
      const docsSpecTask = {
        title: 'Lock the spec and acceptance criteria',
        goal: 'Clarify the spec, acceptance criteria, and excluded scope before implementation begins.',
        dependsOn: [],
        filesLikely: ['README.md', 'docs/'],
        constraints: ['Do not start implementation until the spec task is complete.'],
        acceptanceChecks: ['Acceptance criteria and exclusions are written down in repo docs or the task handoff.']
      };
      rawTasks = injectLeadingGateTask(rawTasks, { ...docsSpecTask });
      policy.syntheticTasks.push('docs-spec');
      policy.policyNotes.push('Docs-first preset injected a spec-alignment task before implementation.');
      recordExecutionPolicyRule(policy, {
        id: 'docs-spec',
        kind: 'synthetic-task',
        title: 'A docs/spec alignment gate task was injected',
        reason: 'Docs-first runs should lock acceptance criteria before implementation starts.',
        effect: 'The plan now opens with a spec alignment pass inside docs/ or README files.',
        syntheticTask: { title: docsSpecTask.title, kind: 'gate' }
      });
    }
  }

  if (pattern === 'fan-out/fan-in' && rawTasks.length >= 2 && !hasMultiDependencyTask(rawTasks)) {
    const fanOutCandidates = rawTasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => !Array.isArray(task.dependsOn) || task.dependsOn.length === 0)
      .slice(0, 4);
    if (fanOutCandidates.length >= 2) {
      const integrationTask = {
        title: 'Integrate fan-out task results',
        goal: 'Combine and validate the outputs of the parallel implementation tasks into one coherent result.',
        dependsOn: fanOutCandidates.map(({ index }) => `__RAW_${index}`),
        filesLikely: [],
        constraints: ['Review the outputs of parallel tasks together before finalizing.'],
        acceptanceChecks: ['Integration changes are validated against the combined acceptance criteria.']
      };
      rawTasks = injectSyntheticTask(rawTasks, { ...integrationTask }, 'append');
      policy.syntheticTasks.push('fan-in');
      policy.policyNotes.push('Fan-out/fan-in pattern injected an explicit integration task.');
      recordExecutionPolicyRule(policy, {
        id: 'fan-in',
        kind: 'synthetic-task',
        title: 'An explicit fan-in integration task was injected',
        reason: 'Parallel branches were present without a later task that depends on both branches.',
        effect: 'The harness appended a join step so the run closes with one integration pass.',
        syntheticTask: { title: integrationTask.title, kind: 'integration' }
      });
    }
  }

  if (planNeedsVerificationNudge(run, rawTasks)) {
    const verificationTask = {
      title: 'Verify the integrated changes mechanically',
      goal: 'Inspect the changed workspace without editing files, run the smallest applicable verification commands, and record evidence for every acceptance check.',
      dependsOn: rawTasks.map((_, index) => `__RAW_${index}`),
      filesLikely: [],
      constraints: ['Read-only verification.', 'Do not edit any files.', 'Use the harness-selected verification commands when they apply.'],
      acceptanceChecks: [
        'The selected verification commands exit 0 or each failure is captured precisely.',
        'Each acceptance check is marked PASS, FAIL, or UNABLE-TO-VERIFY with evidence.'
      ]
    };
    rawTasks = injectSyntheticTask(rawTasks, { ...verificationTask }, 'append');
    policy.syntheticTasks.push('verification-nudge');
    policy.policyNotes.push('A read-only verification task was injected because the original plan lacked an explicit mechanical verification step.');
    policy.verificationNudgeNeeded = true;
    recordExecutionPolicyRule(policy, {
      id: 'verification-nudge',
      kind: 'synthetic-task',
      title: 'A mechanical verification task was injected',
      reason: 'The original task list lacked an explicit read-only verification step even though the run has verification commands or a bugfix posture.',
      effect: 'The plan now ends with a non-editing verification pass that records evidence against acceptance checks.',
      syntheticTask: { title: verificationTask.title, kind: 'verification' }
    });
  }

  return { rawTasks, policy };
}
