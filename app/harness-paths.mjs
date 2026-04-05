import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_HOME = path.join(os.homedir() || process.env.USERPROFILE || '', '.codex');
const overrideHarnessMetaDir = String(process.env.HARNESS_META_DIR || '').trim();
const overrideRunsDir = String(process.env.HARNESS_RUNS_DIR || '').trim();
const overrideProjectsDir = String(process.env.HARNESS_PROJECTS_DIR || '').trim();
const overrideMemoryDir = String(process.env.HARNESS_MEMORY_DIR || '').trim();

export const ROOT_DIR = path.resolve(APP_DIR, '..');
export const RUNS_DIR = overrideRunsDir
  ? path.resolve(overrideRunsDir)
  : path.join(ROOT_DIR, 'runs');
export const PROJECTS_DIR = overrideProjectsDir
  ? path.resolve(overrideProjectsDir)
  : path.join(ROOT_DIR, 'projects');
export const MEMORY_DIR = overrideMemoryDir
  ? path.resolve(overrideMemoryDir)
  : path.join(ROOT_DIR, 'memory', 'projects');
export const HARNESS_META_DIR = overrideHarnessMetaDir
  ? path.resolve(overrideHarnessMetaDir)
  : path.join(ROOT_DIR, '.harness-web');
export const HARNESS_SETTINGS_FILE = path.join(HARNESS_META_DIR, 'settings.json');
export const GLOBAL_AGENTS_FILE = path.join(CODEX_HOME, 'AGENTS.md');
export const KARPATHY_SKILL_FILE = path.join(CODEX_HOME, 'skills', 'karpathy-guidelines', 'SKILL.md');
