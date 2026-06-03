/**
 * ============================================================
 * VoiceBridge — script.js  v3.0  (Dual-Device Fix Edition)
 *
 * BUG FIXES in this version:
 *
 *  ✅ FIX 1 — MOBILE WORD DUPLICATION
 *     Root cause: continuous:true fires onend after each utterance
 *     on Android Chrome. spawnRecognition() created a new instance,
 *     but the OLD instance fired its final onresult AFTER the new
 *     one started — so both instances captured the same audio.
 *     Fix: continuous:false + Session ID guard + lastAddedSegment dedup.
 *
 *  ✅ FIX 2 — DESKTOP SILENCE (can't hear anything)
 *     Root cause: continuous:true on desktop Chrome sometimes never
 *     fires onend — the session silently hangs and the restart loop
 *     never triggers. Also: isRestarting got stuck true if start()
 *     threw an error.
 *     Fix: continuous:false makes onend fire reliably after every
 *     utterance on all platforms. Added try/finally to always unlock
 *     isRestarting. Added per-session abort on rec.start() failures.
 *
 *  ✅ FIX 3 — DOUBLE TRANSLATION
 *     Root cause: confirmedText accumulated duplicate segments from
 *     the stale-session race, which then triggered doTranslate twice.
 *     Fix: lastAddedSegment check prevents identical text from being
 *     appended twice. lastTranslated dedup ensures translate() only
 *     runs once per unique string.
 *
 * HOW THE NEW ENGINE WORKS:
 *  · continuous:false  → each session = one clean utterance, then onend
 *  · onend always restarts after 300ms (the auto-restart loop)
 *  · Session IDs → stale callbacks are silently discarded
 *  · lastAddedSegment → never write the same final segment twice
 *  · isRestarting uses try/finally → can never get permanently stuck
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
let isListening      = false;  // Is the mic session active?
let recognition      = null;   // Current SpeechRecognition instance
let isRestarting     = false;  // Guard: prevent double-spawn (always reset in finally)
let currentSessionId = 0;      // ★ NEW: increments on every spawn; stale callbacks ignored
let confirmedText    = '';     // Accumulated final transcript this session
let lastAddedSegment = '';     // ★ NEW: last final segment added; prevents duplication
let translateTimer   = null;   // Debounce for auto-translate
let typingTimer      = null;   // Typing animation timer
let lastTranslated   = '';     // Dedup: last string sent to translate API
let abortController  = null;   // Active fetch AbortController
const MAX_HISTORY    = 20;

/* ═══════════════════════════════════════════════════════════
   §3 · BROWSER SUPPORT
   ═══════════════════════════════════════════════════════════ */
