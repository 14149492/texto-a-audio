const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EdgeTTS } = require('@andresaya/edge-tts');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { ZipArchive } = require('archiver');

const PORT = 3000;
const AUDIOLIBRO_DIR = path.join(__dirname, 'audiolibro');
if (!fs.existsSync(AUDIOLIBRO_DIR)) {
  fs.mkdirSync(AUDIOLIBRO_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// Curated list of Neural AI Human Voices - Solo Jorge (México)
const NEURAL_VOICES = [
  { id: 'es-MX-JorgeNeural', name: 'Jorge (México)', gender: 'Hombre', lang: 'es-MX', flag: '🇲🇽', desc: 'Voz neutra y formal' }
];

// Split text into chunks for TTS processing respecting natural speech pauses
function splitText(text, maxLen = 1500) {
  if (!text || text.length <= maxLen) return [text || ''];

  // 1. Dividir primero por oraciones completas (. ! ? saltos de línea)
  const sentences = text.match(/[^.!?\n\r]+[.!?\n\r]*/g) || [text];
  const chunks = [];
  let current = '';

  for (const sent of sentences) {
    const trimmed = sent.trim();
    if (!trimmed) continue;

    if ((current + ' ' + trimmed).trim().length > maxLen) {
      if (current.trim()) chunks.push(current.trim());

      // Si una sola oración excede maxLen, dividir por pausas secundarias (, ; : —)
      if (trimmed.length > maxLen) {
        const clauses = trimmed.match(/[^,;:—\n]+[,;:—]*/g) || [trimmed];
        current = '';
        for (const clause of clauses) {
          const cTrim = clause.trim();
          if (!cTrim) continue;

          if ((current + ' ' + cTrim).trim().length > maxLen) {
            if (current.trim()) chunks.push(current.trim());

            // Si una sola cláusula sigue siendo gigante, dividir por palabras
            if (cTrim.length > maxLen) {
              const words = cTrim.split(/\s+/);
              current = '';
              for (const word of words) {
                if ((current + ' ' + word).trim().length > maxLen) {
                  if (current.trim()) chunks.push(current.trim());
                  current = word;
                } else {
                  current = (current + ' ' + word).trim();
                }
              }
            } else {
              current = cTrim;
            }
          } else {
            current = (current + ' ' + cTrim).trim();
          }
        }
      } else {
        current = trimmed;
      }
    } else {
      current = (current + ' ' + trimmed).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Synthesize using EdgeTTS
async function synthesizeEdgeTTS(text, voiceId, rateStr = '+0%', pitchStr = '+0Hz') {
  const tts = new EdgeTTS({
    voice: voiceId || 'es-MX-JorgeNeural',
    lang: (voiceId || 'es-MX').slice(0, 5),
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
  });

  await tts.synthesize(text, voiceId || 'es-MX-JorgeNeural', {
    rate: rateStr,
    pitch: pitchStr
  });

  return await tts.toBuffer();
}

// Synthesize using ElevenLabs API (Optional)
function synthesizeElevenLabs(text, apiKey, voiceId) {
  return new Promise((resolve, reject) => {
    const targetVoice = voiceId || '21m00Tcm4TlvDq8ikWAM';
    const postData = JSON.stringify({
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${targetVoice}`,
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', chunk => errBody += chunk);
        res.on('end', () => reject(new Error(`ElevenLabs Error (${res.statusCode}): ${errBody}`)));
        return;
      }
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Throttle global: espacio mínimo entre el inicio de dos peticiones a Microsoft
// (aplica a todos los workers en paralelo). Solo afecta a la generación, NO al audio final.
const EDGE_MIN_GAP_MS = 400;
let edgeNextSlot = 0;
async function waitEdgeSlot() {
  const now = Date.now();
  const slot = Math.max(now, edgeNextSlot);
  edgeNextSlot = slot + EDGE_MIN_GAP_MS;
  if (slot > now) await sleep(slot - now);
}

// Synthesize using EdgeTTS with realistic timeout, throttle & exponential backoff
async function synthesizeEdgeTTSWithRetry(chunk, voice, rateStr, pitchStr, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timer;
    try {
      await waitEdgeSlot();
      // Timeout amplio de 25s por fragmento para evitar abortos prematuros
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('EdgeTTS timeout después de 25s')), 25000);
      });
      const synthPromise = synthesizeEdgeTTS(chunk, voice, rateStr, pitchStr);
      return await Promise.race([synthPromise, timeoutPromise]);
    } catch (err) {
      if (attempt === retries) throw err;
      const isRateLimit = /429/.test(err.message || '');
      // 429 → 5s, 10s, 20s, 30s, 30s ; otros errores → 1.5s, 3s, 4.5s...
      const base = isRateLimit ? Math.min(5000 * 2 ** attempt, 30000) : 1500 * (attempt + 1);
      const wait = base + Math.floor(Math.random() * 1000);
      if (isRateLimit) {
        // Frena también a los demás workers para que no sigan golpeando el servidor
        edgeNextSlot = Math.max(edgeNextSlot, Date.now() + wait);
      }
      console.warn(`[TTS Retry] Reintentando fragmento (intento ${attempt + 1}/${retries}) en ${(wait / 1000).toFixed(1)}s... Error: ${err.message}`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Helper for parallel batch execution with concurrency control
async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  for (let c = 0; c < Math.min(concurrency, items.length); c++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// Helper to parse request body for POST requests
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 50 * 1024 * 1024) { // 50MB limit to support massive text requests
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Read binary buffer from incoming request for file uploads (up to 250MB)
function readRawBody(req, maxBytes = 250 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      totalLen += chunk.length;
      if (totalLen > maxBytes) {
        req.destroy();
        reject(new Error('Archivo demasiado grande (máximo 250MB)'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Extract clean text from uploaded buffer based on filename extension
async function extractTextFromFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.docx') {
    try {
      // Extracción ultrarrápida con JSZip leyendo word/document.xml directamente
      // Evita saturar la memoria V8 de Node en documentos grandes de cientos de páginas
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const docFile = zip.file('word/document.xml');
      if (docFile) {
        const xml = await docFile.async('string');
        const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
        const lines = [];
        for (const p of paragraphs) {
          const textMatches = p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
          if (textMatches) {
            lines.push(textMatches.map(t => t.replace(/<[^>]+>/g, '')).join(''));
          } else {
            lines.push('');
          }
        }
        return lines.join('\n')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'");
      }
    } catch (e) {
      console.warn('[Docx Fast Extract Warning]:', e.message);
    }
    const res = await mammoth.extractRawText({ buffer });
    return res.value || '';
  } else if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result && result.text) ? result.text : '';
    await parser.destroy();
    return cleanPdfText(text);
  } else {
    // Treat as utf-8 plain text (e.g. .txt, .md)
    return buffer.toString('utf-8');
  }
}

// ===== PDF cleanup: removes running headers/footers, page numbers and detects layout chapter markers =====
const CHAPTER_SENTINEL = '@@VOZAI_CHAPTER@@';
const PDF_PAGE_MARKER = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i;

function normalizeForCompare(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanPdfText(rawText) {
  const normalized = (rawText || '').replace(/\r\n?/g, '\n');

  // 1. Split into pages using pdf-parse markers ("-- 8 of 159 --")
  const pages = [];
  let cur = [];
  for (const line of normalized.split('\n')) {
    if (PDF_PAGE_MARKER.test(line)) {
      pages.push(cur);
      cur = [];
    } else {
      cur.push(line.trim());
    }
  }
  if (cur.some(Boolean)) pages.push(cur);
  if (pages.length < 3) return normalized.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, '');

  // 2. Detect running headers/footers: lines repeated on many pages
  const freq = new Map();
  for (const p of pages) {
    const seen = new Set(p.filter(l => l && l.length <= 150 && !/^\d+$/.test(l)));
    for (const l of seen) freq.set(l, (freq.get(l) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.25));
  const repeated = new Set([...freq].filter(([, c]) => c >= threshold).map(([l]) => l));

  // Blobs of concatenated header lines (to catch the same header wrapped differently)
  const headerBlobs = new Set();
  for (const p of pages) {
    const blob = normalizeForCompare(p.filter(l => repeated.has(l)).join(' '));
    if (blob.length >= 8) headerBlobs.add(blob);
  }
  const isFuzzyHeader = (line) => {
    const n = normalizeForCompare(line);
    if (n.length < 8) return false;
    for (const b of headerBlobs) if (b.includes(n)) return true;
    return false;
  };

  // 3. Clean each page and detect chapter markers ("CAP\n1", "P.A.")
  const outLines = [];
  let markersFound = 0;
  for (const page of pages) {
    let lines = page.slice();
    let chapterTitle = null;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^(?:CAP|CAP\.|CAPÍTULO|CAPITULO)$/i.test(l)) {
        let j = i + 1;
        while (j < lines.length && !lines[j]) j++;
        if (j < lines.length && /^\d{1,3}$/.test(lines[j])) {
          chapterTitle = `Capítulo ${parseInt(lines[j], 10)}`;
          lines = lines.slice(0, i); // drop marker + decorative footer after it
          break;
        }
      }
      if (/^P\.\s?A\.(?:\s|$)/.test(l)) {
        chapterTitle = 'Palabras del autor';
        lines = lines.slice(0, i);
        break;
      }
    }

    const nonEmptyIdx = lines.map((l, i) => (l ? i : -1)).filter(i => i >= 0);
    const edge = new Set([...nonEmptyIdx.slice(0, 5), ...nonEmptyIdx.slice(-5)]);
    const cleaned = lines.filter((l, i) => {
      if (!l) return false;
      if (repeated.has(l)) return false;
      if (edge.has(i) && /^\d{1,4}$/.test(l)) return false; // page numbers
      if (edge.has(i) && isFuzzyHeader(l)) return false;
      return true;
    });

    if (chapterTitle) {
      markersFound++;
      outLines.push(`${CHAPTER_SENTINEL} ${chapterTitle}`);
    }
    outLines.push(...cleaned);
  }

  // 4. Re-join lines broken by the PDF layout (keeps sentence/paragraph breaks)
  const chunks = [];
  let prevLine = '';
  for (const line of outLines) {
    if (line.startsWith(CHAPTER_SENTINEL)) {
      chunks.push(`\n${line}\n`);
      prevLine = '\n';
      continue;
    }
    if (!prevLine || prevLine.endsWith('\n')) {
      chunks.push(line);
    } else if (/[.!?…:”"»)\]~♪]$/.test(prevLine)) {
      chunks.push('\n' + line);
    } else {
      chunks.push(' ' + line);
    }
    prevLine = line;
  }
  const result = chunks.join('');

  console.log(`[PDF] Limpieza: ${pages.length} páginas, ${repeated.size} encabezados repetidos eliminados, ${markersFound} marcas de capítulo detectadas`);
  return result;
}

// Split using explicit layout markers produced by cleanPdfText
function splitBySentinel(normalized) {
  const parts = normalized.split(new RegExp(`^${CHAPTER_SENTINEL}[ \\t]*(.*)$`, 'm'));
  const chapters = [];
  const pre = (parts[0] || '').trim();
  const preWords = pre ? pre.split(/\s+/).filter(Boolean).length : 0;
  if (preWords >= 100) {
    chapters.push({ title: 'Introducción', body: pre });
  }
  for (let i = 1; i < parts.length; i += 2) {
    const title = (parts[i] || '').trim() || `Capítulo ${chapters.length + 1}`;
    const body = (parts[i + 1] || '').trim();
    if (!body) continue;
    chapters.push({ title, body });
  }
  return chapters.map((ch, idx) => {
    const text = `${ch.title}.\n${ch.body}`;
    return {
      id: idx + 1,
      title: ch.title,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      charCount: text.length,
      text
    };
  });
}

// Smart Chapter Splitter (detects Capítulos, Chapters, Prólogo, Epílogo, Secciones)
const ROMAN_NUM = '(?:C{1,3}|CD|D|DC{1,3}|CM)?(?:X{1,3}|XL|L|LX{1,3}|XC)?(?:I{1,3}|IV|V|VI{1,3}|IX)';

const chapterRegex = new RegExp(
  '(?:^|\\n)[ \\t]*(?:' +
  // Named sections: Prólogo, Epílogo, Prefacio, Interludio, Conclusión, etc.
  '(?:pr[oó]logo|ep[ií]logo|prefacio|prologue|epilogue|interludio|interlude|introducci[oó]n|conclusi[oó]n|postfacio|afterword|palabras[ \\t]+del[ \\t]+autor|notas?[ \\t]+del[ \\t]+autor)\\b(?:[ \\t]*[:\\-–—\\.][ \\t]*[^\\n]{0,120}|[ \\t]+[0-9]+[^\\n]{0,120}|[ \\t]+[^\\n]{1,120})?' +
  // Numbered chapters: Capítulo 1, Chapter 01, Cap. 1, etc.
  '|(?:cap[ií]tulos?|chapters?|cap\\.)[ \\t]*(?:n[úu]m(?:ero|\\.)?[ \\t]*)?(?:[0-9]+|' + ROMAN_NUM + '\\b)[^\\n]{0,120}' +
  // Sections / Parts with number or Roman numeral: Parte 1, Sección II (avoids common phrases like "parte delantera")
  '|(?:secci[oó]n|parte)[ \\t]+(?:[0-9]+|' + ROMAN_NUM + '\\b)[^\\n]{0,120}' +
  // Standalone numbered lines: "1. Título", "01 - Título"
  '|(?:[0-9]{1,4})[ \\t]*[\\.\\-–—:][ \\t]+[^\\n]{1,120}' +
  ')',
  'gi'
);

function cleanTitle(headerLine) {
  let title = (headerLine || '').replace(/^[\s*#\-–—:]+/, '').replace(/[\s*#\-–—:]+$/, '').trim();
  title = title.replace(/[ \t]+/g, ' ');
  return title;
}

function splitIntoChapters(fullText) {
  const normalized = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Layout markers detected in PDF (CAP N / P.A.) take priority
  if (normalized.includes(CHAPTER_SENTINEL)) {
    const byMarkers = splitBySentinel(normalized);
    if (byMarkers.length > 0) return byMarkers;
  }

  const matches = [];
  let match;
  chapterRegex.lastIndex = 0;
  while ((match = chapterRegex.exec(normalized)) !== null) {
    const rawMatch = match[0];
    const offset = rawMatch.startsWith('\n') ? 1 : 0;
    matches.push({
      index: match.index + offset,
      rawHeader: rawMatch.trim()
    });
  }

  // Fallback 1: Numbers on their own line (e.g. "1\nTexto...")
  if (matches.length < 2) {
    const numRegex = /(?:^|\n)[ \t]*([0-9]{1,4})[ \t]*\n/g;
    const numMatches = [];
    let nMatch;
    while ((nMatch = numRegex.exec(normalized)) !== null) {
      numMatches.push({
        index: nMatch.index + (nMatch[0].startsWith('\n') ? 1 : 0),
        rawHeader: `Capítulo ${nMatch[1]}`
      });
    }
    if (numMatches.length >= 2) {
      matches.push(...numMatches);
    }
  }

  if (matches.length >= 2) {
    const rawChapters = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const start = current.index;
      const end = (i + 1 < matches.length) ? matches[i + 1].index : normalized.length;
      const chapterContent = normalized.substring(start, end).trim();

      const nonBlankLines = chapterContent.split('\n').map(l => l.trim()).filter(Boolean);
      let title = cleanTitle(nonBlankLines[0] || `Capítulo ${i + 1}`);

      // Si el título es solo "Capítulo 1" o "Epílogo" y la siguiente línea parece subtítulo corto
      if (nonBlankLines.length > 1 && /^(?:cap[ií]tulos?\s*(?:[0-9]+|[ivxlcdm]+)|chapter\s*[0-9]+|pr[oó]logo|ep[ií]logo|prefacio|interludio)$/i.test(title)) {
        const nextLine = cleanTitle(nonBlankLines[1]);
        if (nextLine.length > 0 && nextLine.length <= 80 && !nextLine.endsWith('.') && !/^(?:cap[ií]tulo|pr[oó]logo|ep[ií]logo)/i.test(nextLine)) {
          title = `${title}: ${nextLine}`;
        }
      }

      const words = chapterContent.trim().split(/\s+/).filter(Boolean).length;

      rawChapters.push({
        title: title || `Capítulo ${i + 1}`,
        wordCount: words,
        charCount: chapterContent.length,
        text: chapterContent
      });
    }

    // 1. Filtrar entradas con muy pocas palabras (índices, líneas de TOC, leyendas breves de < 35 palabras)
    let candidates = rawChapters.filter(c => c.wordCount >= 35);
    if (candidates.length === 0) candidates = rawChapters;

    // 2. Descartar duplicados tempranos (ilustraciones / fragmentos del índice donde el mismo título se repite más adelante con más contenido)
    const titleCounts = new Map();
    for (const c of candidates) {
      const normTitle = c.title.toLowerCase().replace(/[^a-z0-9áéíóúñ]/g, '');
      titleCounts.set(normTitle, (titleCounts.get(normTitle) || 0) + 1);
    }

    const validChapters = [];
    for (const c of candidates) {
      const normTitle = c.title.toLowerCase().replace(/[^a-z0-9áéíóúñ]/g, '');
      if (titleCounts.get(normTitle) > 1) {
        const duplicates = candidates.filter(x => x.title.toLowerCase().replace(/[^a-z0-9áéíóúñ]/g, '') === normTitle);
        const maxWords = Math.max(...duplicates.map(x => x.wordCount));
        if (c.wordCount < maxWords * 0.5) {
          console.log(`[Filtro] Descartando duplicado corto preliminar: "${c.title}" (${c.wordCount} palabras vs ${maxWords} del real)`);
          continue;
        }
      }
      validChapters.push(c);
    }

    const finalChapters = validChapters.length > 0 ? validChapters : candidates;

    return finalChapters.map((ch, idx) => ({
      id: idx + 1,
      title: ch.title,
      wordCount: ch.wordCount,
      charCount: ch.charCount,
      text: ch.text
    }));
  }

  // Fallback 2: Sin capítulos → dividir en partes de ~3.000 palabras cortando en párrafos/oraciones
  const totalWords = normalized.trim().split(/\s+/).filter(Boolean).length;
  const PART_WORDS = 3000;
  if (totalWords <= PART_WORDS * 1.3) {
    return [{
      id: 1,
      title: 'Texto Completo',
      wordCount: totalWords,
      charCount: normalized.length,
      text: normalized
    }];
  }

  const units = normalized.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) || [normalized];
  const parts = [];
  let buf = '';
  let bufWords = 0;
  for (const u of units) {
    const w = u.trim().split(/\s+/).filter(Boolean).length;
    buf += u;
    bufWords += w;
    // Cortar al llegar al objetivo, preferentemente en fin de párrafo
    if (bufWords >= PART_WORDS && (/\n\s*$/.test(u) || bufWords >= PART_WORDS * 1.2)) {
      parts.push(buf.trim());
      buf = '';
      bufWords = 0;
    }
  }
  if (buf.trim()) {
    // Unir un residuo muy pequeño a la parte anterior
    if (parts.length && bufWords < PART_WORDS * 0.3) parts[parts.length - 1] += '\n' + buf.trim();
    else parts.push(buf.trim());
  }

  console.log(`[Capítulos] No se detectaron marcas; documento dividido en ${parts.length} partes de ~${PART_WORDS} palabras`);
  return parts.map((text, idx) => ({
    id: idx + 1,
    title: `Parte ${idx + 1}`,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    charCount: text.length,
    text
  }));
}

const serverOptions = {
  maxHeaderSize: 65536 // Increase header size limit to prevent HTTP 431
};

const server = http.createServer(serverOptions, async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-ElevenLabs-ApiKey');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Disposition, X-Response-Time-Ms, X-Synthesis-Chars, X-Chars-Per-Sec');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoint: List Available Neural Voices
  if (req.url === '/api/voices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ voices: NEURAL_VOICES }));
    return;
  }

  // API Endpoint: Synthesize Speech (Supports both POST and GET)
  if (req.url.startsWith('/api/tts')) {
    const startTime = Date.now();
    try {
      let text, voice, engine, rate, pitch, elevenLabsKey;

      if (req.method === 'POST') {
        const payload = await parseRequestBody(req);
        text = payload.text;
        voice = payload.voice || 'es-MX-JorgeNeural';
        engine = payload.engine || 'edge';
        rate = payload.rate || '1.0';
        pitch = payload.pitch || '1.0';
        elevenLabsKey = req.headers['x-elevenlabs-apikey'] || payload.elevenlabs_key;
      } else {
        const urlObj = new URL(req.url, `http://localhost:${PORT}`);
        text = urlObj.searchParams.get('text');
        voice = urlObj.searchParams.get('voice') || 'es-MX-JorgeNeural';
        engine = urlObj.searchParams.get('engine') || 'edge';
        rate = urlObj.searchParams.get('rate') || '1.0';
        pitch = urlObj.searchParams.get('pitch') || '1.0';
        elevenLabsKey = req.headers['x-elevenlabs-apikey'] || urlObj.searchParams.get('elevenlabs_key');
      }

      if (!text || !text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text parameter is required' }));
        return;
      }

      let audioBuffer;

      // Rate and Pitch formatting for EdgeTTS
      const rateVal = Math.round((parseFloat(rate) - 1.0) * 100);
      const rateStr = (rateVal >= 0 ? `+${rateVal}%` : `${rateVal}%`);
      const pitchVal = Math.round((parseFloat(pitch) - 1.0) * 20);
      const pitchStr = (pitchVal >= 0 ? `+${pitchVal}Hz` : `${pitchVal}Hz`);

      if (engine === 'elevenlabs' && elevenLabsKey) {
        // Synthesize with ElevenLabs in chunks of 4500 chars
        const chunks = splitText(text, 4500);
        const buffers = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunkBuf = await synthesizeElevenLabs(chunks[i], elevenLabsKey, voice);
          buffers.push(chunkBuf);
        }
        audioBuffer = Buffer.concat(buffers);
      } else {
        // Synthesize with Edge Neural TTS in chunks of 1500 chars using parallel workers
        const chunks = splitText(text, 1500);
        console.log(`[TTS Inicio] [${new Date().toLocaleTimeString()}] Iniciando síntesis de ${text.length} caracteres (${chunks.length} fragmentos con voz ${voice})...`);

        const CONCURRENCY = 2;
        const buffers = await mapConcurrent(chunks, CONCURRENCY, async (chunk, index) => {
          const chunkStart = Date.now();
          const buf = await synthesizeEdgeTTSWithRetry(chunk, voice, rateStr, pitchStr);
          const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(2);
          console.log(`[TTS Progress] Fragmento ${index + 1}/${chunks.length} sintetizado correctamente en ${chunkElapsed}s`);
          return buf;
        });

        audioBuffer = Buffer.concat(buffers);
      }

      const totalDurationMs = Date.now() - startTime;
      const totalSec = (totalDurationMs / 1000).toFixed(2);
      const charsPerSec = Math.round(text.length / (totalDurationMs / 1000 || 1));
      const sizeKb = (audioBuffer.length / 1024).toFixed(1);

      console.log(`[TTS Completo] ⏱️ Tiempo total síntesis: ${totalSec}s | Velocidad: ${charsPerSec} char/s | MP3: ${sizeKb} KB`);

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
        'Content-Disposition': `attachment; filename="vozai-${Date.now()}.mp3"`,
        'Cache-Control': 'no-cache',
        'X-Response-Time-Ms': totalDurationMs.toString(),
        'X-Synthesis-Chars': text.length.toString(),
        'X-Chars-Per-Sec': charsPerSec.toString()
      });
      res.end(audioBuffer);

    } catch (err) {
      console.error('TTS Synthesis Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Speech synthesis failed' }));
    }
    return;
  }

  // API Endpoint: Extract plain text from document (for free text mode)
  if (req.url === '/api/extract-text' && req.method === 'POST') {
    try {
      const filename = decodeURIComponent(req.headers['x-filename'] || 'documento.pdf');
      const buffer = await readRawBody(req);
      console.log(`[ExtractText] Recibido archivo: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      const fullText = await extractTextFromFile(buffer, filename);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        filename,
        text: fullText
      }));
    } catch (err) {
      console.error('[ExtractText Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Error al extraer texto del documento' }));
    }
    return;
  }

  // API Endpoint: Upload novel document (Word .docx, PDF, TXT) and parse chapters
  if (req.url === '/api/upload-novel' && req.method === 'POST') {
    try {
      const filename = decodeURIComponent(req.headers['x-filename'] || 'novela.docx');
      const buffer = await readRawBody(req);
      console.log(`[Upload] Recibido archivo: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

      const fullText = await extractTextFromFile(buffer, filename);
      const chapters = splitIntoChapters(fullText);
      const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

      console.log(`[Upload] Extracción completa: ${chapters.length} capítulos detectados (${totalWords.toLocaleString()} palabras)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        filename,
        totalChapters: chapters.length,
        totalWords,
        chapters
      }));
    } catch (err) {
      console.error('[Upload Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Error al procesar el archivo' }));
    }
    return;
  }

  // API Endpoint: Synthesize single chapter and save to audiolibro/
  if (req.url === '/api/synthesize-chapter' && req.method === 'POST') {
    try {
      const payload = await parseRequestBody(req);
      const { chapterId, title, text, voice = 'es-MX-JorgeNeural', rate = '1.0', pitch = '1.0' } = payload;
      if (!text || !text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text is required' }));
        return;
      }

      const startTime = Date.now();
      const chunks = splitText(text, 1500);
      const rateVal = Math.round((parseFloat(rate) - 1.0) * 100);
      const rateStr = (rateVal >= 0 ? `+${rateVal}%` : `${rateVal}%`);
      const pitchVal = Math.round((parseFloat(pitch) - 1.0) * 20);
      const pitchStr = (pitchVal >= 0 ? `+${pitchVal}Hz` : `${pitchVal}Hz`);

      console.log(`[Capítulo ${chapterId}] Iniciando síntesis de "${title}" (${text.length} caracteres, ${chunks.length} fragmentos)...`);

      const buffers = await mapConcurrent(chunks, 2, async (chunk, index) => {
        return await synthesizeEdgeTTSWithRetry(chunk, voice, rateStr, pitchStr);
      });

      const audioBuffer = Buffer.concat(buffers);
      const padId = String(chapterId).padStart(3, '0');
      const cleanTitle = (title || `Capitulo_${padId}`)
        .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ\-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 50);

      const filename = `Capitulo_${padId}_${cleanTitle}.mp3`;
      const filePath = path.join(AUDIOLIBRO_DIR, filename);
      fs.writeFileSync(filePath, audioBuffer);

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeKb = (audioBuffer.length / 1024).toFixed(1);

      console.log(`[Capítulo ${chapterId} Guardado] ${filename} (${sizeKb} KB) en ${durationSec}s`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        chapterId,
        filename,
        sizeKb,
        durationSec,
        url: `/audiolibro/${encodeURIComponent(filename)}`
      }));
    } catch (err) {
      console.error('[Capítulo Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Error sintetizando capítulo' }));
    }
    return;
  }

  // API Endpoint: List saved audiolibro files
  if (req.url === '/api/audiolibro-files' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(AUDIOLIBRO_DIR)
        .filter(f => f.endsWith('.mp3'))
        .map(f => {
          const stat = fs.statSync(path.join(AUDIOLIBRO_DIR, f));
          return {
            name: f,
            sizeKb: (stat.size / 1024).toFixed(1),
            url: `/audiolibro/${encodeURIComponent(f)}`,
            mtime: stat.mtime
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API Endpoint: Download all chapters in a ZIP file
  if (req.url === '/api/download-all-zip' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(AUDIOLIBRO_DIR).filter(f => f.endsWith('.mp3'));
      if (files.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No hay archivos MP3 generados todavía' }));
        return;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="audiolibro-completo.zip"');

      const archive = new ZipArchive({ zlib: { level: 6 } });
      archive.on('error', err => {
        console.error('[Zip Error]:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error creando archivo ZIP');
        } else {
          res.end();
        }
      });

      archive.pipe(res);
      for (const f of files) {
        archive.file(path.join(AUDIOLIBRO_DIR, f), { name: f });
      }
      archive.finalize();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // API Endpoint: Progreso de generación por lotes (lee progress.json de cada subcarpeta)
  if (req.url.split('?')[0] === '/api/progreso' && req.method === 'GET') {
    try {
      const jobs = fs.readdirSync(AUDIOLIBRO_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(AUDIOLIBRO_DIR, d.name, 'progress.json'))
        .filter(p => fs.existsSync(p))
        .map(p => JSON.parse(fs.readFileSync(p, 'utf-8')))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ now: Date.now(), jobs }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static file server
  let reqPath = req.url.split('?')[0];
  try { reqPath = decodeURIComponent(reqPath); } catch (e) {}
  let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';
  
  const filePath = path.join(__dirname, safePath);

  // Security check: ensure filePath is within __dirname
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Global error handlers to keep daemon server running resiliently
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  🚀 Servidor VozAI (Voces IA Neuronales) ejecutándose en:`);
  console.log(`  👉 http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});

