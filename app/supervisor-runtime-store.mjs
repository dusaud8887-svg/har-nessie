import { promises as fs } from 'node:fs';
import path from 'node:path';

function sanitizeRuntimeState(state, now) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    running: source.running !== false,
    lastPolledAt: Number(source.lastPolledAt || 0) || 0,
    inFlight: false,
    lastPassAt: String(source.lastPassAt || '').trim(),
    lastAction: String(source.lastAction || '').trim(),
    lastActionAt: String(source.lastActionAt || '').trim(),
    lastError: String(source.lastError || '').trim(),
    lastErrorAt: String(source.lastErrorAt || '').trim(),
    lastRunId: String(source.lastRunId || '').trim(),
    nextScheduledAt: String(source.nextScheduledAt || '').trim(),
    pausedReason: String(source.pausedReason || '').trim(),
    lastScheduledAt: String(source.lastScheduledAt || '').trim(),
    history: Array.isArray(source.history) ? source.history.slice(-12) : [],
    updatedAt: String(source.updatedAt || now()).trim() || now()
  };
}

export function createSupervisorRuntimeStore({ filePath, now = () => new Date().toISOString(), recordHarnessError = null }) {
  let writeQueue = Promise.resolve();

  function buildSnapshot(runtimeMap) {
    const supervisors = {};
    for (const [projectId, runtime] of runtimeMap.entries()) {
      const normalizedId = String(projectId || '').trim();
      if (!normalizedId) continue;
      supervisors[normalizedId] = sanitizeRuntimeState(runtime, now);
    }
    return {
      schemaVersion: '1',
      updatedAt: now(),
      supervisors
    };
  }

  function schedulePersist(runtimeMap) {
    const snapshot = buildSnapshot(runtimeMap);
    writeQueue = writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
      })
      .catch(async (error) => {
        if (typeof recordHarnessError === 'function') {
          await recordHarnessError('supervisor-runtime.persist', error, { filePath });
        } else {
          console.error('[supervisor-runtime.persist]', error?.message || String(error || ''), { filePath });
        }
      });
    return writeQueue;
  }

  async function restore(runtimeMap) {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const supervisors = raw && typeof raw === 'object' ? raw.supervisors : {};
      for (const [projectId, runtime] of Object.entries(supervisors || {})) {
        runtimeMap.set(projectId, sanitizeRuntimeState(runtime, now));
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (typeof recordHarnessError === 'function') {
        await recordHarnessError('supervisor-runtime.restore', error, { filePath });
      } else {
        console.error('[supervisor-runtime.restore]', error?.message || String(error || ''), { filePath });
      }
    }
  }

  return {
    schedulePersist,
    restore
  };
}
