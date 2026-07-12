// FFmpeg render engine: normalized segments -> xfade chain -> text overlays -> music.
//
// Text overlays: primary path composites transparent PNGs rasterized by the browser
// (works on any ffmpeg build); falls back to drawtext when available, else skips text.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export const PRESETS = {
  reel: { id: 'reel', label: 'Reel 9:16', width: 1080, height: 1920, platforms: 'Instagram Reels / Stories / TikTok' },
  square: { id: 'square', label: 'Square 1:1', width: 1080, height: 1080, platforms: 'Instagram Feed' },
  landscape: { id: 'landscape', label: 'Landscape 16:9', width: 1920, height: 1080, platforms: 'LinkedIn / YouTube / X' },
};

const FPS = 30;
const XFADE_DURATION = 0.5;

// '-loop 1' only exists on the image2 demuxer; other stills (gif/heic/…) must be
// converted to PNG before the Ken Burns segment render.
const IMAGE2_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

// Per-clip color "looks". Pure per-pixel filters — kind-agnostic, duration-safe.
export const EFFECTS = {
  none: '',
  vivid: 'eq=saturation=1.35:contrast=1.08',
  warm: 'colorbalance=rs=.06:gs=.02:bs=-.06,eq=saturation=1.08',
  cool: 'colorbalance=rs=-.05:bs=.07,eq=saturation=1.05',
  bw: 'hue=s=0,eq=contrast=1.12',
  dreamy: 'eq=brightness=0.04:saturation=1.12,vignette=PI/5',
  retro: 'curves=preset=vintage',
  punch: 'eq=saturation=1.4:contrast=1.12,vignette=PI/4.5',
};
export const EFFECT_KEYS = Object.keys(EFFECTS);

// Per-clip camera motion. Implemented with zoompan over a slightly larger buffer.
export const MOTIONS = ['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up'];

// Transitions between clips (ffmpeg xfade names).
export const XFADE_TRANSITIONS = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite', 'slideleft', 'slideright',
  'smoothleft', 'smoothright', 'circleopen', 'circleclose', 'wipeleft', 'wiperight', 'radial',
];

// Kinetic text.
export const TEXT_ANIMATIONS = ['fade', 'slide_up', 'slide_in_left', 'float'];
export const TEXT_STYLES = ['boxed', 'bar', 'outline', 'gradient'];

