/* ============================================================
   VozAI — app.js  |  Text-to-Speech Engine + WAV Recorder
   ============================================================ */

'use strict';

// ── DOM references ─────────────────────────────────────────
const textInput       = document.getElementById('textInput');
const charCount       = document.getElementById('charCount');
const voiceSelect     = document.getElementById('voiceSelect');
const langSelect      = document.getElementById('langSelect');
const speedRange      = document.getElementById('speedRange');
const pitchRange      = document.getElementById('pitchRange');
const volumeRange     = document.getElementById('volumeRange');
const speedVal        = document.getElementById('speedVal');
const pitchVal        = document.getElementById('pitchVal');
const volumeVal       = document.getElementById('volumeVal');
const playBtn         = document.getElementById('playBtn');
const stopBtn         = document.getElementById('stopBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const playIcon        = document.getElementById('playIcon');
const pauseIcon       = document.getElementById('pauseIcon');
const progressBar     = document.getElementById('progressBar');
const currentTimeEl   = document.getElementById('currentTime');
const totalTimeEl     = document.getElementById('totalTime');
const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const vizLabel        = document.getElementById('vizLabel');
const waveCanvas      = document.getElementById('waveCanvas');
const downloadSection = document.getElementById('downloadSection');
const downloadLink    = document.getElementById('downloadLink');
const downloadSubtitle = document.getElementById('downloadSubtitle');
const clearBtn        = document.getElementById('clearBtn');
const pasteBtn        = document.getElementById('pasteBtn');
const sampleBtn       = document.getElementById('sampleBtn');

// ── State ──────────────────────────────────────────────────
let voices        = [];
let isSpeaking    = false;
let isPaused      = false;
let utterance     = null;
let startTime     = null;
let estimatedDuration = 0;
let progressTimer = null;
let animFrame     = null;
let audioCtx      = null;
let analyser      = null;
let recorder      = null;
let recordedChunks = [];
let audioBlob      = null;
let waveData       = new Float32Array(128).fill(0);

// Canvas context
const ctx = waveCanvas.getContext('2d');

// ── Sample texts ───────────────────────────────────────────
const samples = [
  'Bienvenido a VozAI, tu asistente de texto a voz más avanzado. Convierte cualquier texto en audio de alta calidad en segundos.',
  'La inteligencia artificial está transformando la forma en que interactuamos con la tecnología. Hoy, podemos convertir texto en voz de manera natural.',
  'El conocimiento es poder. La educación es la llave que abre la puerta a un mundo de oportunidades infinitas para quienes la buscan.',
];
let sampleIdx = 0;

// ── Init ───────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  resizeCanvas();
  loadVoices();
  drawIdleWave();
  initSliders();

  window.speechSynthesis.onvoiceschanged = loadVoices;
  textInput.addEventListener('input', onTextChange);
  langSelect.addEventListener('change', loadVoices);
  playBtn.addEventListener('click', togglePlay);
  stopBtn.addEventListener('click', stopSpeech);
  clearBtn.addEventListener('click', clearText);
  pasteBtn.addEventListener('click', pasteText);
  sampleBtn.addEventListener('click', loadSample);
  downloadBtn.addEventListener('click', generateDownload);
  window.addEventListener('resize', resizeCanvas);
});

