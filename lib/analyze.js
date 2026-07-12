// Claude-powered analysis: watch footage frames, score moments, produce an editing plan.
// Transport-agnostic — works through any provider from providers.js (Claude app or API).
export { MODELS, DEFAULT_MODEL } from './providers.js';
import {
  XFADE_TRANSITIONS, EFFECT_KEYS, MOTIONS, TEXT_ANIMATIONS, TEXT_STYLES,
} from './render.js';

export { XFADE_TRANSITIONS };

function briefLine(brief) {
  return brief ? `\nThe user's creative brief (steer everything toward this): "${brief}".\n` : '';
}

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-sentence summary of what this video shows' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'Segment start in seconds' },
          end: { type: 'number', description: 'Segment end in seconds' },
          score: { type: 'integer', description: 'Commercial appeal 1-10' },
          description: { type: 'string', description: 'What happens in this segment' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['start', 'end', 'score', 'description', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'segments'],
  additionalProperties: false,
};

/**
 * Analyze one video from sampled frames. Returns { summary, segments[] }.
 */
export async function analyzeVideo(provider, file, frames, opts = {}) {
  const prompt =
    `These are frames sampled from an event video ("${file.originalName}", total duration ${file.meta.duration.toFixed(1)}s). ` +
    `Each frame is labeled with its timestamp. Identify the distinct moments/segments in this video and rate each one's ` +
    `potential for a polished social-media commercial (energy, faces, action, composition, lighting). ` +
    `Segments must not overlap, must be within [0, ${file.meta.duration.toFixed(1)}], and should each cover a coherent moment ` +
    `(typically 2-8 seconds). Score 1-10 where 10 = must-use hero shot.` +
    briefLine(opts.brief) +
    (opts.brief ? `Rate moments higher when they serve the brief.` : '');

  const images = frames.map((f) => ({ label: `Frame at ${f.time}s`, path: f.path }));
  const parsed = await provider.runVision({ prompt, images, schema: SEGMENT_SCHEMA, maxTokens: 8000 });

  // Clamp to real duration and drop degenerate segments.
  const dur = file.meta.duration;
  parsed.segments = (parsed.segments || [])
    .map((s) => ({
      ...s,
      start: Math.max(0, Math.min(Number(s.start) || 0, dur)),
      end: Math.max(0, Math.min(Number(s.end) || 0, dur)),
      score: Math.max(1, Math.min(10, Math.round(Number(s.score) || 5))),
    }))
    .filter((s) => s.end - s.start >= 0.8)
    .sort((a, b) => a.start - b.start);
  return parsed;
}

const IMAGES_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '0-based index of the image in the order given' },
          score: { type: 'integer', description: 'Commercial appeal 1-10' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'score', 'description', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['images'],
  additionalProperties: false,
};

/**
 * Analyze a batch of still photos. Returns per-file { score, description, tags }.
 */