const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionAPI) {
  micBtn.disabled      = true;
  micBtn.style.opacity = '0.35';
  micBtn.style.cursor  = 'not-allowed';
  setStatus('⚠ Voice not supported — use Chrome or Edge', 'error');
  setTimeout(() =>
    showToast('⚠ Please open this app in Google Chrome for voice features', 5000), 600);
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
themeToggle.addEventListener('click', () =>
  applyTheme(
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  )
);

/* ═══════════════════════════════════════════════════════════
   §5 · VOICE RECOGNITION ENGINE  ★ v3 Complete Fix ★

   Architecture:
   ─────────────────────────────────────────────────────────
   · continuous: FALSE  → each session captures exactly one
     utterance, then ends cleanly. onend always fires.
     This is the ONLY reliable mode on both mobile & desktop.

   · Session ID  → every spawnRecognition() call gets a unique
     integer ID. Every callback checks this ID first and
     returns immediately if it no longer matches. This completely
     eliminates stale-session races.

   · lastAddedSegment  → before appending a final transcript,
     we compare it to the last one added. Skip if identical.
     This is the direct fix for the mobile duplication bug.

   · isRestarting uses try/finally  → it can NEVER get stuck
     in `true` state, which was the desktop silence bug.
   ═══════════════════════════════════════════════════════════ */

/**
 * spawnRecognition()
 * Creates a fresh SpeechRecognition instance and starts it.
 * This is called on first start and from every onend handler.
 */
function spawnRecognition() {
  if (!isListening) return;
  if (isRestarting) return;

  isRestarting = true;

  // ★ Increment session ID. Old callbacks will see mismatch and bail.
  const mySessionId = ++currentSessionId;

  // Fully detach and kill the old instance
  if (recognition) {
    recognition.onresult  = null;  // ← detach BEFORE abort to stop pending results
    recognition.onend     = null;
    recognition.onerror   = null;
    recognition.onspeechstart = null;
    recognition.onaudiostart  = null;
    try { recognition.abort(); } catch (_) { /* ignore */ }
    recognition = null;
  }

  // 300ms delay: gives the browser time to fully release the mic
  // before re-acquiring it. 120ms was too short for desktop Chrome.
  setTimeout(() => {
    // ★ Guard: if a newer session spawned while we were waiting, abort
    if (mySessionId !== currentSessionId || !isListening) {
      isRestarting = false;
      return;
    }

    // ★ try/finally ensures isRestarting is ALWAYS set to false
    try {
      const rec = new SpeechRecognitionAPI();

      // ────────────────────────────────────────────────────
      // KEY CONFIG CHANGE: continuous = FALSE
      //
      // WHY:  continuous:true on mobile Chrome fires onend
      //       after each utterance anyway, but leaves the old
      //       audio buffer open — causing the new instance to
      //       re-hear the same audio (duplication bug).
      //       continuous:false makes every session cleanly
      //       capture exactly ONE utterance, then close.
      //       onend fires reliably on ALL platforms this way.
      // ────────────────────────────────────────────────────
      rec.lang            = sourceLang.value;   // 'bn-BD' or 'en-US'
      rec.continuous      = false;              // ★ KEY FIX
      rec.interimResults  = true;               // stream live partial results
      rec.maxAlternatives = 1;                  // single best result (faster)

      /* ── onresult ────────────────────────────────────── */
      rec.onresult = (event) => {
        // ★ Stale-session guard: discard if a newer session exists
        if (mySessionId !== currentSessionId) return;

        let interim = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res    = event.results[i];
          const text   = res[0].transcript.trim();

          if (res.isFinal) {
            // ★ DEDUP: only append if this segment differs from the last one.
            // This is the direct fix for the mobile word-doubling bug.
            if (text && text !== lastAddedSegment) {
              confirmedText    += text + ' ';
              lastAddedSegment  = text;
            }
            interim = '';   // clear interim now that this is final
          } else {
            interim += res[0].transcript;
          }
        }

        // Render confirmed + live interim text together
        renderTranscript(confirmedText, interim);

        // Live preview box
        if (interim.trim()) {
          interimBox.textContent = '🎙 ' + interim;
          interimBox.classList.add('active');
        } else {
          clearInterimBox();
        }

        // Debounce: auto-translate 800ms after confirmed text settles
        if (confirmedText.trim()) {
          clearTimeout(translateTimer);
          translateTimer = setTimeout(() => {
            clearInterimBox();
            doTranslate(confirmedText.trim());
          }, 800);
        }

        updateSourceCount();
      };

      /* ── onaudiostart ────────────────────────────────── */
      rec.onaudiostart = () => {
        if (mySessionId !== currentSessionId) return;
        setStatus('🎙 Listening… speak clearly', 'listening');
        waveform.classList.add('active');
        signalDots && signalDots.classList.add('active');
      };

      /* ── onspeechstart ───────────────────────────────── */
      rec.onspeechstart = () => {
        if (mySessionId !== currentSessionId) return;
        setStatus('💬 Hearing you…', 'listening');
      };

      /* ── onspeechend ─────────────────────────────────── */
      rec.onspeechend = () => {
        if (mySessionId !== currentSessionId) return;
        setStatus('⏳ Processing…', 'listening');
      };

      /* ── onerror ─────────────────────────────────────── */
      rec.onerror = (event) => {
        if (mySessionId !== currentSessionId) return;
        const err = event.error;

        if (err === 'not-allowed' || err === 'permission-denied') {
          // Fatal: mic blocked → stop everything
          forceStop();
          setStatus('🚫 Microphone permission denied', 'error');
          showToast('🚫 Click the 🔒 icon in Chrome address bar and allow microphone', 5000);
          return;
        }

        if (err === 'aborted') {
          // We triggered this ourselves — not an error
          return;
        }

        if (err === 'no-speech') {
          // Silence detected — normal, let onend restart
          setStatus('🎙 Listening… (no speech detected)', 'listening');
          return;
        }

        if (err === 'network') {
          setStatus('📡 Network issue — retrying…', 'listening');
          return;
        }

        // Any other error — log, let onend handle restart
        console.warn('[VoiceBridge] Recognition error:', err);
      };

      /* ── onend ───────────────────────────────────────── */
      // ★ This is the restart loop.
      // With continuous:false, onend fires after EVERY utterance,
      // after every error, and after no-speech timeout.
      // We simply wait 300ms and spawn a fresh instance.
      // This is reliable on BOTH mobile and desktop.
      rec.onend = () => {
        if (mySessionId !== currentSessionId) return;
        if (isListening) {
          setStatus('🎙 Listening…', 'listening');
          // 300ms gap prevents mic from getting "confused"
          // between the end of one utterance and start of next
          setTimeout(() => spawnRecognition(), 300);
        }
      };

      // Store and start
      recognition = rec;
      rec.start();
      // Note: if start() throws, the finally block sets isRestarting=false
      // and we schedule a retry below in the catch.

    } catch (startError) {
      console.error('[VoiceBridge] rec.start() failed:', startError.message);
      // Retry after a longer delay
      if (isListening) {
        setTimeout(() => spawnRecognition(), 600);
      }
    } finally {
      // ★ CRITICAL: always unlock isRestarting, even if start() threw.
      // This was the root cause of the desktop "stuck silent" bug.
      isRestarting = false;
    }

  }, 300); // mic release delay
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
  // Reset all per-session state
  confirmedText    = sourceText.value;  // preserve any existing text
  lastAddedSegment = '';                // ★ reset dedup on new session
  lastTranslated   = '';               // allow fresh translate
  isListening      = true;
  isRestarting     = false;

  setMicState(true);
  setStatus('🎙 Starting microphone…', 'listening');
  spawnRecognition();
}