function resizeCanvas() {
  waveCanvas.width  = waveCanvas.offsetWidth  * window.devicePixelRatio;
  waveCanvas.height = waveCanvas.offsetHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

// ── Voice Loader ───────────────────────────────────────────
function loadVoices() {
  voices = window.speechSynthesis.getVoices();
  const lang = langSelect.value;

  // Filter voices matching the selected language prefix
  const langCode = lang.split('-')[0];
  let filtered = voices.filter(v =>
    v.lang.startsWith(langCode) || v.lang === lang
  );
  if (filtered.length === 0) filtered = voices; // fallback

  voiceSelect.innerHTML = '';
  if (filtered.length === 0) {
    voiceSelect.innerHTML = '<option value="">No hay voces disponibles</option>';
    return;
  }

  filtered.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = voices.indexOf(v);
    const flag = getLangFlag(v.lang);
    opt.textContent = `${flag} ${v.name} (${v.lang})`;
    if (v.default) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
}

function getLangFlag(lang) {
  const map = {
    'es':'🇪🇸','en':'🇺🇸','fr':'🇫🇷','de':'🇩🇪',
    'it':'🇮🇹','pt':'🇧🇷','ja':'🇯🇵','zh':'🇨🇳',
    'ko':'🇰🇷','ar':'🇸🇦','ru':'🇷🇺','nl':'🇳🇱',
  };
  const code = lang.split('-')[0].toLowerCase();
  return map[code] || '🌐';
}

// ── Text Events ────────────────────────────────────────────
function onTextChange() {
  const len = textInput.value.length;
  charCount.textContent = len;
  audioBlob = null;
  downloadSection.style.display = 'none';
  downloadBtn.disabled = len === 0;
}

function clearText() {
  textInput.value = '';
  charCount.textContent = '0';
  audioBlob = null;
  downloadSection.style.display = 'none';
  downloadBtn.disabled = true;
  setStatus('idle', 'Texto borrado');
}

async function pasteText() {
  try {
    const text = await navigator.clipboard.readText();
    textInput.value = text.slice(0, 5000);
    onTextChange();
    setStatus('idle', `Texto pegado · ${textInput.value.length} caracteres`);
  } catch {
    setStatus('error', 'No se pudo acceder al portapapeles');
  }
}

function loadSample() {
  textInput.value = samples[sampleIdx % samples.length];
  sampleIdx++;
  onTextChange();
  setStatus('idle', 'Texto de ejemplo cargado');
}

// ── Slider Updates ─────────────────────────────────────────
function initSliders() {
  speedRange.addEventListener('input', () => {
    speedVal.textContent = parseFloat(speedRange.value).toFixed(1) + '×';
    updateSliderFill(speedRange);
  });
  pitchRange.addEventListener('input', () => {
    pitchVal.textContent = parseFloat(pitchRange.value).toFixed(1);
    updateSliderFill(pitchRange);
  });
  volumeRange.addEventListener('input', () => {
    volumeVal.textContent = Math.round(volumeRange.value * 100) + '%';
    updateSliderFill(volumeRange);
  });
  updateSliderFill(speedRange);
  updateSliderFill(pitchRange);
  updateSliderFill(volumeRange);
}

function updateSliderFill(slider) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, #6366f1 ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
}

// ── Speech Synthesis ───────────────────────────────────────
function togglePlay() {
  if (isSpeaking && !isPaused) {
    pauseSpeech();
  } else if (isPaused) {
    resumeSpeech();
  } else {
    startSpeech();
  }
}

