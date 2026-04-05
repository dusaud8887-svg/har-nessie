import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createRuntimeObservability({ metaDir, now = () => new Date().toISOString() }) {
  const logFile = path.join(metaDir, 'runtime-events.ndjson');
  let writeQueue = Promise.resolve();

  function normalizeCorrelationContext(context = {}) {
    const normalized = context && typeof context === 'object' ? { ...context } : {};
    const projectId = String(normalized.projectId || '').trim();
    const runId = String(normalized.runId || '').trim();
    const taskId = String(normalized.taskId || '').trim();
    const correlationId = [
      projectId ? `project:${projectId}` : '',
      runId ? `run:${runId}` : '',
      taskId ? `task:${taskId}` : ''
    ].filter(Boolean).join('|');
    return {
      context: {
        ...normalized,
        ...(projectId ? { projectId } : {}),
        ...(runId ? { runId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(correlationId ? { correlationId } : {})
      },
      projectId,
      runId,
      taskId,
      correlationId
    };
  }

  async function appendEntry(entry) {
    await fs.mkdir(metaDir, { recursive: true });
    await fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function schedule(entry) {
    writeQueue = writeQueue
      .then(() => appendEntry(entry))
      .catch((error) => {
        console.error('[harness-observability] failed to append runtime event', {
          logFile,
          message: error?.message || String(error || '')
        });
      });
    return writeQueue;
  }

  async function recordHarnessEvent(level, scope, message, context = {}) {
    const normalized = normalizeCorrelationContext(context);
    const entry = {
      at: now(),
      level: String(level || 'info').trim() || 'info',
      scope: String(scope || 'runtime').trim() || 'runtime',
      message: String(message || '').trim(),
      ...(normalized.projectId ? { projectId: normalized.projectId } : {}),
      ...(normalized.runId ? { runId: normalized.runId } : {}),
      ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
      ...(normalized.correlationId ? { correlationId: normalized.correlationId } : {}),
      context: normalized.context
    };
    if (entry.level === 'error') {
      console.error(`[${entry.scope}] ${entry.message}`, entry.context);
    } else if (entry.level === 'warn') {
      console.warn(`[${entry.scope}] ${entry.message}`, entry.context);
    }
    await schedule(entry);
    return entry;
  }

  async function recordHarnessError(scope, error, context = {}) {
    const detail = {
      ...((context && typeof context === 'object') ? context : {}),
      errorName: error?.name || '',
      errorCode: error?.code || '',
      stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 6).join('\n') : ''
    };
    return recordHarnessEvent('error', scope, error?.message || String(error || 'Unknown harness error'), detail);
  }

  async function withObservedFallback(work, { scope, context = {}, fallback = null, level = 'warn' }) {
    try {
      return await work();
    } catch (error) {
      if (level === 'error') {
        await recordHarnessError(scope, error, context);
      } else {
        await recordHarnessEvent('warn', scope, error?.message || String(error || 'Observed fallback'), {
          ...context,
          errorCode: error?.code || '',
          errorName: error?.name || ''
        });
      }
      return typeof fallback === 'function' ? fallback(error) : fallback;
    }
  }

  return {
    logFile,
    recordHarnessEvent,
    recordHarnessError,
    withObservedFallback
  };
}
