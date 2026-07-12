// Pipeline job engine: runs ingest -> analyze -> score -> plan -> render, emits SSE-able events.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { extractFrames, prepareImageForVision, prepareLogo } from './media.js';
import { analyzeVideo, analyzeImages, generatePlan, normalizePlan } from './analyze.js';
import { createProvider } from './providers.js';
import { renderPreset, PRESETS } from './render.js';

export const STEP_DEFS = [
  { id: 'ingest', label: 'Probe & sample footage', icon: '🎞️' },
  { id: 'analyze', label: 'Claude watches everything', icon: '👀' },
  { id: 'score', label: 'Score & pick best moments', icon: '🏆' },
  { id: 'plan', label: 'Generate editing plan', icon: '📝' },
  { id: 'render', label: 'FFmpeg renders your clips', icon: '⚙️' },
];

const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

function friendlyApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Invalid Claude API key — check it in Settings (console.anthropic.com → API keys).';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'This API key does not have access to the selected model.';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return 'Model not found for this API key — try a different model in Settings.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Claude rate limit hit — wait a minute and try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Claude API — check your internet connection.';
  }
  return err.message || String(err);
}

// Turn Claude's music recommendation into a card with ready-to-click searches
// on free / royalty-free libraries (no rights issues, nothing to pay for).
function buildMusicSuggestion(music) {
  const query = (music.searchTerms[0] || `${music.mood} ${music.genre}`).trim();
  const q = encodeURIComponent(query);
  return {
    mood: music.mood,
    genre: music.genre,
    bpm: music.bpm,
    energy: music.energy,
    why: music.why,
    searchTerms: music.searchTerms,
    links: [
      { label: 'YouTube Audio Library', url: `https://studio.youtube.com/channel/UC/music?q=${q}` },
      { label: 'Pixabay Music (free)', url: `https://pixabay.com/music/search/${q}/` },
      { label: 'Uppbeat (free)', url: `https://uppbeat.io/browse/search?q=${q}` },
      { label: 'Free Music Archive', url: `https://freemusicarchive.org/search?quicksearch=${q}` },
      { label: 'Chosic (free)', url: `https://www.chosic.com/free-music/all/?keyword=${q}` },
    ],
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createJob({ files, options, dirs }) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    createdAt: Date.now(),
    status: 'running',
    steps: STEP_DEFS.map((s) => ({ ...s, status: 'pending', detail: '', progress: 0 })),
    events: [],
    outputs: [],
    plan: null,
    music: null,
    analysisSummary: null,
    error: null,
    fileIds: files.map((f) => f.id),
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  // Fire and forget; errors are captured on the job.
  run(job, files, options, dirs).catch(() => {});
  return job;
}

function emit(job, event) {
  const payload = { ...event, ts: Date.now() };
  job.events.push(payload);
  if (job.events.length > 500) job.events.splice(0, job.events.length - 400);
  job.emitter.emit('event', payload);
}

function setStep(job, stepId, status, detail = '') {
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  if (detail) step.detail = detail;
  if (status === 'done') step.progress = 1;
  emit(job, { type: 'step', step: stepId, status, detail });
}

function setProgress(job, stepId, progress, detail = '') {
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.progress = progress;
  if (detail) step.detail = detail;
  emit(job, { type: 'progress', step: stepId, progress, detail });
}

function log(job, msg) {
  emit(job, { type: 'log', msg });
}

async function run(job, files, options, dirs) {
  const { workRoot, outputsDir } = dirs;
  const jobWork = path.join(workRoot, job.id);

  try {
    fs.mkdirSync(jobWork, { recursive: true });
    const pc = options.provider || { type: 'auto', apiKey: options.apiKey, model: options.model };
    const provider = await createProvider({
      type: pc.type,
      apiKey: pc.apiKey,
      baseUrl: pc.baseUrl,
      model: pc.model,
      cwd: dirs.appRoot,
    });
    log(job, `Using ${provider.label}.`);
    const brief = options.brief || '';
    const textFiles = files.filter((f) => f.kind === 'text' && f.text);
    const context = textFiles.map((f) => `# ${f.originalName}\n${f.text}`).join('\n\n').slice(0, 40000);
    if (brief) log(job, `📝 Brief: "${brief}"`);
    if (textFiles.length) log(job, `📄 Using ${textFiles.length} transcript/notes file(s) as context.`);
    const videos = files.filter((f) => f.kind === 'video');
    const images = files.filter((f) => f.kind === 'image');
    if (videos.length + images.length === 0) {
      throw new Error('Upload at least one video or image first.');
    }

    // ---- Step 1: ingest (frame sampling) -------------------------------
    setStep(job, 'ingest', 'active');
    const framesByVideo = new Map();
    await mapLimit(videos, 2, async (v) => {
      log(job, `Sampling frames from ${v.originalName} (${v.meta.duration.toFixed(1)}s)…`);
      const frames = await extractFrames(v.path, path.join(jobWork, `frames-${v.id}`), v.meta.duration);
      framesByVideo.set(v.id, frames);
    });
    const visionImagePaths = [];
    for (const img of images) {
      const p = path.join(jobWork, `vision-${img.id}.jpg`);
      await prepareImageForVision(img.path, p);
      visionImagePaths.push(p);
    }
    const totalFrames = [...framesByVideo.values()].reduce((s, f) => s + f.length, 0);
    setStep(job, 'ingest', 'done', `${videos.length} video(s) → ${totalFrames} frames, ${images.length} photo(s)`);

    // ---- Step 2: analyze with Claude -----------------------------------
    setStep(job, 'analyze', 'active', `Claude is watching (via ${provider.label})…`);
    let analyzed = 0;
    const videoAnalyses = await mapLimit(videos, provider.concurrency, async (v) => {
      const analysis = await analyzeVideo(provider, v, framesByVideo.get(v.id), { brief });
      analyzed++;
      setProgress(job, 'analyze', analyzed / Math.max(1, videos.length + (images.length ? 1 : 0)),
        `${v.originalName}: ${analysis.summary}`);
      log(job, `🎥 ${v.originalName} — ${analysis.summary}`);
      return { fileId: v.id, ...analysis };
    });
    let imageAnalyses = [];
    if (images.length > 0) {
      imageAnalyses = await analyzeImages(provider, images, visionImagePaths, { brief });
      log(job, `🖼️ Scored ${images.length} photo(s).`);
    }
    setStep(job, 'analyze', 'done', `${videos.length} video(s) & ${images.length} photo(s) analyzed`);

    // ---- Step 3: score & pick (derived view of the analysis) ----------
    setStep(job, 'score', 'active');
    const allMoments = [];
    for (const va of videoAnalyses) {
      for (const s of va.segments) {
        allMoments.push({ source: files.find((f) => f.id === va.fileId)?.originalName, ...s });
      }
    }
    for (const ia of imageAnalyses) {
      allMoments.push({
        source: files.find((f) => f.id === ia.fileId)?.originalName,
        start: 0, end: 0, score: ia.score, description: ia.description, tags: ia.tags,
      });
    }
    allMoments.sort((a, b) => b.score - a.score);
    job.analysisSummary = { topMoments: allMoments.slice(0, 8), totalMoments: allMoments.length };
    emit(job, { type: 'analysis', summary: job.analysisSummary });
    setStep(job, 'score', 'done',
      `${allMoments.length} moments scored — best: ${allMoments[0]?.score ?? '?'}/10 "${(allMoments[0]?.description || '').slice(0, 60)}"`);

    // ---- Step 4: editing plan ------------------------------------------
    setStep(job, 'plan', 'active', 'Claude is directing your edit…');
    const rawPlan = await generatePlan(provider, { videoAnalyses, imageAnalyses, files }, {
      targetDuration: options.targetDuration,
      vibe: options.vibe,
      eventTitle: options.eventTitle,
      brief,
      context,
    });
    const plan = normalizePlan(rawPlan, files, options.targetDuration);
    job.plan = plan;
    emit(job, { type: 'plan', plan });
    // Music recommendation (feature: "tell me which music to set").
    if (plan.music) {
      job.music = buildMusicSuggestion(plan.music);
      emit(job, { type: 'music', music: job.music });
      log(job, `🎵 Suggested music: ${plan.music.mood} ${plan.music.genre} (~${plan.music.bpm} BPM).`);
    }
    const effectsUsed = [...new Set(plan.timeline.map((t) => t.effect).filter((e) => e && e !== 'none'))];
    setStep(job, 'plan', 'done',
      `"${plan.title}" — ${plan.timeline.length} clips${effectsUsed.length ? `, effects: ${effectsUsed.join('/')}` : ''}. ${plan.rationale}`);

    // Ask the connected browser to rasterize overlay texts as transparent PNGs
    // (works on any ffmpeg build; drawtext is the headless fallback).
    const textAssets = await collectTextAssets(job, plan, jobWork);

    // ---- Step 5: render each preset ------------------------------------
    setStep(job, 'render', 'active');
    const presets = options.presets.map((p) => PRESETS[p]).filter(Boolean);
    if (presets.length === 0) presets.push(PRESETS.reel);
    const music = options.musicId ? files.find((f) => f.id === options.musicId) : null;

    // Prepare the logo once (normalize to PNG) if branding is requested.
    let logo = null;
    if (options.logo?.path && (options.logo.intro || options.logo.outro || options.logo.watermark)) {
      try {
        const logoPng = path.join(jobWork, 'logo.png');
        await prepareLogo(options.logo.path, logoPng);
        logo = { ...options.logo, path: logoPng };
        const on = [options.logo.intro && 'intro', options.logo.outro && 'outro', options.logo.watermark && `watermark(${options.logo.corner || 'tr'})`].filter(Boolean);
        log(job, `🏷️ Logo: ${on.join(', ')}.`);
      } catch (err) {
        log(job, `Logo could not be prepared (${err.message}) — skipping branding.`);
      }
    }

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const outName = `lazyclip-${job.id}-${preset.id}.mp4`;
      const outPath = path.join(outputsDir, outName);
      log(job, `Rendering ${preset.label} (${preset.width}x${preset.height})…`);
      const result = await renderPreset({
        plan, files, preset,
        workDir: path.join(jobWork, `render-${preset.id}`),
        outPath,
        musicPath: music?.path || null,
        keepOriginalAudio: Boolean(options.keepOriginalAudio),
        textAssets,
        logo,
        onProgress: (p, label) => {
          const overall = (i + p) / presets.length;
          setProgress(job, 'render', overall, `${preset.label}: ${label}`);
        },
      });
      const output = {
        preset: preset.id,
        label: preset.label,
        platforms: preset.platforms,
        url: `/media/outputs/${outName}`,
        duration: Number(result.duration.toFixed(1)),
      };
      job.outputs.push(output);
      emit(job, { type: 'output', output });
    }
    setStep(job, 'render', 'done', `${job.outputs.length} clip(s) ready`);

    job.status = 'done';
    emit(job, { type: 'done', outputs: job.outputs, plan });
  } catch (err) {
    const msg = friendlyApiError(err);
    job.status = 'error';
    job.error = msg;
    const active = job.steps.find((s) => s.status === 'active');
    if (active) setStep(job, active.id, 'error', msg);
    emit(job, { type: 'error', error: msg });
  } finally {
    // Keep frames/work for debugging of the latest few jobs; clean older ones.
    pruneOldJobs(dirs.workRoot);
  }
}

