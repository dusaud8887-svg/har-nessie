import { promises as fs } from 'node:fs';
import path from 'node:path';

function normalizeLanguage(value, fallback = 'en') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'en' || normalized === 'ko') return normalized;
  return fallback;
}

function localizeText(language, ko, en) {
  return normalizeLanguage(language, 'en') === 'en' ? String(en || ko || '') : String(ko || en || '');
}

function detectValidationCommands(manifests, packageJson, uniqueBy) {
  const commands = [];
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  for (const key of ['test', 'lint', 'typecheck', 'check', 'build']) {
    if (scripts[key]) commands.push(`npm run ${key}`);
  }
  if (manifests.has('pnpm-workspace.yaml')) {
    for (const key of ['test', 'lint', 'typecheck', 'build']) {
      if (scripts[key]) commands.push(`pnpm ${key}`);
    }
  }
  if (manifests.has('pyproject.toml')) commands.push('python -m pytest');
  if (manifests.has('Cargo.toml')) commands.push('cargo test');
  if (manifests.has('go.mod')) commands.push('go test ./...');
  return uniqueBy(commands, (item) => item).slice(0, 6);
}

async function detectEntryFiles(projectPath, helpers) {
  const candidates = [];
  for (const relativePath of [
    'src/main.ts', 'src/main.tsx', 'src/index.ts', 'src/index.tsx',
    'src/app.ts', 'src/app.tsx', 'app/server.mjs', 'server.js',
    'server.ts', 'main.py', 'manage.py'
  ]) {
    const filePath = path.join(projectPath, ...relativePath.split('/'));
    if (await helpers.fileExists(filePath)) candidates.push(relativePath);
  }
  return candidates.slice(0, 8);
}

async function listTopLevelMarkdownDocs(projectPath, helpers) {
  const picks = [];
  for (const fileName of ['AGENTS.md', 'README.md', 'ARCHITECTURE.md', 'DESIGN.md', 'FRONTEND.md']) {
    const filePath = path.join(projectPath, fileName);
    if (await helpers.fileExists(filePath)) picks.push(filePath);
  }
  const docsDir = path.join(projectPath, 'docs');
  const docsEntries = await fs.readdir(docsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of docsEntries) {
    if (picks.length >= 8) break;
    if (entry.isFile() && /\.(md|mdx|txt|pdf)$/i.test(entry.name)) {
      picks.push(path.join(docsDir, entry.name));
    }
  }
  return helpers.uniqueBy(picks, (item) => item);
}

function isIntakeDocFile(fileName) {
  return /\.(md|mdx|txt|json|pdf)$/i.test(String(fileName || ''));
}

function relativeProjectPath(projectPath, filePath) {
  return path.relative(projectPath, filePath).replace(/\\/g, '/');
}

function classifyIntakeDoc(relativePath) {
  const value = String(relativePath || '').toLowerCase();
  if (/(^|\/)agents\.md$/.test(value) || /architecture|design/.test(value)) return 'constitution';
  if (/spec|prd|requirements|product-spec|product_specs/.test(value)) return 'spec';
  if (/exec-plan|roadmap|plan|milestone|backlog|kanban|todo|phase/.test(value)) return 'plan';
  if (/reference|notes|adr|decision/.test(value)) return 'reference';
  if (/(^|\/)readme\.md$/.test(value)) return 'overview';
  return 'doc';
}

function intakeDocRank(kind, relativePath) {
  const value = String(relativePath || '').toLowerCase();
  if (/(^|\/)agents\.md$/.test(value)) return 0;
  if (/(^|\/)architecture\.md$/.test(value)) return 1;
  if (/(^|\/)readme\.md$/.test(value)) return 2;
  if (kind === 'spec') return 3;
  if (kind === 'plan') return 4;
  if (kind === 'reference') return 5;
  if (kind === 'constitution') return 6;
  if (value.startsWith('docs/')) return 7;
  return 9;
}

function intakeSpecRoot(relativePath, kind) {
  const value = String(relativePath || '').replace(/\\/g, '/');
  for (const prefix of [
    'docs/product-specs/',
    'docs/specs/',
    'specs/',
    'docs/exec-plans/active/',
    'docs/exec-plans/',
    'plans/',
    'docs/references/'
  ]) {
    if (value.startsWith(prefix)) {
      return prefix.replace(/\/$/, '');
    }
  }
  if (['spec', 'plan', 'reference'].includes(kind)) {
    const dirName = path.posix.dirname(value);
    return dirName === '.' ? '' : dirName;
  }
  return '';
}