export async function analyzeImages(provider, imageFiles, visionPaths, opts = {}) {
  const results = imageFiles.map((f, i) => ({
    fileId: f.id,
    score: 5,
    description: f.originalName,
    tags: [],
    index: i,
  }));

  // Batch so a big photo dump can't blow the per-request image cap or the
  // output token budget (which grows with batch size).
  const BATCH = 20;
  for (let offset = 0; offset < imageFiles.length; offset += BATCH) {
    const batchFiles = imageFiles.slice(offset, offset + BATCH);
    const prompt =
      `These are ${batchFiles.length} photos from an event. For each, rate its potential as a shot in a polished ` +
      `social-media commercial (composition, faces, emotion, lighting). Score 1-10. Reply for every image by its 0-based index.` +
      briefLine(opts.brief);
    const images = batchFiles.map((f, i) => ({ label: `Image ${i} ("${f.originalName}")`, path: visionPaths[offset + i] }));

    const parsed = await provider.runVision({
      prompt, images, schema: IMAGES_SCHEMA,
      maxTokens: Math.min(16000, 1500 + 350 * batchFiles.length),
    });
    for (const item of parsed.images || []) {
      const idx = offset + Number(item.index);
      if (Number(item.index) >= 0 && Number(item.index) < batchFiles.length && results[idx]) {
        results[idx].score = Math.max(1, Math.min(10, Math.round(Number(item.score) || 5)));
        results[idx].description = item.description || results[idx].description;
        results[idx].tags = item.tags || [];
      }
    }
  }
  return results;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short punchy on-screen opening title (max 6 words)' },
    title_animation: { type: 'string', enum: TEXT_ANIMATIONS, description: 'How the title enters' },
    title_style: { type: 'string', enum: TEXT_STYLES, description: 'Look of the title text' },
    closing_text: { type: 'string', description: 'Short on-screen closing line / call to action (max 8 words)' },
    outro_animation: { type: 'string', enum: TEXT_ANIMATIONS },
    outro_style: { type: 'string', enum: TEXT_STYLES },
    rationale: { type: 'string', description: 'One or two sentences on the editorial idea' },
    music: {
      type: 'object',
      description: 'A royalty-free music recommendation matching the content and vibe',
      properties: {
        mood: { type: 'string', description: 'e.g. uplifting, cinematic, chill, driving' },
        genre: { type: 'string', description: 'e.g. corporate pop, lo-fi, electronic, orchestral' },
        bpm: { type: 'integer', description: 'Approximate tempo, 60-180' },
        energy: { type: 'string', enum: ['low', 'medium', 'high'] },
        why: { type: 'string', description: 'One sentence on why this fits' },
        search_terms: { type: 'array', items: { type: 'string' }, description: '3-5 search phrases for a royalty-free music library' },
      },
      required: ['mood', 'genre', 'bpm', 'energy', 'why', 'search_terms'],
      additionalProperties: false,
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'The id of the source video or image' },
          type: { type: 'string', enum: ['video', 'image'] },
          start: { type: 'number', description: 'For video: in-point seconds. For image: always 0.' },
          end: { type: 'number', description: 'For video: out-point seconds. For image: display duration (2.5-4).' },
          transition: { type: 'string', enum: XFADE_TRANSITIONS, description: 'Transition FROM the previous clip INTO this one. Vary it clip-to-clip.' },
          effect: { type: 'string', enum: EFFECT_KEYS, description: 'Color look for this clip. Vary across clips; use none for some.' },
          motion: { type: 'string', enum: MOTIONS, description: 'Camera move for this clip (zoom/pan). Vary it.' },
          overlay_text: { type: 'string', description: 'Optional short caption over this clip; empty string for none' },
          text_animation: { type: 'string', enum: TEXT_ANIMATIONS, description: 'Only used when overlay_text is set' },
          text_style: { type: 'string', enum: TEXT_STYLES, description: 'Only used when overlay_text is set' },
        },
        required: ['source_id', 'type', 'start', 'end', 'transition', 'effect', 'motion', 'overlay_text', 'text_animation', 'text_style'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'title_animation', 'title_style', 'closing_text', 'outro_animation', 'outro_style', 'rationale', 'music', 'timeline'],
  additionalProperties: false,
};

/**
 * Turn per-source analyses into an edit plan for one final clip.
 */
