// LazyClips frontend — uploads, settings, pipeline SSE, results.
const $ = (sel) => document.querySelector(sel);

const state = {
  files: [],
  musicId: undefined, // undefined = unset (auto-pick), null = explicitly "no music"
  keepOriginalAudio: false,
  job: null,
  eventSource: null,
  config: { models: [], presets: [], hasEnvKey: false, claudeApp: { available: false } },
};

// ---------- boot ----------
async function boot() {
  const config = await fetch('/api/config').then((r) => r.json());
  state.config = config;

  if (!config.ffmpeg) $('#ffmpeg-warning').classList.remove('hidden');

  const savedModel = localStorage.getItem('lazyclips.model') ?? '';
  const modelSel = $('#model');
  modelSel.innerHTML = config.models
    .map((m) => `<option value="${m.id}" ${m.id === savedModel ? 'selected' : ''}>${m.label}</option>`)
    .join('');
  modelSel.addEventListener('change', () => {
    localStorage.setItem('lazyclips.model', modelSel.value);
  });

  const presetDefaults = new Set(['reel', 'landscape']);
  $('#preset-checks').innerHTML = config.presets
    .map((p) => `
      <label title="${p.platforms}">
        <input type="checkbox" name="preset" value="${p.id}" ${presetDefaults.has(p.id) ? 'checked' : ''} />
        ${p.label}
      </label>`)
    .join('');

  // Provider settings.
  $('#api-key').value = localStorage.getItem('lazyclips.apiKey') || '';
  $('#openai-base').value = localStorage.getItem('lazyclips.openaiBase') || (config.openaiDefaults?.base || '');
  $('#openai-model').value = localStorage.getItem('lazyclips.openaiModel') || (config.openaiDefaults?.model || '');
  $('#openai-key').value = localStorage.getItem('lazyclips.openaiKey') || '';
  $('#provider-type').value = localStorage.getItem('lazyclips.providerType') || 'auto';
  wireProviderFields();
  applyProviderMode();
  updateConnectionStatus();

  const { files } = await fetch('/api/files').then((r) => r.json());
  state.files = files;
  renderFiles();
  updateGoHint();

  // Reconnect to a job that was running when the page was closed/reloaded.
  const savedJob = localStorage.getItem('lazyclips.job');
  if (savedJob) {
    const r = await fetch(`/api/jobs/${savedJob}`).catch(() => null);
    if (r?.ok) {
      $('#generate').disabled = true;
      watchJob(savedJob);
    } else {
      localStorage.removeItem('lazyclips.job');
    }
  }
}

// ---------- settings modal & connection status ----------
$('#settings-btn').addEventListener('click', () => $('#settings-modal').classList.remove('hidden'));
$('#settings-close').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
$('#settings-modal').addEventListener('click', (e) => {
  if (e.target === $('#settings-modal')) $('#settings-modal').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#settings-modal').classList.add('hidden');
});

// Provider config assembled from the current UI state.
function currentProvider() {
  const type = $('#provider-type').value;
  if (type === 'openai') {
    return {
      type: 'openai',
      apiKey: $('#openai-key').value.trim(),
      baseUrl: $('#openai-base').value.trim(),
      model: $('#openai-model').value.trim(),
    };
  }
  return { type, apiKey: $('#api-key').value.trim(), model: $('#model').value };
}

function wireProviderFields() {
  const persist = (id, key) => $(id).addEventListener('change', () => {
    localStorage.setItem(key, $(id).value.trim());
    updateConnectionStatus();
  });
  $('#provider-type').addEventListener('change', () => {
    localStorage.setItem('lazyclips.providerType', $('#provider-type').value);
    applyProviderMode();
    updateConnectionStatus();
  });
  persist('#openai-base', 'lazyclips.openaiBase');
  persist('#openai-model', 'lazyclips.openaiModel');
  persist('#openai-key', 'lazyclips.openaiKey');
  ['#openai-base', '#openai-model', '#openai-key', '#api-key'].forEach((id) =>
    $(id).addEventListener('input', updateConnectionStatus));
}

