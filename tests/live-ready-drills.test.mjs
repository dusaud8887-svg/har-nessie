import test from 'node:test';
import assert from 'node:assert/strict';
import { runCorruptionDrill, runLiveReadyDrill } from '../scripts/live-ready-drill.mjs';

test('live-ready drill covers clarify, approval, retry, requeue, skip, stop-resume, and automatic replanning flows', { concurrency: false, timeout: 90000 }, async () => {
  const report = await runLiveReadyDrill();

  assert.equal(report.ok, true);
  assert.equal(report.scenarioCount, 7);
  assert.ok(report.scenarios.some((item) => item.name === 'clarify-approval-success' && item.status === 'completed'));
  assert.ok(report.scenarios.some((item) => item.name === 'retry-flow' && item.status === 'completed'));
  assert.ok(report.scenarios.some((item) => item.name === 'requeue-flow' && item.status === 'completed'));
  assert.ok(report.scenarios.some((item) => item.name === 'skip-flow' && item.taskStatus === 'skipped'));
  assert.ok(report.scenarios.some((item) => item.name === 'stop-resume-flow' && item.status === 'completed'));
  assert.ok(report.scenarios.some((item) => item.name === 'provider-profile-recovery' && item.status === 'completed'));
  assert.ok(report.scenarios.some((item) => item.name === 'replan-flow' && item.autoReplanApplied === true));

  const providerReadiness = report.scenarios.find((item) => item.name === 'clarify-approval-success')?.providerReadiness || [];
  assert.ok(providerReadiness.some((item) => item.capabilityId === 'codex' && item.ready === true));
  const providerRecovery = report.scenarios.find((item) => item.name === 'provider-profile-recovery')?.providerProfile;
  assert.equal(providerRecovery?.coordinationProvider, 'codex');
  assert.equal(providerRecovery?.workerProvider, 'gemini');
  assert.ok((providerRecovery?.selectedProviders || []).some((item) => item.provider === 'codex' && item.ready === true));
  assert.ok((providerRecovery?.selectedProviders || []).some((item) => item.provider === 'gemini' && item.ready === true));
});

test('corruption drill recovers stale running state and tolerates broken action logs', { concurrency: false, timeout: 90000 }, async () => {
  const report = await runCorruptionDrill();

  assert.equal(report.ok, true);
  assert.equal(report.detailStatus, 'stopped');
  assert.equal(report.recoveredTaskStatus, 'ready');
  assert.equal(report.codeContextMissing, true);
  assert.ok(report.actionRecordCount >= 0);
});
