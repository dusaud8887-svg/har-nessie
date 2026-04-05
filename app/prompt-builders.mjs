import path from 'node:path';

export function createPromptBuilders(deps) {
  const {
    ROOT_DIR,
    buildContinuationPromptLines,
    buildHarnessGuidanceLines,
    buildMemoryPromptLines,
    buildProjectPlanningPriorLines,
    buildProjectPromptLines,
    buildProjectCodeIntelligence,
    buildPromptContextExcerpts,
    buildScopeRules,
    buildUpstreamContext,
    clipText,
    deriveExecutionGraphSignals,
    harnessGuidancePath,
    normalizeAcceptanceCheckResults,
    predictTaskScopeEnforcement,
    providerDisplayName,
    readFilesLikelyContents,
    runCheckpointPath,
    runDir,
    searchProjectMemory,
    selectVerificationCommands,
    writeInPreferredLanguageRule
  } = deps;

  function buildRetryContext(task, memory = null, codeContext = null, graphSignals = null) {
    if (!task.attempts) return [];
    const priorAcceptance = normalizeAcceptanceCheckResults(task.lastExecution?.acceptanceCheckResults)
      .slice(0, 5)
      .map((item) => `${item.check}: ${item.status || 'unknown'}${item.note ? ` (${item.note})` : ''}`);
    const resolvedGraphSignals = graphSignals || deriveExecutionGraphSignals(task, codeContext, memory);
    return [
      `Previous attempt count: ${task.attempts}`,
      `Previous reviewer summary: ${task.reviewSummary || 'None recorded.'}`,
      `Previous findings: ${(task.findings || []).join(' | ') || 'None recorded.'}`,
      ...(priorAcceptance.length ? [`Previous acceptance check results: ${priorAcceptance.join(' | ')}`] : []),
      ...resolvedGraphSignals.retryLines,
      'Do not repeat the same failed approach. Change the method if the prior attempt did not converge.'
    ];
  }

  function buildCodeContextPromptLines(codeContext, memory = null, task = null, graphSignals = null) {
    if (!codeContext) return ['Code context: unavailable'];
    const lines = [`Code context summary: ${clipText(codeContext.summary || 'None', 400)}`];
    const resolvedGraphSignals = graphSignals || deriveExecutionGraphSignals(task, codeContext, memory);
    if (codeContext?.projectGraph?.indexedFileCount) {
      const truncation = codeContext.projectGraph.truncated ? ' (partial due to file cap)' : '';
      const cache = codeContext.projectGraph.cache || {};
      const cacheBits = [];
      if (cache.hit === true) cacheBits.push('cache hit');
      if (Number(cache.reusedFiles || 0) > 0) cacheBits.push(`reused=${cache.reusedFiles}`);
      if (Number(cache.refreshedFiles || 0) > 0) cacheBits.push(`refreshed=${cache.refreshedFiles}`);
      lines.push(`Project symbol impact index: files=${codeContext.projectGraph.indexedFileCount}${truncation}${cacheBits.length ? ` | ${cacheBits.join(', ')}` : ''}`);
      if (codeContext.projectGraph.truncated) {
        lines.push('Graph confidence note: the repo-wide graph is partial in this run. Before widening scope, manually verify the next import/call chain instead of trusting the static graph alone.');
      }
    }
    if (Array.isArray(codeContext.relatedFiles) && codeContext.relatedFiles.length > 0) {
      lines.push('Relevant code files and symbols:');
      for (const item of codeContext.relatedFiles.slice(0, 4)) {
        const localSymbols = [
          ...(Array.isArray(item.symbols) ? item.symbols : []),
          ...(Array.isArray(item.codeGraph?.exports) ? item.codeGraph.exports : []),
          ...(Array.isArray(item.codeGraph?.importedSymbols) ? item.codeGraph.importedSymbols : [])
        ].filter(Boolean).slice(0, 4);
        const importTargets = (Array.isArray(item.codeGraph?.imports) ? item.codeGraph.imports : [])
          .map((entry) => entry.target || entry.specifier)
          .filter(Boolean)
          .slice(0, 3);
        const inbound = Number(item?.impact?.importedByCount || 0);
        const activeCallers = Number(item?.impact?.calledByCount || 0);
        const hotSymbol = (Array.isArray(item?.impact?.exportedSymbolImpact) ? item.impact.exportedSymbolImpact : [])[0]
          || (Array.isArray(item?.impact?.calledSymbolImpact) ? item.impact.calledSymbolImpact : [])[0]
          || (Array.isArray(item?.impact?.importedSymbolImpact) ? item.impact.importedSymbolImpact : [])[0]
          || null;
        const impactBits = [
          `symbols=${localSymbols.join(', ') || 'none'}`,
          `imports=${importTargets.join(', ') || 'none'}`,
          `importedBy=${inbound}`,
          `calledBy=${activeCallers}`,
          hotSymbol ? `hotSymbol=${hotSymbol.symbol}: importers=${hotSymbol.importerCount || 0}, callers=${hotSymbol.callerCount || 0}, calls=${hotSymbol.callCount || 0}` : ''
        ].filter(Boolean);
        lines.push(`- ${item.path}: ${clipText(impactBits.join(' | '), 220)}`);
      }
      if (resolvedGraphSignals.criticalSymbolRiskLines.length) {
        lines.push('CRITICAL-RISK symbols:');
        for (const item of resolvedGraphSignals.criticalSymbolRiskLines) lines.push(`- ${item}`);
      }
      if (resolvedGraphSignals.relationshipLines.length) {
        lines.push('Graph relationships to watch:');
        for (const item of resolvedGraphSignals.relationshipLines) lines.push(`- ${item}`);
      }
      if (resolvedGraphSignals.symbolRiskLines.length) {
        lines.push('High-impact symbols to verify first:');
        for (const item of resolvedGraphSignals.symbolRiskLines.slice(0, 3)) lines.push(`- ${item}`);
      }
      if (resolvedGraphSignals.dependencyWarnings.length) {
        lines.push('Scope boundary warnings:');
        for (const item of resolvedGraphSignals.dependencyWarnings) lines.push(`- ${item}`);
      }
    } else {
      lines.push('Relevant code files and symbols: none');
    }
    return lines;
  }

  async function buildCodexPrompt(run, task, memory, executionCtx, codeContext = null, provider = 'codex', graphSignals = null) {
    const verificationCommands = selectVerificationCommands(run, task);
    const contextExcerpts = await buildPromptContextExcerpts(run);
    const expectedScope = predictTaskScopeEnforcement(task, executionCtx);
    const fileContexts = await readFilesLikelyContents(run, task, executionCtx);
    const upstreamContext = buildUpstreamContext(run, task);
    const resolvedGraphSignals = graphSignals || deriveExecutionGraphSignals(task, codeContext, memory);
    const retryContext = buildRetryContext(task, memory, codeContext, resolvedGraphSignals);
    const providerName = providerDisplayName(provider);
    const riskMemory = await searchProjectMemory(ROOT_DIR, run.memory.projectKey, 'task risk failure out-of-scope retry', 3, {
      projectPath: run.projectPath || ''
    }, {
      reindex: false,
      stage: 'review',
      taskId: task.id,
      filesLikely: task.filesLikely,
      relatedFiles: codeContext?.relatedFiles || [],
      symbolHints: codeContext?.symbolHints || []
    }).catch(() => ({ searchResults: [] }));
    return [
      `You are the ${providerName} implementation executor inside a local engineering harness.`,
      'Read the spec bundle and project summary files first, then edit the current working directory directly.',
      `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
      `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
      `Harness guidance: ${harnessGuidancePath(run.id)}`,
      ...buildMemoryPromptLines(memory),
      ...buildCodeContextPromptLines(codeContext, memory, task, resolvedGraphSignals),
      ...buildHarnessGuidanceLines(run.harnessConfig, 'implementer', provider),
      '',
      ...buildContinuationPromptLines(run, task.id),
      '',
      ...contextExcerpts,
      ...(fileContexts.length ? ['', 'FilesLikely current contents:', ...fileContexts] : []),
      ...(upstreamContext.length ? ['', 'Completed upstream context:', ...upstreamContext] : []),
      ...(retryContext.length ? ['', 'Retry context:', ...retryContext] : []),
      ...(riskMemory.searchResults?.length ? ['', 'Known failure patterns from previous runs:', ...riskMemory.searchResults.map((hit) => `- ${clipText(hit.snippet || '', 260)}`)] : []),
      '',
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Goal: ${task.goal}`,
      `Files likely: ${(task.filesLikely || []).join(', ') || 'Unknown'}`,
      `Expected scope enforcement: ${expectedScope}`,
      `Constraints: ${(task.constraints || []).join(' | ') || 'None'}`,
      `Acceptance checks: ${(task.acceptanceChecks || []).join(' | ') || 'None'}`,
      `Checkpoint notes: ${(task.checkpointNotes || []).join(' | ') || 'None'}`,
      `Recommended verification commands: ${verificationCommands.join(' | ') || 'None selected by harness'}`,
      '',
      'Rules:',
      '- You are the implementation executor for the current task, not the planner for the entire run.',
      '- Read the three files above before editing.',
      '- Keep the diff inside filesLikely unless the spec clearly requires a small adjacent change.',
      ...buildScopeRules(expectedScope),
      '- The recommended verification commands are required unless they clearly do not apply to this task.',
      '- Resume directly from the current task state and prior findings instead of rewriting the whole history.',
      '- Keep the required output section headers in English exactly as written below.',
      writeInPreferredLanguageRule(run.harnessConfig, `Write the body content of Summary, Risks or follow-ups, ${providerName} handoff, and acceptance check notes`),
      '',
      'Required output sections:',
      'Context read',
      'Summary',
      'Files changed',
      'Checks run',
      'Acceptance check results',
      '- For each acceptance check, report PASS / FAIL / UNABLE-TO-VERIFY and why.',
      ...(task.acceptanceChecks || []).map((check, index) => `  ${index + 1}. ${check}`),
      'Risks or follow-ups',
      `${providerName} handoff`
    ].join('\n');
  }

  function buildReviewPrompt(run, task, outputFile, diffFile, verificationFile, scopeSummary, memory, provider = 'codex') {
    const providerName = providerDisplayName(provider);
    return [
      `You are the ${providerName} verifier for a local engineering harness.`,
      `Read the spec bundle, project summary, ${providerName} handoff, task diff, and inspect the current project before deciding.`,
      `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
      `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
      ...buildMemoryPromptLines(memory),
      ...buildHarnessGuidanceLines(run.harnessConfig, 'verifier', provider),
      ...buildContinuationPromptLines(run, task.id),
      `${providerName} handoff: ${outputFile}`,
      `Task diff: ${diffFile}`,
      `Verification report: ${verificationFile}`,
      `Repository changed files: ${(scopeSummary?.repoChangedFiles || []).join(', ') || 'None'}`,
      `Out-of-scope file changes: ${(scopeSummary?.outOfScopeFiles || []).join(', ') || 'None'}`,
      `Scope enforcement level: ${scopeSummary?.scopeEnforcement || 'unknown'}`,
      run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
      '',
      `Task ID: ${task.id}`,
      `Current goal: ${task.goal}`,
      `Acceptance checks: ${(task.acceptanceChecks || []).map((check, index) => `${index + 1}. ${check}`).join(' | ') || 'None defined'}`,
      `Previous attempts: ${task.attempts || 0}`,
      `Previous review summary: ${task.reviewSummary || 'None'}`,
      `Previous findings: ${(task.findings || []).join(' | ') || 'None'}`,
      ...(task.attempts >= 2 ? [
        'WARNING: This task has already failed multiple times.',
        'You must identify the repeated root cause and propose a materially different retry plan if you choose retry.'
      ] : []),
      '',
      'Return JSON only with this shape:',
      '{',
      '  "decision":"approve|retry",',
      '  "summary":"string",',
      '  "findings":["string"],',
      '  "functionalFindings":["string"],',
      '  "structuralFindings":["string"],',
      '  "codeFindings":["string"],',
      '  "staticVerificationFindings":["string"],',
      '  "browserUxFindings":["string"],',
      '  "acceptanceCheckResults":[{"check":"string","status":"pass|fail|unverifiable","note":"string"}],',
      '  "retryDiagnosis":"string",',
      '  "updatedTask": {',
      '    "goal":"string",',
      '    "filesLikely":["string"],',
      '    "constraints":["string"],',
      '    "acceptanceChecks":["string"]',
      '  }',
      '}',
      'Use updatedTask only when decision is retry.',
      writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, findings, retryDiagnosis, and updatedTask fields'),
      'Keep a single verdict, but place findings into the most specific categories you can.',
      'functionalFindings covers spec alignment, behavior, acceptance evidence, scope, integration, and operator-visible regressions.',
      'structuralFindings covers architecture boundaries, ownership, module fit, duplicated state, and layering concerns.',
      'codeFindings covers logic bugs, risky patterns, and newly introduced maintenance debt.',
      'staticVerificationFindings covers syntax/build/type/lint/test failures or high-confidence static breakage risks.',
      'browserUxFindings covers browser-visible UX, accessibility, loading/error states, and missing frontend wiring.',
      'If a category is clean, return an empty array for that category.',
      'Do not block approval on style-only remarks unless they imply a real defect, static failure risk, or clear maintenance regression.',
      'Prioritize the verification artifact and acceptance check evidence over the model handoff narrative.',
      'Resume directly from the latest task artifacts and do not recap unrelated run history.',
      'If this task has failed repeatedly, diagnose the root cause instead of repeating the same advice.'
    ].join('\n');
  }

  async function buildAutomaticReplanPrompt(run, memory, checkpoint, provider = 'codex') {
    const ledger = run.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      goal: task.goal,
      dependsOn: task.dependsOn || [],
      filesLikely: task.filesLikely || [],
      constraints: task.constraints || [],
      acceptanceChecks: task.acceptanceChecks || [],
      checkpointNotes: task.checkpointNotes || [],
      reviewSummary: task.reviewSummary || '',
      attempts: task.attempts || 0
    }));

    const providerName = providerDisplayName(provider);
    const projectIntelligence = run.projectPath ? await buildProjectCodeIntelligence(run.projectPath) : null;
    return [
      `You are ${providerName} acting as the automatic replanner for a local engineering harness.`,
      'Read the spec bundle, project summary, harness guidance, and current checkpoint before deciding.',
      `Spec bundle: ${path.join(runDir(run.id), 'input', 'spec-bundle.md')}`,
      `Project summary: ${path.join(runDir(run.id), 'context', 'project-summary.md')}`,
      `Harness guidance: ${harnessGuidancePath(run.id)}`,
      `Current checkpoint: ${runCheckpointPath(run.id)}`,
      ...buildMemoryPromptLines(memory),
      ...buildProjectPlanningPriorLines(memory, run, projectIntelligence),
      ...buildHarnessGuidanceLines(run.harnessConfig, 'replanner', provider),
      run.projectPath ? `Project root: ${run.projectPath}` : 'Project root: none',
      ...buildProjectPromptLines(run),
      '',
      ...buildContinuationPromptLines(run),
      '',
      'Checkpoint summary:',
      JSON.stringify(checkpoint, null, 2),
      '',
      'Current task ledger:',
      JSON.stringify(ledger, null, 2),
      '',
      'Non-negotiable rules:',
      '- Preserve the clarified objective, spec bundle intent, and prompt-source precedence.',
      '- You may edit only tasks whose current status is "ready".',
      '- Never rewrite done, skipped, failed, or in_progress tasks.',
      '- Do not silently broaden scope or weaken acceptance checks.',
      '- Prefer the smallest backlog change that improves the next batch.',
      `- Keep the backlog inside the active task budget (${run.profile?.taskBudget ?? '-'}).`,
      `- Keep each task inside the active file budget (${run.profile?.fileBudget ?? '-'} filesLikely) unless you are explicitly inserting a read-only diagnosis task.`,
      `- Diagnosis-first is ${run.profile?.diagnosisFirst === false ? 'optional' : 'required'} for this run.`,
      `- Fresh session threshold: ${run.profile?.freshSessionThreshold || '-'}. If crossed, stop and recommend a fresh session instead of forcing more replans.`,
      '- If the current objective or scope no longer looks safe or valid, do not auto-apply changes. Request a human pause instead.',
      '',
      'Return JSON only with this shape:',
      '{',
      '  "shouldReplan": true,',
      '  "summary":"string",',
      '  "objectiveStillValid": true,',
      '  "driftRisk":"low",',
      '  "pauseForHuman": false,',
      '  "preserve":["string"],',
      '  "whyNow":["string"],',
      '  "edits":[{',
      '    "id":"T002",',
      '    "title":"string",',
      '    "goal":"string",',
      '    "dependsOn":["T001"],',
      '    "filesLikely":["relative/path.ts"],',
      '    "constraints":["string"],',
      '    "acceptanceChecks":["string"],',
      '    "checkpointNotes":["string"]',
      '  }],',
      '  "newTasks":[{',
      '    "title":"string",',
      '    "goal":"string",',
      '    "dependsOn":["T002"],',
      '    "filesLikely":["relative/path.ts"],',
      '    "constraints":["string"],',
      '    "acceptanceChecks":["string"],',
      '    "checkpointNotes":["string"]',
      '  }]',
      '}',
      'Return exactly one valid JSON object and nothing else.',
      'Do not include scratchpad notes, self-corrections, timing calculations, or markdown fences.',
      'If shouldReplan is false, return empty edits and newTasks.',
      'If objectiveStillValid is false or driftRisk is high, set pauseForHuman to true.',
      writeInPreferredLanguageRule(run.harnessConfig, 'Write summary, preserve, whyNow, and task fields')
    ].join('\n');
  }

  return {
    buildRetryContext,
    buildCodeContextPromptLines,
    buildCodexPrompt,
    buildReviewPrompt,
    buildAutomaticReplanPrompt
  };
}