async function collectProjectDocCandidates(projectPath, baseDir, picks, seen, helpers, depth = 0, maxDepth = 3, maxItems = 36) {
  if (depth > maxDepth || picks.length >= maxItems) return;
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (picks.length >= maxItems) break;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || ['node_modules', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
      await collectProjectDocCandidates(projectPath, fullPath, picks, seen, helpers, depth + 1, maxDepth, maxItems);
      continue;
    }
    if (!isIntakeDocFile(entry.name)) continue;
    const relativePath = relativeProjectPath(projectPath, fullPath);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const kind = classifyIntakeDoc(relativePath);
    const snippet = /\.(md|mdx|txt|pdf)$/i.test(entry.name) ? await helpers.readSnippetIfExists(fullPath, 500) : '';
    picks.push({
      path: fullPath,
      relativePath,
      kind,
      sourceRoot: intakeSpecRoot(relativePath, kind),
      rank: intakeDocRank(kind, relativePath),
      snippet
    });
  }
}

export async function detectProjectValidationCommands(projectPath, helpers) {
  if (!projectPath) return [];
  const manifests = new Set();
  const packageJsonPath = path.join(projectPath, 'package.json');
  const packageJson = await helpers.readJson(packageJsonPath).catch(() => null);
  for (const manifest of [
    'package.json', 'pnpm-workspace.yaml', 'turbo.json', 'pyproject.toml',
    'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle'
  ]) {
    if (await helpers.fileExists(path.join(projectPath, manifest))) {
      manifests.add(manifest);
    }
  }
  return detectValidationCommands(manifests, packageJson, helpers.uniqueBy);
}

export async function listProjectIntakeDocs(projectPath, helpers) {
  const seen = new Set();
  const picks = [];
  for (const filePath of await listTopLevelMarkdownDocs(projectPath, helpers)) {
    const relativePath = relativeProjectPath(projectPath, filePath);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const kind = classifyIntakeDoc(relativePath);
    picks.push({
      path: filePath,
      relativePath,
      kind,
      sourceRoot: intakeSpecRoot(relativePath, kind),
      rank: intakeDocRank(kind, relativePath),
      snippet: await helpers.readSnippetIfExists(filePath, 500)
    });
  }

  for (const dirName of ['docs', 'plans', 'specs']) {
    const fullDir = path.join(projectPath, dirName);
    if (await helpers.fileExists(fullDir)) {
      await collectProjectDocCandidates(projectPath, fullDir, picks, seen, helpers, 0, 5, 60);
    }
  }

  return picks
    .sort((left, right) => (left.rank - right.rank) || left.relativePath.localeCompare(right.relativePath))
    .slice(0, 18);
}

export async function buildProjectSummary(projectPath, helpers) {
  const lines = ['# Project Summary', ''];
  if (!projectPath) {
    lines.push('- No project path provided. Treat this as a greenfield run.');
    return lines.join('\n');
  }

  lines.push(`- Root: ${projectPath}`, '', '## Top-level entries');
  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  for (const entry of entries.slice(0, 60)) {
    lines.push(`- ${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`);
  }

  const manifests = new Set();
  const packageJsonPath = path.join(projectPath, 'package.json');
  const packageJson = await helpers.readJson(packageJsonPath).catch(() => null);
  lines.push('', '## Common manifests');
  for (const manifest of [
    'package.json', 'pnpm-workspace.yaml', 'turbo.json', 'pyproject.toml',
    'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'README.md'
  ]) {
    if (await helpers.fileExists(path.join(projectPath, manifest))) {
      manifests.add(manifest);
      lines.push(`- ${manifest}`);
    }
  }

  if (packageJson?.scripts && typeof packageJson.scripts === 'object') {
    lines.push('', '## package.json scripts');
    for (const [key, value] of Object.entries(packageJson.scripts).slice(0, 12)) {
      lines.push(`- ${key}: ${helpers.clipLine(value, 140)}`);
    }
  }

  const validationCommands = detectValidationCommands(manifests, packageJson, helpers.uniqueBy);
  if (validationCommands.length) {
    lines.push('', '## Suggested validation commands');
    for (const command of validationCommands) lines.push(`- ${command}`);
  }

  const entryFiles = await detectEntryFiles(projectPath, helpers);
  if (entryFiles.length) {
    lines.push('', '## Candidate entry files');
    for (const fileName of entryFiles) lines.push(`- ${fileName}`);
  }

  const summaryDocs = (await listProjectIntakeDocs(projectPath, helpers))
    .filter((item) => ['constitution', 'overview', 'spec', 'plan', 'reference'].includes(item.kind))
    .slice(0, 10);
  if (summaryDocs.length) {
    lines.push('', '## Repository constitution and focused context pack');
    for (const item of summaryDocs) {
      const content = path.basename(item.path).toLowerCase() === 'agents.md'
        ? helpers.clipLargeContext(await helpers.readSpecFile(item.path), 6000)
        : (item.snippet || await helpers.readSnippetIfExists(item.path, 1100));
      lines.push(`### ${item.relativePath} (${item.kind})`, '', content, '');
    }
  }

  const gitResult = await helpers.runProcess(
    process.platform === 'win32' ? 'cmd.exe' : 'git',
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'git', '-C', projectPath, 'status', '--short', '--branch']
      : ['-C', projectPath, 'status', '--short', '--branch'],
    projectPath,
    null,
    false
  );

  lines.push('', '## Git');
  lines.push(gitResult.code === 0 && gitResult.stdout.trim()
    ? gitResult.stdout.trim()
    : '- Not a git repository or git status unavailable.');

  return lines.join('\n');
}

