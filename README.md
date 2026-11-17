# YouTube Watcher

Give Claude Code the ability to **watch and understand videos**: it sees the frames and reads a
timestamped transcript, so it gets the visuals behind the words, not just the words.

Everything runs on your machine. No API keys, no accounts, no cloud services.

A fork of [claude-video-vision](https://github.com/jordanrendric/claude-video-vision) by Jordan
Vasconcelos (MIT), rebuilt around low token cost and local-only processing.

## What's different from upstream

- **Keyframes mode** — `video_watch` with `fps: "keyframes"` takes one frame per visual change
  (new slide, cut, diagram appearing) instead of a fixed rate. On a 19-minute lecture: 64 frames
  covering the whole video, extracted in 0.3 s, instead of 100 frames that stop at 8:20.
- **Compact transcripts** — YouTube's rolling auto-captions are de-duplicated and sent as
  `[HH:MM:SS] text` lines: ~5k tokens instead of ~35k for the same 19 minutes.
- **Local-only** — the transcript comes from YouTube captions, else local Whisper if installed.
  The Gemini and OpenAI backends are gone.
- **Persistent notes** — after watching, Claude writes a notes file per video
  (`~/.claude-video-vision/notes/<video id>.md`) and reads it first next time.
- **720p H.264 downloads** — enough for frames at 1024 px, fast to decode everywhere.

## Install

1. Dependencies:

   | | Windows | macOS | Linux |
   |---|---|---|---|
   | Node.js 24+ | `winget install OpenJS.NodeJS.LTS` | `brew install node` | your package manager |
   | ffmpeg (required) | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |
   | yt-dlp (YouTube URLs) | `winget install yt-dlp.yt-dlp` | `brew install yt-dlp` | `pipx install yt-dlp` |
   | Whisper (optional) | `pip install openai-whisper` | `brew install whisper-cpp` | `pip install openai-whisper` |

2. Build the MCP server:

   ```bash
   cd mcp-server && npm ci && npx tsc
   ```

3. Load the plugin:

   ```bash
   claude --plugin-dir /path/to/youtube-watcher
   ```

4. Check everything is found: `/claude-video-vision:setup-video-vision`.

There is nothing to configure.

## Usage

```
/watch-video https://www.youtube.com/watch?v=... "summarize this video"
/watch-video path/to/video.mp4 "what is on screen at 1:30?"
```

Or just mention a video file or YouTube URL in conversation.

Claude picks one of two paths:
- **Whole video** (summaries, notes, lectures): keyframes + transcript in one call.
- **Targeted question** (a moment, a visual detail): `video_analyze` to find where to look, then
  frames for those segments, then `video_detail` to zoom in.

## Transcripts

1. YouTube manual subtitles, then YouTube auto-captions.
2. Local Whisper, if installed — for videos without captions and for local files. `whisper-cli`
   (whisper.cpp) is preferred when found, else `whisper` (openai-whisper). The model is chosen
   automatically: `base` without a GPU, `large-v3-turbo` with one. Models download once to
   `~/.claude-video-vision/models/`.
3. Otherwise frames only, and Claude is told why there is no transcript.

## MCP tools

- `video_watch` — frames + transcript (main tool)
- `video_analyze` — scene changes, silence, motion, etc. before extracting frames
- `video_detail` — drill into specific moments
- `video_info` — metadata only
- `video_configure` — change settings
- `video_setup` — check what is installed

## Configuration

Optional, in `~/.claude-video-vision/config.json`:

```json
{
  "whisper_model": "auto",
  "frame_mode": "images",
  "frame_format": "jpeg",
  "frame_resolution": 512,
  "default_fps": "auto",
  "max_frames": 100,
  "frame_describer_model": "sonnet",
  "enable_index": false,
  "session_max_age_days": 7,
  "downloads_max_age_days": 7
}
```

`frame_format` can be `jpeg`, `png` (lossless, good for screen recordings) or `webp`.

## Development

```bash
cd mcp-server
npm ci
npx tsc --noEmit
npx vitest run
```

## License

MIT — see [LICENSE](./LICENSE). Original work © Jordan Vasconcelos.
