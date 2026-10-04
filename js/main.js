/* Chain Dominoes — bootstrap: host handshake, capability detection,
 * store load (with cloud-conflict check), UI start, lifecycle.
 */
(function (root) {
  'use strict';

  function boot() {
    const P = root.ChainDominoesPlatform;
    const store = new P.Store();
    P.host.init();
    P.host.loadBindings(store.settings.bindings).then(() => { if (root.__CD_UI) root.__CD_UI.refreshBindings(); });

    // Cloud save conflict check (preserves both, asks the player).
    if (P.host.present) {
      store.cloudLoad().then((conflict) => {
        if (conflict && root.__CD_UI) root.__CD_UI.refreshTitle();
      }).catch(() => {});
      // Hosted: the account nickname replaces the guest name everywhere
      // (match seats, boards, profile screen).
      P.host.fetchProfile().then((prof) => {
        if (prof) {
          store.doc.profile = { name: prof.name, avatar: null, guest: false };
          store.saveNow();
          if (root.__CD_UI) root.__CD_UI.refreshTitle();
        }
      }).catch(() => {});
      P.host.onSync(() => { if (root.__CD_UI) root.__CD_UI.refreshTitle(); });
      // Platform settings KV wins over the saved preferences.
      P.host.getSettings().then((kv) => {
        if (!kv || !Object.keys(kv).length) return;
        Object.assign(store.doc.settings, kv);
        store.saveNow();
        if (root.__CD_UI) root.__CD_UI.reapplySettings();
      }).catch(() => {});
    }
    P.host.onAuth((a) => {
      if (root.__CD_UI) {
        if (!a.signedIn) root.__CD_UI.platformNotice('signedOut');
        root.__CD_UI.refreshTitle();
      }
    });

    const ui = new root.ChainDominoesUI.UI({
      store,
      audio: root.ChainDominoesAudio,
    });
    root.__CD_UI = ui;
    ui.init();

    // First-run: default telemetry consent stays off until the player opts in.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : globalThis);
