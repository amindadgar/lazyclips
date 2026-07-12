// LLM backends (bring-your-own-model). In priority order:
//   1. Your logged-in Claude app (claude CLI) — default, no key needed.
//   2. Anthropic API key (BYOK override).
//   3. Any OpenAI-format endpoint — ChatGPT/OpenAI, or a custom base URL + key
//      (OpenRouter, Together, LM Studio, Ollama, vLLM, LocalAI, …).
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';

const execFileP = promisify(execFile);

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

export const MODELS = [
  { id: '', label: 'Your Claude app default (recommended)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (best quality)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (fast & cheaper)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)' },
];

let cliPromise = null;
export function detectCli() {
  if (!cliPromise) {
    cliPromise = execFileP('claude', ['--version'], { timeout: 10000 })
      .then(({ stdout }) => ({ available: true, version: stdout.trim().split('\n')[0] }))
      .catch(() => ({ available: false }));
  }
  return cliPromise;
}

/** Pull a JSON object out of model text that may be fenced or padded with prose. */
export function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`Could not find JSON in response: ${cleaned.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ------------------------------------------------------------------ */
/* API provider (BYOK)                                                  */
/* ------------------------------------------------------------------ */

// Adaptive thinking is supported on 4.6+ Opus/Sonnet; Fable has it always-on
// (param must be omitted); Haiku doesn't support adaptive.
function thinkingFor(model) {
  if (/opus-4-[678]|sonnet-5|sonnet-4-6/.test(model)) return { thinking: { type: 'adaptive' } };
  return {};
}

class ApiProvider {
  constructor({ apiKey, model }) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.model = model || DEFAULT_MODEL;
    this.name = 'api';
    this.label = `Claude API (${this.model})`;
    this.concurrency = 3;
  }

  /**
   * prompt: string; images: [{label, path}] (jpeg); schema: JSON schema;
   * returns the parsed JSON object.
   */
  async runVision({ prompt, images = [], schema, maxTokens = 8000, useThinking = false }) {
    const content = [{ type: 'text', text: prompt }];
    for (const img of images) {
      content.push({ type: 'text', text: `${img.label}:` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: fs.readFileSync(img.path).toString('base64'),
        },
      });
    }
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...(useThinking ? thinkingFor(this.model) : {}),
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to analyze this content.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Claude response was truncated (max_tokens) — try a shorter video set.');
    }
    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new Error('Too much footage for one request — remove some files and try again.');
    }
    const block = response.content.find((b) => b.type === 'text');
    if (!block) throw new Error(`Claude returned no text (stop_reason: ${response.stop_reason})`);
    return JSON.parse(block.text);
  }

  async test() {
    const m = await this.client.models.retrieve(this.model);
    return `API key works — ${m.display_name} available`;
  }
}

/* ------------------------------------------------------------------ */
/* Claude-app provider (logged-in claude CLI, headless)                 */
/* ------------------------------------------------------------------ */

class CliProvider {
  constructor({ model, cwd }) {
    this.model = model || null; // null = whatever the user's Claude app defaults to
    this.cwd = cwd || process.cwd();
    this.name = 'app';
    this.label = `your Claude app${this.model ? ` (${this.model})` : ''}`;
    this.concurrency = 2;
  }

  runCli(promptText, { timeoutMs = 10 * 60 * 1000 } = {}) {
    const args = [
      '-p',
      '--output-format', 'json',
      '--allowedTools', 'Read',
      '--disallowedTools', 'Bash,Write,Edit,WebFetch,WebSearch,Task',
      '--max-turns', '40',
    ];
    if (this.model) args.push('--model', this.model);

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, { cwd: this.cwd });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Claude app call timed out.'));
      }, timeoutMs);
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; if (stderr.length > 40000) stderr = stderr.slice(-20000); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          return reject(new Error(`Claude app exited with code ${code}: ${stderr.slice(-400)}`));
        }
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.is_error || envelope.subtype !== 'success') {
            return reject(new Error(`Claude app error (${envelope.subtype || 'unknown'}): ${String(envelope.result || '').slice(0, 300)}`));
          }
          resolve(envelope.result);
        } catch (err) {
          reject(new Error(`Could not parse Claude app output: ${err.message}`));
        }
      });
      // The child may exit before draining stdin (large prompt, early auth/startup
      // failure), which raises EPIPE on this socket — swallow it so it can't become
      // an uncaughtException that kills the whole server; proc.on('close') surfaces
      // the real error with the exit code + stderr.
      proc.stdin.on('error', () => {});
      proc.stdin.write(promptText);
      proc.stdin.end();
    });
  }

  async runVision({ prompt, images = [], schema }) {
    const parts = [prompt];
    if (images.length > 0) {
      parts.push(
        `\nExamine these image files with your Read tool (they are labeled; read them all before answering):\n` +
        images.map((img) => `- ${img.label}: ${img.path}`).join('\n')
      );
    }
    parts.push(
      `\nRespond with ONLY one valid JSON object that matches this JSON Schema — no prose, no markdown fences:\n` +
      JSON.stringify(schema)
    );
    const text = await this.runCli(parts.join('\n'));
    return extractJson(text);
  }

  async test() {
    const text = await this.runCli('Reply with exactly this JSON and nothing else: {"ok":true}', { timeoutMs: 90 * 1000 });
    extractJson(text);
    return `Your Claude app responds${this.model ? ` (model ${this.model})` : ''} — no API key needed`;
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible provider (ChatGPT / any /v1 base URL + key)         */
/* ------------------------------------------------------------------ */

// One POST to /chat/completions with best-effort compatibility fallbacks: some
// OpenAI-format servers reject `response_format` or want `max_completion_tokens`.
async function openaiChat(baseUrl, apiKey, body) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let attempt = { ...body };
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(attempt),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 400 && /response_format/i.test(text) && attempt.response_format) {
      delete attempt.response_format; // server doesn't support JSON mode — rely on prompt
      continue;
    }
    if (res.status === 400 && /max_completion_tokens|max_tokens/i.test(text) && attempt.max_tokens != null) {
      attempt = { ...attempt, max_completion_tokens: attempt.max_tokens };
      delete attempt.max_tokens; // newer OpenAI models require max_completion_tokens
      continue;
    }
    if (res.status === 401) throw new Error('OpenAI-compatible endpoint rejected the API key (401).');
    throw new Error(`OpenAI-compatible endpoint error ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error('OpenAI-compatible endpoint kept returning 400 after compatibility retries.');
}

