---
name: video-perception
description: Use when the user mentions a video file (.mp4, .mov, .avi, .mkv, .webm), a YouTube URL, asks to watch/analyze/review a video, or references video content in conversation
---

# Video Perception

You have access to video understanding tools via the claude-video-vision MCP server.

## Available Tools

- `video_analyze` — Analyze video structure with ffmpeg filters (scene changes, silence, motion, etc.). Use this BEFORE extracting frames to plan your strategy.
- `video_watch` — Extract frames + process audio from a video. Supports variable FPS/resolution per segment.
- `video_detail` — Drill into specific segments. Separates extraction from viewing — extract many frames, view few at a time.
- `video_info` — Get video metadata without processing.
- `video_configure` — Change settings (resolution, max_frames, whisper_model, enable_index, etc.).
- `video_setup` — Check what is installed (ffmpeg, yt-dlp, optional local Whisper).

## Workflow

**Follow these steps in order.**

0. **Check your notes first.** Notes live in `.claude-video-vision/notes/` under the user's home
   directory (`%USERPROFILE%` on Windows, `$HOME` elsewhere); always use the absolute path, since
   `~` is not expanded by file tools. The file is `<key>.md`, where `<key>` is the YouTube video ID
   (e.g. `dQw4w9WgXcQ`) or, for a local file, its name without extension.
   - YouTube: if the file exists, answer from it where it covers the question.
   - Local file: names collide, so first run step 1 and check that the notes' source path and
     duration match `video_info`. If they don't, ignore the file.
   Extract frames only for what the notes do not cover, then add what you learn to the file.

1. Always start with `video_info` to get duration, resolution, and audio presence.
   If the user gives a YouTube URL, pass the URL directly as `path`.
   The MCP server downloads it with `yt-dlp`. Everything runs locally: the transcript comes from
   YouTube subtitles/auto-captions, else from local Whisper if it is installed. If the audio result
   has a `transcript_note`, the transcript is missing or partial: tell the user why, and rely on
   the frames for what the transcript does not cover.

2. **Pick ONE path:**

   **Path A — understand the whole video** (summarize, take notes, "what does this video show",
   lectures, tutorials, talks): call `video_watch` with `fps: "keyframes"` and no `video_analyze`.
   Keyframes does its own change detection and `video_watch` returns the transcript, so analyzing
   first would decode the video twice and put the transcript in context twice. Then go to step 5.

   **Path B — a targeted question** (a specific moment, a visual property, a short clip, "the first
   second", frozen parts, lighting): continue with steps 3-4.

3. **(Path B, videos > 30s)** Call `video_analyze` BEFORE extracting any frames.
   It gives you structural data to make smart extraction decisions.
   Select filters relevant to the user's question:

   | User intent | Filters to select |
   |---|---|
   | "What happens in this video?" | scene_changes, silence, transcription |
   | "Find the scene transitions" | scene_changes, black_intervals |
   | "Are there frozen/stuck parts?" | freeze, blur |
   | "Is this a talking head or action?" | motion |
   | "When does the music start?" | silence, loudness |
   | "Analyze the lighting" | exposure |
   | General / unclear intent | scene_changes, silence, transcription |

   Always include `transcription: true` when the video has audio — the transcription
   tells you WHERE to look visually.

   `scene_changes: true` reports hard cuts (scdet score >= 8). If the user needs softer
   transitions (dissolves, slow fades), pass `scene_changes: { threshold: 4 }`; if
   handheld or fast-moving footage floods the list, raise it (e.g. `{ threshold: 15 }`).

4. **(Path B)** Plan and run `video_watch` from the analysis and transcription:
   - Low FPS (0.1-0.5) for static or predictable segments
   - Higher FPS (1-3) only around scene changes, motion peaks, or moments
     referenced in speech ("look at this", "as you can see", "let me show you")
   - Never exceed the minimum FPS needed for the task
   - Prefer fewer segments at lower FPS — you can always drill deeper
   - **Short videos (< 2 minutes):** `fps: "auto"` without `view_sample` — full coverage so brief moments aren't missed.
   - **Long videos (> 2 minutes):** `segments` with variable FPS, and `view_sample` to limit the initial frame count.

   **Keyframes details (Path A):** you get one frame per visual change (new slide, cut, diagram
   appearing, at most one per 2 s) plus one every `max_gap` seconds while the picture changes, with
   near-duplicates dropped. Lower `scene_threshold` (0.05) for slide decks with tiny edits; raise it
   (0.3-0.4) for handheld or fast-moving footage. If the result warns it was truncated, call again from
   the timestamp it gives with `skip_audio: true` — you already have the transcript.

5. Use `video_detail` to drill into specific moments (both paths — e.g. to read small on-screen text
   at 1024+ px after a keyframes overview):
   - Start with 3-5 second windows around points of interest
   - Use `view_sample: 3` to preview (first, middle, last frame)
   - Then request specific timestamps with `view` if you need more detail
   - Expand the window only if the initial view is insufficient
   - Treat frame viewing like a binary search — narrow down to what matters
   - Never view all extracted frames at once

6. When the user asks follow-up questions about the same video, consult
   the manifest already in your context. Do not re-extract frames you
   already have at the same resolution. Do not re-request frames you
   already have in context.

7. **Write notes after watching** (skip only for videos under a minute or one-off visual checks).
   Save to the absolute notes path from step 0 (same key), containing:
   - title, source URL or absolute path, duration, date watched
   - coverage: which time ranges you actually saw frames for, and at what resolution, so a later
     session can tell "not shown in the video" from "not looked at"
   - a timestamped outline: for each point, what is said AND what is shown
     (`[02:14] Explains cache eviction — slide: LRU diagram with 4 boxes, arrow from tail to head`)
   - any on-screen text, code, numbers or chart values worth keeping verbatim
   Describe visuals in words: the frames are not kept, so the notes must stand without them.

## Parameter Guide

**fps:** `"keyframes"` for a whole-video overview at the lowest cost. `"auto"` for a uniform sample. Use the video's original fps (from `video_info`) for frame-by-frame detail. Use 5-10 for analyzing specific short moments. Use 0.1-0.5 for long videos.

**resolution:** 256-512 for quick scans. 512-768 for normal analysis. 1024+ when reading on-screen text or fine details.

**segments:** Use when you have analysis data. Each segment can have its own fps and resolution. Overrides global fps/start_time/end_time.

**view_sample:** Returns N evenly spaced frames from the extracted set. Use this to avoid flooding context with too many images.

**skip_audio:** Set to true when you only need visual analysis.

**YouTube URLs:** Pass supported YouTube URLs directly as `path`. Treat
`transcription_source: "youtube_subtitles"` as stronger than
`youtube_auto_captions`; auto-captions can still have recognition errors.

## Working with Results

You receive:
- **Manifest** (when enable_index is on) — index of all cached frames by resolution and timestamp. Use this to avoid redundant requests.
- **Frames** as images — look at them to understand what's happening visually
- **Audio transcription** with timestamps — read the speech content
- **Analysis data** — scene changes, silence intervals, motion levels, etc.

Combine all sources to form a complete understanding. Use analysis + transcription to guide where you look visually. The analysis tells you WHEN things happen; the frames tell you WHAT happens.