function sizeFilter(w, h) {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

// A motion chain fragment that outputs exactly width×height with the given move.
// Assumes the caller feeds it `dur * FPS` frames (video: after tpad; image: -loop).
function motionSuffix(motion, { width, height, dur }) {
  if (!motion || motion === 'none') return sizeFilter(width, height);
  const N = Math.max(1, Math.round(dur * FPS));
  const bufW = Math.round((width * 1.25) / 2) * 2;
  const bufH = Math.round((height * 1.25) / 2) * 2;
  const zp = (z, x, y) =>
    `${sizeFilter(bufW, bufH)},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${FPS}`;
  const cx = 'iw/2-(iw/zoom/2)';
  const cy = 'ih/2-(ih/zoom/2)';
  switch (motion) {
    case 'zoom_in': return zp(`min(1.0+0.14*on/${N},1.14)`, cx, cy);
    case 'zoom_out': return zp(`max(1.14-0.14*on/${N},1.001)`, cx, cy);
    case 'pan_left': return zp('1.12', `(iw-iw/zoom)*on/${N}`, cy);
    case 'pan_right': return zp('1.12', `(iw-iw/zoom)*(1-on/${N})`, cy);
    case 'pan_up': return zp('1.12', cx, `(ih-ih/zoom)*on/${N}`);
    default: return sizeFilter(width, height);
  }
}

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

export function findFont() {
  return FONT_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

let drawtextPromise = null;
export function hasDrawtext() {
  if (!drawtextPromise) {
    drawtextPromise = execFileP(FFMPEG, ['-hide_banner', '-filters'])
      .then(({ stdout }) => /\bdrawtext\b/.test(stdout) && Boolean(findFont()))
      .catch(() => false);
  }
  return drawtextPromise;
}

function runFfmpeg(args, { onProgress, expectedDuration } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-y', '-hide_banner', ...args]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
      if (onProgress && expectedDuration > 0) {
        const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          onProgress(Math.min(0.99, sec / expectedDuration));
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.split('\n').slice(-25).join('\n')}`));
    });
  });
}

async function probeDuration(filePath) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

/** Render one normalized segment (same codec/size/fps/audio for clean xfade). */
async function renderSegment({ item, srcPath, outPath, width, height, index }) {
  const dur = item.duration;
  const args = [];
  const filters = [];

  const effect = EFFECTS[item.effect] ? item.effect : 'none';
  const effectChain = EFFECTS[effect] ? EFFECTS[effect] : '';
  // Default motion: images get a Ken Burns zoom (alternating), video stays still
  // unless the plan asks for a move.
  const motion = MOTIONS.includes(item.motion) && item.motion !== 'none'
    ? item.motion
    : (item.kind === 'image' ? (index % 2 === 0 ? 'zoom_in' : 'zoom_out') : 'none');

  if (item.kind === 'video') {
    args.push('-ss', String(item.start), '-t', String(dur), '-i', srcPath);
    // tpad clones the last frame in case the video stream ends before the container
    // duration — keeps every segment exactly `dur` long so xfade offsets stay true.
    let vchain =
      `[0:v]${sizeFilter(width, height)},fps=${FPS},setsar=1,` +
      `tpad=stop_mode=clone:stop_duration=${dur}`;
    if (motion !== 'none') vchain += `,${motionSuffix(motion, { width, height, dur })}`;
    if (effectChain) vchain += `,${effectChain}`;
    vchain += `,setsar=1,format=yuv420p[v]`;
    filters.push(vchain);
    if (item.hasAudio) {
      filters.push(
        `[0:a]aresample=async=1:first_pts=0,` +
        `aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${dur}[a]`
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo:d=${dur}[a]`);
    }
  } else {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', srcPath);
    let vchain = `[0:v]${motionSuffix(motion, { width, height, dur })}`;
    if (effectChain) vchain += `,${effectChain}`;
    vchain += `,setsar=1,format=yuv420p[v]`;
    filters.push(vchain);
    filters.push(`anullsrc=r=48000:cl=stereo:d=${dur}[a]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', String(dur),
    outPath
  );
  await runFfmpeg(args, { expectedDuration: dur });
}

function escapeDrawtextPath(p) {
  // The value is wrapped in single quotes (verbatim in ffmpeg's tokenizer), so
  // only embedded quotes need handling: close quote, escaped quote, reopen.
  return p.replace(/'/g, `'\\''`);
}

function drawtextFilter({ textFile, fontFile, fontSize, yFrac, tStart, tEnd, boxAlpha = 0.35 }) {
  const fade = 0.4;
  const alpha = `clip((t-${tStart})/${fade}\\,0\\,1)*clip((${tEnd}-t)/${fade}\\,0\\,1)`;
  return (
    `drawtext=textfile='${escapeDrawtextPath(textFile)}'` +
    `:fontfile='${escapeDrawtextPath(fontFile)}'` +
    `:fontsize=${fontSize}:fontcolor=white` +
    `:x=(w-text_w)/2:y=h*${yFrac}-text_h/2` +
    `:box=1:boxcolor=black@${boxAlpha}:boxborderw=18` +
    `:alpha='${alpha}'` +
    `:enable='between(t,${tStart},${tEnd})'`
  );
}

/**
 * Compute the text overlays (what to show, when, where) for a plan whose
 * segments have the given real durations. Used both to render and to tell
 * the browser what PNGs to rasterize.
 */
export function computeOverlaySpecs(plan, segDurations, totalDuration) {
  const specs = [];
  const anim = (a, fallback) => (TEXT_ANIMATIONS.includes(a) ? a : fallback);
  const style = (s, fallback) => (TEXT_STYLES.includes(s) ? s : fallback);
  if (plan.title) {
    specs.push({
      key: 'title', text: plan.title, kind: 'title',
      tStart: 0.4, tEnd: Math.min(3.4, Math.max(1.2, totalDuration - 0.5)),
      yFrac: 0.42, widthFrac: 0.88, fontFrac: 1 / 14,
      animation: anim(plan.titleAnimation, 'slide_up'),
      style: style(plan.titleStyle, 'gradient'),
    });
  }
  if (plan.closingText && totalDuration > 6) {
    specs.push({
      key: 'outro', text: plan.closingText, kind: 'outro',
      tStart: Math.max(0, totalDuration - 3.2), tEnd: totalDuration - 0.1,
      yFrac: 0.76, widthFrac: 0.8, fontFrac: 1 / 20,
      animation: anim(plan.outroAnimation, 'fade'),
      style: style(plan.outroStyle, 'outline'),
    });
  }
  let clock = 0;
  const n = segDurations.length;
  for (let i = 0; i < n; i++) {
    const item = plan.timeline[i];
    if (item?.overlayText) {
      const tStart = Math.max(0.2, clock + 0.3);
      const tEnd = Math.min(totalDuration - 0.1, clock + segDurations[i] - 0.3);
      if (tEnd - tStart > 0.8) {
        specs.push({
          key: `cap${i}`, text: item.overlayText, kind: 'caption',
          tStart: Number(tStart.toFixed(2)), tEnd: Number(tEnd.toFixed(2)),
          yFrac: 0.84, widthFrac: 0.82, fontFrac: 1 / 24,
          animation: anim(item.textAnimation, 'slide_in_left'),
          style: style(item.textStyle, 'bar'),
        });
      }
    }
    clock += segDurations[i] - (i < n - 1 ? XFADE_DURATION : 0);
  }
  return specs;
}

// overlay x/y expressions for a kinetic text spec. baseY centers the box on
// H*yFrac; the entrance eases over the first 0.45s.
function overlayPosition(spec) {
  const baseX = '(W-w)/2';
  const baseY = `H*${spec.yFrac}-h/2`;
  const inRamp = `clip((t-${spec.tStart})/0.45,0,1)`;
  switch (spec.animation) {
    case 'slide_up':
      return { x: baseX, y: `${baseY}+70*(1-${inRamp})` };
    case 'slide_in_left':
      return { x: `${baseX}-160*(1-${inRamp})`, y: baseY };
    case 'float':
      return { x: baseX, y: `${baseY}+9*sin(2*PI*(t-${spec.tStart})/2.2)` };
    case 'fade':
    default:
      return { x: baseX, y: baseY };
  }
}

export const LOGO_CORNERS = ['tl', 'tr', 'bl', 'br'];

// Where/when to composite the logo. Intro (top-center, first ~2.5s), outro
// (center, last ~2.5s), and/or a persistent corner watermark.
function computeLogoSpecs(logo, { width, height, totalDuration }) {
  if (!logo || !logo.path) return [];
  const M = Math.round(width * 0.035);
  const specs = [];
  if (logo.intro) {
    specs.push({
      key: 'logo-intro', w: Math.round(width * 0.30),
      x: '(W-w)/2', y: 'H*0.22-h/2',
      tStart: 0.3, tEnd: Math.min(2.6, Math.max(1.4, totalDuration * 0.5)),
      alpha: 1, fadeIn: 0.4, fadeOut: 0.4,
    });
  }
  if (logo.outro && totalDuration > 4) {
    specs.push({
      key: 'logo-outro', w: Math.round(width * 0.34),
      x: '(W-w)/2', y: 'H*0.40-h/2',
      tStart: Math.max(0, totalDuration - 2.6), tEnd: totalDuration - 0.15,
      alpha: 1, fadeIn: 0.4, fadeOut: 0.4,
    });
  }
  if (logo.watermark) {
    const corner = LOGO_CORNERS.includes(logo.corner) ? logo.corner : 'tr';
    const pos = {
      tl: { x: `${M}`, y: `${M}` },
      tr: { x: `W-w-${M}`, y: `${M}` },
      bl: { x: `${M}`, y: `H-h-${M}` },
      br: { x: `W-w-${M}`, y: `H-h-${M}` },
    }[corner];
    specs.push({
      key: 'logo-wm', w: Math.round(width * 0.14),
      x: pos.x, y: pos.y,
      tStart: 0, tEnd: totalDuration,
      alpha: 0.72, fadeIn: 0.5, fadeOut: 0,
    });
  }
  return specs;
}

/**
 * Render the final video for one preset.
 *
 * textAssets: optional { [specKey]: pngPath } — transparent PNGs rasterized by
 * the browser. When absent, falls back to drawtext (if this ffmpeg has it).
 * logo: optional { path, intro, outro, watermark, corner } — a prepared PNG
 * composited as intro/outro cards and/or a corner watermark.
 */
export async function renderPreset({
  plan, files, preset, workDir, outPath,
  musicPath = null, keepOriginalAudio = false, textAssets = null, logo = null,
  onProgress = () => {},
}) {
  const { width, height } = preset;
  fs.mkdirSync(workDir, { recursive: true });
  const byId = new Map(files.map((f) => [f.id, f]));

  // 1) Normalized segments (60% of the progress budget).
  const segPaths = [];
  for (let i = 0; i < plan.timeline.length; i++) {
    const item = plan.timeline[i];
    const src = byId.get(item.sourceId);
    if (!src) throw new Error(`Plan references unknown source ${item.sourceId}`);
    let srcPath = src.path;
    if (item.kind !== 'video' && !IMAGE2_EXT.has(path.extname(srcPath).toLowerCase())) {
      const png = path.join(workDir, `still-${String(i).padStart(2, '0')}.png`);
      await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', src.path, '-frames:v', '1', '-update', '1', png]);
      srcPath = png;
    }
    const segPath = path.join(workDir, `seg-${String(i).padStart(2, '0')}.mp4`);
    await renderSegment({
      item: { ...item, hasAudio: src.meta.hasAudio },
      srcPath,
      outPath: segPath,
      width, height, index: i,
    });
    segPaths.push(segPath);
    onProgress(((i + 1) / plan.timeline.length) * 0.6, `clip ${i + 1}/${plan.timeline.length}`);
  }

  // Actual durations (encoders shift by a frame or two — xfade offsets must be exact).
  const segDurations = [];
  for (const p of segPaths) segDurations.push(await probeDuration(p));

  const n = segPaths.length;
  const totalDuration = segDurations.reduce((s, d) => s + d, 0) - Math.max(0, n - 1) * XFADE_DURATION;

  // 2) Concat command: segments (+ text PNGs, + music) in one pass.
  const args = [];
  for (const p of segPaths) args.push('-i', p);

  const specs = computeOverlaySpecs(plan, segDurations, totalDuration);
  const overlayInputs = []; // { spec, inputIndex }
  let nextInput = n;
  if (textAssets) {
    for (const spec of specs) {
      const png = textAssets[spec.key];
      if (png && fs.existsSync(png)) {
        // Finite (-t) so the looped image input can't deadlock the overlay graph;
        // full fps keeps the 0.4s fades smooth.
        args.push('-loop', '1', '-t', totalDuration.toFixed(3), '-framerate', String(FPS), '-i', png);
        overlayInputs.push({ spec, inputIndex: nextInput++ });
      }
    }
  }
  // Logo overlays (intro / outro / watermark) — same finite-input pattern as text.
  const logoSpecs = computeLogoSpecs(logo, { width, height, totalDuration });
  const logoInputs = [];
  for (const ls of logoSpecs) {
    args.push('-loop', '1', '-t', totalDuration.toFixed(3), '-framerate', String(FPS), '-i', logo.path);
    logoInputs.push({ ...ls, inputIndex: nextInput++ });
  }

  let musicInputIndex = -1;
  if (musicPath) {
    musicInputIndex = nextInput++;
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  // When music fully replaces the original sound, don't build the segment-audio
  // chain at all — a dangling acrossfade output makes ffmpeg abort.
  const useSegmentAudio = !musicPath || keepOriginalAudio;

  const filters = [];
  for (let i = 0; i < n; i++) {
    filters.push(`[${i}:v]fps=${FPS},settb=AVTB[v${i}]`);
    if (useSegmentAudio) {
      filters.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
    }
  }

  let vOut = '[v0]';
  let aOut = useSegmentAudio ? '[a0]' : null;
  if (n > 1) {
    let offset = 0;
    for (let i = 1; i < n; i++) {
      offset += segDurations[i - 1] - XFADE_DURATION;
      // Per-clip transition (the one on the incoming clip), falling back to the
      // plan-level default. Enforced-varied upstream in normalizePlan.
      const trans = XFADE_TRANSITIONS.includes(plan.timeline[i]?.transition)
        ? plan.timeline[i].transition
        : (XFADE_TRANSITIONS.includes(plan.transition) ? plan.transition : 'fade');
      const vNext = `[vx${i}]`;
      filters.push(
        `${vOut}[v${i}]xfade=transition=${trans}:duration=${XFADE_DURATION}:offset=${offset.toFixed(3)}${vNext}`
      );
      vOut = vNext;
      if (useSegmentAudio) {
        const aNext = `[ax${i}]`;
        filters.push(`${aOut}[a${i}]acrossfade=d=${XFADE_DURATION}:c1=tri:c2=tri${aNext}`);
        aOut = aNext;
      }
    }
  }

  // 3) Text overlays — kinetic (position/alpha) animation of browser PNGs.
  if (overlayInputs.length > 0) {
    for (let k = 0; k < overlayInputs.length; k++) {
      const { spec, inputIndex } = overlayInputs[k];
      const targetW = Math.round(width * spec.widthFrac);
      const fadeOutStart = Math.max(spec.tStart, spec.tEnd - 0.4);
      // Normalize the overlay input to the main chain's fps + timebase, else the
      // looped image and settb=AVTB main stall the overlay filter.
      filters.push(
        `[${inputIndex}:v]scale=${targetW}:-1,format=rgba,fps=${FPS},settb=AVTB,` +
        `fade=t=in:st=${spec.tStart}:d=0.4:alpha=1,` +
        `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.4:alpha=1[txt${k}]`
      );
      const { x, y } = overlayPosition(spec);
      const oNext = `[vo${k}]`;
      // Expressions are single-quoted, so commas inside clip()/sin() are literal.
      filters.push(
        `${vOut}[txt${k}]overlay=x='${x}':y='${y}':eof_action=pass` +
        `:enable='between(t,${spec.tStart},${spec.tEnd})'${oNext}`
      );
      vOut = oNext;
    }
  } else if (specs.length > 0 && (await hasDrawtext())) {
    const fontFile = findFont();
    const textFilters = specs.map((spec, k) => {
      const textFile = path.join(workDir, `text-${spec.key}.txt`);
      fs.writeFileSync(textFile, spec.text);
      return drawtextFilter({
        textFile, fontFile,
        fontSize: Math.round(height * spec.fontFrac),
        yFrac: spec.yFrac,
        tStart: spec.tStart, tEnd: spec.tEnd,
        boxAlpha: spec.kind === 'caption' ? 0.3 : 0.35,
      });
    });
    filters.push(`${vOut}${textFilters.join(',')}[vtext]`);
    vOut = '[vtext]';
  }

  // 3b) Logo overlays (composited on top of the text).
  for (let k = 0; k < logoInputs.length; k++) {
    const lo = logoInputs[k];
    let chain = `[${lo.inputIndex}:v]scale=${lo.w}:-1,format=rgba,fps=${FPS},settb=AVTB`;
    if (lo.alpha < 1) chain += `,colorchannelmixer=aa=${lo.alpha}`;
    chain += `,fade=t=in:st=${lo.tStart.toFixed(3)}:d=${lo.fadeIn}:alpha=1`;
    if (lo.fadeOut > 0) {
      const foStart = Math.max(lo.tStart, lo.tEnd - lo.fadeOut);
      chain += `,fade=t=out:st=${foStart.toFixed(3)}:d=${lo.fadeOut}:alpha=1`;
    }
    chain += `[lg${k}]`;
    filters.push(chain);
    const oNext = `[vlg${k}]`;
    filters.push(
      `${vOut}[lg${k}]overlay=x='${lo.x}':y='${lo.y}':eof_action=pass` +
      `:enable='between(t,${lo.tStart.toFixed(3)},${lo.tEnd.toFixed(3)})'${oNext}`
    );
    vOut = oNext;
  }

  // 4) Music bed.
  if (musicInputIndex >= 0) {
    const fadeOutStart = Math.max(0, totalDuration - 1.8);
    filters.push(
      `[${musicInputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=0:${totalDuration.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.8[music]`
    );
    if (useSegmentAudio) {
      filters.push(`${aOut}[music]amix=inputs=2:duration=first:weights=0.5 1:normalize=0[afinal]`);
    } else {
      filters.push(`[music]anull[afinal]`);
    }
    aOut = '[afinal]';
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', vOut, '-map', aOut,
    '-t', totalDuration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath
  );

  await runFfmpeg(args, {
    expectedDuration: totalDuration,
    onProgress: (p) => onProgress(0.6 + p * 0.4, 'final encode'),
  });
  onProgress(1, 'done');
  return { outPath, duration: totalDuration };
}
