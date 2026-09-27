// Isolated world: bridges chrome.storage / popup <-> page (MAIN world) script.
(() => {
  const SRC_MAIN = 'ytlg-main';
  const SRC_ISO = 'ytlg-iso';
  let latest = null;

  const toMain = (type, data) =>
    window.postMessage({ src: SRC_ISO, type, data }, location.origin);

  const pushSettings = () =>
    chrome.storage.sync.get(YTLG_DEFAULTS, (s) => toMain('settings', s));

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.src !== SRC_MAIN) return;
    if (e.data.type === 'stats') latest = e.data.data;
    else if (e.data.type === 'hello') pushSettings();
  });

  chrome.storage.onChanged.addListener((_, area) => {
    if (area === 'sync') pushSettings();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'getStats') {
      reply({ stats: latest });
    } else if (['jump', 'lower', 'autoQuality'].includes(msg.type)) {
      toMain(msg.type);
      reply({ ok: true });
    }
  });

  pushSettings();
})();