export async function generatePlan(provider, { videoAnalyses, imageAnalyses, files }, opts) {
  const { targetDuration, vibe, eventTitle, brief, context } = opts;

  const sourceDescriptions = [];
  for (const va of videoAnalyses) {
    const f = files.find((x) => x.id === va.fileId);
    sourceDescriptions.push(
      `VIDEO source_id=${va.fileId} name="${f.originalName}" duration=${f.meta.duration.toFixed(1)}s\n` +
      `  summary: ${va.summary}\n` +
      va.segments.map((s) =>
        `  - [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] score=${s.score}/10 ${s.description} (${s.tags.join(', ')})`
      ).join('\n')
    );
  }
  for (const ia of imageAnalyses) {
    const f = files.find((x) => x.id === ia.fileId);
    sourceDescriptions.push(
      `IMAGE source_id=${ia.fileId} name="${f.originalName}" score=${ia.score}/10 ${ia.description} (${ia.tags.join(', ')})`
    );
  }

  const prompt =
    `You are an expert social-media video editor. Build the editing plan for ONE ~${targetDuration}s commercial-style clip ` +
    `from the analyzed event footage below. It will be posted on Instagram and LinkedIn.\n\n` +
    `Vibe: ${vibe}.\n` +
    (eventTitle ? `Event: "${eventTitle}". Base the opening title on it.\n` : '') +
    briefLine(brief) +
    (context ? `\nEXTRA CONTEXT (transcripts / notes the user provided — use it to pick the right moments, write accurate titles/captions, and match music):\n"""${context}"""\n` : '') +
    `\nRules:\n` +
    `- Use 4-10 clips. Prefer the highest-scoring moments, but order them to tell a story (establishing -> energy -> peak -> close).\n` +
    `- Video clips: 1.5-5s each (use a sub-range of a good segment; never exceed the source segment bounds).\n` +
    `- Images: 2.5-4s each (set start=0, end=display duration). Use at most ${Math.max(1, Math.round(targetDuration / 10))} images unless there are no videos.\n` +
    `- Sum of clip durations should be close to ${targetDuration}s (each transition overlaps 0.5s, so aim slightly above).\n` +
    `- Vary the sources; avoid two consecutive clips from the same source unless it's clearly the hero moment.\n` +
    `- EFFECTS & MOTION: give the clips VARIETY — do NOT reuse the same transition, effect, or motion on back-to-back clips. Mix looks (vivid/warm/bw/etc, some "none") and moves (zoom_in/zoom_out/pan_*, some "none") so the montage feels dynamic, not repetitive. Match choices to the vibe.\n` +
    `- overlay_text: use sparingly (0-2 clips), only when a short caption adds punch. Empty string otherwise. When set, pick a fitting text_animation and text_style.\n` +
    `- music: recommend a royalty-free track (mood/genre/bpm/energy) that fits the content and vibe, with search phrases the user can paste into a free music library.\n\n` +
    `ANALYZED SOURCES:\n${sourceDescriptions.join('\n\n')}`;

  return provider.runVision({ prompt, images: [], schema: PLAN_SCHEMA, maxTokens: 16000, useThinking: true });
}

// Rotate a value away from the previous one to force variety.
function diversify(desired, prev, pool) {
  if (desired && desired !== prev) return desired;
  const start = Math.max(0, pool.indexOf(prev));
  for (let i = 1; i <= pool.length; i++) {
    const cand = pool[(start + i) % pool.length];
    if (cand !== prev) return cand;
  }
  return desired || pool[0];
}

/**
 * Validate/normalize the plan against real sources & target duration.
 */