function startSpeech() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('error', 'Ingresa un texto primero');
    textInput.focus();
    return;
  }

  window.speechSynthesis.cancel();
  utterance = new SpeechSynthesisUtterance(text);

  // Voice
  const voiceIdx = parseInt(voiceSelect.value);
  if (!isNaN(voiceIdx) && voices[voiceIdx]) {
    utterance.voice = voices[voiceIdx];
  }
  utterance.lang   = langSelect.value;
  utterance.rate   = parseFloat(speedRange.value);
  utterance.pitch  = parseFloat(pitchRange.value);
  utterance.volume = parseFloat(volumeRange.value);

  // Estimate duration: ~130 words/min * rate, ~5 chars/word
  const wordCount = text.split(/\s+/).length;
  estimatedDuration = (wordCount / (130 * utterance.rate)) * 60;

  utterance.onstart = () => {
    isSpeaking = true; isPaused = false;
    startTime = Date.now();
    playIcon.style.display  = 'none';
    pauseIcon.style.display = 'block';
    stopBtn.disabled   = false;
    progressBar.style.width = '0%';
    vizLabel.classList.add('hidden');
    setStatus('active', 'Reproduciendo audio…');
    startProgressTimer();
    startWaveAnimation();
    totalTimeEl.textContent = formatTime(estimatedDuration);
  };

  utterance.onend = () => {
    isSpeaking = false; isPaused = false;
    playIcon.style.display  = 'block';
    pauseIcon.style.display = 'none';
    stopBtn.disabled = true;
    progressBar.style.width = '100%';
    clearInterval(progressTimer);
    cancelAnimationFrame(animFrame);
    vizLabel.classList.remove('hidden');
    vizLabel.textContent = 'Reproducción finalizada';
    setStatus('success', 'Texto reproducido completamente');
    setTimeout(() => { progressBar.style.width = '0%'; currentTimeEl.textContent = '0:00'; }, 1500);
    drawIdleWave();
    // Enable download after playback
    downloadBtn.disabled = false;
  };

  utterance.onerror = (e) => {
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    setStatus('error', `Error al reproducir: ${e.error}`);
    resetPlayer();
  };

  utterance.onpause = () => {
    isPaused = true;
    clearInterval(progressTimer);
    stopWaveAnimation();
    vizLabel.classList.remove('hidden');
    vizLabel.textContent = 'En pausa';
    setStatus('idle', 'Reproducción pausada');
  };

  utterance.onresume = () => {
    isPaused = false;
    vizLabel.classList.add('hidden');
    setStatus('active', 'Reproduciendo audio…');
    startProgressTimer();
    startWaveAnimation();
  };

  window.speechSynthesis.speak(utterance);
}

function pauseSpeech() {
  if (isSpeaking) {
    window.speechSynthesis.pause();
    isPaused = true;
    playIcon.style.display  = 'block';
    pauseIcon.style.display = 'none';
  }
}

function resumeSpeech() {
  if (isPaused) {
    window.speechSynthesis.resume();
    isPaused = false;
    playIcon.style.display  = 'none';
    pauseIcon.style.display = 'block';
  }
}

function stopSpeech() {
  window.speechSynthesis.cancel();
  resetPlayer();
  setStatus('idle', 'Reproducción detenida');
  vizLabel.textContent = 'Listo para reproducir';
  downloadBtn.disabled = false;
}

function resetPlayer() {
  isSpeaking = false; isPaused = false;
  playIcon.style.display  = 'block';
  pauseIcon.style.display = 'none';
  stopBtn.disabled = true;
  clearInterval(progressTimer);
  cancelAnimationFrame(animFrame);
  progressBar.style.width = '0%';
  currentTimeEl.textContent = '0:00';
  vizLabel.classList.remove('hidden');
  drawIdleWave();
}

