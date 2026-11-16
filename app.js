/* ============================================================
   VozAI — app.js  |  Neural AI Human Voice Engine
   ============================================================ */

'use strict';

// ── DOM References ─────────────────────────────────────────
const textInput          = document.getElementById('textInput');
const charCount          = document.getElementById('charCount');
const wordCount          = document.getElementById('wordCount');
const voiceSelect        = document.getElementById('voiceSelect');
const engineSelect       = document.getElementById('engineSelect');
const elevenLabsContainer= document.getElementById('elevenLabsContainer');
const elevenKeyInput     = document.getElementById('elevenKeyInput');
const speedRange         = document.getElementById('speedRange');
const pitchRange         = document.getElementById('pitchRange');
const speedVal           = document.getElementById('speedVal');
const pitchVal           = document.getElementById('pitchVal');
const playBtn            = document.getElementById('playBtn');
const stopBtn            = document.getElementById('stopBtn');
const downloadBtn        = document.getElementById('downloadBtn');
const playIcon           = document.getElementById('playIcon');
const pauseIcon          = document.getElementById('pauseIcon');
const progressBar        = document.getElementById('progressBar');
const currentTimeEl      = document.getElementById('currentTime');
const totalTimeEl        = document.getElementById('totalTime');
const statusDot          = document.getElementById('statusDot');
const statusText         = document.getElementById('statusText');
const vizLabel           = document.getElementById('vizLabel');
const waveCanvas         = document.getElementById('waveCanvas');
const downloadSection    = document.getElementById('downloadSection');
const downloadLink       = document.getElementById('downloadLink');
const downloadSubtitle   = document.getElementById('downloadSubtitle');
const clearBtn           = document.getElementById('clearBtn');
const pasteBtn           = document.getElementById('pasteBtn');
const sampleBtn          = document.getElementById('sampleBtn');
const metricsPanel       = document.getElementById('metricsPanel');
const metricsLiveBadge   = document.getElementById('metricsLiveBadge');
const metricTime         = document.getElementById('metricTime');
const metricSpeed        = document.getElementById('metricSpeed');
const metricSize         = document.getElementById('metricSize');
const metricBreakdown    = document.getElementById('metricBreakdown');

// ── State ──────────────────────────────────────────────────
let voices           = [];
let currentAudio     = null;
let currentAudioUrl  = null;
let isPlaying        = false;
let isPaused         = false;
let audioCtx         = null;
let analyser         = null;
let animFrame        = null;
let lastTextPlayed   = '';
let synthIntervalTimer = null;

const ctx = waveCanvas.getContext('2d');

// Sample texts
const samples = [
  'Hola, bienvenido a VozAI. Esta es una muestra de voz neuronal inteligente con entonación humana de alta fidelidad.',
  'La inteligencia artificial moderna permite generar lecturas con expresión, pausas naturales y máxima claridad.',
  'El conocimiento abre puertas infinitas. Transforma tus textos en contenido de audio listo para escuchar o descargar.',
];
let sampleIdx = 0;

// ── Init ───────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  resizeCanvas();
  drawIdleWave();
  initSliders();
  await loadVoices();

  textInput.addEventListener('input', onTextChange);
  engineSelect.addEventListener('change', onEngineChange);
  playBtn.addEventListener('click', togglePlay);
  stopBtn.addEventListener('click', stopAudio);
  clearBtn.addEventListener('click', clearText);
  pasteBtn.addEventListener('click', pasteText);
  sampleBtn.addEventListener('click', loadSample);
  downloadBtn.addEventListener('click', prepareDownload);
  window.addEventListener('resize', resizeCanvas);
});

function resizeCanvas() {
  waveCanvas.width  = waveCanvas.offsetWidth  * window.devicePixelRatio;
  waveCanvas.height = waveCanvas.offsetHeight * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}

