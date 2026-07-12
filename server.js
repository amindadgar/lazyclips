// LazyClips server — uploads, pipeline jobs, SSE progress, static frontend.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { probe, detectKind, makeThumbnail, checkFfmpeg, readTextFile } from './lib/media.js';
import {
  MODELS, DEFAULT_MODEL, createProvider, detectCli,
  OPENAI_DEFAULT_BASE, OPENAI_DEFAULT_MODEL,
} from './lib/providers.js';
import { PRESETS } from './lib/render.js';
import { createJob, getJob, jobPublicState, isFileInUse } from './lib/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'outputs');
const THUMBS = path.join(DATA, 'thumbs');
const WORK = path.join(DATA, 'work');
const REGISTRY_PATH = path.join(DATA, 'files.json');
for (const dir of [DATA, UPLOADS, OUTPUTS, THUMBS, WORK]) fs.mkdirSync(dir, { recursive: true });

// ---- File registry (persisted across restarts) -------------------------
let registry = [];
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
    .filter((f) => fs.existsSync(f.path))
    // Re-hydrate transcript text from disk (it isn't stored in files.json).
    .map((f) => (f.kind === 'text' ? { ...f, text: safeReadText(f.path) } : f));
} catch { registry = []; }

function safeReadText(p) {
  try { return readTextFile(p); } catch { return ''; }
}

function saveRegistry() {
  // Atomic write (temp + rename) so a crash mid-write can't corrupt the registry;
  // transcript text is dropped from disk and re-read from the source file on load.
  const lean = registry.map((f) => { const { text, ...rest } = f; return rest; });
  const tmp = `${REGISTRY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lean, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

function publicFile(f) {
  return {
    id: f.id,
    originalName: f.originalName,
    kind: f.kind,
    meta: f.meta,
    thumb: f.thumb ? `/media/thumbs/${path.basename(f.thumb)}` : null,
  };
}

// ---- Uploads ------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      const id = crypto.randomBytes(5).toString('hex');
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-80);
      cb(null, `${id}-${safe}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 30 },
});

const app = express();
// Generous limit: /api/jobs/:id/text-assets receives base64 PNGs from the browser.
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media/outputs', express.static(OUTPUTS));
app.use('/media/thumbs', express.static(THUMBS));

app.get('/api/config', async (req, res) => {
  const cli = await detectCli();
  res.json({
    models: MODELS,
    defaultModel: DEFAULT_MODEL,
    openaiDefaults: { base: OPENAI_DEFAULT_BASE, model: OPENAI_DEFAULT_MODEL },
    presets: Object.values(PRESETS).map(({ id, label, platforms }) => ({ id, label, platforms })),
    ffmpeg: await checkFfmpeg(),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    claudeApp: cli,
  });
});

// Normalize the provider config coming from the client into createProvider args.
function readProvider(body = {}) {
  const p = body.provider || {};
  const type = ['auto', 'anthropic', 'claude-app', 'openai'].includes(p.type) ? p.type : 'auto';
  return {
    type,
    apiKey: (p.apiKey || body.apiKey || '').trim() || undefined,
    baseUrl: (p.baseUrl || '').trim() || undefined,
    model: p.model !== undefined ? p.model : body.model,
  };
}

app.get('/api/files', (req, res) => {
  res.json({ files: registry.map(publicFile) });
});

app.post('/api/upload', upload.array('files', 30), async (req, res) => {
  const added = [];
  const rejected = [];
  for (const file of req.files || []) {
    const kind = detectKind(file.originalname);
    if (!kind) {
      rejected.push({ name: file.originalname, reason: 'unsupported file type' });
      fs.rmSync(file.path, { force: true });
      continue;
    }
    try {
      const id = path.basename(file.filename).split('-')[0];

      if (kind === 'text') {
        // Transcript / notes — no probe or thumbnail, just capture the content.
        const content = readTextFile(file.path);
        if (!content) throw new Error('text file is empty');
        const entry = {
          id, originalName: file.originalname, kind, path: file.path, thumb: null,
          text: content,
          meta: { duration: 0, width: null, height: null, hasAudio: false, size: content.length, chars: content.length },
          addedAt: Date.now(),
        };
        registry.push(entry);
        added.push(publicFile(entry));
        continue;
      }

      const meta = await probe(file.path);
      if (kind === 'video' && (!meta.hasVideo || meta.duration < 1)) {
        throw new Error('video has no usable video stream (or is under 1s)');
      }
      let thumb = null;
      if (kind !== 'audio') {
        thumb = path.join(THUMBS, `${id}.jpg`);
        await makeThumbnail(file.path, kind, thumb, Math.min(1, meta.duration / 2));
      }
      const entry = {
        id,
        originalName: file.originalname,
        kind,
        path: file.path,
        thumb,
        meta: {
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.hasAudio,
          size: meta.size,
        },
        addedAt: Date.now(),
      };
      registry.push(entry);
      added.push(publicFile(entry));
    } catch (err) {
      rejected.push({ name: file.originalname, reason: err.message });
      fs.rmSync(file.path, { force: true });
    }
  }
  saveRegistry();
  res.json({ added, rejected });
});