// ── Progress Timer ─────────────────────────────────────────
function startProgressTimer() {
  clearInterval(progressTimer);
  const base = startTime || Date.now();
  const pausedAt = isPaused ? Date.now() : null;

  progressTimer = setInterval(() => {
    const elapsed = (Date.now() - base) / 1000;
    const pct = Math.min((elapsed / estimatedDuration) * 100, 99);
    progressBar.style.width = pct + '%';
    currentTimeEl.textContent = formatTime(elapsed);
  }, 250);
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Waveform Animation ─────────────────────────────────────
let wavePhase = 0;
let isAnimating = false;

function startWaveAnimation() {
  isAnimating = true;
  animateWave();
}

function stopWaveAnimation() {
  isAnimating = false;
  cancelAnimationFrame(animFrame);
}

function animateWave() {
  if (!isAnimating) return;
  drawActiveWave();
  animFrame = requestAnimationFrame(animateWave);
}

function drawIdleWave() {
  const W = waveCanvas.offsetWidth;
  const H = waveCanvas.offsetHeight;
  ctx.clearRect(0, 0, W, H);

  // Draw a flat subtle line
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(99,102,241,0)');
  grad.addColorStop(0.5, 'rgba(99,102,241,0.3)');
  grad.addColorStop(1, 'rgba(99,102,241,0)');

  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  for (let x = 0; x <= W; x += 2) {
    const y = H / 2 + Math.sin(x * 0.04) * 2;
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawActiveWave() {
  const W = waveCanvas.offsetWidth;
  const H = waveCanvas.offsetHeight;
  ctx.clearRect(0, 0, W, H);

  wavePhase += 0.06;

  const bars = 60;
  const barW = (W / bars) * 0.6;
  const gap  = W / bars;

  for (let i = 0; i < bars; i++) {
    const noise = Math.sin(i * 0.4 + wavePhase) * 0.5 +
                  Math.sin(i * 0.9 - wavePhase * 1.3) * 0.3 +
                  Math.sin(i * 0.2 + wavePhase * 0.7) * 0.2;
    const amplitude = (Math.abs(noise) * 0.5 + 0.1) * (H * 0.75);
    const x = i * gap + gap / 2;
    const y = (H - amplitude) / 2;

    const grad = ctx.createLinearGradient(x, y, x, y + amplitude);
    grad.addColorStop(0, 'rgba(139,92,246,0.9)');
    grad.addColorStop(0.5, 'rgba(99,102,241,1)');
    grad.addColorStop(1, 'rgba(139,92,246,0.9)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(x - barW / 2, y, barW, amplitude, barW / 2)
      : ctx.rect(x - barW / 2, y, barW, amplitude);
    ctx.fill();
  }

  // Glow overlay
  const glowGrad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, W/2);
  glowGrad.addColorStop(0, 'rgba(99,102,241,0.05)');
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, W, H);
}

// ── Download ───────────────────────────────────────────────
// Instant download using free TTS APIs (no recording needed).
// Strategy cascade:
//   1. StreamElements TTS API (Amazon Polly, CORS-enabled, best quality)
//   2. Google Translate TTS fetch (may fail CORS)
//   3. Google TTS direct link (opens in new tab, always works)

let isDownloading = false;

// ── Voice map for StreamElements (Amazon Polly voices) ─────
const POLLY_VOICES = {
  'es': { female: ['Lucia', 'Conchita', 'Lupe', 'Mia'], male: ['Enrique', 'Miguel'] },
  'en': { female: ['Joanna', 'Salli', 'Kendra'], male: ['Matthew', 'Joey'] },
  'fr': { female: ['Celine', 'Lea'], male: ['Mathieu'] },
  'de': { female: ['Marlene', 'Vicki'], male: ['Hans'] },
  'it': { female: ['Carla', 'Bianca'], male: ['Giorgio'] },
  'pt': { female: ['Vitoria', 'Camila'], male: ['Ricardo'] },
  'ja': { female: ['Mizuki'], male: ['Takumi'] },
  'zh': { female: ['Zhiyu'], male: [] },
  'ko': { female: ['Seoyeon'], male: [] },
  'ar': { female: ['Zeina'], male: [] },
  'ru': { female: ['Tatyana'], male: ['Maxim'] },
  'nl': { female: ['Lotte'], male: ['Ruben'] },
};

function getPollyVoice(lang) {
  const code = lang.split('-')[0].toLowerCase();
  const entry = POLLY_VOICES[code] || POLLY_VOICES['es'];
  // Return first available voice (prefer female)
  return entry.female[0] || entry.male[0] || 'Lucia';
}

// ── Split text into chunks ─────────────────────────────────
function splitText(text, maxLen) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = '';

  for (const sent of sentences) {
    const words = sent.trim().split(/\s+/);
    for (const word of words) {
      if ((current + ' ' + word).trim().length > maxLen) {
        if (current.trim()) chunks.push(current.trim());
        current = word;
      } else {
        current = (current + ' ' + word).trim();
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Main download handler ──────────────────────────────────
async function generateDownload() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('error', 'Ingresa un texto para descargar');
    return;
  }

  if (isDownloading) return;
  isDownloading = true;

  downloadSection.style.display = 'block';
  downloadSubtitle.textContent  = 'Generando audio…';
  downloadBtn.disabled = true;
  setStatus('active', 'Descargando audio…');

  // Clean up previous extra links
  const oldExtra = downloadSection.querySelector('.extra-links');
  if (oldExtra) oldExtra.remove();

  // ── Strategy 0: Local Server Proxy (/api/tts) ──
  try {
    await fetchLocalServerTTS(text);
    isDownloading = false;
    return;
  } catch (err) {
    console.warn('Strategy 0 (Local Server) failed:', err);
  }

  // ── Strategy 1: SoundofText API (Google Engine, 100% CORS-friendly) ──
  try {
    await fetchSoundOfTextTTS(text);
    isDownloading = false;
    return;
  } catch (err) {
    console.warn('Strategy 1 (SoundofText) failed:', err);
  }

  // ── Strategy 2: StreamElements TTS (Amazon Polly) ──
  try {
    await fetchStreamElementsTTS(text);
    isDownloading = false;
    return;
  } catch (err) {
    console.warn('Strategy 2 (StreamElements) failed:', err);
  }

  // ── Strategy 3: Google Translate TTS fetch (with CORS Proxy) ──
  try {
    await fetchGoogleTTS(text);
    isDownloading = false;
    return;
  } catch (err) {
    console.warn('Strategy 3 (Google TTS fetch) failed:', err);
  }

  // ── Fallback Error Display ──
  setStatus('error', 'No se pudo conectar con el servidor de audio. Revisa tu conexión.');
  downloadSubtitle.textContent = 'Error de conexión. Intenta de nuevo más tarde.';
  downloadBtn.disabled = false;
  isDownloading = false;
}

// ────────────────────────────────────────────────────────────
// Strategy 0: Local Server API (/api/tts)
// Instant, reliable MP3 server proxy
// ────────────────────────────────────────────────────────────
async function fetchLocalServerTTS(text) {
  const lang = langSelect.value;
  const url = `/api/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Local server returned status: ${response.status}`);
  
  const blob = await response.blob();
  if (blob.size < 200) throw new Error('Blob too small');
  
  audioBlob = blob;
  presentDownloadFile(blob, 'mp3');
}

// ────────────────────────────────────────────────────────────
// Strategy 1: SoundofText API (Google Engine)
// Free, robust API specifically designed for TTS MP3 downloads
// ────────────────────────────────────────────────────────────
async function fetchSoundOfTextTTS(text) {
  const lang = langSelect.value; // e.g. "es-ES"
  const chunks = splitText(text, 100);
  const blobs = [];

  for (let i = 0; i < chunks.length; i++) {
    downloadSubtitle.textContent = chunks.length > 1
      ? `Generando parte ${i + 1} de ${chunks.length}…`
      : 'Generando audio MP3…';

    const req = await fetch('https://api.soundoftext.com/sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'Google',
        data: {
          text: chunks[i],
          voice: lang
        }
      })
    });

    if (!req.ok) throw new Error(`SoundofText API error: ${req.status}`);
    const res = await req.json();

    if (!res.success || !res.id) throw new Error('SoundofText generation failed');

    const fileUrl = `https://files.soundoftext.com/${res.id}.mp3`;
    const audioReq = await fetch(fileUrl);
    if (!audioReq.ok) throw new Error(`Failed to fetch MP3 file: ${audioReq.status}`);

    const blob = await audioReq.blob();
    if (blob.size < 100) throw new Error('Audio blob too small');

    blobs.push(blob);
  }

  const mergedBlob = new Blob(blobs, { type: 'audio/mpeg' });
  if (mergedBlob.size < 200) throw new Error('Audio too small');

  audioBlob = mergedBlob;
  presentDownloadFile(mergedBlob, 'mp3');
}

