/* Chain Dominoes — graphics quality model (pure, no three.js, no DOM).
 * Presets, per-category overrides, GPU detection, a cost summary and the
 * Graphics panel strings. Works in Node (module.exports, unit tests) and the
 * browser (window.ChainDominoesGfx). The renderer and the Settings panel both
 * read settings through resolve(), so they always agree on what a setting means.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChainDominoesGfx = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  const CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],       // RoomEnvironment IBL on ceramic, cup, wood
    detail: ['plain', 'detailed'],    // clearcoat glaze, bump-mapped felt/wood/pips
    particles: ['low', 'high'],       // coffee steam
    ambience: ['static', 'animated'], // window light shimmer
  };

  // Each preset: tiers plus a pixel-ratio cap and a render scale.
  const TABLE = {
    low: { cap: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', detail: 'plain', particles: 'low', ambience: 'static' },
    balanced: { cap: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'low', ambience: 'animated' },
    high: { cap: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', ambience: 'animated' },
    ultra: { cap: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', ambience: 'animated' },
  };

  const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  /** Best preset for a GPU from its unmasked renderer string; `mobile` caps it at balanced. */
  function detectPreset(gpu, mobile) {
    const g = String(gpu || '').toLowerCase();
    let p = 'balanced';
    if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
    if (mobile && p === 'high') p = 'balanced';
    return p;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /** Old saves stored quality as auto|low|medium|high. */
  function normalizePreset(p) {
    if (p === 'medium') return 'balanced';
    return PRESETS.includes(p) ? p : 'auto';
  }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }
   */
  function resolve(saved, detected) {
    const s = saved || {};
    const chosen = normalizePreset(s.preset);
    const preset = chosen !== 'auto' ? chosen : (PRESETS.includes(detected) ? detected : 'balanced');
    const row = TABLE[preset];
    const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
    const out = { preset, auto: chosen === 'auto', cap: row.cap, renderScale, scale: row.scale * renderScale };
    for (const cat of Object.keys(CATEGORIES)) {
      out[cat] = CATEGORIES[cat].includes(s[cat]) ? s[cat] : row[cat];
    }
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    out.shadowMap = SHADOW_MAP[out.shadows];
    // Post-processing runs only when something needs it (MSAA can use the canvas).
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** Choosing a preset clears every per-category override. */
  function choosePreset(saved, preset) {
    const s = Object.assign({}, saved || {});
    for (const cat of Object.keys(CATEGORIES)) delete s[cat];
    s.preset = normalizePreset(preset);
    return s;
  }

  /** The preset's own tier for a category (for "From preset (…)" labels). */
  function presetTier(preset, cat) {
    const row = TABLE[normalizePreset(preset)];
    return row ? row[cat] : undefined;
  }

  /* ----------------------------------------------------------- strings */
  const EN = {
    graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra',
    render_scale: 'Render scale', from_preset: 'From preset ({tier})',
    cat_shadows: 'Shadows', cat_ao: 'Ambient occlusion', cat_bloom: 'Bloom', cat_grade: 'Color grade',
    cat_antialias: 'Anti-aliasing', cat_reflections: 'Reflections', cat_detail: 'Surface detail',
    cat_particles: 'Steam particles', cat_ambience: 'Window light',
    t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High',
    t_plain: 'Plain', t_detailed: 'Detailed', t_static: 'Static', t_animated: 'Animated',
    adaptive: 'Adaptive resolution', show_fps: 'Show frame rate',
    post_failed: 'Post-processing is unavailable on this device, so the table renders without it.',
    unknown_gpu: 'unknown GPU',
    s_no_shadows: 'no shadows', s_shadows: '{n}² shadows', s_ao: 'ambient occlusion', s_ao_full: 'full ambient occlusion',
    s_bloom: 'bloom', s_reflections: 'reflections', s_no_aa: 'no anti-aliasing',
  };
  const STRINGS = {
    'en-US': EN,
    'en-GB': Object.assign({}, EN, { cat_grade: 'Colour grade' }),
    'es-419': {
      graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      render_scale: 'Escala de render', from_preset: 'Del preajuste ({tier})',
      cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Corrección de color',
      cat_antialias: 'Suavizado de bordes', cat_reflections: 'Reflejos', cat_detail: 'Detalle de superficies',
      cat_particles: 'Partículas de vapor', cat_ambience: 'Luz de la ventana',
      t_off: 'Desactivado', t_on: 'Activado', t_low: 'Baja', t_medium: 'Media', t_high: 'Alta',
      t_plain: 'Sencillo', t_detailed: 'Detallado', t_static: 'Estática', t_animated: 'Animada',
      adaptive: 'Resolución adaptativa', show_fps: 'Mostrar cuadros por segundo',
      post_failed: 'El posprocesado no está disponible en este dispositivo; la mesa se muestra sin él.',
      unknown_gpu: 'GPU desconocida',
      s_no_shadows: 'sin sombras', s_shadows: 'sombras {n}²', s_ao: 'oclusión ambiental', s_ao_full: 'oclusión ambiental completa',
      s_bloom: 'resplandor', s_reflections: 'reflejos', s_no_aa: 'sin suavizado',
    },
    'es-ES': {
      graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      render_scale: 'Escala de renderizado', from_preset: 'Del ajuste predefinido ({tier})',
      cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor', cat_grade: 'Corrección de color',
      cat_antialias: 'Suavizado de bordes', cat_reflections: 'Reflejos', cat_detail: 'Detalle de superficies',
      cat_particles: 'Partículas de vapor', cat_ambience: 'Luz de la ventana',
      t_off: 'Desactivado', t_on: 'Activado', t_low: 'Baja', t_medium: 'Media', t_high: 'Alta',
      t_plain: 'Sencillo', t_detailed: 'Detallado', t_static: 'Estática', t_animated: 'Animada',
      adaptive: 'Resolución adaptativa', show_fps: 'Mostrar fotogramas por segundo',
      post_failed: 'El posprocesado no está disponible en este dispositivo; la mesa se muestra sin él.',
      unknown_gpu: 'GPU desconocida',
      s_no_shadows: 'sin sombras', s_shadows: 'sombras {n}²', s_ao: 'oclusión ambiental', s_ao_full: 'oclusión ambiental completa',
      s_bloom: 'resplandor', s_reflections: 'reflejos', s_no_aa: 'sin suavizado',
    },
    'de-DE': {
      graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra',
      render_scale: 'Renderskalierung', from_preset: 'Aus Voreinstellung ({tier})',
      cat_shadows: 'Schatten', cat_ao: 'Umgebungsverdeckung', cat_bloom: 'Leuchten', cat_grade: 'Farbkorrektur',
      cat_antialias: 'Kantenglättung', cat_reflections: 'Spiegelungen', cat_detail: 'Oberflächendetails',
      cat_particles: 'Dampfpartikel', cat_ambience: 'Fensterlicht',
      t_off: 'Aus', t_on: 'An', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch',
      t_plain: 'Einfach', t_detailed: 'Detailliert', t_static: 'Statisch', t_animated: 'Animiert',
      adaptive: 'Adaptive Auflösung', show_fps: 'Bildrate anzeigen',
      post_failed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher wird ohne sie gerendert.',
      unknown_gpu: 'unbekannte GPU',
      s_no_shadows: 'keine Schatten', s_shadows: '{n}²-Schatten', s_ao: 'Umgebungsverdeckung', s_ao_full: 'volle Umgebungsverdeckung',
      s_bloom: 'Leuchten', s_reflections: 'Spiegelungen', s_no_aa: 'keine Kantenglättung',
    },
    'fr-FR': {
      graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
      render_scale: 'Échelle de rendu', from_preset: 'Selon le préréglage ({tier})',
      cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux', cat_grade: 'Étalonnage des couleurs',
      cat_antialias: 'Anticrénelage', cat_reflections: 'Reflets', cat_detail: 'Détail des surfaces',
      cat_particles: 'Particules de vapeur', cat_ambience: 'Lumière de la fenêtre',
      t_off: 'Désactivé', t_on: 'Activé', t_low: 'Faible', t_medium: 'Moyen', t_high: 'Élevé',
      t_plain: 'Simple', t_detailed: 'Détaillé', t_static: 'Statique', t_animated: 'Animée',
      adaptive: 'Résolution adaptative', show_fps: 'Afficher la fréquence d’images',
      post_failed: 'Le post-traitement n’est pas disponible sur cet appareil ; la table s’affiche sans.',
      unknown_gpu: 'GPU inconnu',
      s_no_shadows: 'sans ombres', s_shadows: 'ombres {n}²', s_ao: 'occlusion ambiante', s_ao_full: 'occlusion ambiante complète',
      s_bloom: 'halo', s_reflections: 'reflets', s_no_aa: 'sans anticrénelage',
    },
    'fr-CA': {
      graphics: 'Graphiques', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra',
      render_scale: 'Échelle de rendu', from_preset: 'Selon le préréglage ({tier})',
      cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux', cat_grade: 'Correction des couleurs',
      cat_antialias: 'Anticrénelage', cat_reflections: 'Reflets', cat_detail: 'Détail des surfaces',
      cat_particles: 'Particules de vapeur', cat_ambience: 'Lumière de la fenêtre',
      t_off: 'Désactivé', t_on: 'Activé', t_low: 'Faible', t_medium: 'Moyen', t_high: 'Élevé',
      t_plain: 'Simple', t_detailed: 'Détaillé', t_static: 'Statique', t_animated: 'Animée',
      adaptive: 'Résolution adaptative', show_fps: 'Afficher la fréquence d’affichage',
      post_failed: 'Le post-traitement n’est pas offert sur cet appareil; la table s’affiche sans.',
      unknown_gpu: 'GPU inconnu',
      s_no_shadows: 'sans ombres', s_shadows: 'ombres {n}²', s_ao: 'occlusion ambiante', s_ao_full: 'occlusion ambiante complète',
      s_bloom: 'halo', s_reflections: 'reflets', s_no_aa: 'sans anticrénelage',
    },
    'pt-BR': {
      graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra',
      render_scale: 'Escala de renderização', from_preset: 'Da predefinição ({tier})',
      cat_shadows: 'Sombras', cat_ao: 'Oclusão de ambiente', cat_bloom: 'Brilho', cat_grade: 'Correção de cor',
      cat_antialias: 'Suavização de bordas', cat_reflections: 'Reflexos', cat_detail: 'Detalhe das superfícies',
      cat_particles: 'Partículas de vapor', cat_ambience: 'Luz da janela',
      t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixa', t_medium: 'Média', t_high: 'Alta',
      t_plain: 'Simples', t_detailed: 'Detalhado', t_static: 'Estática', t_animated: 'Animada',
      adaptive: 'Resolução adaptativa', show_fps: 'Mostrar taxa de quadros',
      post_failed: 'O pós-processamento não está disponível neste dispositivo; a mesa é exibida sem ele.',
      unknown_gpu: 'GPU desconhecida',
      s_no_shadows: 'sem sombras', s_shadows: 'sombras {n}²', s_ao: 'oclusão de ambiente', s_ao_full: 'oclusão de ambiente completa',
      s_bloom: 'brilho', s_reflections: 'reflexos', s_no_aa: 'sem suavização',
    },
    'it-IT': {
      graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra',
      render_scale: 'Scala di rendering', from_preset: 'Dal preset ({tier})',
      cat_shadows: 'Ombre', cat_ao: 'Occlusione ambientale', cat_bloom: 'Bagliore', cat_grade: 'Correzione colore',
      cat_antialias: 'Antialiasing', cat_reflections: 'Riflessi', cat_detail: 'Dettaglio superfici',
      cat_particles: 'Particelle di vapore', cat_ambience: 'Luce della finestra',
      t_off: 'Disattivato', t_on: 'Attivato', t_low: 'Bassa', t_medium: 'Media', t_high: 'Alta',
      t_plain: 'Semplice', t_detailed: 'Dettagliato', t_static: 'Statica', t_animated: 'Animata',
      adaptive: 'Risoluzione adattiva', show_fps: 'Mostra frequenza fotogrammi',
      post_failed: 'La post-elaborazione non è disponibile su questo dispositivo; il tavolo viene mostrato senza.',
      unknown_gpu: 'GPU sconosciuta',
      s_no_shadows: 'senza ombre', s_shadows: 'ombre {n}²', s_ao: 'occlusione ambientale', s_ao_full: 'occlusione ambientale completa',
      s_bloom: 'bagliore', s_reflections: 'riflessi', s_no_aa: 'senza antialiasing',
    },
  };
  const LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

  /** Best supported locale for a BCP 47 tag (exact, Spain/Latin America split, then language). */
  function pickLocale(tag) {
    const t = String(tag || 'en-US');
    const exact = Object.keys(STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
    if (exact) return exact;
    const lang = t.split('-')[0].toLowerCase();
    if (lang === 'es') return /-es$/i.test(t) ? 'es-ES' : 'es-419';
    if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
    if (lang === 'en' && /-(gb|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
    return LANG_DEFAULT[lang] || 'en-US';
  }

  function t(locale, key, vars) {
    const table = STRINGS[locale] || EN;
    let s = table[key] != null ? table[key] : (EN[key] != null ? EN[key] : key);
    if (vars) for (const k of Object.keys(vars)) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }

  /** Label for a tier value (FXAA/SMAA/MSAA stay as acronyms). */
  function tierLabel(locale, tier) {
    if (tier === 'fxaa' || tier === 'smaa' || tier === 'msaa') return tier.toUpperCase();
    return t(locale, 't_' + tier);
  }

  /** Cost summary for the panel: effects in use and the drawing-buffer size. */
  function describe(r, pixels, locale) {
    const L = locale || 'en-US';
    const parts = [
      r.shadows === 'off' ? t(L, 's_no_shadows') : t(L, 's_shadows', { n: SHADOW_MAP[r.shadows] }),
      r.ao === 'off' ? null : t(L, r.ao === 'high' ? 's_ao_full' : 's_ao'),
      r.bloom === 'on' ? t(L, 's_bloom') : null,
      r.reflections === 'on' ? t(L, 's_reflections') : null,
      r.antialias === 'off' ? t(L, 's_no_aa') : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS, CATEGORIES, SHADOW_MAP, STRINGS,
    detectPreset, resolve, choosePreset, presetTier, normalizePreset, describe,
    pickLocale, t, tierLabel,
  };
});