app.delete('/api/files/:id', (req, res) => {
  const idx = registry.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (isFileInUse(req.params.id)) {
    return res.status(409).json({ error: 'This file is being used by a running job — wait for it to finish.' });
  }
  const [f] = registry.splice(idx, 1);
  fs.rmSync(f.path, { force: true });
  if (f.thumb) fs.rmSync(f.thumb, { force: true });
  saveRegistry();
  res.json({ ok: true });
});

// Validates whichever backend would actually be used.
app.post('/api/test-connection', async (req, res) => {
  try {
    const provider = await createProvider({ ...readProvider(req.body), cwd: __dirname });
    const detail = await provider.test();
    res.json({ ok: true, mode: provider.name, detail });
  } catch (err) {
    let reason = err?.message || 'unknown error';
    if (err instanceof Anthropic.AuthenticationError) reason = 'Invalid API key.';
    else if (err instanceof Anthropic.NotFoundError) reason = 'Key is valid but this model is not available to it.';
    else if (err instanceof Anthropic.APIConnectionError) reason = 'Could not reach the Claude API.';
    res.json({ ok: false, reason });
  }
});

// ---- Pipeline -----------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const {
    targetDuration = 30,
    vibe = 'Energetic',
    eventTitle = '',
    presets = ['reel', 'landscape'],
    musicId = null,
    keepOriginalAudio = false,
    fileIds = null,
    brief = '',
  } = req.body || {};
  const provider = readProvider(req.body);

  if (!(await checkFfmpeg())) {
    return res.status(500).json({ error: 'ffmpeg/ffprobe not found. Install with: brew install ffmpeg' });
  }
  // Validate we have a usable backend before starting a job.
  try {
    await createProvider({ ...provider, cwd: __dirname });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const selected = Array.isArray(fileIds) && fileIds.length > 0
    ? registry.filter((f) => fileIds.includes(f.id))
    : registry;
  const media = selected.filter((f) => f.kind === 'video' || f.kind === 'image');
  if (media.length === 0) {
    return res.status(400).json({ error: 'Upload at least one video or photo first.' });
  }

  // For the Claude providers keep the model to the known Claude ids; OpenAI takes any string.
  const model = provider.type === 'openai'
    ? provider.model
    : (MODELS.some((m) => m.id === provider.model) ? provider.model : '');

  const job = createJob({
    files: selected,
    options: {
      provider: { type: provider.type, apiKey: provider.apiKey, baseUrl: provider.baseUrl, model },
      targetDuration: Math.max(10, Math.min(90, Number(targetDuration) || 30)),
      vibe: String(vibe).slice(0, 40),
      eventTitle: String(eventTitle).slice(0, 80),
      presets: (Array.isArray(presets) ? presets : []).filter((p) => PRESETS[p]),
      musicId,
      keepOriginalAudio,
      brief: String(brief).slice(0, 600),
    },
    dirs: { workRoot: WORK, outputsDir: OUTPUTS, appRoot: __dirname },
  });
  res.json({ jobId: job.id });
});

// Browser posts rasterized text-overlay PNGs (canvas) for the running job.
app.post('/api/jobs/:id/text-assets', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!job.resolveTextAssets) return res.json({ ok: false, reason: 'not waiting for text assets' });
  job.resolveTextAssets(req.body?.assets || []);
  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(jobPublicState(job));
});

// SSE stream: replay history, then live events.
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'state', state: jobPublicState(job) })}\n\n`);

  const onEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  job.emitter.on('event', onEvent);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.off('event', onEvent);
  });
});

// Global error handler: return JSON (not an HTML stack trace with absolute
// paths) for Multer upload-limit errors and anything else that reaches here.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'File too large (max 2 GB per file).'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'Too many files at once (max 30).'
        : `Upload error: ${err.message}`;
    return res.status(413).json({ error: msg });
  }
  console.error('Unhandled server error:', err?.message || err);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4173;
// Bind on all interfaces so the app is reachable when run in a container.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 LazyClips running at http://localhost:${PORT}`);
});
