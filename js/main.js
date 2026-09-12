/* Chain Dominoes — bootstrap: host handshake, capability detection,
 * store load (with cloud-conflict check), UI start, lifecycle.
 */
(function (root) {
  'use strict';

  function boot() {
    const P = root.ChainDominoesPlatform;
    const store = new P.Store();
    P.host.init();

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
    }

    const ui = new root.ChainDominoesUI.UI({
      store,
      audio: root.ChainDominoesAudio,
    });
    root.__CD_UI = ui;
    ui.init();

    // First-run: default telemetry consent stays off until the player opts in.

    // Warm the daily widget with server-synchronized time (hosted only).
    if (P.host.present) {
      P.host.syncTime().then(() => ui.refreshTitle()).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : globalThis);
