---
description: "Watch and analyze a video file or YouTube URL — extracts frames and audio for understanding"
argument-hint: "path/to/video.mp4 or YouTube URL [optional prompt or question about the video]"
---

# Watch Video

Parse the user's input to extract:
1. **Video path** — the file path (required)
   - YouTube URLs are also supported; pass the URL directly as `path`
2. **Prompt** — any question or instruction about the video (optional)
3. **Flags** — `--fps <number>`, `--resolution <number>` (optional)

Then follow the **video-perception** skill's workflow in order: check the notes file, call
`video_info`, then pick ONE path:

- **No prompt, or a question about the video as a whole** → Path A: `video_watch` with
  `fps: "keyframes"`, no `video_analyze`.
- **A question about a specific moment or visual property** → Path B: `video_analyze` (videos > 30s),
  then `video_watch` with segments, then `video_detail` to drill in.

If the user passed `--fps` or `--resolution`, use them instead of the skill's defaults.

Then:
1. If the user provided a prompt/question, answer it based on the video content.
2. If no prompt was provided, give a comprehensive summary of what happens in the video.
3. Write or update the notes file as the skill describes.

If `video_watch` fails with a setup error, call `video_setup` first, then retry.