/**
 * Emit a 'need-text-render' event and wait for the browser to POST PNGs back
 * (server route calls job.resolveTextAssets). Resolves to {key: pngPath} or
 * null after a timeout (headless runs fall back to drawtext / no text).
 */
function collectTextAssets(job, plan, jobWork) {
  // Styles here must match the fallbacks in render.js computeOverlaySpecs.
  const requests = [];
  if (plan.title) {
    requests.push({ key: 'title', text: plan.title, kind: 'title', style: plan.titleStyle || 'gradient' });
  }
  if (plan.closingText) {
    requests.push({ key: 'outro', text: plan.closingText, kind: 'outro', style: plan.outroStyle || 'outline' });
  }
  plan.timeline.forEach((item, i) => {
    if (item.overlayText) {
      requests.push({ key: `cap${i}`, text: item.overlayText, kind: 'caption', style: item.textStyle || 'bar' });
    }
  });
  if (requests.length === 0) return Promise.resolve(null);

  const assetsDir = path.join(jobWork, 'text-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  job.textAssetRequests = requests;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      job.resolveTextAssets = null;
      log(job, 'No browser connected to render text overlays — using ffmpeg fallback.');
      resolve(null);
    }, 12000);

    job.resolveTextAssets = (assets) => {
      clearTimeout(timer);
      job.resolveTextAssets = null;
      // Never leave the promise pending: any malformed payload falls back to null.
      try {
        const map = {};
        const validKeys = new Set(requests.map((r) => r.key));
        for (const item of Array.isArray(assets) ? assets : []) {
          const { key, dataUrl } = item || {};
          if (!validKeys.has(key)) continue;
          const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
          if (!m) continue;
          const buf = Buffer.from(m[1], 'base64');
          if (buf.length > 4 * 1024 * 1024) continue;
          const p = path.join(assetsDir, `${key}.png`);
          fs.writeFileSync(p, buf);
          map[key] = p;
        }
        const count = Object.keys(map).length;
        if (count > 0) log(job, `Text overlays rendered in your browser (${count}).`);
        resolve(count > 0 ? map : null);
      } catch (err) {
        log(job, `Text-asset handling failed (${err.message}) — using ffmpeg fallback.`);
        resolve(null);
      }
    };
    emit(job, { type: 'need-text-render', requests });
  });
}

function pruneOldJobs(workRoot) {
  try {
    const entries = fs.readdirSync(workRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      // Never touch the work dir of a job that is still running.
      .filter((e) => jobs.get(e.name)?.status !== 'running')
      .map((e) => {
        const p = path.join(workRoot, e.name);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(5)) {
      fs.rmSync(entry.p, { recursive: true, force: true });
    }
  } catch { /* best-effort cleanup */ }
}

/** True when a registry file is captured by a still-running job. */
export function isFileInUse(fileId) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.fileIds?.includes(fileId)) return true;
  }
  return false;
}

export function jobPublicState(job) {
  return {
    id: job.id,
    status: job.status,
    steps: job.steps.map(({ emitter, ...s }) => s),
    outputs: job.outputs,
    plan: job.plan,
    music: job.music || null,
    analysisSummary: job.analysisSummary,
    error: job.error,
    // Lets a (re)connecting browser answer an in-flight text-render request.
    pendingTextRender: job.resolveTextAssets ? job.textAssetRequests : null,
  };
}
