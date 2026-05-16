/**
 * ============================================================
 * VoiceBridge — script.js  v2.0  (Power Edition)
 *
 * KEY UPGRADES over v1:
 *
 *  VOICE ENGINE
 *  ─────────────────────────────────────────────────────────
 *  · spawnRecognition() — always creates a *fresh* instance
 *    on every restart; fixes the #1 "stops hearing" bug
 *  · Accumulated confirmedText + live interim shown in textarea
 *  · Silent restart on no-speech (no scary error messages)
 *  · Restart guard flag prevents race conditions
 *  · maxAlternatives: 3 — picks highest-confidence result
 *  · Graceful abort/stop separation
 *  · Auto-retry up to 8x on transient failures
 *
 *  TRANSLATION ENGINE
 *  ─────────────────────────────────────────────────────────
 *  · 3-tier fallback chain:
 *      1. Google Translate unofficial (translate.googleapis.com)
 *      2. MyMemory Free API (api.mymemory.translated.net)
 *      3. Google Translate alternative endpoint variant
 *  · Per-request AbortController with 8s timeout
 *  · Deduplication: won't re-translate same text twice
 *  · Smart debounce: 600ms after speech, 1400ms after typing
 *
 *  UI
 *  ─────────────────────────────────────────────────────────
 *  · Interim text shown live inside textarea (live preview box)
 *  · Signal strength dots animate with audio activity
 *  · Status messages are informative not alarming
 * ============================================================
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   §1 · DOM REFERENCES
   ═══════════════════════════════════════════════════════════ */
const micBtn         = document.getElementById('micBtn');
const micStatus      = document.getElementById('micStatus');
const micIcon        = document.getElementById('micIcon');
const waveform       = document.getElementById('waveform');
const signalDots     = document.getElementById('signalDots');
const interimBox     = document.getElementById('interimBox');
const sourceText     = document.getElementById('sourceText');
const translatedText = document.getElementById('translatedText');
const sourceLang     = document.getElementById('sourceLang');
const targetLang     = document.getElementById('targetLang');
const swapLangs      = document.getElementById('swapLangs');
const translateBtn   = document.getElementById('translateBtn');
const clearSource    = document.getElementById('clearSource');
const clearTarget    = document.getElementById('clearTarget');
const speakSource    = document.getElementById('speakSource');
const speakTarget    = document.getElementById('speakTarget');
const copyBtn        = document.getElementById('copyBtn');
const downloadBtn    = document.getElementById('downloadBtn');
const themeToggle    = document.getElementById('themeToggle');
const themeIcon      = document.getElementById('themeIcon');
const historyToggle  = document.getElementById('historyToggle');
const historyPanel   = document.getElementById('historyPanel');
const historyList    = document.getElementById('historyList');
const historyEmpty   = document.getElementById('historyEmpty');
const clearHistory   = document.getElementById('clearHistory');
const loadingOverlay = document.getElementById('loadingOverlay');
const sourceCount    = document.getElementById('sourceCount');
const targetCount    = document.getElementById('targetCount');
const toast          = document.getElementById('toast');

/* ═══════════════════════════════════════════════════════════
   §2 · APP STATE
   ═══════════════════════════════════════════════════════════ */
let isListening     = false;   // Is the mic session active?
let recognition     = null;    // Current SpeechRecognition instance
let isRestarting    = false;   // Guard: prevent double-spawn
let retryCount      = 0;       // Consecutive silent restarts
const MAX_RETRIES   = 8;
let confirmedText   = '';      // Accumulated final transcript this session
let translateTimer  = null;    // Debounce: auto-translate trigger
let typingTimer     = null;    // Typing animation frame timer
let lastTranslated  = '';      // Dedup: last text sent to translate API
let abortController = null;    // Current fetch AbortController
const MAX_HISTORY   = 20;

/* ═══════════════════════════════════════════════════════════
   §3 · BROWSER SUPPORT CHECK
   ═══════════════════════════════════════════════════════════ */
