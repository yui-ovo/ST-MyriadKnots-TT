import test from 'node:test';
import assert from 'node:assert/strict';
import { installExtensionUpdateRefresh } from '../src/extension-update-refresh.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup({ js = 'dist/qqj-app.js?v=new', ok = true, busy = false, extensionManager = true } = {}) {
  const events = new Map(), closes = new Map(), timers = [];
  let reloads = 0, reads = 0;
  const documentRef = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const dialog = { querySelector: () => extensionManager, addEventListener: (name, fn) => closes.set(name, fn), removeEventListener: name => closes.delete(name) };
  const target = { closest: selector => selector === '.popup-button-ok' ? { closest: () => dialog } : null };
  const stop = installExtensionUpdateRefresh({ moduleUrl: 'https://host.test/scripts/extensions/third-party/qqj/dist/qqj-app.js?v=old', documentRef,
    fetchManifest: async url => { reads++; assert.equal(url, 'https://host.test/scripts/extensions/third-party/qqj/manifest.json'); return { ok, json: async () => ({ js }) }; },
    reload: () => reloads++, isBusy: () => busy, schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => timers.splice(0),
  });
  return { click: () => events.get('click')?.({ target }), close: () => closes.get('close')?.(), stop, timers,
    idle: () => { busy = false; }, reads: () => reads, reloads: () => reloads };
}

test('updated own build reloads once only after user Close and actual host close', async () => {
  const host = setup();
  host.close(); await tick(); assert.equal(host.reads(), 0, 'automatic popup recreation is ignored');
  host.click(); host.click(); await tick(); assert.equal(host.reads(), 0, 'wait for host settings save and close');
  host.close(); await tick(); assert.equal(host.reloads(), 1);
  host.close(); await tick(); assert.equal(host.reloads(), 1);
});

test('unchanged, unrelated, malformed, unavailable manifests and other dialogs do not reload', async () => {
  for (const options of [{ js: 'dist/qqj-app.js?v=old' }, { js: 'https://other.test/dist/qqj-app.js?v=new' },
    { js: '../other/dist/qqj-app.js?v=new' }, { js: null }, { ok: false }, { extensionManager: false }]) {
    const host = setup(options); host.click(); host.close(); await tick(); assert.equal(host.reloads(), 0); host.stop();
  }
});

test('active work delays reload until idle and cleanup cancels pending reload', async () => {
  const host = setup({ busy: true }); host.click(); host.close(); await tick();
  assert.equal(host.reloads(), 0); assert.equal(host.timers.length, 1);
  host.idle(); host.timers.shift()(); assert.equal(host.reloads(), 1);
  const stopped = setup({ busy: true }); stopped.click(); stopped.close(); await tick(); stopped.stop();
  assert.equal(stopped.timers.length, 0); stopped.close(); assert.equal(stopped.reloads(), 0);
});

test('removing the listener before host close prevents a refresh', async () => {
  const host = setup(); host.click(); host.stop(); host.close(); await tick(); assert.equal(host.reads(), 0);
});
