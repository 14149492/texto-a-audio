const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = 3000;

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

// Split text into chunks respecting sentence boundaries
function splitText(text, maxLen = 150) {
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

// Fetch single chunk from Google TTS
function fetchChunk(chunk, lang) {
  return new Promise((resolve, reject) => {
    const url = `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=${encodeURIComponent(lang.split('-')[0])}&q=${encodeURIComponent(chunk)}`;
    
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Google TTS status: ${res.statusCode}`));
        return;
      }
      const data = [];
      res.on('data', (c) => data.push(c));
      res.on('end', () => resolve(Buffer.concat(data)));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('TTS request timeout'));
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // TTS Proxy endpoint
  if (req.url.startsWith('/api/tts')) {
    try {
      const urlObj = new URL(req.url, `http://localhost:${PORT}`);
      const text = urlObj.searchParams.get('text');
      const lang = urlObj.searchParams.get('lang') || 'es';

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text required' }));
        return;
      }

      const chunks = splitText(text, 150);
      const buffers = [];

      for (const chunk of chunks) {
        const buf = await fetchChunk(chunk, lang);
        buffers.push(buf);
      }

      const merged = Buffer.concat(buffers);

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': merged.length,
        'Content-Disposition': `attachment; filename="vozai-${Date.now()}.mp3"`,
        'Cache-Control': 'no-cache',
      });
      res.end(merged);

    } catch (err) {
      console.error('TTS Proxy error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static file server
  let safePath = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, '');
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
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  🚀 Servidor VozAI ejecutándose en:`);
  console.log(`  👉 http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