const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionAPI) {
  micBtn.disabled      = true;
  micBtn.style.opacity = '0.35';
  micBtn.style.cursor  = 'not-allowed';
  setStatus('⚠ Voice not supported — use Chrome or Edge', 'error');
  setTimeout(() => showToast('⚠ Please open in Google Chrome for voice features', 5000), 600);
}

/* ═══════════════════════════════════════════════════════════
   §4 · THEME TOGGLE
   ═══════════════════════════════════════════════════════════ */
const MOON_SVG = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
const SUN_SVG  = `
  <circle cx="12" cy="12" r="5"/>
  <line x1="12" y1="1" x2="12" y2="3"/>
  <line x1="12" y1="21" x2="12" y2="23"/>
  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
  <line x1="1" y1="12" x2="3" y2="12"/>
  <line x1="21" y1="12" x2="23" y2="12"/>
  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeIcon.innerHTML = theme === 'dark' ? MOON_SVG : SUN_SVG;
  localStorage.setItem('vb_theme', theme);
}
applyTheme(localStorage.getItem('vb_theme') || 'dark');
themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

/* ═══════════════════════════════════════════════════════════
   §5 · VOICE RECOGNITION ENGINE  ★ Robust Rewrite ★
   ═══════════════════════════════════════════════════════════ */

/**
 * spawnRecognition()
 * ─────────────────
 * Creates a BRAND-NEW SpeechRecognition instance and starts it.
 * This is the heart of the fix: we never "restart" an old instance
 * (which silently fails). We always abort the old one and spawn fresh.
 *
 * Called by: startListening(), and recognition.onend (auto-restart loop)
 */
function spawnRecognition() {
  if (!isListening) return;   // session ended — do nothing
  if (isRestarting) return;   // another spawn already in progress

  isRestarting = true;

  // Kill the old instance (detach onend first to prevent echo restarts)
  if (recognition) {
    recognition.onend   = null;
    recognition.onerror = null;
    try { recognition.abort(); } catch (_) { /* ignore */ }
    recognition = null;
  }

  // Give the browser ~120ms to release the audio device before re-acquiring
  setTimeout(() => {
    isRestarting = false;
    if (!isListening) return;

    const rec = new SpeechRecognitionAPI();

    // ── Configuration ──────────────────────────────────────
    rec.lang            = sourceLang.value;  // 'bn-BD' or 'en-US'
    rec.continuous      = true;              // stay alive after pauses
    rec.interimResults  = true;              // stream partial results live
    rec.maxAlternatives = 3;                 // consider top-3 → pick best confidence

    // ── onresult: speech heard ──────────────────────────────
    rec.onresult = (event) => {
      retryCount = 0;        // reset on any speech detected
      let interim = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result     = event.results[i];
        const bestAlt    = getBestAlternative(result);
        const transcript = bestAlt.transcript;

        if (result.isFinal) {
          confirmedText += transcript.trim() + ' ';
          interim = '';
        } else {
          interim += transcript;
        }
      }

      // Show confirmed + live interim in textarea
      renderTranscript(confirmedText, interim);

      // Interim preview box (below the textarea)
      if (interim.trim()) {
        interimBox.textContent = '🎙 ' + interim;
        interimBox.classList.add('active');
      } else {
        clearInterimBox();
      }

      // Auto-translate 600ms after confirmed text settles
      if (confirmedText.trim()) {
        clearTimeout(translateTimer);
        translateTimer = setTimeout(() => {
          clearInterimBox();
          doTranslate(confirmedText.trim());
        }, 600);
      }

      updateSourceCount();
      pulseWaveform();
    };

    // ── onaudiostart: mic has captured audio ────────────────
    rec.onaudiostart = () => {
      setStatus('🎙 Listening… speak clearly', 'listening');
      waveform.classList.add('active');
      signalDots && signalDots.classList.add('active');
    };

    // ── onsoundstart: non-speech sound detected ─────────────
    rec.onsoundstart  = () => setStatus('🔊 Sound detected…', 'listening');

    // ── onspeechstart: speech started ───────────────────────
    rec.onspeechstart = () => setStatus('💬 Hearing you…', 'listening');

    // ── onspeechend: speech paused ──────────────────────────
    rec.onspeechend   = () => setStatus('⏳ Processing…', 'listening');

    // ── onerror ─────────────────────────────────────────────
    rec.onerror = (event) => {
      const err = event.error;
      console.warn('[VoiceBridge] Recognition error:', err);

      // FATAL errors — stop the session
      if (err === 'not-allowed' || err === 'permission-denied') {
        forceStop();
        setStatus('🚫 Microphone permission denied', 'error');
        showToast('🚫 Allow microphone in browser settings', 4500);
        return;
      }

      // NON-FATAL — let onend handle the restart
      if (err === 'no-speech') {
        retryCount++;
        const msg = retryCount > MAX_RETRIES
          ? '🎙 Listening (speak louder or closer?)'
          : '🎙 Still listening…';
        setStatus(msg, 'listening');
        if (retryCount > MAX_RETRIES) retryCount = 0;
        return;
      }

      if (err === 'network') {
        setStatus('📡 Network issue — retrying…', 'listening');
        return;
      }

      // aborted = we triggered it ourselves; ignore
      if (err === 'aborted') return;

      // Other: audio-capture, service-not-allowed, etc.
      setStatus(`⚠ ${err} — retrying…`, 'listening');
    };

    // ── onend: ALWAYS restart if session is still active ────
    // This fires after EVERY session end, including after every error.
    // Spawning a fresh instance here keeps the session perpetually alive.
    rec.onend = () => {
      if (isListening) {
        spawnRecognition(); // ← the key to the fix
      }
    };

    // Store and start
    recognition = rec;
    try {
      rec.start();
    } catch (startErr) {
      console.error('[VoiceBridge] rec.start() threw:', startErr);
      isRestarting = false;
      setTimeout(() => spawnRecognition(), 300); // retry after brief delay
    }

  }, 120); // mic release delay
}

/**
 * getBestAlternative()
 * Pick the recognition alternative with the highest confidence.
 */
function getBestAlternative(result) {
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    if ((result[i].confidence || 0) > (best.confidence || 0)) best = result[i];
  }
  return best;
}

/**
 * renderTranscript()
 * Writes confirmed + interim into the textarea and scrolls to end.
 */
function renderTranscript(confirmed, interim) {
  sourceText.value = confirmed + (interim || '');
  sourceText.scrollTop = sourceText.scrollHeight;
}

/** Clear the live interim preview box */
function clearInterimBox() {
  if (interimBox) {
    interimBox.textContent = '';
    interimBox.classList.remove('active');
  }
}

/** Brief waveform boost on speech activity */
let waveBoostTimer = null;
function pulseWaveform() {
  clearTimeout(waveBoostTimer);
  waveform.classList.add('burst');
  waveBoostTimer = setTimeout(() => waveform.classList.remove('burst'), 300);
}

/* ═══════════════════════════════════════════════════════════
   §6 · MIC BUTTON — Start / Stop
   ═══════════════════════════════════════════════════════════ */
micBtn.addEventListener('click', () => {
  if (!SpeechRecognitionAPI) {
    showToast('⚠ Please use Google Chrome for voice features');
    return;
  }
  isListening ? stopListening() : startListening();
});

function startListening() {
  confirmedText = sourceText.value; // snapshot any existing text
  retryCount    = 0;
  isListening   = true;
  isRestarting  = false;

  setMicState(true);
  setStatus('🎙 Starting microphone…', 'listening');
  spawnRecognition();
}

function stopListening() {
  isListening = false;
  retryCount  = 0;

  if (recognition) {
    recognition.onend   = null; // ← critical: prevent auto-restart after manual stop
    recognition.onerror = null;
    try { recognition.stop(); } catch (_) { }
    recognition = null;
  }

  clearInterimBox();
  setMicState(false);
  waveform.classList.remove('active', 'burst');
  signalDots && signalDots.classList.remove('active');
  setStatus('Click to start listening', '');
  sourceText.placeholder = 'Your speech will appear here… or type directly.';

  // Final translate if there is new unsubmitted text
  const current = sourceText.value.trim();
  if (current && current !== lastTranslated) {
    doTranslate(current);
  }
}

/** Emergency stop (no translate triggered) */
function forceStop() {
  isListening  = false;
  isRestarting = false;
  if (recognition) {
    recognition.onend   = null;
    recognition.onerror = null;
    try { recognition.abort(); } catch (_) { }
    recognition = null;
  }
  setMicState(false);
  waveform.classList.remove('active', 'burst');
  signalDots && signalDots.classList.remove('active');
  clearInterimBox();
}

/** Sync visual state of the mic button */
function setMicState(listening) {
  micBtn.classList.toggle('listening', listening);
  micBtn.setAttribute('aria-pressed', listening);
  micBtn.setAttribute('aria-label', listening ? 'Stop listening' : 'Start listening');

  micIcon.innerHTML = listening
    ? `<rect x="4" y="4" width="16" height="16" rx="3" ry="3" fill="white" stroke="none"/>`
    : `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
       <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
       <line x1="12" y1="19" x2="12" y2="23"/>
       <line x1="8" y1="23" x2="16" y2="23"/>`;
}

function setStatus(msg, type = '') {
  micStatus.textContent = msg;
  micStatus.className   = 'mic-status' + (type ? ` ${type}` : '');
}

/* ═══════════════════════════════════════════════════════════
   §7 · TRANSLATION ENGINE  ★ 3-Tier Fallback ★
   ═══════════════════════════════════════════════════════════ */

/**
 * doTranslate(text)
 * Entry point for all translations.
 * Handles dedup, loading state, API chain, and result display.
 */
async function doTranslate(text) {
  const input = (text || sourceText.value).trim();
  if (!input) { translatedText.value = ''; updateTargetCount(0); return; }

  // Deduplication: skip if identical to last translated
  if (input === lastTranslated) return;
  lastTranslated = input;

  const srcCode = sourceLang.value === 'bn-BD' ? 'bn' : 'en';
  const tgtCode = targetLang.value; // 'bn' or 'en'

  if (srcCode === tgtCode) {
    displayTypingAnimation(input);
    return;
  }

  showLoading(true);

  // Cancel any previous in-flight request
  if (abortController) { try { abortController.abort(); } catch (_) { } }
  abortController = new AbortController();

  try {
    const result = await translateWithFallback(input, srcCode, tgtCode, abortController.signal);
    showLoading(false);
    if (result) {
      displayTypingAnimation(result);
      updateTargetCount(result.length);
      saveHistory({
        source: input, translated: result,
        srcLang: sourceLang.options[sourceLang.selectedIndex].text,
        tgtLang: targetLang.options[targetLang.selectedIndex].text,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // cancelled — ignore
    console.error('[VoiceBridge] All APIs failed:', err);
    showLoading(false);
    translatedText.value = '⚠ Translation unavailable. Check internet connection.';
    showToast('⚠ Translation failed — check internet', 3000);
  }
}

/**
 * translateWithFallback()
 * Tries 3 APIs in order. Returns first successful result.
 * Throws only if ALL three fail.
 */
async function translateWithFallback(text, src, tgt, signal) {
  // ── API 1: Google Translate (gtx) ─────────────────────
  try {
    const r = await googleTranslate(text, src, tgt, signal);
    if (r) { console.info('[VoiceBridge] Translated via Google (gtx)'); return r; }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] Google gtx failed:', e.message);
  }

  // ── API 2: MyMemory (free, no key required) ────────────
  try {
    const r = await myMemoryTranslate(text, src, tgt, signal);
    if (r) { console.info('[VoiceBridge] Translated via MyMemory'); return r; }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] MyMemory failed:', e.message);
  }

  // ── API 3: Google Translate (alternative params) ───────
  try {
    const r = await googleTranslateAlt(text, src, tgt, signal);
    if (r) { console.info('[VoiceBridge] Translated via Google (alt)'); return r; }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] Google alt failed:', e.message);
  }

  throw new Error('All translation endpoints exhausted');
}

/** Google Translate — unofficial endpoint 1 */
async function googleTranslate(text, src, tgt, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map(seg => seg?.[0] || '').join('').trim();
}

/** MyMemory — free public translation API, no key needed */
async function myMemoryTranslate(text, src, tgt, signal) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(`Status ${data.responseStatus}`);
  const t = (data.responseData?.translatedText || '').trim();
  // MyMemory returns the original when it can't translate
  if (!t || t.toLowerCase() === text.toLowerCase().trim()) {
    throw new Error('No useful translation');
  }
  return t;
}

/** Google Translate — alternative params variant */
async function googleTranslateAlt(text, src, tgt, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&dt=bd&ie=UTF-8&oe=UTF-8&q=${encodeURIComponent(text)}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map(seg => seg?.[0] || '').join('').trim();
}

/**
 * fetchWithTimeout()
 * Races fetch() against a reject timeout.
 */
function fetchWithTimeout(url, options, ms) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms));
  return Promise.race([fetch(url, options), timeout]);
}

/* ═══════════════════════════════════════════════════════════
   §8 · TYPING ANIMATION
   ═══════════════════════════════════════════════════════════ */
function displayTypingAnimation(text) {
  clearTimeout(typingTimer);
  translatedText.value = '';
  translatedText.classList.add('typing-cursor');

  let i = 0;
  // Adaptive speed: faster for longer text
  const speed = Math.max(8, Math.min(28, Math.round(1400 / text.length)));

  function typeNext() {
    if (i < text.length) {
      translatedText.value += text[i++];
      translatedText.scrollTop = translatedText.scrollHeight;
      updateTargetCount(i);
      typingTimer = setTimeout(typeNext, speed);
    } else {
      translatedText.classList.remove('typing-cursor');
    }
  }
  typeNext();
}

/* ═══════════════════════════════════════════════════════════
   §9 · CHARACTER COUNTERS
   ═══════════════════════════════════════════════════════════ */
function updateSourceCount() {
  const len = sourceText.value.length;
  sourceCount.textContent = `${len} / 1000`;
  sourceCount.style.color =
    len > 900 ? 'var(--danger)' :
    len > 750 ? 'var(--warn)'   : 'var(--text-muted)';
}

function updateTargetCount(len) {
  targetCount.textContent = `${len} chars`;
}

// Live counter + auto-translate on manual typing
sourceText.addEventListener('input', () => {
  updateSourceCount();
  confirmedText = sourceText.value; // sync if user types manually
  clearTimeout(translateTimer);
  const val = sourceText.value.trim();
  if (val) {
    translateTimer = setTimeout(() => doTranslate(val), 1400);
  }
});

/* ═══════════════════════════════════════════════════════════
   §10 · LOADING OVERLAY
   ═══════════════════════════════════════════════════════════ */
function showLoading(show) {
  loadingOverlay.classList.toggle('visible', show);
  loadingOverlay.setAttribute('aria-hidden', String(!show));
}

/* ═══════════════════════════════════════════════════════════
   §11 · LANGUAGE SWAP
   ═══════════════════════════════════════════════════════════ */
swapLangs.addEventListener('click', () => {
  const srcVal = sourceLang.value;
  const tgtVal = targetLang.value;

  sourceLang.value = tgtVal === 'bn' ? 'bn-BD' : 'en-US';
  targetLang.value = srcVal === 'bn-BD' ? 'en' : 'bn';

  const temp = sourceText.value;
  sourceText.value = translatedText.value;

  clearTimeout(typingTimer);
  translatedText.classList.remove('typing-cursor');
  translatedText.value = temp;

  confirmedText  = sourceText.value;
  lastTranslated = ''; // force fresh translate

  updateSourceCount();
  updateTargetCount(translatedText.value.length);

  if (isListening) {
    stopListening();
    showToast('Language swapped — tap mic to restart');
  }

  if (sourceText.value.trim()) {
    clearTimeout(translateTimer);
    translateTimer = setTimeout(() => doTranslate(sourceText.value.trim()), 600);
  }
});

/* ═══════════════════════════════════════════════════════════
   §12 · TRANSLATE BUTTON (manual trigger)
   ═══════════════════════════════════════════════════════════ */
translateBtn.addEventListener('click', () => {
  lastTranslated = ''; // bypass dedup for manual trigger
  doTranslate(sourceText.value.trim());
});

/* ═══════════════════════════════════════════════════════════
   §13 · CLEAR BUTTONS
   ═══════════════════════════════════════════════════════════ */
clearSource.addEventListener('click', () => {
  sourceText.value = '';
  confirmedText    = '';
  lastTranslated   = '';
  clearInterimBox();
  updateSourceCount();
  showToast('Source cleared');
});

clearTarget.addEventListener('click', () => {
  clearTimeout(typingTimer);
  translatedText.value = '';
  translatedText.classList.remove('typing-cursor');
  updateTargetCount(0);
  showToast('Translation cleared');
});

/* ═══════════════════════════════════════════════════════════
   §14 · TEXT-TO-SPEECH
   ═══════════════════════════════════════════════════════════ */
function speak(text, langCode) {
  if (!window.speechSynthesis) { showToast('⚠ TTS not supported'); return; }
  if (!text.trim())             { showToast('Nothing to speak');    return; }
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text);
  utt.lang    = langCode;
  utt.rate    = 0.9;
  utt.pitch   = 1;
  utt.volume  = 1;
  const voices = window.speechSynthesis.getVoices();
  const match  = voices.find(v => v.lang.startsWith(langCode.slice(0, 2)));
  if (match) utt.voice = match;
  window.speechSynthesis.speak(utt);
}

speakSource.addEventListener('click', () => speak(sourceText.value, sourceLang.value));
speakTarget.addEventListener('click', () =>
  speak(translatedText.value, targetLang.value === 'bn' ? 'bn-BD' : 'en-US'));

/* ═══════════════════════════════════════════════════════════
   §15 · COPY TO CLIPBOARD
   ═══════════════════════════════════════════════════════════ */
copyBtn.addEventListener('click', async () => {
  const text = translatedText.value.trim();
  if (!text) { showToast('Nothing to copy'); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast('✓ Copied to clipboard!');
  } catch {
    translatedText.select();
    document.execCommand('copy');
    showToast('✓ Copied!');
  }
});

/* ═══════════════════════════════════════════════════════════
   §16 · DOWNLOAD AS .TXT
   ═══════════════════════════════════════════════════════════ */
downloadBtn.addEventListener('click', () => {
  const src = sourceText.value.trim();
  const tgt = translatedText.value.trim();
  if (!tgt) { showToast('Nothing to download'); return; }

  const content = [
    '════════════════════════════════════',
    '   VoiceBridge — Translation Export',
    '════════════════════════════════════',
    `Date     : ${new Date().toLocaleString()}`,
    `Direction: ${sourceLang.options[sourceLang.selectedIndex].text} → ${targetLang.options[targetLang.selectedIndex].text}`,
    '', '── Original ──────────────────────', src || '(empty)',
    '', '── Translation ───────────────────', tgt,
    '', '════════════════════════════════════',
  ].join('\n');

  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })),
    download: `voicebridge_${Date.now()}.txt`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('✓ File downloaded');
});

/* ═══════════════════════════════════════════════════════════
   §17 · TRANSLATION HISTORY
   ═══════════════════════════════════════════════════════════ */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('vb_history') || '[]'); }
  catch { return []; }
}

function saveHistory(entry) {
  const h = loadHistory();
  if (h.length > 0 && h[0].source === entry.source) return; // dedup
  h.unshift(entry);
  if (h.length > MAX_HISTORY) h.pop();
  localStorage.setItem('vb_history', JSON.stringify(h));
  if (!historyPanel.hidden) renderHistory();
}

function renderHistory() {
  const h = loadHistory();
  historyList.innerHTML = '';
  historyEmpty.style.display = h.length === 0 ? 'block' : 'none';
  h.forEach(item => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    const t = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `
      <div class="history-item-inner">
        <span class="history-source">${escapeHTML(truncate(item.source, 55))}</span>
        <span class="history-target">${escapeHTML(truncate(item.translated, 55))}</span>
      </div>
      <span class="history-meta">${t}</span>`;
    const restore = () => {
      sourceText.value     = item.source;
      translatedText.value = item.translated;
      confirmedText        = item.source;
      lastTranslated       = item.source;
      updateSourceCount();
      updateTargetCount(item.translated.length);
      showToast('Translation restored');
      historyPanel.hidden = true;
    };
    li.addEventListener('click', restore);
    li.addEventListener('keydown', e => e.key === 'Enter' && restore());
    historyList.appendChild(li);
  });
}

historyToggle.addEventListener('click', () => {
  historyPanel.hidden = !historyPanel.hidden;
  if (!historyPanel.hidden) renderHistory();
});

clearHistory.addEventListener('click', () => {
  localStorage.removeItem('vb_history');
  renderHistory();
  showToast('History cleared');
});

/* ═══════════════════════════════════════════════════════════
   §18 · TOAST
   ═══════════════════════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg, duration = 2600) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ═══════════════════════════════════════════════════════════
   §19 · LANGUAGE SELECT SYNC
   ═══════════════════════════════════════════════════════════ */
sourceLang.addEventListener('change', () => {
  targetLang.value = sourceLang.value === 'bn-BD' ? 'en' : 'bn';
  lastTranslated   = '';
  if (isListening) {
    stopListening();
    showToast('Language changed — tap mic to restart');
  }
});
targetLang.addEventListener('change', () => {
  sourceLang.value = targetLang.value === 'bn' ? 'en-US' : 'bn-BD';
  lastTranslated   = '';
  if (sourceText.value.trim()) doTranslate(sourceText.value.trim());
});

/* ═══════════════════════════════════════════════════════════
   §20 · KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.code === 'Space') {
    e.preventDefault(); micBtn.click();
  }
  if (e.ctrlKey && e.code === 'Enter') {
    e.preventDefault(); lastTranslated = ''; doTranslate(sourceText.value.trim());
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
    e.preventDefault(); copyBtn.click();
  }
  if (e.code === 'Escape' && isListening) stopListening();
});

/* ═══════════════════════════════════════════════════════════
   §21 · UTILITIES
   ═══════════════════════════════════════════════════════════ */
function escapeHTML(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function truncate(s, max) { return s.length > max ? s.slice(0, max) + '…' : s; }

/* ═══════════════════════════════════════════════════════════
   §22 · INIT
   ═══════════════════════════════════════════════════════════ */
(function init() {
  updateSourceCount();
  updateTargetCount(0);
  renderHistory();

  // Pre-load voices asynchronously (needed by some browsers)
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }

  if (!localStorage.getItem('vb_visited')) {
    setTimeout(() => showToast('👋 Click the mic and speak in Bangla or English!', 3800), 900);
    localStorage.setItem('vb_visited', '1');
  }

  console.info(
    '%c VoiceBridge v2.0 ',
    'background:#14dcc0;color:#080d1a;font-weight:800;border-radius:4px;padding:3px 8px;',
    '\n★ Robust recognition engine · 3-tier translation fallback',
    '\nShortcuts: Ctrl+Space (mic) · Ctrl+Enter (translate) · Esc (stop)'
  );
})();