// ── Load Neural Voices ─────────────────────────────────────
async function loadVoices() {
  try {
    setStatus('loading', 'Cargando voces neuronales humanas…');
    const res = await fetch('/api/voices');
    const data = await res.json();
    voices = data.voices || [];

    voiceSelect.innerHTML = '';
    if (voices.length === 0) {
      voiceSelect.innerHTML = '<option value="">No se encontraron voces</option>';
      return;
    }

    // Group by language
    const groups = {};
    voices.forEach(v => {
      const groupName = getLangName(v.lang);
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(v);
    });

    for (const [groupName, vList] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      vList.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = `${v.flag} ${v.name} – ${v.desc}`;
        opt.selected = true;
        optgroup.appendChild(opt);
      });
      voiceSelect.appendChild(optgroup);
    }

    setStatus('idle', 'Voces neuronales cargadas correctamente');
  } catch (err) {
    console.error('Error cargando voces:', err);
    setStatus('error', 'Error conectando con el servidor de voces');
  }
}

function getLangName(langCode) {
  const map = {
    'es-ES': '🇪🇸 Español (España)',
    'es-MX': '🇲🇽 Español (México)',
    'es-US': '🇺🇸 Español (EE.UU. / Latino)',
    'es-AR': '🇦🇷 Español (Argentina)',
    'es-CO': '🇨🇴 Español (Colombia)',
    'es-CL': '🇨🇱 Español (Chile)',
    'en-US': '🇺🇸 English (US)',
    'en-GB': '🇬🇧 English (UK)',
    'fr-FR': '🇫🇷 Français',
    'de-DE': '🇩🇪 Deutsch',
    'it-IT': '🇮🇹 Italiano',
    'pt-BR': '🇧🇷 Português',
  };
  return map[langCode] || langCode;
}

function onEngineChange() {
  if (engineSelect.value === 'elevenlabs') {
    elevenLabsContainer.style.display = 'block';
  } else {
    elevenLabsContainer.style.display = 'none';
  }
}

// ── Text Events ────────────────────────────────────────────
function onTextChange() {
  const text = textInput.value;
  const len = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  charCount.textContent = len.toLocaleString();
  if (wordCount) wordCount.textContent = words.toLocaleString();
  downloadSection.style.display = 'none';
  downloadBtn.disabled = len === 0;
}

function clearText() {
  stopAudio();
  textInput.value = '';
  charCount.textContent = '0';
  if (wordCount) wordCount.textContent = '0';
  downloadSection.style.display = 'none';
  downloadBtn.disabled = true;
  setStatus('idle', 'Texto limpiado');
}

async function pasteText() {
  try {
    const text = await navigator.clipboard.readText();
    textInput.value = text.slice(0, 500000); // Soporta hasta 500,000 caracteres (~80,000 palabras)
    onTextChange();
    const words = textInput.value.trim() ? textInput.value.trim().split(/\s+/).length : 0;
    setStatus('idle', `Texto pegado · ${textInput.value.length.toLocaleString()} caracteres (${words.toLocaleString()} palabras)`);
  } catch {
    setStatus('error', 'No se pudo acceder al portapapeles');
  }
}

function loadSample() {
  stopAudio();
  textInput.value = samples[sampleIdx % samples.length];
  sampleIdx++;
  onTextChange();
  setStatus('idle', 'Texto de ejemplo cargado');
}

// ── Sliders ────────────────────────────────────────────────
function initSliders() {
  speedRange.addEventListener('input', () => {
    speedVal.textContent = parseFloat(speedRange.value).toFixed(2) + '×';
    updateSliderFill(speedRange);
  });
  pitchRange.addEventListener('input', () => {
    pitchVal.textContent = parseFloat(pitchRange.value).toFixed(2);
    updateSliderFill(pitchRange);
  });
  updateSliderFill(speedRange);
  updateSliderFill(pitchRange);
}

function updateSliderFill(slider) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, #6366f1 ${pct}%, rgba(255,255,255,0.1) ${pct}%)`;
}

// ── Audio Playback ─────────────────────────────────────────
async function togglePlay() {
  if (isPlaying && !isPaused) {
    pauseAudio();
  } else if (isPaused) {
    resumeAudio();
  } else {
    await startAudio();
  }
}