// ────────────────────────────────────────────────────────────
// Strategy 2: StreamElements TTS (Amazon Polly)
// ────────────────────────────────────────────────────────────
async function fetchStreamElementsTTS(text) {
  const lang = langSelect.value;
  const voice = getPollyVoice(lang);
  const chunks = splitText(text, 150);
  const blobs = [];

  for (let i = 0; i < chunks.length; i++) {
    downloadSubtitle.textContent = chunks.length > 1
      ? `Generando parte ${i + 1} de ${chunks.length}…`
      : 'Generando audio…';

    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encodeURIComponent(chunks[i])}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`StreamElements API error: ${response.status}`);

    const blob = await response.blob();
    if (blob.size < 100) throw new Error('Response too small');

    blobs.push(blob);
  }

  const mergedBlob = new Blob(blobs, { type: 'audio/mpeg' });
  if (mergedBlob.size < 200) throw new Error('Audio too small');

  audioBlob = mergedBlob;
  presentDownloadFile(mergedBlob, 'mp3');
}

// ────────────────────────────────────────────────────────────
// Strategy 3: Google Translate TTS fetch (with CORS Proxy)
// ────────────────────────────────────────────────────────────
function buildGoogleTTSUrl(text, lang, client = 'gtx') {
  return `https://translate.googleapis.com/translate_tts?client=${client}&ie=UTF-8&tl=${lang}&q=${encodeURIComponent(text)}`;
}

