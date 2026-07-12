# 🎬 LazyClips

Drop your event videos & photos → an AI picks the best moments → FFmpeg cuts commercial-ready clips for Instagram, LinkedIn, TikTok. You do nothing else.

Runs on your machine. It works **free with just your Claude app subscription** — or bring your own key (Claude API, or **any OpenAI-compatible endpoint like ChatGPT**). Rendering is local FFmpeg, so it costs nothing.

## The pipeline

```
Your footage (videos + photos + optional music + optional transcript/brief)
      │
      ▼  ffprobe + frame sampling (local, free)
Probe & sample footage
      │
      ▼  AI vision — steered by your brief
Analyze every video & photo
      │
      ▼
Score every moment (1–10 commercial appeal)
      │
      ▼  AI planning — uses transcripts/notes for context
Generate editing plan: clip order, in/out points, per-clip transition +
      color effect + camera motion, kinetic titles/captions, music pick
      │
      ▼  FFmpeg (local, free): cuts, varied xfade transitions, Ken Burns +
      │  zoom/pan motion, color looks, animated text overlays, music bed
      ▼
Final clips — 9:16 Reel · 1:1 Square · 16:9 Landscape
```

Only small sampled frames (≤768px JPEGs) are sent to the model, so analysis costs cents; everything else is local.

## What the AI decides (for variety, not repetition)

- **Creative brief / prompt** — a free-text box that steers moment-picking, titles, captions, and music toward your intent (e.g. *"hype recap for LinkedIn, focus on the keynote and crowd energy"*).
- **Transcripts & notes** — drop a `.txt` / `.srt` / `.vtt` / `.md`; the model uses it as context to pick the right moments and write accurate captions.
- **Per-clip effects** — each clip gets its own transition, color look (`vivid`, `warm`, `cool`, `bw`, `dreamy`, `retro`, `punch`, …), and camera motion (`zoom_in/out`, `pan_left/right/up`). Back-to-back repeats are actively avoided so the montage feels dynamic.
- **Music recommendation** — suggests a royalty-free track (mood / genre / BPM / energy) with one-click search links to free libraries (Pixabay, YouTube Audio Library, Uppbeat, Free Music Archive, Chosic). Drop the track you like back in as the music bed.
- **Kinetic text** — titles and captions animate (slide-up, slide-in, float) with rich looks (gradient fill, outline, lower-third bar), rendered crisply in your browser — not flat overlays.

## Requirements

- Node.js ≥ 20
- FFmpeg (`brew install ffmpeg`)
- An AI connection — any **one** of:
  - **Your logged-in Claude app** (the `claude` CLI) — used automatically, no key, no extra cost beyond your subscription. *(default)*
  - A **Claude API key** (console.anthropic.com).
  - **Any OpenAI-compatible endpoint** — ChatGPT/OpenAI, or a custom base URL + key.

## Run

```bash
npm install
npm start
# open http://localhost:4173
```

## How to use (lazy mode)

1. Drop videos/photos onto the page. Optionally drop an mp3/m4a as the music bed, or a transcript (`.txt`/`.srt`/`.vtt`) for context.
2. *(Optional)* type a **creative brief** and pick a vibe/length in the **Style** card.
3. Hit **✨ Make my clips**. (If you're logged into the Claude app, that's it — no key.)
4. Watch the pipeline, then download your clips. A suggested-music card appears with search links.

## Bring your own model (BYOD / BYOK)

Open the **⚙️ gear** (top right) → **AI provider**:

| Provider | What you enter | Notes |
|---|---|---|
| **Claude app (default)** | nothing | Uses your logged-in `claude` CLI. Free beyond your subscription. |
| **Claude API key** | your `sk-ant-…` key + model | Anthropic API (Opus 4.8 / Sonnet 5 / Haiku 4.5). |
| **OpenAI-compatible** | Base URL + model + key | ChatGPT/OpenAI, or **any `/v1/chat/completions` endpoint**. |

The **OpenAI-compatible** option works with OpenAI, **OpenRouter, Together, Groq, LM Studio, Ollama, vLLM, LocalAI** — anything speaking the OpenAI format. Set the base URL (default `https://api.openai.com/v1`), a **vision-capable model** (e.g. `gpt-4o`, `gpt-4.1`, or a local `llava`/`qwen2-vl`), and your key. The app requests JSON output and tolerantly parses it, and auto-adjusts for servers that want `max_completion_tokens` or don't support JSON mode.

Hit **Test connection** to verify before running. **All keys are stored only in your browser's `localStorage`** and sent straight to the provider you chose — nothing is written to disk or committed. Resolution order when set on the server: a key you enter → server `ANTHROPIC_API_KEY` env → your Claude app.

## Options (Style card)

| Setting | Default | Notes |
|---|---|---|
| Clip length | ~30s | 15–60s |
| Vibe | Energetic | steers the edit, effects, and transition style |
| Event title | — | seeds the opening title |
| Creative brief | — | free-text prompt that steers the whole edit |
| Formats | Reel + Landscape | Square 1:1 also available |
| Music | none | uploaded audio replaces original sound (fade in/out); optionally mixed under it |

## Privacy & cost

- **Local & free** except the model call: FFmpeg rendering, framing, and file handling never leave your machine.
- Only downscaled sampled frames go to the model, using **your** key/subscription.
- No credentials are stored on disk or in the repo — keys live in your browser only. `data/` (uploads, outputs, registry) is git-ignored.

## Contributing & feedback

Ideas and bug reports are very welcome 🙌

- **Have an idea to make it better?** Open an [issue](../../issues/new) describing it, or start a [discussion](../../discussions).
- **Found a bug?** Open an [issue](../../issues/new) — include your OS, the FFmpeg version (`ffmpeg -version`), the provider you used (Claude app / Claude API / OpenAI-compatible), and the console/pipeline log if you have it. **Please don't paste API keys or other secrets.**
- **Want to contribute code?** Fork the repo, make your change on a branch, and open a pull request.

No account or key is needed just to browse, file an issue, or suggest a feature.

## License

MIT — do what you like; no warranty.
