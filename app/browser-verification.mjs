import path from 'node:path';

export function createBrowserVerificationRunner(deps) {
  const {
    clipLine,
    firstUrlFromTask,
    fs,
    killProcessTree,
    normalizeBrowserVerificationConfig,
    normalizeDevServerConfig,
    probeHttpUrl,
    startBackgroundCommand,
    waitForHttpUrl
  } = deps;

  return async function runBrowserVerification(run, task, executionCtx, currentTaskDir, controller) {
    const browserConfig = normalizeBrowserVerificationConfig(run?.projectContext?.browserVerification) || {};
    const devServerConfig = normalizeDevServerConfig(run?.projectContext?.devServer, run?.projectPath || executionCtx?.reviewCwd || '') || null;
    const targetUrl = browserConfig.url || devServerConfig?.url || firstUrlFromTask(task);
    const selector = browserConfig.selector || '';
    const timeoutMs = Number(browserConfig.timeoutMs || devServerConfig?.timeoutMs || 15000);
    const result = {
      required: true,
      status: 'unverifiable',
      ok: false,
      targetUrl,
      selector,
      note: '',
      usedExistingServer: false,
      startedServer: false,
      screenshotPath: '',
      consoleSummary: [],
      stepLog: []
    };
    if (!targetUrl) {
      result.note = 'No browser target URL configured for this task.';
      return result;
    }

    let serverHandle = null;
    try {
      const alreadyHealthy = await probeHttpUrl(targetUrl, 1500);
      if (alreadyHealthy) {
        result.usedExistingServer = true;
        result.stepLog.push(`Attached to existing server at ${targetUrl}.`);
      } else if (devServerConfig?.command) {
        serverHandle = await startBackgroundCommand(devServerConfig.command, devServerConfig.cwd || run.projectPath || executionCtx.reviewCwd, controller);
        result.startedServer = true;
        result.stepLog.push(`Started dev server with command: ${devServerConfig.command}`);
        const healthy = await waitForHttpUrl(targetUrl, devServerConfig.timeoutMs || timeoutMs);
        if (!healthy) {
          const output = serverHandle.readOutput();
          await fs.writeFile(path.join(currentTaskDir, 'browser-dev-server.log'), `${output.stdout || ''}\n${output.stderr || ''}`.trim(), 'utf8');
          result.note = `Dev server did not become healthy at ${targetUrl}.`;
          return result;
        }
      } else {
        result.note = `Target URL ${targetUrl} is not reachable and no dev server command was configured.`;
        return result;
      }

      let playwrightModule = null;
      try {
        playwrightModule = await import('playwright');
      } catch {
        result.note = 'Playwright is not installed, so browser verification was recorded as unverifiable.';
        return result;
      }

      const browser = await playwrightModule.chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('console', (message) => {
        if (result.consoleSummary.length >= 12) return;
        result.consoleSummary.push(`${message.type()}: ${clipLine(message.text(), 180)}`);
      });
      await page.goto(targetUrl, { waitUntil: browserConfig.waitUntil || 'domcontentloaded', timeout: timeoutMs });
      result.stepLog.push(`Navigated to ${targetUrl}.`);
      if (selector) {
        await page.waitForSelector(selector, { timeout: timeoutMs });
        result.stepLog.push(`Selector matched: ${selector}`);
      }
      const screenshotPath = path.join(currentTaskDir, 'browser-screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;
      result.status = 'passed';
      result.ok = true;
      result.note = selector ? `Browser verification passed for selector ${selector}.` : 'Browser verification passed.';
      await context.close();
      await browser.close();
      return result;
    } catch (error) {
      result.status = 'failed';
      result.ok = false;
      result.note = clipLine(error?.message || 'Browser verification failed.');
      return result;
    } finally {
      if (serverHandle?.child) {
        killProcessTree(serverHandle.child);
        if (controller) controller.children.delete(serverHandle.child);
      }
    }
  };
}
