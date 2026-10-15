// Check only after the user closes the host's extension manager. The host also
// closes/recreates that dialog during updates; those automatic closes are ignored.
async function fetchInstalledManifest(url) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await globalThis.fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    const value = response.ok ? await response.json() : null;
    return { ok: response.ok, json: async () => value };
  } finally { clearTimeout(timer); }
}

export function installExtensionUpdateRefresh({ moduleUrl, documentRef = globalThis.document,
  fetchManifest = fetchInstalledManifest,
  reload = () => globalThis.location.reload(), isBusy = () => false,
  schedule = (callback, ms) => setTimeout(callback, ms), cancel = timer => clearTimeout(timer),
} = {}) {
  let loaded;
  try { loaded = new URL(moduleUrl); } catch { return () => {}; }
  if (!/\/dist\/qqj-app\.js$/.test(loaded.pathname) || !documentRef?.addEventListener) return () => {};
  const manifestUrl = new URL('../manifest.json', loaded);
  const pendingDialogs = new Map();
  let disposed = false, checking = false, requested = false, timer = null;
  const refreshWhenIdle = () => {
    if (disposed) return;
    if (isBusy()) { timer = schedule(refreshWhenIdle, 500); return; }
    reload();
  };
  const check = async () => {
    if (disposed || checking || requested) return;
    checking = true;
    try {
      const response = await fetchManifest(manifestUrl.href);
      if (!response.ok) return;
      const manifest = await response.json();
      if (disposed || typeof manifest?.js !== 'string') return;
      const installed = new URL(manifest.js, manifestUrl);
      // A changed build stamp on this exact installed extension is sufficient;
      // a failed fetch, unrelated extension, or arbitrary manifest URL is not.
      if (installed.origin !== loaded.origin || installed.pathname !== loaded.pathname || installed.search === loaded.search) return;
      requested = true;
      refreshWhenIdle();
    } catch { /* An unavailable manifest must never trigger a speculative reload. */ }
    finally { checking = false; }
  };
  const onClick = event => {
    const button = event.target?.closest?.('.popup-button-ok');
    const dialog = button?.closest?.('dialog.popup');
    if (!dialog?.querySelector?.('.extensions_info') || pendingDialogs.has(dialog)) return;
    const onClose = () => { pendingDialogs.delete(dialog); void check(); };
    pendingDialogs.set(dialog, onClose);
    // Wait for the host's async onClosing/saveSettings and actual native close.
    dialog.addEventListener('close', onClose, { once: true });
  };
  documentRef.addEventListener('click', onClick, true);
  return () => {
    disposed = true;
    documentRef.removeEventListener('click', onClick, true);
    for (const [dialog, callback] of pendingDialogs) dialog.removeEventListener('close', callback);
    pendingDialogs.clear();
    if (timer !== null) cancel(timer);
  };
}
