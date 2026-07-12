// Media toolkit: ffprobe metadata, thumbnails, frame sampling for Claude vision.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export async function checkFfmpeg() {
  try {
    await execFileP(FFMPEG, ['-version']);
    await execFileP(FFPROBE, ['-version']);
    return true;
  } catch {
    return false;
  }
}

export async function probe(filePath) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    filePath,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
  const duration = parseFloat(data.format?.duration ?? video?.duration ?? 0) || 0;
  return {
    duration,
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    codec: video?.codec_name ?? audio?.codec_name ?? null,
    size: Number(data.format?.size ?? 0),
  };
}

// Kind detection by extension (mimetypes from browsers are unreliable for video).
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.mts', '.m2ts', '.3gp', '.mpg', '.mpeg', '.wmv', '.flv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tif', '.tiff']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus']);
const TEXT_EXT = new Set(['.txt', '.md', '.srt', '.vtt', '.text', '.log']);

export function detectKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

// Read a transcript/notes file into clean plain text (strips SRT/VTT timecodes
// and cue numbers). Caps length so a huge transcript can't blow the context.
export function readTextFile(filePath, maxChars = 24000) {
  let raw = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.srt' || ext === '.vtt') {
    raw = raw
      .replace(/^WEBVTT.*$/gim, '')
      .replace(/^\d+\s*$/gm, '') // cue index lines
      .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/gm, '') // timecode lines
      .replace(/<[^>]+>/g, ''); // inline tags
  }
  raw = raw.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…(truncated)` : raw;
}

// Thumbnail for the UI file grid.
export async function makeThumbnail(srcPath, kind, outPath, atSecond = 1) {
  const args = ['-y', '-v', 'error'];
  if (kind === 'video') args.push('-ss', String(atSecond));
  args.push('-i', srcPath);
  // Always single-frame: multi-packet stills (e.g. gifs) otherwise make the
  // image2 muxer fail with "Cannot write more than one file with the same name".
  args.push('-frames:v', '1', '-update', '1');
  args.push('-vf', 'scale=320:-2', '-q:v', '6', outPath);
  await execFileP(FFMPEG, args);
  return outPath;
}

/**
 * Extract evenly spaced frames from a video, downscaled for cheap vision tokens.
 * Returns [{ time, path }].
 */
export async function extractFrames(videoPath, outDir, duration, maxFrames = 14) {
  fs.mkdirSync(outDir, { recursive: true });
  const usable = Math.max(duration - 0.2, 0.2);
  const count = Math.max(2, Math.min(maxFrames, Math.ceil(usable / 2.5)));
  const frames = [];
  for (let i = 0; i < count; i++) {
    // Sample at the middle of each equal slice so frames represent their window.
    const t = Math.min(usable * ((i + 0.5) / count), Math.max(usable - 0.1, 0));
    frames.push({ time: Number(t.toFixed(2)), path: path.join(outDir, `f${String(i).padStart(3, '0')}.jpg`) });
  }
  // Lazy worker pool (max 4 concurrent ffmpeg processes). A frame that fails to
  // extract (e.g. -ss past the real stream end) is skipped, not fatal.
  let next = 0;
  async function worker() {
    while (next < frames.length) {
      const f = frames[next++];
      try {
        await execFileP(FFMPEG, [
          '-y', '-v', 'error',
          '-ss', String(f.time.toFixed(3)),
          '-i', videoPath,
          '-frames:v', '1',
          '-vf', 'scale=512:-2',
          '-q:v', '7',
          f.path,
        ]);
      } catch { /* skip this frame */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, frames.length) }, worker));
  const ok = frames.filter((f) => fs.existsSync(f.path));
  if (ok.length === 0) throw new Error(`Could not extract any frames from ${path.basename(videoPath)}`);
  return ok;
}

// Downscaled copy of an image for vision analysis.
export async function prepareImageForVision(srcPath, outPath) {
  await execFileP(FFMPEG, [
    '-y', '-v', 'error',
    '-i', srcPath,
    '-vf', 'scale=768:-2',
    '-q:v', '7',
    '-frames:v', '1',
    outPath,
  ]);
  return outPath;
}

export function toBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

// Normalize a logo to a PNG (preserves transparency), capped in size for cheap
// compositing. Handles any input format (png/jpg/webp/heic/svg-as-raster).
export async function prepareLogo(srcPath, outPath, maxW = 512) {
  await execFileP(FFMPEG, [
    '-y', '-v', 'error',
    '-i', srcPath,
    '-vf', `scale='min(${maxW},iw)':-1`,
    '-frames:v', '1', '-update', '1',
    outPath,
  ]);
  return outPath;
}
