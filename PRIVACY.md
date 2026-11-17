# Privacy

- **No telemetry**, no analytics, no account, no API keys.
- **Nothing you watch is sent to any third-party service.** Frames and transcripts go only to
  your own Claude Code session.

## Network activity

The plugin itself only reaches the network to:

- download YouTube videos and their captions with `yt-dlp`, when you give it a YouTube URL;
- download a Whisper model from HuggingFace once, on first use, if you use whisper.cpp
  (`openai-whisper` downloads its own model the same way).

## Local files

- `~/.claude-video-vision/config.json` — optional settings
- `~/.claude-video-vision/downloads/` — downloaded YouTube videos, removed after
  `downloads_max_age_days` (default 7)
- `~/.claude-video-vision/models/` — Whisper models
- `~/.claude-video-vision/notes/` — the notes Claude writes about videos it watched
- `~/.claude-video-vision/sessions/` — frame cache, only when `enable_index` is on
- the OS temp directory — frames and audio for one call, deleted afterwards