class OpenAIProvider {
  constructor({ apiKey, baseUrl, model }) {
    if (!apiKey) throw new Error('An API key is required for the OpenAI-compatible provider.');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || OPENAI_DEFAULT_BASE;
    this.model = model || OPENAI_DEFAULT_MODEL;
    this.name = 'openai';
    const host = (() => { try { return new URL(this.baseUrl).host; } catch { return this.baseUrl; } })();
    this.label = `OpenAI-compatible (${this.model} @ ${host})`;
    this.concurrency = 3;
  }

  async runVision({ prompt, images = [], schema, maxTokens = 8000 }) {
    const content = [{
      type: 'text',
      text: `${prompt}\n\nRespond with ONLY one valid JSON object matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(schema)}`,
    }];
    for (const img of images) {
      content.push({ type: 'text', text: `${img.label}:` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(img.path).toString('base64')}` },
      });
    }
    const data = await openaiChat(this.baseUrl, this.apiKey, {
      model: this.model,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
    });
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI-compatible endpoint returned an empty response.');
    return extractJson(text);
  }

  async test() {
    const data = await openaiChat(this.baseUrl, this.apiKey, {
      model: this.model,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Endpoint responded but returned no text.');
    return `OpenAI-compatible endpoint works — model "${this.model}" responded. (Use a vision-capable model, e.g. gpt-4o.)`;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Pick the backend from an explicit type, or auto-detect.
 *
 * type: 'openai' → OpenAIProvider (needs apiKey [+ baseUrl, model])
 *       'anthropic' → Anthropic API (apiKey or server env key)
 *       'claude-app' → logged-in claude CLI
 *       'auto'/undefined → apiKey/env ⇒ Anthropic, else claude CLI
 */
export async function createProvider({ type, apiKey, baseUrl, model, cwd }) {
  if (type === 'openai') {
    return new OpenAIProvider({ apiKey, baseUrl, model });
  }
  if (type === 'anthropic') {
    // The SDK defers the auth check to request time, so validate up front —
    // otherwise a keyless request passes pre-flight and dies mid-job.
    if (!apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error('A Claude API key is required for the Claude API provider — add one in Settings, or switch to your Claude app.');
    }
    return new ApiProvider({ apiKey, model });
  }
  if (type === 'claude-app') {
    const cli = await detectCli();
    if (!cli.available) throw new Error('The Claude app (claude CLI) is not installed or not logged in.');
    return new CliProvider({ model, cwd });
  }
  // auto
  if (apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return new ApiProvider({ apiKey, model });
  }
  const cli = await detectCli();
  if (cli.available) {
    return new CliProvider({ model, cwd });
  }
  throw new Error(
    'No AI connection: log into the Claude app (claude CLI), or add an API key in Settings (⚙) — Anthropic or any OpenAI-format endpoint.'
  );
}