async function startAudio() {
  const text = textInput.value.trim();
  if (!text) {
    setStatus('error', 'Por favor ingresa un texto para reproducir');
    return;
  }

  // Clear previous timer if any
  if (synthIntervalTimer) clearInterval(synthIntervalTimer);

  const startTime = performance.now();

  // Show and reset Metrics Panel for real-time monitoring
  metricsPanel.style.display = 'block';
  metricsLiveBadge.className = 'metrics-live-badge';
  metricsLiveBadge.textContent = '⏱️ SINTETIZANDO EN VIVO';
  metricTime.textContent = '0.00 s';
  metricSpeed.textContent = '0 caract/s';
  metricSize.textContent = 'Calculando...';
  metricBreakdown.textContent = 'Procesando...';

  // Start real-time live timer UI updates
  synthIntervalTimer = setInterval(() => {
    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
    metricTime.textContent = `${elapsedSec} s`;
    const estSpeed = Math.round(text.length / Math.max(0.1, (performance.now() - startTime) / 1000));
    metricSpeed.textContent = `${estSpeed.toLocaleString()} caract/s`;
    
    setStatus('loading', `⏱️ Sintetizando voz neuronal en tiempo real (${elapsedSec}s)...`);
    vizLabel.textContent = `⏱️ Tiempo de síntesis en vivo: ${elapsedSec}s (${text.length.toLocaleString()} caracteres)`;
  }, 50);

  try {
    playBtn.disabled = true;
    stopBtn.disabled = false;

    const voice = voiceSelect.value;
    const engine = engineSelect.value;
    const rate = speedRange.value;
    const pitch = pitchRange.value;
    const elevenKey = elevenKeyInput.value.trim();

    const headers = { 'Content-Type': 'application/json' };
    if (engine === 'elevenlabs' && elevenKey) {
      headers['X-ElevenLabs-ApiKey'] = elevenKey;
    }

    // Fetch audio blob via POST to prevent HTTP 431 header length errors
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        text: text,
        voice: voice,
        engine: engine,
        rate: rate,
        pitch: pitch,
        elevenlabs_key: elevenKey
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Error de servidor HTTP ${res.status}`);
    }

    // Extract performance headers sent by server
    const serverTimeMs = parseFloat(res.headers.get('X-Response-Time-Ms') || '0');
    const serverCharsPerSec = parseInt(res.headers.get('X-Chars-Per-Sec') || '0');

    const blob = await res.blob();

    // Stop real-time timer
    if (synthIntervalTimer) {
      clearInterval(synthIntervalTimer);
      synthIntervalTimer = null;
    }

    const totalClientMs = performance.now() - startTime;
    const totalClientSec = (totalClientMs / 1000).toFixed(2);
    const netMs = Math.max(0, totalClientMs - serverTimeMs);
    const sizeKb = (blob.size / 1024).toFixed(1);
    const finalSpeed = serverCharsPerSec || Math.round(text.length / (totalClientMs / 1000 || 1));

    // Update Metrics Panel with final metrics
    metricsLiveBadge.className = 'metrics-live-badge complete';
    metricsLiveBadge.textContent = '✅ COMPLETADO';
    metricTime.textContent = `${totalClientSec} s`;
    metricSpeed.textContent = `${finalSpeed.toLocaleString()} caract/s`;
    metricSize.textContent = `${sizeKb} KB`;
    metricBreakdown.textContent = `${(serverTimeMs / 1000).toFixed(2)}s Servidor / ${(netMs / 1000).toFixed(2)}s Red`;

    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(blob);

    // Setup audio element
    if (currentAudio) {
      currentAudio.pause();
    }
    currentAudio = new Audio(currentAudioUrl);
    currentAudio.playbackRate = parseFloat(speedRange.value);

    setupWebAudio(currentAudio);

    currentAudio.onplay = () => {
      isPlaying = true;
      isPaused = false;
      playBtn.disabled = false;
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
      setStatus('speaking', `Reproduciendo voz humana neuronal HD (Sintetizado en ${totalClientSec}s)`);
      vizLabel.textContent = '🔊 Reproduciendo Voz Humana HD';
      drawActiveWave();
    };

    currentAudio.ontimeupdate = () => {
      if (!currentAudio) return;
      const cur = currentAudio.currentTime || 0;
      const dur = currentAudio.duration || 1;
      const pct = (cur / dur) * 100;
      progressBar.style.width = `${pct}%`;
      currentTimeEl.textContent = formatTime(cur);
      totalTimeEl.textContent = formatTime(dur);
    };

    currentAudio.onended = () => {
      onAudioEnded();
    };

    currentAudio.onerror = (e) => {
      console.error('Audio playback error:', e);
      setStatus('error', 'Error durante la reproducción del audio');
      stopAudio();
    };

    await currentAudio.play();
    lastTextPlayed = text;

    // Show download button & summary
    downloadLink.href = currentAudioUrl;
    downloadSubtitle.textContent = `⚡ Sintetizado en ${totalClientSec}s (${finalSpeed.toLocaleString()} caract/s) · ${sizeKb} KB MP3`;
    downloadSection.style.display = 'block';

  } catch (err) {
    if (synthIntervalTimer) {
      clearInterval(synthIntervalTimer);
      synthIntervalTimer = null;
    }
    metricsLiveBadge.className = 'metrics-live-badge';
    metricsLiveBadge.style.background = 'rgba(239, 68, 68, 0.2)';
    metricsLiveBadge.style.color = '#fca5a5';
    metricsLiveBadge.textContent = '❌ ERROR';

    console.error('Error al generar audio:', err);
    setStatus('error', err.message || 'No se pudo generar el audio');
    playBtn.disabled = false;
    stopBtn.disabled = true;
    vizLabel.textContent = 'Error al generar audio';
  }
}

function pauseAudio() {
  if (currentAudio && isPlaying) {
    currentAudio.pause();
    isPaused = true;
    isPlaying = false;
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    setStatus('idle', 'Reproducción pausada');
    vizLabel.textContent = 'Pausado';
  }
}

function resumeAudio() {
  if (currentAudio && isPaused) {
    currentAudio.play();
    isPaused = false;
    isPlaying = true;
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
    setStatus('speaking', 'Reproduciendo voz humana neuronal HD…');
    vizLabel.textContent = '🔊 Reproduciendo Voz Humana HD';
    drawActiveWave();
  }
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }
  isPlaying = false;
  isPaused = false;
  playBtn.disabled = false;
  stopBtn.disabled = true;
  playIcon.style.display = 'block';
  pauseIcon.style.display = 'none';
  progressBar.style.width = '0%';
  currentTimeEl.textContent = '0:00';
  setStatus('idle', 'Audio detenido');
  vizLabel.textContent = 'Listo para generar audio neuronal';
  drawIdleWave();
}

function onAudioEnded() {
  isPlaying = false;
  isPaused = false;
  playBtn.disabled = false;
  stopBtn.disabled = true;
  playIcon.style.display = 'block';
  pauseIcon.style.display = 'none';
  progressBar.style.width = '100%';
  setStatus('idle', 'Reproducción finalizada');
  vizLabel.textContent = 'Finalizado · Listo';
  drawIdleWave();
}

async function prepareDownload() {
  if (currentAudioUrl) {
    downloadSection.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  await startAudio();
}

// ── Web Audio API Visualizer ───────────────────────────────
function setupWebAudio(audioEl) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;

    const source = audioCtx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    // MediaElementSource can only be connected once per element, which is safe to swallow if already bound
  }
}

function drawActiveWave() {
  if (!isPlaying) return;

  const w = waveCanvas.width / window.devicePixelRatio;
  const h = waveCanvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, w, h);

  let dataArray = new Uint8Array(32);
  if (analyser) {
    analyser.getByteFrequencyData(dataArray);
  } else {
    for (let i = 0; i < 32; i++) dataArray[i] = Math.random() * 200;
  }

  const barWidth = (w / 32) * 0.8;
  let x = 0;

  for (let i = 0; i < 32; i++) {
    const val = dataArray[i] / 255;
    const barHeight = Math.max(4, val * h * 0.8);

    const grad = ctx.createLinearGradient(0, h, 0, h - barHeight);
    grad.addColorStop(0, '#6366f1');
    grad.addColorStop(1, '#a855f7');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, h / 2 - barHeight / 2, barWidth, barHeight, 4);
    ctx.fill();

    x += barWidth + 2;
  }

  animFrame = requestAnimationFrame(drawActiveWave);
}

function drawIdleWave() {
  if (animFrame) cancelAnimationFrame(animFrame);

  const w = waveCanvas.width / window.devicePixelRatio;
  const h = waveCanvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(99, 102, 241, 0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

// ── Helpers ────────────────────────────────────────────────
function setStatus(state, msg) {
  statusText.textContent = msg;
  statusDot.className = 'status-dot ' + state;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ── Novel Mode Controller ──────────────────────────────────
let novelChapters = [];
let isBatchRunning = false;
let isBatchPaused = false;
let activeBatchIndex = 0;

const tabFreeText        = document.getElementById('tabFreeText');
const tabNovelMode       = document.getElementById('tabNovelMode');
const freeTextSection    = document.getElementById('freeTextSection');
const novelSection       = document.getElementById('novelSection');
const novelDropzone      = document.getElementById('novelDropzone');
const novelFileInput     = document.getElementById('novelFileInput');
const novelSummaryCard   = document.getElementById('novelSummaryCard');
const novelDocTitle      = document.getElementById('novelDocTitle');
const novelDocStats      = document.getElementById('novelDocStats');
const startBatchBtn      = document.getElementById('startBatchBtn');
const pauseBatchBtn      = document.getElementById('pauseBatchBtn');
const downloadAllZipBtn  = document.getElementById('downloadAllZipBtn');
const batchProgressLabel = document.getElementById('batchProgressLabel');
const batchPercentLabel  = document.getElementById('batchPercentLabel');
const batchProgressBar   = document.getElementById('batchProgressBar');
const chaptersStatusCount= document.getElementById('chaptersStatusCount');
const chaptersTableBody  = document.getElementById('chaptersTableBody');

function initNovelMode() {
  if (!tabFreeText || !tabNovelMode) return;

  tabFreeText.addEventListener('click', () => {
    tabFreeText.classList.add('active');
    tabNovelMode.classList.remove('active');
    if (freeTextSection) freeTextSection.style.display = 'block';
    if (novelSection) novelSection.style.display = 'none';
  });

  tabNovelMode.addEventListener('click', () => {
    tabNovelMode.classList.add('active');
    tabFreeText.classList.remove('active');
    if (freeTextSection) freeTextSection.style.display = 'none';
    if (novelSection) novelSection.style.display = 'block';
  });

  novelDropzone.addEventListener('click', () => novelFileInput.click());
  novelFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      uploadNovelFile(e.target.files[0]);
    }
  });

  novelDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    novelDropzone.classList.add('dragover');
  });

  novelDropzone.addEventListener('dragleave', () => {
    novelDropzone.classList.remove('dragover');
  });

  novelDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    novelDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadNovelFile(e.dataTransfer.files[0]);
    }
  });

  startBatchBtn.addEventListener('click', startBatchProcessing);
  pauseBatchBtn.addEventListener('click', pauseBatchProcessing);
}

async function uploadNovelFile(file) {
  const allowed = ['.docx', '.pdf', '.txt'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowed.includes(ext)) {
    alert('Por favor selecciona un archivo Word (.docx), PDF (.pdf) o Texto (.txt)');
    return;
  }

  const originalContent = novelDropzone.innerHTML;
  novelDropzone.innerHTML = `
    <div class="dropzone-content">
      <div class="dropzone-icon" style="animation: spin 1.5s linear infinite;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      </div>
      <h3>Analizando "${file.name}"...</h3>
      <p>Extrayendo texto y detectando capítulos automáticamente. Esto tomará unos segundos.</p>
    </div>
  `;

  try {
    setStatus('loading', `Analizando documento "${file.name}"...`);
    const res = await fetch('/api/upload-novel', {
      method: 'POST',
      headers: {
        'X-Filename': encodeURIComponent(file.name)
      },
      body: file
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error de servidor HTTP ${res.status}`);
    }

    const data = await res.json();
    novelChapters = (data.chapters || []).map(ch => ({
      ...ch,
      status: 'pending',
      audioUrl: null,
      filename: null
    }));

    novelDocTitle.textContent = data.filename || file.name;
    const estHours = (data.totalWords / 150 / 60).toFixed(1);
    novelDocStats.textContent = `${novelChapters.length} capítulos detectados · ${data.totalWords.toLocaleString()} palabras · ~${estHours} horas de audio estimadas`;

    renderChaptersTable();
    updateBatchProgress();

    novelSummaryCard.style.display = 'block';
    setStatus('idle', `Novela cargada: ${novelChapters.length} capítulos listos para generar`);
    novelSummaryCard.scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    console.error('Error al subir novela:', err);
    alert('Error al analizar la novela: ' + err.message);
    setStatus('error', 'Error al procesar el archivo');
  } finally {
    novelDropzone.innerHTML = originalContent;
  }
}

