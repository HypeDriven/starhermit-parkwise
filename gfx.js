'use strict';

// Parkwise graphics quality model: presets, per-category overrides, GPU
// detection, a cost summary and the Graphics panel strings. Pure (no three.js),
// so the settings panel, the renderer and the unit tests agree on what a
// setting means. Works in the browser (window.PARKWISE_GFX) and Node.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.PARKWISE_GFX = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {

    const PRESETS = ['low', 'balanced', 'high', 'ultra'];

    // Category → allowed tiers, cheapest first.
    const CATEGORIES = {
        shadows: ['off', 'low', 'medium', 'high'],
        ao: ['off', 'on', 'high'],
        bloom: ['off', 'on'],
        grade: ['off', 'on'],
        antialias: ['off', 'fxaa', 'smaa', 'msaa'],
        reflections: ['off', 'on'],
        detail: ['plain', 'detailed'],
        particles: ['low', 'high'],
    };

    // Each preset: a tier per category, a render scale (multiplies the capped
    // device pixel ratio) and the device-pixel-ratio cap.
    const TABLE = {
        low: { scale: 1, cap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low' },
        balanced: { scale: 1, cap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'low' },
        high: { scale: 1, cap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high' },
        ultra: { scale: 1.25, cap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high' },
    };

    const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

    /** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
    function detectPreset(gpu) {
        const g = String(gpu || '').toLowerCase();
        if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 'low';
        if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) return 'high';
        return 'balanced';
    }

    /** Auto choice: detected preset, capped at Balanced on touch/mobile devices. */
    function autoPreset(gpu, mobile) {
        const p = detectPreset(gpu);
        return mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced') ? 'balanced' : p;
    }

    function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

    /**
     * Resolve saved settings into concrete tiers.
     * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
     */
    function resolve(saved, detected) {
        const s = saved || {};
        const preset = PRESETS.includes(s.preset) ? s.preset : (PRESETS.includes(detected) ? detected : 'balanced');
        const row = TABLE[preset];
        const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
        const out = { preset, auto: !PRESETS.includes(s.preset), scale: row.scale * userScale, userScale, cap: row.cap };
        for (const [cat, tiers] of Object.entries(CATEGORIES)) out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
        out.adaptive = s.adaptive !== false;
        out.showFps = !!s.show_fps;
        // Post-processing runs only when something needs it; otherwise the canvas renders directly.
        out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
        return out;
    }

    /** Choosing a preset clears every per-category override (render scale and toggles stay). */
    function withPreset(saved, preset) {
        const s = Object.assign({}, saved || {});
        for (const cat of Object.keys(CATEGORIES)) delete s[cat];
        s.preset = preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto';
        return s;
    }

    /** The preset's own tier for a category (for "From preset (…)" labels). */
    function presetTier(preset, cat) {
        return TABLE[preset] ? TABLE[preset][cat] : undefined;
    }

    // ---- panel strings (the rest of the game UI is English-only) ----
    const EN = {
        graphics: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
        renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
        adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
        postFailed: 'Post-processing is unavailable on this device; the game renders without it.',
        cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Scene detail', particles: 'Particles' },
        tiers: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', off: 'Off', on: 'On', medium: 'Medium', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
        sum: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing' },
        gpuUnknown: 'unknown GPU',
    };
    function over(base, patch) {
        const o = Object.assign({}, base, patch);
        for (const k of ['cats', 'tiers', 'sum']) o[k] = Object.assign({}, base[k], patch[k] || {});
        return o;
    }
    const ES = over(EN, {
        graphics: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
        renderScale: 'Escala de renderizado', fromPreset: 'Según el ajuste ({tier})',
        adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
        postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
        cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Gradación de color', antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de la escena', particles: 'Partículas' },
        tiers: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', off: 'No', on: 'Sí', medium: 'Media', plain: 'Simple', detailed: 'Detallado' },
        sum: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin antialiasing' },
        gpuUnknown: 'GPU desconocida',
    });
    const STRINGS = {
        'en-US': EN,
        'en-GB': over(EN, { cats: { grade: 'Colour grade' } }),
        'es-419': ES,
        'es-ES': over(ES, { renderScale: 'Escala de renderizado', showFps: 'Mostrar FPS' }),
        'de-DE': over(EN, {
            graphics: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
            renderScale: 'Renderskalierung', fromPreset: 'Laut Voreinstellung ({tier})',
            adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
            postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
            cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur', antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Szenendetails', particles: 'Partikel' },
            tiers: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', off: 'Aus', on: 'An', medium: 'Mittel', plain: 'Einfach', detailed: 'Detailliert' },
            sum: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung', bloom: 'Leuchteffekt', reflections: 'Spiegelungen', noAa: 'keine Kantenglättung' },
            gpuUnknown: 'unbekannte GPU',
        }),
        'fr-FR': over(EN, {
            graphics: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
            renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
            adaptive: 'Résolution adaptative', showFps: 'Afficher les images/s',
            postFailed: 'Le post-traitement est indisponible sur cet appareil ; le jeu s’affiche sans.',
            cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage', antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détails de la scène', particles: 'Particules' },
            tiers: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', off: 'Non', on: 'Oui', medium: 'Moyenne', plain: 'Simple', detailed: 'Détaillé' },
            sum: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète', bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage' },
            gpuUnknown: 'GPU inconnu',
        }),
        'pt-BR': over(EN, {
            graphics: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
            renderScale: 'Escala de renderização', fromPreset: 'Conforme a predefinição ({tier})',
            adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
            postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
            cats: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento', reflections: 'Reflexos', detail: 'Detalhes da cena', particles: 'Partículas' },
            tiers: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', off: 'Não', on: 'Sim', medium: 'Média', plain: 'Simples', detailed: 'Detalhado' },
            sum: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem antisserrilhamento' },
            gpuUnknown: 'GPU desconhecida',
        }),
        'it-IT': over(EN, {
            graphics: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
            renderScale: 'Scala di rendering', fromPreset: 'Da preimpostazione ({tier})',
            adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame al secondo',
            postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
            cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio scena', particles: 'Particelle' },
            tiers: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', off: 'No', on: 'Sì', medium: 'Media', plain: 'Semplice', detailed: 'Dettagliato' },
            sum: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza antialiasing' },
            gpuUnknown: 'GPU sconosciuta',
        }),
    };
    STRINGS['fr-CA'] = over(STRINGS['fr-FR'], { showFps: 'Afficher les images par seconde' });
    // StarHermit account strings (sign-in / invite buttons and toasts), same locale pick.
    const SH = {
        'en-US': { signIn: 'Sign in with StarHermit', signInHint: 'Sync your progress and settings.', invite: 'Invite a friend', inviteHint: 'Copy your invite link.', copied: 'Invite link copied to the clipboard.', copyFailed: 'Could not copy the invite link.', signedOut: 'Signed out — playing locally.', lbPosting: 'Posting score to the leaderboard…', lbRank: 'Leaderboard rank: #{rank}', lbPosted: 'Score posted to the leaderboard.', lbNotPosted: 'Score not posted to the leaderboard.' },
        'en-GB': { signIn: 'Sign in with StarHermit', signInHint: 'Sync your progress and settings.', invite: 'Invite a friend', inviteHint: 'Copy your invite link.', copied: 'Invite link copied to the clipboard.', copyFailed: 'Couldn’t copy the invite link.', signedOut: 'Signed out — playing locally.', lbPosting: 'Posting score to the leaderboard…', lbRank: 'Leaderboard rank: #{rank}', lbPosted: 'Score posted to the leaderboard.', lbNotPosted: 'Score not posted to the leaderboard.' },
        'es-419': { signIn: 'Iniciar sesión con StarHermit', signInHint: 'Sincroniza tu progreso y tus ajustes.', invite: 'Invitar a un amigo', inviteHint: 'Copia tu enlace de invitación.', copied: 'Enlace de invitación copiado al portapapeles.', copyFailed: 'No se pudo copiar el enlace de invitación.', signedOut: 'Sesión cerrada: juegas en modo local.', lbPosting: 'Enviando la puntuación a la clasificación…', lbRank: 'Puesto en la clasificación: #{rank}', lbPosted: 'Puntuación enviada a la clasificación.', lbNotPosted: 'No se envió la puntuación a la clasificación.' },
        'es-ES': { signIn: 'Iniciar sesión con StarHermit', signInHint: 'Sincroniza tu progreso y tus ajustes.', invite: 'Invitar a un amigo', inviteHint: 'Copia tu enlace de invitación.', copied: 'Enlace de invitación copiado al portapapeles.', copyFailed: 'No se ha podido copiar el enlace de invitación.', signedOut: 'Sesión cerrada: juegas en local.', lbPosting: 'Enviando la puntuación a la clasificación…', lbRank: 'Puesto en la clasificación: #{rank}', lbPosted: 'Puntuación enviada a la clasificación.', lbNotPosted: 'No se ha enviado la puntuación a la clasificación.' },
        'de-DE': { signIn: 'Mit StarHermit anmelden', signInHint: 'Fortschritt und Einstellungen synchronisieren.', invite: 'Freund einladen', inviteHint: 'Einladungslink kopieren.', copied: 'Einladungslink in die Zwischenablage kopiert.', copyFailed: 'Einladungslink konnte nicht kopiert werden.', signedOut: 'Abgemeldet – du spielst lokal weiter.', lbPosting: 'Punktzahl wird an die Bestenliste gesendet …', lbRank: 'Platz in der Bestenliste: #{rank}', lbPosted: 'Punktzahl an die Bestenliste gesendet.', lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.' },
        'fr-FR': { signIn: 'Se connecter avec StarHermit', signInHint: 'Synchronisez progression et réglages.', invite: 'Inviter un ami', inviteHint: 'Copier votre lien d’invitation.', copied: 'Lien d’invitation copié dans le presse-papiers.', copyFailed: 'Impossible de copier le lien d’invitation.', signedOut: 'Déconnecté — vous jouez en local.', lbPosting: 'Envoi du score au classement…', lbRank: 'Rang au classement : #{rank}', lbPosted: 'Score envoyé au classement.', lbNotPosted: 'Score non envoyé au classement.' },
        'fr-CA': { signIn: 'Se connecter avec StarHermit', signInHint: 'Synchronisez votre progression et vos paramètres.', invite: 'Inviter un ami', inviteHint: 'Copier votre lien d’invitation.', copied: 'Lien d’invitation copié dans le presse-papiers.', copyFailed: 'Impossible de copier le lien d’invitation.', signedOut: 'Déconnecté — vous jouez en local.', lbPosting: 'Envoi du pointage au classement…', lbRank: 'Rang au classement : #{rank}', lbPosted: 'Pointage envoyé au classement.', lbNotPosted: 'Pointage non envoyé au classement.' },
        'pt-BR': { signIn: 'Entrar com StarHermit', signInHint: 'Sincronize seu progresso e suas configurações.', invite: 'Convidar um amigo', inviteHint: 'Copie seu link de convite.', copied: 'Link de convite copiado para a área de transferência.', copyFailed: 'Não foi possível copiar o link de convite.', signedOut: 'Sessão encerrada — jogando localmente.', lbPosting: 'Enviando a pontuação para o ranking…', lbRank: 'Posição no ranking: #{rank}', lbPosted: 'Pontuação enviada para o ranking.', lbNotPosted: 'A pontuação não foi enviada para o ranking.' },
        'it-IT': { signIn: 'Accedi con StarHermit', signInHint: 'Sincronizza progressi e impostazioni.', invite: 'Invita un amico', inviteHint: 'Copia il tuo link di invito.', copied: 'Link di invito copiato negli appunti.', copyFailed: 'Impossibile copiare il link di invito.', signedOut: 'Disconnesso: giochi in locale.', lbPosting: 'Invio del punteggio alla classifica…', lbRank: 'Posizione in classifica: #{rank}', lbPosted: 'Punteggio inviato alla classifica.', lbNotPosted: 'Punteggio non inviato alla classifica.' },
    };
    for (const loc of Object.keys(STRINGS)) STRINGS[loc] = Object.assign({}, STRINGS[loc], { sh: SH[loc] });

    /** Pick the closest supported locale for a BCP-47 tag (exact, then language, then en-US). */
    function pickLocale(tag) {
        const t = String(tag || '').replace('_', '-');
        const exact = Object.keys(STRINGS).find(k => k.toLowerCase() === t.toLowerCase());
        if (exact) return exact;
        const lang = t.split('-')[0].toLowerCase();
        if (lang === 'es') return /-(es)$/i.test(t) ? 'es-ES' : 'es-419';
        if (lang === 'en' && /-(gb|au|nz|ie|in|za)$/i.test(t)) return 'en-GB';
        if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
        const byLang = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' }[lang];
        return byLang || 'en-US';
    }
    function strings(locale) { return STRINGS[locale] || EN; }

    /** One-line cost summary: shadows · AO · bloom · reflections · AA · WxH px. */
    function describe(r, pixels, S) {
        const s = (S || EN).sum;
        const parts = [
            r.shadows === 'off' ? s.noShadows : s.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
            r.ao === 'off' ? null : r.ao === 'high' ? s.aoHigh : s.ao,
            r.bloom === 'on' ? s.bloom : null,
            r.reflections === 'on' ? s.reflections : null,
            r.antialias === 'off' ? s.noAa : r.antialias.toUpperCase(),
            pixels ? `${pixels[0]}×${pixels[1]} px` : null,
        ];
        return parts.filter(Boolean).join(' · ');
    }

    return { PRESETS, CATEGORIES, SHADOW_MAP, detectPreset, autoPreset, resolve, withPreset, presetTier, describe, STRINGS, pickLocale, strings };
});
