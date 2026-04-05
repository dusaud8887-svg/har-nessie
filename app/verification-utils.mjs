function firstCommandToken(value) {
  return String(value || '').trim().split(/\s+/)[0].toLowerCase();
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function parseSimpleRipgrepCommand(commandLine) {
  const normalized = String(commandLine || '').trim();
  const match = normalized.match(/^rg(?:\.exe)?\s+(-n\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/i);
  if (!match) return null;
  const pattern = String(match[2] || match[3] || match[4] || '').trim();
  const rawPath = String(match[5] || '').trim();
  if (!pattern || !rawPath) return null;
  const pathMatch = rawPath.match(/^"(.*)"$|^'(.*)'$/);
  const filePath = String(pathMatch?.[1] || pathMatch?.[2] || rawPath).trim();
  if (!filePath) return null;
  return { pattern, filePath };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function looksLikeShellCommand(value) {
  const command = String(value || '').trim();
  if (!command || /\r|\n/.test(command)) return false;
  const firstToken = firstCommandToken(command);
  if (/^[a-z]+-[a-z0-9]+$/i.test(firstToken)) return true;
  return [
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'npx',
    'node',
    'python',
    'python3',
    'pytest',
    'cargo',
    'go',
    'dotnet',
    'mvn',
    'gradle',
    './gradlew',
    'git',
    'rg',
    'rg.exe',
    'grep',
    'findstr',
    'sed',
    'awk',
    'cat',
    'type',
    'ls',
    'dir',
    'wc',
    'head',
    'tail',
    'echo',
    'test-path',
    'powershell',
    'powershell.exe',
    'pwsh',
    'cmd',
    'bash',
    'sh',
    'get-childitem',
    'get-content',
    'select-string',
    'compare-object',
    'measure-object',
    'sort-object',
    'where-object',
    'foreach-object',
    'write-output'
  ].includes(firstToken);
}

export function extractAcceptanceCommand(check) {
  const value = String(check || '').trim();
  if (!value) return '';

  let match = value.match(/^`([^`]+)`(?:\s+(?:exits?\s*0|returns?\s+(?:true|false)|passes|succeeds?|should\b|must\b).*)?$/i);
  if (match && looksLikeShellCommand(match[1])) {
    return String(match[1] || '').trim();
  }

  match = value.match(/^(.+?)\s+(?:exits?\s*0|returns?\s+(?:true|false)|passes|succeeds?|should\s+(?:pass|succeed|return|exit)|must\s+(?:pass|succeed|return|exit))\b/i);
  if (match && looksLikeShellCommand(match[1])) {
    return String(match[1] || '').trim();
  }

  return '';
}

export function classifyAcceptanceChecks(acceptanceChecks = []) {
  return (Array.isArray(acceptanceChecks) ? acceptanceChecks : [])
    .map((check) => {
      const normalizedCheck = String(check || '').trim();
      const command = extractAcceptanceCommand(normalizedCheck);
      return {
        check: normalizedCheck,
        command,
        commandBacked: Boolean(command)
      };
    })
    .filter((item) => item.check);
}

export function extractAcceptanceVerificationCommands(acceptanceChecks = [], maxCommands = 3) {
  return uniqueBy(
    classifyAcceptanceChecks(acceptanceChecks)
      .map((item) => item.command)
      .filter(Boolean),
    (item) => item.toLowerCase()
  ).slice(0, Math.max(1, Number(maxCommands || 0) || 3));
}

export function acceptanceChecksAutoVerifiable(acceptanceChecks = []) {
  const classified = classifyAcceptanceChecks(acceptanceChecks);
  return classified.length > 0 && classified.every((item) => item.commandBacked);
}

export function windowsCommandPrefersPowerShell(commandLine) {
  const normalized = String(commandLine || '').trim();
  if (!normalized) return false;
  const firstToken = firstCommandToken(normalized);
  const lower = normalized.toLowerCase();
  return firstToken === 'rg'
    || firstToken === 'rg.exe'
    || /^[a-z]+-[a-z0-9]+$/i.test(firstToken)
    || lower.startsWith('$')
    || lower.includes('$_');
}

export function rewriteWindowsCommandForAvailability(commandLine, availability = {}) {
  const normalized = String(commandLine || '').trim();
  if (!normalized) return { commandLine: normalized, rewritten: false, note: '' };
  const firstToken = firstCommandToken(normalized);
  if (!['rg', 'rg.exe'].includes(firstToken) || availability.rg !== false) {
    return { commandLine: normalized, rewritten: false, note: '' };
  }
  const parsed = parseSimpleRipgrepCommand(normalized);
  if (!parsed) {
    return { commandLine: normalized, rewritten: false, note: '' };
  }
  const pattern = escapePowerShellSingleQuoted(parsed.pattern);
  const filePath = escapePowerShellSingleQuoted(parsed.filePath);
  return {
    commandLine: [
      `$__harnessMatches = Select-String -Path '${filePath}' -Pattern '${pattern}'`,
      'if ($__harnessMatches) {',
      '  $__harnessMatches | ForEach-Object { "{0}:{1}:{2}" -f $_.Path, $_.LineNumber, $_.Line.TrimEnd() }',
      '  exit 0',
      '}',
      'exit 1'
    ].join('; '),
    rewritten: true,
    note: 'rg unavailable; used PowerShell Select-String fallback.'
  };
}
