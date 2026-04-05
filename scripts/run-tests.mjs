import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tempStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'har-nessie-test-state-'));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempMetaDir = path.join(tempStateRoot, 'meta');
const tempRunsDir = path.join(tempStateRoot, 'runs');
const tempProjectsDir = path.join(tempStateRoot, 'projects');
const tempMemoryDir = path.join(tempStateRoot, 'memory', 'projects');

try {
  await Promise.all([
    fs.mkdir(tempMetaDir, { recursive: true }),
    fs.mkdir(tempRunsDir, { recursive: true }),
    fs.mkdir(tempProjectsDir, { recursive: true }),
    fs.mkdir(tempMemoryDir, { recursive: true })
  ]);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', 'tests/*.test.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HARNESS_META_DIR: tempMetaDir,
      HARNESS_RUNS_DIR: tempRunsDir,
      HARNESS_PROJECTS_DIR: tempProjectsDir,
      HARNESS_MEMORY_DIR: tempMemoryDir
    },
    stdio: 'inherit',
    windowsHide: true
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
} finally {
  await fs.rm(tempStateRoot, { recursive: true, force: true }).catch(() => {});
}
