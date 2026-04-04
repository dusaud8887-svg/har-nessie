export const DEFAULT_SETTINGS = {
  maxParallel: 1,
  maxTaskAttempts: 2,
  maxGoalLoops: 3,
  requirePlanApproval: true,
  codexRuntimeProfile: 'yolo',
  codexModel: 'gpt-5.4',
  codexReasoningEffort: 'high',
  codexServiceTier: 'fast',
  claudeModel: '',
  geminiModel: 'gemini-2.5-flash',
  geminiProjectId: ''
};

export const CODEX_RUNTIME_PROFILES = {
  safe: {
    id: 'safe',
    label: 'Safe',
    approvalPolicy: 'untrusted',
    sandboxMode: 'read-only',
    summary: 'Read-mostly. Most write operations are blocked. Good for inspection runs.'
  },
  'full-auto': {
    id: 'full-auto',
    label: 'Full Auto',
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
    summary: 'Auto-execute within the workspace. Dangerous commands may still prompt for approval.'
  },
  yolo: {
    id: 'yolo',
    label: 'Yolo',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    summary: 'Full write access, no approval prompts. Fast, but runs without guardrails.'
  }
};

export function normalizeCodexRuntimeProfile(value, fallback = DEFAULT_SETTINGS.codexRuntimeProfile) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.hasOwn(CODEX_RUNTIME_PROFILES, normalized) ? normalized : fallback;
}

export const SUPPORTED_AGENT_PROVIDERS = new Set(['codex', 'claude', 'gemini']);

export const HARNESS_PATTERNS = [
  'pipeline',
  'fan-out/fan-in',
  'producer-reviewer',
  'supervisor',
  'expert-pool',
  'hierarchical-delegation'
];

export const RUN_PRESETS = [
  {
    id: 'auto',
    name: 'Auto',
    description: 'The harness chooses the closest execution mode from the request.'
  },
  {
    id: 'existing-repo-feature',
    name: 'Existing Repo Feature',
    description: 'Add or extend a feature in an existing codebase with implementation and validation.'
  },
  {
    id: 'existing-repo-bugfix',
    name: 'Existing Repo Bugfix',
    description: 'Reproduce, fix, validate, and stop at the smallest safe diff.'
  },
  {
    id: 'greenfield-app',
    name: 'Greenfield App',
    description: 'Create a new app or module from a spec with staged build-out.'
  },
  {
    id: 'refactor-stabilize',
    name: 'Refactor and Stabilize',
    description: 'Restructure code in controlled slices while preserving behavior.'
  },
  {
    id: 'docs-spec-first',
    name: 'Docs and Spec First',
    description: 'Clarify requirements, design, and examples before larger implementation work.'
  }
];

export const RUN_PROFILE_DEFAULTS = {
  auto: {
    flowProfile: 'sequential',
    maxParallel: 1,
    taskBudget: 8,
    fileBudget: 3,
    diagnosisFirst: true,
    replanThreshold: 'task-batch',
    freshSessionThreshold: '90m or 2 failed replans'
  },
  'existing-repo-bugfix': {
    flowProfile: 'sequential',
    maxParallel: 1,
    taskBudget: 6,
    fileBudget: 2,
    diagnosisFirst: true,
    replanThreshold: 'task-batch',
    freshSessionThreshold: '2 failed replans or 60m'
  },
  'existing-repo-feature': {
    flowProfile: 'sequential',
    maxParallel: 1,
    taskBudget: 8,
    fileBudget: 3,
    diagnosisFirst: true,
    replanThreshold: 'task-batch',
    freshSessionThreshold: '3 failed replans or 90m'
  },
  'greenfield-app': {
    flowProfile: 'sequential',
    maxParallel: 1,
    taskBudget: 8,
    fileBudget: 2,
    diagnosisFirst: true,
    replanThreshold: 'task-batch',
    freshSessionThreshold: '2 high-drift replans or 75m'
  },
  'refactor-stabilize': {
    flowProfile: 'sequential',
    maxParallel: 1,
    taskBudget: 6,
    fileBudget: 2,
    diagnosisFirst: true,
    replanThreshold: 'task-batch',
    freshSessionThreshold: '2 failed replans or 60m'
  },
  'docs-spec-first': {
    flowProfile: 'hybrid',
    maxParallel: 2,
    taskBudget: 6,
    fileBudget: 4,
    diagnosisFirst: true,
    replanThreshold: 'phase-boundary',
    freshSessionThreshold: '120m'
  }
};

export const RUN_OPERATION_DEFAULTS = {
  auto: { maxTaskAttempts: 2, maxGoalLoops: 3 },
  'existing-repo-bugfix': { maxTaskAttempts: 2, maxGoalLoops: 3 },
  'existing-repo-feature': { maxTaskAttempts: 2, maxGoalLoops: 3 },
  'greenfield-app': { maxTaskAttempts: 2, maxGoalLoops: 4 },
  'refactor-stabilize': { maxTaskAttempts: 2, maxGoalLoops: 3 },
  'docs-spec-first': { maxTaskAttempts: 2, maxGoalLoops: 4 }
};

export const DEFAULT_HARNESS_SETTINGS = {
  includeGlobalAgents: true,
  includeKarpathyGuidelines: true,
  uiLanguage: 'en',
  agentLanguage: 'en',
  customConstitution: '',
  plannerStrategy: '',
  teamStrategy: '',
  codexRuntimeProfile: DEFAULT_SETTINGS.codexRuntimeProfile,
  codexNotes: '',
  coordinationProvider: 'codex',
  workerProvider: 'codex',
  claudeNotes: '',
  geminiNotes: '',
  claudeModel: '',
  geminiModel: DEFAULT_SETTINGS.geminiModel,
  geminiProjectId: ''
};