function renderChaptersTable() {
  chaptersTableBody.innerHTML = '';
  novelChapters.forEach((ch, idx) => {
    const tr = document.createElement('tr');
    tr.id = `chapter-row-${ch.id}`;

    let statusHtml = '';
    if (ch.status === 'pending') {
      statusHtml = '<span class="badge-ch-status pending">⏳ Pendiente</span>';
    } else if (ch.status === 'processing') {
      statusHtml = '<span class="badge-ch-status processing">⚙️ Sintetizando...</span>';
    } else if (ch.status === 'completed') {
      statusHtml = '<span class="badge-ch-status completed">✅ Listo</span>';
    } else if (ch.status === 'error') {
      statusHtml = '<span class="badge-ch-status error">❌ Error</span>';
    }

    let actionsHtml = '';
    if (ch.status === 'completed' && ch.audioUrl) {
      actionsHtml = `
        <button class="row-btn" onclick="playChapterAudio('${ch.audioUrl}', '${ch.title}')" title="Escuchar">▶️ Escuchar</button>
        <a class="row-btn download" href="${ch.audioUrl}" download="${ch.filename}" title="Descargar MP3 offline">⬇️ MP3</a>
      `;
    } else {
      actionsHtml = `
        <button class="row-btn" onclick="synthesizeSingleChapter(${idx})" title="Generar solo este capítulo">⚡ Generar</button>
      `;
    }

    tr.innerHTML = `
      <td style="color: var(--text-muted); font-weight: 600;">#${ch.id}</td>
      <td style="font-weight: 500;">${escapeHtml(ch.title)}</td>
      <td style="color: var(--text-secondary);">${ch.wordCount.toLocaleString()}</td>
      <td id="chapter-status-${ch.id}">${statusHtml}</td>
      <td id="chapter-actions-${ch.id}" style="text-align: right;">${actionsHtml}</td>
    `;
    chaptersTableBody.appendChild(tr);
  });
}