function stopListening() {
  isListening = false;

  if (recognition) {
    recognition.onresult  = null;   // ★ detach BEFORE stop — no more stale results
    recognition.onend     = null;   // ← critical: don't auto-restart after manual stop
    recognition.onerror   = null;
    try { recognition.stop(); } catch (_) { }
    recognition = null;
  }

  clearInterimBox();
  setMicState(false);
  waveform.classList.remove('active', 'burst');
  signalDots && signalDots.classList.remove('active');
  setStatus('Click to start listening', '');
  sourceText.placeholder = 'Your speech will appear here… or type directly.';

  // Trigger a final translate if there is new unsubmitted text
  const current = sourceText.value.trim();
  if (current && current !== lastTranslated) {
    doTranslate(current);
  }
}

/** Hard stop — no translate, used on fatal errors */
function forceStop() {
  isListening  = false;
  isRestarting = false;
  if (recognition) {
    recognition.onresult = null;
    recognition.onend    = null;
    recognition.onerror  = null;
    try { recognition.abort(); } catch (_) { }
    recognition = null;
  }
  setMicState(false);
  waveform.classList.remove('active', 'burst');
  signalDots && signalDots.classList.remove('active');
  clearInterimBox();
}

/** Sync mic button visual state */
function setMicState(listening) {
  micBtn.classList.toggle('listening', listening);
  micBtn.setAttribute('aria-pressed', String(listening));
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

/* ─── Visual helpers ──────────────────────────────────────── */
function renderTranscript(confirmed, interim) {
  sourceText.value = confirmed + (interim || '');
  sourceText.scrollTop = sourceText.scrollHeight;
}

function clearInterimBox() {
  if (!interimBox) return;
  interimBox.textContent = '';
  interimBox.classList.remove('active');
}

let waveBoostTimer = null;
function pulseWaveform() {
  clearTimeout(waveBoostTimer);
  waveform.classList.add('burst');
  waveBoostTimer = setTimeout(() => waveform.classList.remove('burst'), 300);
}

/* ═══════════════════════════════════════════════════════════
   §7 · TRANSLATION ENGINE  — 3-Tier Fallback
   ═══════════════════════════════════════════════════════════ */

/**
 * doTranslate(text)
 * Deduplicates, manages loading state, calls the API chain.
 */
async function doTranslate(text) {
  const input = (text || sourceText.value).trim();
  if (!input) { translatedText.value = ''; updateTargetCount(0); return; }

  // ★ Dedup: skip if this exact string was just translated
  if (input === lastTranslated) return;
  lastTranslated = input;

  const srcCode = sourceLang.value === 'bn-BD' ? 'bn' : 'en';
  const tgtCode = targetLang.value;

  // Same language? Just echo it back.
  if (srcCode === tgtCode) { displayTypingAnimation(input); return; }

  showLoading(true);

  // Cancel any in-flight request
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
    if (err.name === 'AbortError') return;
    console.error('[VoiceBridge] All translation APIs failed:', err);
    showLoading(false);
    translatedText.value = '⚠ Translation failed. Check your internet connection.';
    showToast('⚠ Translation failed — check internet', 3000);
  }
}