function applyProviderMode() {
  const type = $('#provider-type').value;
  const openai = type === 'openai';
  $('#fields-claude').classList.toggle('hidden', openai);
  $('#fields-openai').classList.toggle('hidden', !openai);
  $('#claude-key-hint').textContent = type === 'anthropic'
    ? '(required)'
    : '(optional — without it your logged-in Claude app is used)';
}

function connectionInfo() {
  const type = $('#provider-type').value;
  if (type === 'openai') {
    const key = $('#openai-key').value.trim();
    const model = $('#openai-model').value.trim() || 'gpt-4o';
    let host = 'OpenAI';
    try { host = new URL($('#openai-base').value.trim() || 'https://api.openai.com/v1').host; } catch { /* noop */ }
    return key
      ? { cls: 'ok', msg: `🔑 Using OpenAI-compatible endpoint — ${model} @ ${host}.` }
      : { cls: 'bad', msg: '⚠️ OpenAI-compatible mode needs an API key below.' };
  }
  const key = $('#api-key').value.trim();
  if (type === 'anthropic') {
    return key || state.config.hasEnvKey
      ? { cls: 'ok', msg: '🔑 Using your Claude API key.' }
      : { cls: 'bad', msg: '⚠️ Claude API mode needs a key below (or one in the server env).' };
  }
  // auto
  if (key) return { cls: 'ok', msg: '🔑 Using your Claude API key (override of the Claude app).' };
  if (state.config.hasEnvKey) return { cls: 'ok', msg: '🔑 Using the server’s API key (environment).' };
  if (state.config.claudeApp?.available) {
    return { cls: 'ok', msg: `✅ Using your Claude app (${state.config.claudeApp.version || 'claude CLI'}) — no API key needed.` };
  }
  return { cls: 'bad', msg: '⚠️ No AI connection. Log into the Claude app, or add a key below (Claude or OpenAI-compatible).' };
}

function updateConnectionStatus() {
  const info = connectionInfo();
  const el = $('#conn-status');
  el.textContent = info.msg;
  el.className = `conn-status ${info.cls}`;
  $('#conn-chip').textContent = info.msg;
}

// ---------- uploads ----------
const dropzone = $('#dropzone');
const fileInput = $('#file-input');

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = '';
});

async function uploadFiles(fileList) {
  const status = $('#upload-status');
  status.classList.remove('hidden');
  status.textContent = `Uploading ${fileList.length} file(s)…`;
  const form = new FormData();
  for (const f of fileList) form.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
    const { added = [], rejected = [] } = data;
    state.files.push(...added);
    renderFiles();
    const parts = [];
    if (added.length) parts.push(`✅ added ${added.length}`);
    if (rejected.length) {
      parts.push(`<span class="err">❌ ${rejected.map((r) => escapeHtml(`${r.name} (${r.reason})`)).join(', ')}</span>`);
    }
    status.innerHTML = parts.join(' · ') || 'Nothing uploaded.';
    setTimeout(() => { if (!rejected.length) status.classList.add('hidden'); }, 4000);
  } catch (err) {
    status.innerHTML = `<span class="err">Upload failed: ${escapeHtml(err.message)}</span>`;
  }
  updateGoHint();
}

