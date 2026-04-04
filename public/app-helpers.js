(function attachHarnessUiHelpers(global) {
  let currentUiLanguage = 'en';

  function normalizeUiLanguage(value, fallback = 'en') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'en' || normalized === 'ko') return normalized;
    return fallback;
  }

  function setUiLanguage(value) {
    currentUiLanguage = normalizeUiLanguage(value, currentUiLanguage || 'en');
    try {
      global.localStorage?.setItem('har-nessie-ui-language', currentUiLanguage);
    } catch {}
    if (global.document?.documentElement) {
      global.document.documentElement.lang = currentUiLanguage === 'en' ? 'en' : 'ko';
    }
    return currentUiLanguage;
  }

  function getUiLanguage() {
    return currentUiLanguage;
  }

  function pickText(ko, en = '') {
    return currentUiLanguage === 'en' ? String(en || ko || '') : String(ko || en || '');
  }

  (function bootstrapUiLanguage() {
    let next = 'en';
    try {
      next = normalizeUiLanguage(global.localStorage?.getItem('har-nessie-ui-language') || '', 'en');
    } catch {}
    setUiLanguage(next);
  }());

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  }

  function clip(value, max = 160) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function normalizeAgentModel(value, fallback = 'codex') {
    const normalized = String(value || '').trim().toLowerCase();
    return ['codex', 'claude', 'gemini'].includes(normalized) ? normalized : fallback;
  }

  function providerLabel(value) {
    const normalized = normalizeAgentModel(value, 'codex');
    if (normalized === 'claude') return 'Claude';
    if (normalized === 'gemini') return 'Gemini';
    return 'Codex';
  }

  function browserReadinessLabel(browserVerification, readiness) {
    const target = String(browserVerification?.url || readiness?.targetUrl || '').trim();
    if (!target) return pickText('미설정', 'Not set');
    if (readiness?.ready) return `${target} · ${pickText('준비됨', 'Ready')}`;
    if (readiness?.configured) return `${target} · ${pickText('런타임 미준비', 'Runtime missing')}`;
    return target;
  }

  function browserReadinessDetail(readiness, browserVerification = null) {
    if (!readiness?.configured) {
      return browserVerification?.url
        ? pickText('브라우저 검증 설정은 있지만 런타임 확인 전입니다.', 'Browser verification is configured, but runtime readiness is not confirmed yet.')
        : pickText('브라우저 검증은 미설정 상태입니다. 웹 화면이나 브라우저 흐름을 확인해야 할 때만 설정하면 됩니다.', 'Browser verification is not configured. Set it only when you need to validate a web UI or browser flow.');
    }
    if (readiness?.ready) return `Playwright ${pickText('준비됨', 'ready')}${readiness.runtime?.version ? ` · ${readiness.runtime.version}` : ''}`;
    return readiness?.note || pickText('브라우저 검증 런타임이 준비되지 않았습니다. 웹 UI 검증이 필요한 경우에만 Playwright를 준비하면 됩니다.', 'Browser verification runtime is not ready. Install Playwright only when you need web UI verification.');
  }

  global.HarnessUiHelpers = {
    escapeHtml,
    clip,
    normalizeAgentModel,
    providerLabel,
    browserReadinessLabel,
    browserReadinessDetail,
    normalizeUiLanguage,
    setUiLanguage,
    getUiLanguage,
    pickText
  };
}(window));