function updateBatchProgress() {
  const total = novelChapters.length;
  const completed = novelChapters.filter(c => c.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  batchProgressLabel.textContent = `Progreso general: ${completed} de ${total} capítulos completados`;
  batchPercentLabel.textContent = `${pct}%`;
  batchProgressBar.style.width = `${pct}%`;
  chaptersStatusCount.textContent = `${completed} de ${total} completados`;

  if (completed > 0) {
    downloadAllZipBtn.style.display = 'inline-flex';
  }
}

async function startBatchProcessing() {
  if (novelChapters.length === 0) return;

  isBatchRunning = true;
  isBatchPaused = false;
  startBatchBtn.style.display = 'none';
  pauseBatchBtn.style.display = 'inline-flex';

  for (let i = 0; i < novelChapters.length; i++) {
    if (isBatchPaused) {
      setStatus('idle', 'Generación en lote pausada');
      break;
    }

    const ch = novelChapters[i];
    if (ch.status === 'completed') continue;

    // Scroll to active row
    const rowEl = document.getElementById(`chapter-row-${ch.id}`);
    if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    await processChapter(i);
  }

  isBatchRunning = false;
  pauseBatchBtn.style.display = 'none';
  startBatchBtn.style.display = 'inline-flex';

  const completed = novelChapters.filter(c => c.status === 'completed').length;
  if (completed === novelChapters.length) {
    startBatchBtn.textContent = '✅ Todos los Capítulos Generados';
    startBatchBtn.disabled = true;
    setStatus('success', '¡Audiolibro completo generado exitosamente!');
  } else if (isBatchPaused) {
    startBatchBtn.textContent = '▶️ Reanudar Generación';
  }
}

function pauseBatchProcessing() {
  isBatchPaused = true;
  pauseBatchBtn.style.display = 'none';
  startBatchBtn.style.display = 'inline-flex';
  startBatchBtn.textContent = '▶️ Reanudar Generación';
  setStatus('idle', 'Pausando generación tras el capítulo actual...');
}

async function processChapter(index) {
  const ch = novelChapters[index];
  ch.status = 'processing';
  updateChapterRowUI(ch);

  setStatus('loading', `Sintetizando ${ch.title} (${index + 1}/${novelChapters.length})...`);

  try {
    const res = await fetch('/api/synthesize-chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterId: ch.id,
        title: ch.title,
        text: ch.text,
        voice: voiceSelect.value || 'es-MX-JorgeNeural',
        rate: speedRange.value || '1.0',
        pitch: pitchRange.value || '1.0'
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error ${res.status}`);
    }

    const data = await res.json();
    ch.status = 'completed';
    ch.audioUrl = data.url;
    ch.filename = data.filename;
    updateChapterRowUI(ch);
    updateBatchProgress();

  } catch (err) {
    console.error(`Error en capítulo ${ch.id}:`, err);
    ch.status = 'error';
    updateChapterRowUI(ch);
  }
}

function updateChapterRowUI(ch) {
  const statusEl = document.getElementById(`chapter-status-${ch.id}`);
  const actionsEl = document.getElementById(`chapter-actions-${ch.id}`);
  if (!statusEl || !actionsEl) return;

  if (ch.status === 'processing') {
    statusEl.innerHTML = '<span class="badge-ch-status processing">⚙️ Sintetizando...</span>';
  } else if (ch.status === 'completed') {
    statusEl.innerHTML = '<span class="badge-ch-status completed">✅ Listo</span>';
    actionsEl.innerHTML = `
      <button class="row-btn" onclick="playChapterAudio('${ch.audioUrl}', '${escapeHtml(ch.title)}')" title="Escuchar">▶️ Escuchar</button>
      <a class="row-btn download" href="${ch.audioUrl}" download="${ch.filename}" title="Descargar MP3 offline">⬇️ MP3</a>
    `;
  } else if (ch.status === 'error') {
    statusEl.innerHTML = '<span class="badge-ch-status error">❌ Error</span>';
    actionsEl.innerHTML = `
      <button class="row-btn" onclick="synthesizeSingleChapter(${novelChapters.indexOf(ch)})" title="Reintentar">🔄 Reintentar</button>
    `;
  }
}

async function synthesizeSingleChapter(index) {
  await processChapter(index);
}

function playChapterAudio(url, title) {
  if (currentAudio) {
    currentAudio.pause();
  }
  currentAudio = new Audio(url);
  currentAudio.playbackRate = parseFloat(speedRange.value);
  setupWebAudio(currentAudio);

  currentAudio.onplay = () => {
    isPlaying = true;
    isPaused = false;
    playBtn.disabled = false;
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
    setStatus('speaking', `Reproduciendo: ${title}`);
    vizLabel.textContent = `🔊 ${title}`;
    drawActiveWave();
  };

  currentAudio.ontimeupdate = () => {
    if (!currentAudio) return;
    const cur = currentAudio.currentTime || 0;
    const dur = currentAudio.duration || 1;
    const pct = (cur / dur) * 100;
    progressBar.style.width = `${pct}%`;
    currentTimeEl.textContent = formatTime(cur);
    totalTimeEl.textContent = formatTime(dur);
  };

  currentAudio.onended = onAudioEnded;
  currentAudio.play();

  // Scroll player into view
  document.querySelector('.player-card').scrollIntoView({ behavior: 'smooth' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Ensure initNovelMode is called on load
window.addEventListener('DOMContentLoaded', () => {
  initNovelMode();
});

