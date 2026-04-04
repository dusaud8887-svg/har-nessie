import { promises as fs } from 'node:fs';
import {
  buildIntakeCharterSeed,
  buildProjectSummary,
  buildSpecFolderCandidates,
  detectProjectValidationCommands,
  explainRecommendedSpec,
  listProjectIntakeDocs
} from './project-intel.mjs';

export function createProjectWorkflow(deps) {
  const {
    DEFAULT_HARNESS_SETTINGS,
    buildEnvironmentDiagnostics,
    clipLargeContext,
    getHarnessSettings,
    localizedText,
    normalizeAgentProvider,
    normalizeBrowserVerificationConfig,
    normalizeDevServerConfig,
    normalizeLanguage,
    now,
    parsePorcelain,
    projectIntelHelpers,
    providerDisplayName,
    resolveGitProject,
    resolveInputPath,
    runGit,
    uniqueBy
  } = deps;

  function buildProjectBrowserReadiness(project, environment) {
    const browserVerification = normalizeBrowserVerificationConfig(project?.defaultSettings?.browserVerification);
    const devServer = normalizeDevServerConfig(project?.defaultSettings?.devServer, project?.rootPath || '');
    const playwright = environment?.playwright || { ok: false, version: '', error: '' };
    const configured = Boolean(browserVerification?.url || browserVerification?.selector || devServer?.command || devServer?.url);
    const policy = configured ? 'project-baseline' : 'optional';
    const ready = Boolean(configured && playwright.ok);
    let note = 'Browser verification is not configured. Set it only when you need to validate a web UI or browser flow.';
    if (configured && ready) note = 'Browser verification is ready to run.';
    else if (configured && !playwright.ok) note = 'Browser verification is configured but Playwright runtime is missing. Install it only when you need web UI verification.';
    return {
      configured,
      policy,
      policyLabel: configured ? 'Project baseline' : 'Optional',
      policyNote: configured
        ? 'This project has browser verification or dev-server config, so Playwright is treated as a baseline dependency.'
        : 'Default harness operation keeps Playwright optional.',
      ready,
      targetUrl: browserVerification?.url || devServer?.url || '',
      selector: browserVerification?.selector || '',
      devServerCommand: devServer?.command || '',
      runtime: {
        installed: Boolean(playwright.ok),
        version: String(playwright.version || '').trim(),
        error: String(playwright.error || '').trim()
      },
      note
    };
  }

  async function buildProjectDiagnostics(projectPath, language = 'en') {
    if (!projectPath) {
      return {
        attached: false,
        projectPath: '',
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        gitRoot: '',
        gitClean: false,
        dirtyFiles: [],
        worktreeEligible: false,
        note: localizedText(language, '연결된 프로젝트 폴더가 없습니다. 새 프로젝트 시작 모드만 사용할 수 있습니다.', 'No project folder attached. Greenfield mode only.')
      };
    }

    const stat = await fs.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        attached: true,
        projectPath,
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        gitRoot: '',
        gitClean: false,
        dirtyFiles: [],
        worktreeEligible: false,
        note: localizedText(language, '프로젝트 경로가 없거나 폴더가 아닙니다.', 'Project path does not exist or is not a directory.')
      };
    }

    const gitRoot = await resolveGitProject(projectPath);
    if (!gitRoot) {
      return {
        attached: true,
        projectPath,
        exists: true,
        isDirectory: true,
        isGitRepo: false,
        gitRoot: '',
        gitClean: false,
        dirtyFiles: [],
        worktreeEligible: false,
        note: localizedText(language, 'git 저장소가 아니라 공유 워크스페이스 모드로 진행합니다.', 'Project is not a git repository. Shared workspace mode will be used.')
      };
    }

    const statusResult = await runGit(gitRoot, ['status', '--porcelain=v1'], null, false);
    const dirtyFiles = parsePorcelain(statusResult.stdout).map((item) => `${item.status} ${item.path}`);
    const gitClean = statusResult.code === 0 && dirtyFiles.length === 0;
    return {
      attached: true,
      projectPath,
      exists: true,
      isDirectory: true,
      isGitRepo: true,
      gitRoot,
      gitClean,
      dirtyFiles,
      worktreeEligible: gitClean,
      note: gitClean
        ? localizedText(language, 'git 저장소가 clean 상태라 태스크 단위 worktree 격리를 사용할 수 있습니다.', 'Clean git repository. Task-level worktree isolation is available.')
        : localizedText(language, 'git 저장소가 dirty 상태라 정리 전까지는 shared workspace fallback을 사용합니다.', 'Git repository is dirty. Shared workspace fallback will be used until cleaned.')
    };
  }

  async function buildSpecDiagnostics(resolvedSpecFiles) {
    const items = [];
    for (const filePath of resolvedSpecFiles) {
      const stat = await fs.stat(filePath).catch(() => null);
      items.push({
        path: filePath,
        exists: Boolean(stat),
        readable: Boolean(stat?.isFile()),
        kind: stat?.isFile() ? filePath.split('.').pop()?.toLowerCase() || 'file' : 'missing'
      });
    }
    return items;
  }

  function classifyAutonomy(preflight = {}) {
    const language = normalizeLanguage(preflight.language, 'en');
    const blockers = Array.isArray(preflight.blockers) ? preflight.blockers : [];
    const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
    const project = preflight.project || {};
    const specFiles = Array.isArray(preflight.specFiles) ? preflight.specFiles : [];
    const severeReasons = [];

    if (project.attached && project.exists && !project.isGitRepo) {
      severeReasons.push(localizedText(language, 'git 저장소가 아니라 같은 폴더를 직접 수정합니다.', 'This is not a git repo, so the harness will edit the same folder directly.'));
    }
    if (project.isGitRepo && !project.gitClean) {
      severeReasons.push(localizedText(language, '저장소가 dirty 상태라 격리 worktree를 쓰지 못합니다.', 'The repository is dirty, so isolated worktrees are not available.'));
    }
    if (process.platform === 'win32' && String(project.projectPath || '').length > 220) {
      severeReasons.push(localizedText(language, '프로젝트 경로가 길어 Windows 경로 길이 문제 가능성이 큽니다.', 'The project path is long enough that Windows path-length issues are likely.'));
    }
    if (specFiles.some((item) => item && item.readable === false)) {
      severeReasons.push(localizedText(language, '읽지 못하는 명세 파일이 있어 문서 기준 자동화 신뢰도가 떨어집니다.', 'Some spec files could not be read, so docs-grounded automation is less reliable.'));
    }

    if (blockers.length) {
      return {
        tier: 'manual_required',
        label: localizedText(language, '사람 확인 필수', 'Manual review required'),
        score: 20,
        summary: localizedText(language, '도구나 경로 문제 때문에 지금 바로 자동 진행하면 안 됩니다.', 'Tooling or path issues mean you should not start automation yet.'),
        reasons: blockers.slice(0, 4),
        executionReady: false
      };
    }
    if (severeReasons.length) {
      return {
        tier: 'manual_required',
        label: localizedText(language, '사람 확인 필수', 'Manual review required'),
        score: 42,
        summary: localizedText(language, '실행은 가능하지만, 지금 상태는 자동으로 맡기기보다 먼저 사람이 확인하는 편이 안전합니다.', 'Execution is possible, but it is safer to review the setup before handing it over to automation.'),
        reasons: severeReasons,
        executionReady: true
      };
    }
    if (warnings.length) {
      return {
        tier: 'caution_auto',
        label: localizedText(language, '주의 자동화', 'Caution automation'),
        score: 68,
        summary: localizedText(language, '자동 진행은 가능하지만 중간 확인이 있는 편이 안전합니다.', 'Automation can proceed, but periodic human checks are safer.'),
        reasons: warnings.slice(0, 4),
        executionReady: true
      };
    }
    return {
      tier: 'safe_auto',
      label: localizedText(language, '안전 자동화', 'Safe automation'),
      score: 92,
      summary: localizedText(language, '현재 상태는 비교적 안전하게 자동 진행할 수 있습니다.', 'The current setup is relatively safe for autonomous execution.'),
      reasons: [],
      executionReady: true
    };
  }

  async function buildPreflight(projectPath, resolvedSpecFiles, harnessSettings = null) {
    const language = normalizeLanguage(harnessSettings?.uiLanguage || harnessSettings?.agentLanguage, 'en');
    const [environment, project, specFiles] = await Promise.all([
      buildEnvironmentDiagnostics(),
      buildProjectDiagnostics(projectPath, language),
      buildSpecDiagnostics(resolvedSpecFiles)
    ]);
    const providerSettings = harnessSettings || DEFAULT_HARNESS_SETTINGS;
    const coordinationProvider = normalizeAgentProvider(providerSettings?.coordinationProvider, 'codex');
    const workerProvider = normalizeAgentProvider(providerSettings?.workerProvider, 'codex');
    const requiredProviders = [...new Set([coordinationProvider, workerProvider])];

    const blockers = [];
    const warnings = [];
    for (const provider of requiredProviders) {
      const status = environment[provider];
      if (!status?.ok) blockers.push(localizedText(language, `${providerDisplayName(provider)} CLI를 찾을 수 없습니다: ${status?.error || 'unknown error'}`, `${providerDisplayName(provider)} CLI unavailable: ${status?.error || 'unknown error'}`));
    }
    if (!environment.node.ok) blockers.push(localizedText(language, `Node.js를 찾을 수 없습니다: ${environment.node.error || 'unknown error'}`, `Node.js unavailable: ${environment.node.error || 'unknown error'}`));
    if (projectPath && !project.exists) blockers.push(project.note);
    if (!environment.git.ok) warnings.push(localizedText(language, `Git을 찾을 수 없습니다: ${environment.git.error || 'unknown error'}`, `Git unavailable: ${environment.git.error || 'unknown error'}`));
    if (requiredProviders.includes('gemini')) {
      const configuredGeminiProject = String(providerSettings?.geminiProjectId || environment.geminiProject || '').trim();
      if (!configuredGeminiProject) warnings.push(localizedText(language, 'Gemini project id가 설정되지 않았습니다. Gemini CLI가 GOOGLE_CLOUD_PROJECT를 요구하면 로컬 하네스 설정에 먼저 저장해 두는 편이 안전합니다.', 'Gemini project id is not configured. If your Gemini CLI requires GOOGLE_CLOUD_PROJECT, save it in local harness settings first.'));
    }
    if (project.attached && project.exists && !project.isGitRepo) warnings.push(project.note);
    if (project.isGitRepo && !project.gitClean) warnings.push(project.note);
    if (process.platform === 'win32' && projectPath && projectPath.length > 220) warnings.push(localizedText(language, '프로젝트 경로가 매우 깁니다. Windows 경로 길이 문제로 worktree, patch apply, 또는 CLI 도구가 흔들릴 수 있습니다.', 'Project path is very long. Windows path-length limits may affect worktree, patch apply, or CLI tools.'));
    for (const item of specFiles) {
      if (!item.readable) warnings.push(localizedText(language, `명세 파일을 읽지 못했습니다: ${item.path}`, `Spec file unavailable: ${item.path}`));
      if (process.platform === 'win32' && String(item.path || '').length > 220) warnings.push(localizedText(language, `명세 파일 경로가 매우 깁니다: ${item.path}`, `Spec file path is very long: ${item.path}`));
    }

    const actionPlan = [];
    for (const provider of requiredProviders) {
      if (environment[provider]?.ok) continue;
      actionPlan.push({
        id: `install-${provider}`,
        kind: 'required',
        title: localizedText(language, `${providerDisplayName(provider)} CLI 준비`, `Prepare ${providerDisplayName(provider)} CLI`),
        description: localizedText(language, `${providerDisplayName(provider)} CLI 설치 또는 로그인 상태를 먼저 해결해야 합니다.`, `Install ${providerDisplayName(provider)} CLI or fix its login state first.`)
      });
    }
    if (requiredProviders.includes('gemini') && !String(providerSettings?.geminiProjectId || environment.geminiProject || '').trim()) {
      actionPlan.push({
        id: 'configure-gemini-project',
        kind: 'recommended',
        title: localizedText(language, 'Gemini 프로젝트 ID 확인', 'Check Gemini project ID'),
        description: localizedText(language, '회사 환경에서 Gemini CLI가 프로젝트 ID를 요구하면 로컬 하네스 설정에 gemini project id를 저장해 두는 편이 안전합니다.', 'If Gemini CLI requires a project ID in your environment, save gemini project id in local harness settings.')
      });
    }
    if (project.attached && !project.exists) {
      actionPlan.push({
        id: 'fix-project-path',
        kind: 'required',
        title: localizedText(language, '프로젝트 경로 수정', 'Fix project path'),
        description: localizedText(language, '존재하는 프로젝트 폴더를 다시 선택해야 합니다.', 'Choose an existing project folder again.')
      });
    }
    if (project.isGitRepo && !project.gitClean) {
      actionPlan.push({
        id: 'clean-git-state',
        kind: 'recommended',
        title: localizedText(language, 'git 상태 정리', 'Clean git state'),
        description: localizedText(language, '현재는 shared workspace fallback이므로, 안전한 worktree 격리를 원하면 저장소를 clean 상태로 맞추는 편이 좋습니다.', 'The repo is currently using shared-workspace fallback. Clean the repo if you want safer worktree isolation.')
      });
    }
    if (project.attached && !project.isGitRepo) {
      actionPlan.push({
        id: 'decide-shared-workspace',
        kind: 'recommended',
        title: localizedText(language, '공유 워크스페이스 사용 여부 확인', 'Confirm shared workspace mode'),
        description: localizedText(language, 'git 저장소가 아니므로 태스크 격리 없이 같은 폴더를 직접 수정합니다.', 'This is not a git repo, so tasks will edit the same folder directly without isolation.')
      });
    }
    if (!specFiles.length) {
      actionPlan.push({
        id: 'attach-specs',
        kind: 'optional',
        title: localizedText(language, '명세 파일 추가', 'Attach spec files'),
        description: localizedText(language, '핵심 요구사항 문서나 회의 메모가 있으면 attach하는 편이 계획 품질에 유리합니다.', 'Attach key requirement docs or meeting notes if you have them. It improves planning quality.')
      });
    }

    const autonomy = classifyAutonomy({ blockers, warnings, project, specFiles, language });
    return {
      checkedAt: now(),
      ready: blockers.length === 0,
      blockers,
      warnings,
      autonomy,
      actionPlan,
      environment,
      project,
      specFiles,
      providerProfile: { coordinationProvider, workerProvider }
    };
  }

  function diagnoseRunInputShape(input = {}, language = 'en') {
    const objective = String(input.objective || '').trim();
    const successCriteria = String(input.successCriteria || '').trim();
    const protectedAreas = String(input.protectedAreas || '').trim();
    const excludedScope = String(input.excludedScope || '').trim();
    const specFiles = String(input.specFiles || '').trim();
    const warnings = [];
    const actionPlan = [];
    if (objective && objective.length < 16) warnings.push(localizedText(language, '목표 설명이 짧아서 계획이 추측에 의존할 수 있습니다. 원하는 결과를 한두 문장 더 적는 편이 안전합니다.', 'The goal is short enough that the plan may lean on guesses. Add another sentence or two about the result you want.'));
    if (!successCriteria) warnings.push(localizedText(language, '성공 조건이 비어 있어 완료 판단이 애매해질 수 있습니다.', 'Success criteria are empty, so completion may be hard to judge.'));
    if (!protectedAreas) warnings.push(localizedText(language, '변경 금지 영역이 비어 있습니다. 건드리면 안 되는 영역이 있으면 적어 두는 편이 안전합니다.', 'Protected areas are empty. If there are places the harness must not touch, write them down.'));
    if (!excludedScope) warnings.push(localizedText(language, '제외 범위가 비어 있습니다. 이번에 하지 않을 것을 적어 두면 과도한 확장을 줄일 수 있습니다.', 'Excluded scope is empty. Writing down what should not be done this time helps reduce overreach.'));
    if (!specFiles && objective.length < 40) {
      actionPlan.push({
        id: 'consider-intake-first',
        kind: 'recommended',
        title: localizedText(language, '먼저 시작 전 정리로 좁히기', 'Start with an intake pass first'),
        description: localizedText(language, '입력이 짧고 명세 파일도 없으니, 구현보다 먼저 범위와 완료 기준을 정리하는 작업으로 시작하는 편이 안전합니다.', 'The input is short and there are no spec files, so it is safer to start with a scope-and-success-criteria intake pass before implementation.')
      });
    }
    return { warnings, actionPlan };
  }

  async function analyzeProjectIntake(input = {}) {
    const rootPath = input.rootPath ? resolveInputPath(input.rootPath, '') : '';
    const intakeSettings = await getHarnessSettings(rootPath);
    const intakeLanguage = normalizeLanguage(input.uiLanguage || intakeSettings?.uiLanguage || intakeSettings?.agentLanguage, 'en');
    if (!rootPath) throw new Error(localizedText(intakeLanguage, '프로젝트 루트 폴더가 필요합니다.', 'Project root path is required.'));
    const stat = await fs.stat(rootPath).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(localizedText(intakeLanguage, '프로젝트 루트 경로가 없거나 폴더가 아닙니다.', 'Project root path does not exist or is not a directory.'));

    const docCandidates = await listProjectIntakeDocs(rootPath, projectIntelHelpers);
    const specFolderCandidates = buildSpecFolderCandidates(docCandidates);
    const requestedSpecRoots = uniqueBy((Array.isArray(input.selectedSpecRoots) ? input.selectedSpecRoots : []).map((item) => String(item || '').trim().replace(/\\/g, '/')).filter(Boolean), (item) => item);
    const defaultSpecRoots = specFolderCandidates.filter((item) => item.recommended).map((item) => item.root);
    const selectedSpecRoots = requestedSpecRoots.length ? requestedSpecRoots : defaultSpecRoots;
    const recommendedSpecCandidates = docCandidates.filter((item) => {
      if (!['constitution', 'overview', 'spec', 'plan', 'reference'].includes(item.kind)) return false;
      if (!selectedSpecRoots.length) return true;
      return selectedSpecRoots.some((root) => item.sourceRoot === root || item.relativePath === root || item.relativePath.startsWith(`${root}/`));
    }).slice(0, 8);
    const fallbackSpecCandidates = docCandidates.filter((item) => ['constitution', 'overview', 'spec', 'plan', 'reference'].includes(item.kind)).slice(0, 8);
    const selectedSpecCandidates = recommendedSpecCandidates.length ? recommendedSpecCandidates : fallbackSpecCandidates;
    const recommendedSpecFiles = selectedSpecCandidates.map((item) => item.path);
    const [preflight, validationCommands, projectSummary] = await Promise.all([
      buildPreflight(rootPath, recommendedSpecFiles, intakeSettings),
      detectProjectValidationCommands(rootPath, projectIntelHelpers),
      buildProjectSummary(rootPath, projectIntelHelpers)
    ]);

    const titleSuggestion = String(input.title || rootPath.split(/[\\/]/).filter(Boolean).pop() || 'Project').trim();
    const hasDocs = docCandidates.length > 0;
    const docsHeavy = docCandidates.filter((item) => ['spec', 'plan', 'reference'].includes(item.kind)).length >= 2;
    const recommendedProject = {
      title: titleSuggestion,
      defaultPresetId: hasDocs && docsHeavy ? 'docs-spec-first' : (preflight.project?.exists ? 'existing-repo-feature' : 'greenfield-app'),
      phaseTitle: hasDocs ? 'Project Intake' : 'Foundation',
      phaseGoal: hasDocs
        ? localizedText(intakeLanguage, '기존 repo와 docs를 대조해 실행 가능한 phase/task backlog와 verification contract를 고정한다.', 'Compare the repo and docs, then lock an executable phase/task backlog and verification contract.')
        : localizedText(intakeLanguage, 'repo 구조, 핵심 검증 경로, 초기 문서 틀을 먼저 고정한다.', 'Lock the repo structure, main verification path, and starter docs first.'),
      charterText: buildIntakeCharterSeed(titleSuggestion, docCandidates, intakeLanguage)
    };

    return {
      checkedAt: now(),
      rootPath,
      preflight,
      repo: { titleSuggestion, validationCommands, summary: clipLargeContext(projectSummary, 2600) },
      docs: {
        candidates: docCandidates.map((item) => ({ path: item.path, relativePath: item.relativePath, kind: item.kind, sourceRoot: item.sourceRoot, snippet: item.snippet })),
        specFolderCandidates,
        selectedSpecRoots,
        recommendedSpecFiles,
        recommendedSpecDetails: selectedSpecCandidates.map((item) => ({
          path: item.path,
          relativePath: item.relativePath,
          kind: item.kind,
          selectionReason: explainRecommendedSpec(item, selectedSpecRoots, intakeLanguage)
        }))
      },
      recommendedProject,
      starterRunDraft: {
        title: `${String(titleSuggestion || 'project').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}-intake`,
        presetId: hasDocs ? 'docs-spec-first' : recommendedProject.defaultPresetId,
        objective: hasDocs
          ? localizedText(intakeLanguage, '현재 저장소와 docs를 분석해 phase/task backlog, verification plan, carry-over 없는 starter plan으로 고정한다.', 'Analyze the current repo and docs, then lock the phase/task backlog, verification plan, and a starter plan without carry-over.')
          : localizedText(intakeLanguage, '현재 저장소 구조를 분석해 첫 phase backlog와 verification plan을 만든다.', 'Analyze the current repo structure and create the first phase backlog and verification plan.'),
        successCriteria: localizedText(intakeLanguage, '핵심 docs와 현재 repo 구조를 근거로 실행 가능한 phase/task backlog와 verification 기준을 정리한다.', 'Use the key docs and current repo structure to define an executable phase/task backlog and verification criteria.'),
        excludedScope: localizedText(intakeLanguage, '초기 intake run에서는 넓은 구현 변경을 하지 않고, 문서 정렬과 계획 고정에 집중한다.', 'The initial intake run should avoid broad implementation changes and focus on aligning docs and locking the plan.'),
        specFiles: recommendedSpecFiles,
        specFilesText: recommendedSpecFiles.join('\n')
      }
    };
  }

  return { analyzeProjectIntake, buildPreflight, buildProjectBrowserReadiness, buildProjectDiagnostics, diagnoseRunInputShape };
}