export function buildIntakeCharterSeed(projectTitle, docCandidates, language = 'ko') {
  const title = String(projectTitle || 'Project').trim() || 'Project';
  const sources = docCandidates.slice(0, 3).map((item) => item.relativePath);
  const sourceNote = sources.length
    ? localizeText(language, ` 참고 문서: ${sources.join(', ')}.`, ` Reference docs: ${sources.join(', ')}.`)
    : '';
  return localizeText(
    language,
    `${title} 프로젝트는 기존 저장소와 문서를 system of record로 삼고, 현재 phase 범위 안에서 실행 가능한 backlog와 verification contract를 유지한다.${sourceNote}`,
    `${title} uses the existing repository and docs as the system of record, and keeps an executable backlog and verification contract within the current phase.${sourceNote}`
  );
}

export function buildSpecFolderCandidates(docCandidates) {
  const buckets = new Map();
  for (const item of Array.isArray(docCandidates) ? docCandidates : []) {
    if (!item?.sourceRoot) continue;
    const current = buckets.get(item.sourceRoot) || {
      root: item.sourceRoot,
      docCount: 0,
      kinds: new Set(),
      recommended: false
    };
    current.docCount += 1;
    current.kinds.add(item.kind || 'doc');
    if (['spec', 'plan'].includes(item.kind)) current.recommended = true;
    buckets.set(item.sourceRoot, current);
  }
  return [...buckets.values()]
    .map((item) => ({
      root: item.root,
      docCount: item.docCount,
      kinds: [...item.kinds].sort(),
      recommended: item.recommended
    }))
    .sort((left, right) => {
      if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
      if (left.docCount !== right.docCount) return right.docCount - left.docCount;
      return left.root.localeCompare(right.root);
    })
    .slice(0, 8);
}

export function explainRecommendedSpec(item, selectedRoots = [], language = 'ko') {
  const relativePath = String(item?.relativePath || '').replace(/\\/g, '/');
  const ext = path.extname(relativePath).toLowerCase();
  const root = String(item?.sourceRoot || '').replace(/\\/g, '/');
  if (/(^|\/)agents\.md$/i.test(relativePath)) return localizeText(language, '프로젝트 운영 원칙을 가장 직접적으로 설명하는 문서라서 포함했습니다.', 'Included because it most directly explains how this project is meant to be operated.');
  if (/(^|\/)readme\.md$/i.test(relativePath)) return localizeText(language, '프로젝트 전체 개요를 빠르게 잡는 최상위 문서라서 포함했습니다.', 'Included because it is the top-level overview that quickly explains the whole project.');
  if (ext === '.pdf') return root
    ? localizeText(language, `선택한 문서 묶음(${root}) 안의 PDF 요구사항 문서라서 포함했습니다.`, `Included because it is a PDF requirements document inside the selected doc set (${root}).`)
    : localizeText(language, 'PDF 요구사항 문서라서 포함했습니다.', 'Included because it is a PDF requirements document.');
  if (item?.kind === 'spec') return root
    ? localizeText(language, `선택한 문서 묶음(${root}) 안의 핵심 명세 문서라서 포함했습니다.`, `Included because it is a core spec document inside the selected doc set (${root}).`)
    : localizeText(language, '핵심 명세 문서라서 포함했습니다.', 'Included because it is a core spec document.');
  if (item?.kind === 'plan') return root
    ? localizeText(language, `선택한 문서 묶음(${root}) 안의 실행 계획 문서라서 포함했습니다.`, `Included because it is an execution-plan document inside the selected doc set (${root}).`)
    : localizeText(language, '실행 계획 문서라서 포함했습니다.', 'Included because it is an execution-plan document.');
  if (item?.kind === 'reference') return root
    ? localizeText(language, `선택한 문서 묶음(${root}) 안의 참고 문서라서 포함했습니다.`, `Included because it is a reference document inside the selected doc set (${root}).`)
    : localizeText(language, '참고 문서라서 포함했습니다.', 'Included because it is a reference document.');
  if (selectedRoots.length && root) return localizeText(language, `선택한 문서 묶음(${root}) 안에 있어 포함했습니다.`, `Included because it is inside the selected doc set (${root}).`);
  return localizeText(language, '현재 저장소 이해에 도움이 되는 상위 문서라서 포함했습니다.', 'Included because it helps explain the current repository at a high level.');
}
