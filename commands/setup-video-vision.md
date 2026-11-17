---
description: "Check that claude-video-vision's dependencies are installed (ffmpeg, yt-dlp, optional local Whisper)"
---

# Setup Video Vision

There is nothing to configure: everything runs locally, with no API keys or accounts.

1. Call `video_setup` and show the user its report.
2. If something is missing, give the user the install command from the report, and remind them to
   restart Claude Code afterwards so the new commands are on PATH.
3. If local Whisper is missing, explain the trade-off in one line: without it, YouTube videos
   without captions and local video files get frames but no transcript. It is optional.