function renderFiles() {
  const grid = $('#file-grid');
  const media = state.files.filter((f) => f.kind === 'video' || f.kind === 'image');
  const audio = state.files.filter((f) => f.kind === 'audio');
  const texts = state.files.filter((f) => f.kind === 'text');

  grid.innerHTML = media.map((f) => `
    <div class="file-tile" data-id="${f.id}">
      ${f.thumb
        ? `<img src="${f.thumb}" alt="" />`
        : `<div class="no-thumb">${f.kind === 'video' ? '🎥' : '🖼️'}</div>`}
      <span class="badge">${f.kind === 'video' ? `🎥 ${fmtDur(f.meta.duration)}` : '🖼️'}</span>
      <button class="remove" title="Remove" data-id="${f.id}">✕</button>
      <div class="name">${escapeHtml(f.originalName)}</div>
    </div>`).join('');

  grid.querySelectorAll('.remove').forEach((btn) =>
    btn.addEventListener('click', () => removeFile(btn.dataset.id)));

  // Transcript / notes context files.
  const contextRow = $('#context-row');
  if (texts.length > 0) {
    contextRow.classList.remove('hidden');
    contextRow.innerHTML = texts.map((f) => `
      <div class="context-tile">
        <span class="ctx-icon">📄</span>
        <div>
          <div class="ctx-name">${escapeHtml(f.originalName)}</div>
          <div class="ctx-meta">transcript / notes${f.meta?.chars ? ` · ${f.meta.chars.toLocaleString()} chars` : ''} — used as context</div>
        </div>
        <button class="remove" title="Remove" data-id="${f.id}">✕</button>
      </div>`).join('');
    contextRow.querySelectorAll('.remove').forEach((btn) =>
      btn.addEventListener('click', () => removeFile(btn.dataset.id)));
  } else {
    contextRow.classList.add('hidden');
    contextRow.innerHTML = '';
  }

  const musicRow = $('#music-row');
  if (audio.length > 0) {
    if (state.musicId === undefined) {
      state.musicId = audio[0].id; // first audio upload: auto-select
    } else if (state.musicId !== null && !audio.some((a) => a.id === state.musicId)) {
      state.musicId = audio[0].id; // previously selected file was removed
    }
    musicRow.classList.remove('hidden');
    musicRow.innerHTML = `
      🎵 Music bed:
      <select id="music-select">
        <option value="" ${state.musicId === null ? 'selected' : ''}>(no music — keep original audio)</option>
        ${audio.map((a) => `<option value="${a.id}" ${a.id === state.musicId ? 'selected' : ''}>${escapeHtml(a.originalName)}</option>`).join('')}
      </select>
      <label><input type="checkbox" id="keep-audio" ${state.keepOriginalAudio ? 'checked' : ''}/> also keep original audio (mixed under music)</label>
      <button class="btn small" id="remove-music" ${state.musicId ? '' : 'disabled'}>remove file</button>`;
    $('#music-select').addEventListener('change', (e) => {
      state.musicId = e.target.value || null;
      $('#remove-music').disabled = !state.musicId;
    });
    $('#keep-audio').addEventListener('change', (e) => { state.keepOriginalAudio = e.target.checked; });
    $('#remove-music').addEventListener('click', () => {
      if (!state.musicId) return; // nothing selected — nothing to remove
      removeFile(state.musicId);
      state.musicId = undefined;
    });
  } else {
    state.musicId = undefined;
    musicRow.classList.add('hidden');
    musicRow.innerHTML = '';
  }
}

async function removeFile(id) {
  await fetch(`/api/files/${id}`, { method: 'DELETE' });
  state.files = state.files.filter((f) => f.id !== id);
  renderFiles();
  updateGoHint();
}

// ---------- key handling ----------
function setKeyStatus(msg, cls = '') {
  const el = $('#key-status');
  el.textContent = msg;
  el.className = `key-status ${cls}`;
}

$('#api-key').addEventListener('change', () => {
  localStorage.setItem('lazyclips.apiKey', $('#api-key').value.trim());
  updateConnectionStatus();
});

$('#test-key').addEventListener('click', async () => {
  setKeyStatus('Testing connection… (the Claude app path can take ~15s)');
  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: currentProvider() }),
    }).then((r) => r.json());
    if (res.ok) setKeyStatus(`✅ ${res.detail}`, 'ok');
    else setKeyStatus(`❌ ${res.reason}`, 'bad');
  } catch (err) {
    setKeyStatus(`❌ ${err.message}`, 'bad');
  }
});