/**
 * translateWithFallback() — tries 3 APIs in order
 */
async function translateWithFallback(text, src, tgt, signal) {
  // API 1: Google Translate (gtx client — most reliable)
  try {
    const r = await googleTranslate(text, src, tgt, signal);
    if (r) return r;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] Google gtx failed:', e.message);
  }

  // API 2: MyMemory (free, no key needed)
  try {
    const r = await myMemoryTranslate(text, src, tgt, signal);
    if (r) return r;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] MyMemory failed:', e.message);
  }

  // API 3: Google Translate (alternative params)
  try {
    const r = await googleTranslateAlt(text, src, tgt, signal);
    if (r) return r;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[VoiceBridge] Google alt failed:', e.message);
  }

  throw new Error('All translation endpoints failed');
}

async function googleTranslate(text, src, tgt, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map(s => s?.[0] || '').join('').trim();
}

async function myMemoryTranslate(text, src, tgt, signal) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(`Status ${data.responseStatus}`);
  const t = (data.responseData?.translatedText || '').trim();
  if (!t || t.toLowerCase() === text.toLowerCase()) throw new Error('No useful translation');
  return t;
}

async function googleTranslateAlt(text, src, tgt, signal) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&dt=bd&ie=UTF-8&oe=UTF-8&q=${encodeURIComponent(text)}`;
  const res  = await fetchWithTimeout(url, { signal }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map(s => s?.[0] || '').join('').trim();
}

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

// Manual typing: sync confirmedText + debounced auto-translate
sourceText.addEventListener('input', () => {
  updateSourceCount();
  confirmedText    = sourceText.value;
  lastAddedSegment = '';
  clearTimeout(translateTimer);
  const val = sourceText.value.trim();
  if (val) translateTimer = setTimeout(() => doTranslate(val), 1400);
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

  const temp           = sourceText.value;
  sourceText.value     = translatedText.value;
  clearTimeout(typingTimer);
  translatedText.classList.remove('typing-cursor');
  translatedText.value = temp;

  confirmedText    = sourceText.value;
  lastAddedSegment = '';
  lastTranslated   = '';  // force fresh translate after swap

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
   §12 · TRANSLATE BUTTON (manual)
   ═══════════════════════════════════════════════════════════ */
translateBtn.addEventListener('click', () => {
  lastTranslated = '';  // bypass dedup for manual trigger
  doTranslate(sourceText.value.trim());
});

/* ═══════════════════════════════════════════════════════════
   §13 · CLEAR BUTTONS
   ═══════════════════════════════════════════════════════════ */
clearSource.addEventListener('click', () => {
  sourceText.value = '';
  confirmedText    = '';
  lastAddedSegment = '';
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
  if (h.length > 0 && h[0].source === entry.source) return;
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
      lastAddedSegment     = '';
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
  if (isListening) { stopListening(); showToast('Language changed — tap mic to restart'); }
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
  if (e.ctrlKey && e.code === 'Space')                 { e.preventDefault(); micBtn.click(); }
  if (e.ctrlKey && e.code === 'Enter')                 { e.preventDefault(); lastTranslated = ''; doTranslate(sourceText.value.trim()); }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyC')    { e.preventDefault(); copyBtn.click(); }
  if (e.code === 'Escape' && isListening)              { stopListening(); }
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

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }

  if (!localStorage.getItem('vb_visited')) {
    setTimeout(() => showToast('👋 Click the mic and speak in Bangla or English!', 3800), 900);
    localStorage.setItem('vb_visited', '1');
  }

  console.info(
    '%c VoiceBridge v3.0 ',
    'background:#14dcc0;color:#080d1a;font-weight:800;border-radius:4px;padding:3px 8px;',
    '\n✅ Mobile duplication fixed · ✅ Desktop silence fixed',
    '\nShortcuts: Ctrl+Space (mic) · Ctrl+Enter (translate) · Esc (stop)'
  );
})();