export function normalizePlan(plan, files, targetDuration) {
  const byId = new Map(files.map((f) => [f.id, f]));
  let timeline = (plan.timeline || [])
    .map((item) => {
      const f = byId.get(item.source_id);
      if (!f) return null;
      const kind = f.kind;
      if (kind !== 'video' && kind !== 'image') return null;
      let start = Math.max(0, Number(item.start) || 0);
      let end = Number(item.end) || 0;
      if (kind === 'video') {
        const dur = f.meta.duration;
        end = Math.min(end, dur);
        start = Math.min(start, Math.max(dur - 1, 0));
        if (end - start > 6) end = start + 6;
        if (end - start < 1) end = Math.min(start + 1.5, dur);
      } else {
        start = 0;
        end = Math.max(2, Math.min(end || 3, 5));
      }
      if (end - start < 0.8) return null;
      return {
        sourceId: f.id,
        kind,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        duration: Number((end - start).toFixed(2)),
        transition: XFADE_TRANSITIONS.includes(item.transition) ? item.transition : null,
        effect: EFFECT_KEYS.includes(item.effect) ? item.effect : null,
        motion: MOTIONS.includes(item.motion) ? item.motion : null,
        overlayText: (item.overlay_text || '').trim(),
        textAnimation: TEXT_ANIMATIONS.includes(item.text_animation) ? item.text_animation : null,
        textStyle: TEXT_STYLES.includes(item.text_style) ? item.text_style : null,
      };
    })
    .filter(Boolean);

  if (timeline.length === 0) {
    // Fallback: build a naive plan from whatever exists.
    timeline = files
      .filter((f) => f.kind === 'video' || f.kind === 'image')
      .slice(0, 8)
      .map((f) => {
        const dur = f.kind === 'video' ? Math.min(3, f.meta.duration) : 3;
        return {
          sourceId: f.id, kind: f.kind, start: 0, end: dur, duration: dur,
          transition: null, effect: null, motion: null, overlayText: '', textAnimation: null, textStyle: null,
        };
      })
      .filter((t) => t.duration >= 0.8);
  }
  if (timeline.length === 0) throw new Error('No usable clips could be planned from the uploaded files.');

  // Scale down if wildly over target (keep transitions overlap in mind: 0.5s each).
  const transitionLoss = Math.max(0, timeline.length - 1) * 0.5;
  const total = timeline.reduce((s, t) => s + t.duration, 0) - transitionLoss;
  const maxTotal = targetDuration * 1.25;
  if (total > maxTotal) {
    const scale = (maxTotal + transitionLoss) / (total + transitionLoss);
    for (const t of timeline) {
      let newDur = Math.max(1.2, t.duration * scale);
      if (t.kind === 'video') {
        // Never rescale past the end of the source.
        const srcDur = byId.get(t.sourceId)?.meta.duration ?? newDur;
        newDur = Math.min(newDur, Math.max(0.8, srcDur - t.start));
      }
      t.end = Number((t.start + newDur).toFixed(2));
      t.duration = Number(newDur.toFixed(2));
    }
  }

  // Enforce variety: no back-to-back identical transition / effect / motion.
  // Effects and motions each get a "some clips plain" bias by seeding the pool.
  const EFFECT_POOL = ['vivid', 'warm', 'none', 'cool', 'punch', 'bw', 'dreamy', 'retro'];
  const MOTION_POOL = ['zoom_in', 'pan_right', 'none', 'zoom_out', 'pan_left', 'pan_up'];
  let prevTrans = null; let prevEffect = null; let prevMotion = null;
  timeline.forEach((t, i) => {
    if (i > 0) {
      t.transition = diversify(t.transition, prevTrans, XFADE_TRANSITIONS);
      prevTrans = t.transition;
    } else {
      t.transition = null; // first clip has no incoming transition
    }
    t.effect = diversify(t.effect || (i % 3 === 2 ? 'none' : null), prevEffect, EFFECT_POOL);
    prevEffect = t.effect;
    if (t.kind === 'image') {
      t.motion = MOTIONS.includes(t.motion) && t.motion !== 'none' ? t.motion : diversify(null, prevMotion, MOTION_POOL.filter((m) => m !== 'none'));
    } else {
      t.motion = diversify(t.motion, prevMotion, MOTION_POOL);
    }
    prevMotion = t.motion;
  });

  const m = plan.music || {};
  const music = {
    mood: String(m.mood || '').slice(0, 40),
    genre: String(m.genre || '').slice(0, 40),
    bpm: Math.max(40, Math.min(200, Math.round(Number(m.bpm) || 100))),
    energy: ['low', 'medium', 'high'].includes(m.energy) ? m.energy : 'medium',
    why: String(m.why || '').slice(0, 200),
    searchTerms: Array.isArray(m.search_terms)
      ? m.search_terms.map((s) => String(s).slice(0, 60)).filter(Boolean).slice(0, 5)
      : [],
  };

  return {
    title: (plan.title || '').trim().slice(0, 60),
    titleAnimation: TEXT_ANIMATIONS.includes(plan.title_animation) ? plan.title_animation : null,
    titleStyle: TEXT_STYLES.includes(plan.title_style) ? plan.title_style : null,
    closingText: (plan.closing_text || '').trim().slice(0, 80),
    outroAnimation: TEXT_ANIMATIONS.includes(plan.outro_animation) ? plan.outro_animation : null,
    outroStyle: TEXT_STYLES.includes(plan.outro_style) ? plan.outro_style : null,
    transition: 'fade', // legacy default used only if a per-clip transition is missing
    rationale: plan.rationale || '',
    music: (music.mood || music.genre || music.searchTerms.length) ? music : null,
    timeline,
  };
}