// ---------- generate ----------
function updateGoHint() {
  const videos = state.files.filter((f) => f.kind === 'video').length;
  const images = state.files.filter((f) => f.kind === 'image').length;
  const media = videos + images;
  const extras = [];
  if (state.files.some((f) => f.kind === 'audio')) extras.push('music');
  if (state.files.some((f) => f.kind === 'text')) extras.push('transcript');
  $('#go-hint').textContent = media === 0
    ? 'Upload footage above, then hit the button.'
    : `Ready: ${videos} video(s), ${images} photo(s)${extras.length ? ` + ${extras.join(' + ')}` : ''}.`;
}

function fmtDur(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#generate').addEventListener('click', async () => {
  const btn = $('#generate');
  btn.disabled = true;
  try {
    const presets = [...document.querySelectorAll('input[name="preset"]:checked')].map((c) => c.value);
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: currentProvider(),
        targetDuration: Number($('#duration').value),
        vibe: $('#vibe').value,
        eventTitle: $('#event-title').value.trim(),
        brief: $('#brief').value.trim(),
        presets: presets.length ? presets : ['reel'],
        musicId: state.musicId,
        keepOriginalAudio: state.keepOriginalAudio,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start.');
    watchJob(data.jobId);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
});

// ---------- pipeline view ----------
function renderPipeline(steps) {
  $('#pipeline').innerHTML = steps.map((s) => `
    <div class="pl-step ${s.status}" data-step="${s.id}">
      <div class="pl-rail">
        <div class="pl-dot">${s.status === 'done' ? '✓' : s.status === 'error' ? '✕' : s.icon}</div>
        <div class="pl-line"></div>
      </div>
      <div class="pl-body">
        <div class="pl-title">${s.label}</div>
        <div class="pl-detail">${escapeHtml(s.detail || '')}</div>
        <div class="pl-bar"><div style="width:${Math.round((s.progress || 0) * 100)}%"></div></div>
      </div>
    </div>`).join('');
}

function updateStepEl(stepId, { status, detail, progress }) {
  const el = document.querySelector(`.pl-step[data-step="${stepId}"]`);
  if (!el) return;
  if (status) {
    el.className = `pl-step ${status}`;
    const dot = el.querySelector('.pl-dot');
    if (status === 'done') dot.textContent = '✓';
    else if (status === 'error') dot.textContent = '✕';
  }
  if (detail !== undefined && detail !== '') el.querySelector('.pl-detail').textContent = detail;
  if (progress !== undefined) el.querySelector('.pl-bar > div').style.width = `${Math.round(progress * 100)}%`;
}

function renderPlan(plan) {
  const el = $('#plan-view');
  el.classList.remove('hidden');
  const chip = (v) => (v && v !== 'none' ? ` · <span class="fx">${escapeHtml(v)}</span>` : '');
  el.innerHTML = `
    <div class="plan-title">🎬 “${escapeHtml(plan.title)}” <span class="hint">· ${plan.timeline.length} clips</span></div>
    <div class="hint">${escapeHtml(plan.rationale || '')}</div>
    <ol>${plan.timeline.map((t) =>
      `<li>${t.kind === 'video' ? '🎥' : '🖼️'} ${escapeHtml(t.sourceId)} · ${t.kind === 'video' ? `${t.start}s→${t.end}s` : `${t.duration}s`}` +
      chip(t.effect) + chip(t.motion) + (t.transition ? ` · <span class="fx">↔ ${escapeHtml(t.transition)}</span>` : '') +
      (t.overlayText ? ` · “${escapeHtml(t.overlayText)}”` : '') + `</li>`
    ).join('')}</ol>`;
}