async function fetchGoogleTTS(text) {
  const lang = langSelect.value.split('-')[0];
  const chunks = splitText(text, 150);
  const blobs = [];

  for (let i = 0; i < chunks.length; i++) {
    let fetched = false;

    downloadSubtitle.textContent = chunks.length > 1
      ? `Descargando parte ${i + 1} de ${chunks.length}…`
      : 'Descargando audio…';

    const rawUrl = buildGoogleTTSUrl(chunks[i], lang, 'gtx');
    const urlsToTry = [
      rawUrl,
      `https://corsproxy.io/?${encodeURIComponent(rawUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(rawUrl)}`
    ];

    for (const targetUrl of urlsToTry) {
      try {
        const response = await fetch(targetUrl);
        if (!response.ok) continue;

        const blob = await response.blob();
        if (blob.size < 100) continue;

        blobs.push(blob);
        fetched = true;
        break;
      } catch {
        continue;
      }
    }
    if (!fetched) throw new Error(`Failed to fetch chunk ${i + 1}`);
  }

  const mergedBlob = new Blob(blobs, { type: 'audio/mpeg' });
  if (mergedBlob.size < 200) throw new Error('Audio too small');

  audioBlob = mergedBlob;
  presentDownloadFile(mergedBlob, 'mp3');
}



// ────────────────────────────────────────────────────────────
// Shared: Present download file (used by Strategy 1 & 2)
// ────────────────────────────────────────────────────────────
function presentDownloadFile(blob, ext) {
  const audioURL = URL.createObjectURL(blob);

  downloadLink.href = audioURL;
  downloadLink.download = `vozai-audio-${Date.now()}.${ext}`;
  downloadLink.target = '';
  downloadLink.textContent = '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.innerHTML = '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>';
  downloadLink.appendChild(svg);
  downloadLink.appendChild(document.createTextNode(` Descargar ${ext.toUpperCase()}`));

  const sizeKB = Math.round(blob.size / 1024);
  downloadSubtitle.textContent = `Audio listo · ${sizeKB} KB`;

  downloadBtn.disabled = false;
  isRecordingDownload = false;
  setStatus('success', '✅ Audio listo — haz clic para descargar');
}

// ── Status Helpers ─────────────────────────────────────────
function setStatus(type, msg) {
  statusText.textContent = msg;
  statusDot.className = 'status-dot';
  if (type === 'active')  statusDot.classList.add('active');
  if (type === 'success') statusDot.classList.add('success');
  if (type === 'error')   statusDot.classList.add('error');
}

// ── Handle page visibility (Chrome bug fix) ────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isSpeaking && !isPaused) {
    // Chrome stops speech when tab is hidden — restart if needed
    // Not restarted here to avoid complexity, just log
  }
});

// Fix Chrome speechSynthesis bug (stops after ~15s)
setInterval(() => {
  if (isSpeaking && !isPaused) {
    window.speechSynthesis.resume();
  }
}, 10000);