function addLog(msg) {
  const log = $('#log');
  const div = document.createElement('div');
  div.textContent = msg;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function renderMusic(music) {
  if (!music) return;
  const el = $('#music-suggestion');
  $('#results-card').classList.remove('hidden');
  el.classList.remove('hidden');
  const tags = [
    music.mood, music.genre,
    music.bpm ? `${music.bpm} BPM` : '', music.energy ? `${music.energy} energy` : '',
  ].filter(Boolean);
  el.innerHTML = `
    <h3>🎵 Suggested music</h3>
    <div class="ms-tags">${tags.map((t) => `<span class="ms-tag">${escapeHtml(t)}</span>`).join('')}</div>
    ${music.why ? `<div class="ms-why">${escapeHtml(music.why)}</div>` : ''}
    <div class="ms-links">
      ${(music.links || []).map((l) => `<a href="${encodeURI(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)} ↗</a>`).join('')}
    </div>
    ${music.searchTerms?.length ? `<div class="ms-why" style="margin-top:8px">Search terms: ${music.searchTerms.map(escapeHtml).join(' · ')}</div>` : ''}`;
}

function renderResults(outputs) {
  $('#results-card').classList.remove('hidden');
  $('#results').innerHTML = outputs.map((o) => `
    <div class="result-tile">
      <video src="${o.url}" controls playsinline preload="metadata"></video>
      <div class="result-meta">
        <div>
          <div class="label">${o.label} · ${o.duration}s</div>
          <div class="platforms">${o.platforms}</div>
        </div>
        <a class="btn" href="${o.url}" download>⬇ Download</a>
      </div>
    </div>`).join('');
  $('#results-card').scrollIntoView({ behavior: 'smooth' });
}

// ---------- job streaming ----------
function watchJob(jobId) {
  state.job = jobId;
  localStorage.setItem('lazyclips.job', jobId);
  $('#pipeline-card').classList.remove('hidden');
  $('#plan-view').classList.add('hidden');
  $('#results-card').classList.add('hidden');
  $('#log').innerHTML = '';
  $('#pipeline-card').scrollIntoView({ behavior: 'smooth' });

  if (state.eventSource) state.eventSource.close();
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  state.eventSource = es;

  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    switch (event.type) {
      case 'state':
        renderPipeline(event.state.steps);
        if (event.state.plan) renderPlan(event.state.plan);
        if (event.state.music) renderMusic(event.state.music);
        if (event.state.pendingTextRender) submitTextAssets(jobId, event.state.pendingTextRender);
        if (event.state.outputs?.length && event.state.status === 'done') renderResults(event.state.outputs);
        if (event.state.status !== 'running') finishJob(event.state.status === 'error' ? event.state.error : null);
        break;
      case 'step':
        updateStepEl(event.step, { status: event.status, detail: event.detail });
        break;
      case 'progress':
        updateStepEl(event.step, { progress: event.progress, detail: event.detail });
        break;
      case 'log':
        addLog(event.msg);
        break;
      case 'plan':
        renderPlan(event.plan);
        break;
      case 'music':
        renderMusic(event.music);
        break;
      case 'need-text-render':
        submitTextAssets(jobId, event.requests);
        break;
      case 'done':
        renderResults(event.outputs);
        finishJob(null);
        break;
      case 'error':
        addLog(`❌ ${event.error}`);
        finishJob(event.error);
        break;
    }
  };
  es.onerror = () => {
    // Server closed or restarted; do a one-shot state fetch to settle the UI.
    fetch(`/api/jobs/${jobId}`).then((r) => {
      if (r.status === 404) {
        // Job is gone (server restarted) — stop the EventSource retry loop.
        finishJob('The server restarted and this job was lost — hit ✨ again.');
        return null;
      }
      return r.ok ? r.json() : null;
    }).then((s) => {
      if (s && s.status !== 'running') {
        renderPipeline(s.steps);
        if (s.outputs?.length) renderResults(s.outputs);
        finishJob(s.error);
      }
    }).catch(() => {});
  };
}

// ---------- text overlay rasterization (canvas -> transparent PNG) ----------
// The server composites these over the video; this gives crisp system-font
// typography and richer looks (gradient / outline / lower-third bar) on any
// ffmpeg build.
const KIND_SIZES = {
  title:   { weight: 800, size: 128, radius: 26 },
  outro:   { weight: 700, size: 82,  radius: 20 },
  caption: { weight: 700, size: 68,  radius: 16 },
};
const ACCENT = '#ff7a45';
const ACCENT_2 = '#ffb347';
const FAMILY = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const attempt = line ? `${line} ${word}` : word;
    if (ctx.measureText(attempt).width > maxWidth && line) { lines.push(line); line = word; }
    else line = attempt;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// style ∈ boxed | bar | outline | gradient
function rasterizeText(text, kind, style = 'boxed') {
  const s = KIND_SIZES[kind] || KIND_SIZES.caption;
  const size = s.size;
  const fontSpec = `${s.weight} ${size}px ${FAMILY}`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = fontSpec;

  const lines = wrapLines(measure, text, 1500);
  if (lines.length === 0) return null;

  const lineHeight = Math.round(size * 1.22);
  const textWidth = Math.max(...lines.map((l) => measure.measureText(l).width));
  const padX = Math.round(size * (style === 'bar' ? 0.5 : 0.42));
  const padY = Math.round(size * 0.34);
  const barW = style === 'bar' ? Math.round(size * 0.16) : 0;
  const stroke = style === 'outline' || style === 'gradient' ? Math.max(6, Math.round(size * 0.09)) : 0;

  const w = Math.ceil(textWidth + padX * 2 + barW + stroke * 2);
  const h = Math.ceil(lines.length * lineHeight + padY * 2);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.textAlign = style === 'bar' ? 'left' : 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontSpec;

  const textLeft = style === 'bar' ? barW + padX : w / 2;

  // Background treatments.
  if (style === 'boxed') {
    ctx.fillStyle = 'rgba(10,10,14,0.42)';
    roundRectPath(ctx, 0, 0, w, h, s.radius);
    ctx.fill();
  } else if (style === 'bar') {
    ctx.fillStyle = 'rgba(10,10,14,0.5)';
    roundRectPath(ctx, 0, 0, w, h, s.radius);
    ctx.fill();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, ACCENT_2);
    grad.addColorStop(1, ACCENT);
    ctx.fillStyle = grad;
    roundRectPath(ctx, 0, 0, barW, h, s.radius);
    ctx.fill();
  }

  const drawLine = (l, y) => {
    if (stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = stroke;
      ctx.strokeStyle = 'rgba(8,8,12,0.92)';
      ctx.strokeText(l, textLeft, y);
    }
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = style === 'boxed' || style === 'bar' ? 12 : 8;
    ctx.shadowOffsetY = 3;
    if (style === 'gradient') {
      const grad = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, ACCENT_2);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = '#ffffff';
    }
    ctx.fillText(l, textLeft, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  };

  lines.forEach((l, i) => drawLine(l, padY + lineHeight * i + lineHeight / 2));
  return canvas.toDataURL('image/png');
}

async function submitTextAssets(jobId, requests) {
  // Rasterize per-asset so one bad string can't sink the batch; always POST
  // (even empty) so the server stops waiting and falls back promptly.
  const assets = [];
  for (const r of requests || []) {
    try {
      const dataUrl = rasterizeText(r.text, r.kind, r.style);
      if (dataUrl) assets.push({ key: r.key, dataUrl });
    } catch (err) {
      console.warn('text asset render failed for', r.key, err);
    }
  }
  try {
    await fetch(`/api/jobs/${jobId}/text-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assets }),
    });
  } catch (err) {
    console.warn('text asset upload failed', err);
  }
}

function finishJob(error) {
  $('#generate').disabled = false;
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  if (error) addLog(`Pipeline stopped: ${error}`);
}

boot();
