import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, resolve, join } from "path";
import { promisify } from "util";
import type { AudioResult, TranscriptionSegment } from "../types.js";
import { formatHMS, parseHMS } from "./timestamps.js";

const execFileAsync = promisify(execFile);

const DOWNLOADS_DIR = join(homedir(), ".claude-video-vision", "downloads");

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const MAX_DESCRIPTION_CHARS = 4000;

function validateRegularFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${filePath}`);
  }
  return filePath;
}

export interface VideoSourceMetadata {
  type: "youtube";
  url: string;
  title?: string;
  channel?: string;
  duration?: string;
  upload_date?: string;
  view_count?: number;
  description?: string;
  caption_track?: YouTubeCaptionTrackMetadata;
}

export interface ResolvedVideoInput {
  path: string;
  source?: VideoSourceMetadata;
  captions?: YouTubeCaptionResult;
}

export interface YouTubeCaptionTrackMetadata {
  source: "subtitles" | "automatic_captions";
  language: string;
  language_name?: string;
}

export interface YouTubeCaptionResult extends YouTubeCaptionTrackMetadata {
  transcription: TranscriptionSegment[];
  coverage_seconds: number;
}

export function isYouTubeUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (url.protocol === "http:" || url.protocol === "https:") && YOUTUBE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function validateVideoPath(inputPath: string): string {
  return validateRegularFile(resolve(inputPath));
}

function cachePrefixForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function truncateDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  return `${value.slice(0, MAX_DESCRIPTION_CHARS)}\n\n[description truncated]`;
}

function parseSubtitleTimestamp(raw: string): number {
  const match = raw.trim().match(/(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function decodeSubtitleText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSubtitleContent(raw: string): TranscriptionSegment[] {
  const normalized = raw.replace(/\r/g, "");
  const blocks = normalized.split(/\n{2,}/);
  const transcription: TranscriptionSegment[] = [];
  let previousLines: string[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim());
    if (!startRaw || !endRaw) continue;

    // YouTube auto-captions roll: each cue repeats the previous cue's lines before adding a new one.
    // Keep only lines the previous cue did not show, or the transcript triples in size.
    const cueLines = lines.slice(timingIndex + 1).map(decodeSubtitleText).filter(Boolean);
    const text = cueLines.filter((line) => !previousLines.includes(line)).join(" ");
    previousLines = cueLines;
    if (!text) continue;

    transcription.push({
      start: formatHMS(parseSubtitleTimestamp(startRaw)),
      end: formatHMS(parseSubtitleTimestamp(endRaw)),
      text,
    });
  }

  return transcription;
}

export function cleanExpiredDownloads(downloadsDir: string, maxAgeDays: number): void {
  if (!existsSync(downloadsDir)) return;

  const cutoff = Date.now() - maxAgeDays * 86400_000;
  for (const entry of readdirSync(downloadsDir)) {
    const filePath = join(downloadsDir, entry);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) {
        rmSync(filePath, { force: true });
      }
    } catch {
      rmSync(filePath, { force: true });
    }
  }
}

function findDownloadedPath(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (existsSync(line) && statSync(line).isFile()) {
      return line;
    }
  }

  return null;
}

// Captions are written next to the video under the same name (`<prefix>-<id>.<lang>.srt`). With
// --no-overwrites a re-watch finds them on disk and never calls YouTube's rate-limited caption endpoint.
function captionArgs(track: YouTubeCaptionTrackMetadata): string[] {
  return [
    track.source === "subtitles" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    track.language,
    "--sub-format",
    "srt/vtt/best",
    // yt-dlp re-downloads subtitles by default and deletes the cached file when that request fails.
    "--no-overwrites",
  ];
}

function outputArgs(url: string): string[] {
  return ["--paths", DOWNLOADS_DIR, "-o", `${cachePrefixForUrl(url)}-%(id)s.%(ext)s`];
}

async function downloadYouTubeVideo(url: string, captionTrack: YouTubeCaptionTrackMetadata | null): Promise<string> {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--merge-output-format",
    "mp4",
    // Prefer ~720p (res = shorter side, so vertical Shorts get 720x1280) in H.264, which every
    // ffmpeg decodes fast; falls back to whatever exists. Keeps download and decode time down.
    "-f",
    "bv*+ba/b",
    "-S",
    "res:720,vcodec:h264,ext:mp4:m4a",
    ...outputArgs(url),
    "--print",
    "after_move:filepath",
  ];
  // Fetching captions in the same run reuses one YouTube session instead of opening a second one
  // in parallel, which is what got the caption request rate-limited (HTTP 429). --ignore-errors keeps
  // a failed caption download from failing the video download.
  if (captionTrack) args.push(...captionArgs(captionTrack), "--ignore-errors");
  args.push(url);

  let stdout = "";
  let failure: any = null;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", args, {
      timeout: 20 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    }));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error("yt-dlp is required for YouTube URLs but was not found. Run /setup-video-vision for installation instructions.");
    }
    // With --ignore-errors yt-dlp exits non-zero when only the captions failed; the video may be fine.
    stdout = typeof err?.stdout === "string" ? err.stdout : "";
    failure = err;
  }

  const downloadedPath = findDownloadedPath(stdout);
  if (!downloadedPath) {
    const detail = failure ? failure.stderr || failure.message || String(failure) : "yt-dlp did not report a downloaded file path";
    throw new Error(`Failed to download YouTube video with yt-dlp: ${detail}`);
  }
  return validateRegularFile(downloadedPath);
}

/** Reads the caption file yt-dlp wrote next to `videoPath`, if any. */
export function readCaptionsBesideVideo(
  videoPath: string,
  track: YouTubeCaptionTrackMetadata,
): YouTubeCaptionResult | null {
  const dir = dirname(videoPath);
  const stem = basename(videoPath).replace(/\.[^.]+$/, "");
  const file = readdirSync(dir).find(
    (name) => name.startsWith(`${stem}.`) && (name.endsWith(".srt") || name.endsWith(".vtt")),
  );
  if (!file) return null;
  const transcription = parseSubtitleContent(readFileSync(join(dir, file), "utf-8"));
  return { ...track, transcription, coverage_seconds: getTranscriptCoverageSeconds(transcription) };
}

function chooseCaptionTrack(data: Record<string, unknown>): YouTubeCaptionTrackMetadata | null {
  const subtitles = data.subtitles as Record<string, unknown> | undefined;
  const automaticCaptions = data.automatic_captions as Record<string, unknown> | undefined;

  const preferredLanguages = ["en", "en-orig", "en-US", "en-GB"];

  for (const language of preferredLanguages) {
    if (subtitles?.[language]) {
      return { source: "subtitles", language };
    }
  }

  for (const language of Object.keys(subtitles ?? {})) {
    if (language.startsWith("en")) {
      return { source: "subtitles", language };
    }
  }

  for (const language of preferredLanguages) {
    if (automaticCaptions?.[language]) {
      return { source: "automatic_captions", language };
    }
  }

  for (const language of Object.keys(automaticCaptions ?? {})) {
    if (language.startsWith("en")) {
      return { source: "automatic_captions", language };
    }
  }

  return null;
}

async function fetchYouTubeInfo(url: string): Promise<{
  source: VideoSourceMetadata;
  captionTrack: YouTubeCaptionTrackMetadata | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      ["--skip-download", "--no-playlist", "--dump-single-json", url],
      {
        timeout: 30_000,
        maxBuffer: 25 * 1024 * 1024,
        encoding: "utf-8",
      },
    );
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const captionTrack = chooseCaptionTrack(data);
    return {
      source: {
        type: "youtube",
        url,
        title: typeof data.title === "string" ? data.title : undefined,
        channel: typeof data.channel === "string" ? data.channel : undefined,
        duration: typeof data.duration_string === "string" ? data.duration_string : undefined,
        upload_date: typeof data.upload_date === "string" ? data.upload_date : undefined,
        view_count: typeof data.view_count === "number" ? data.view_count : undefined,
        description: truncateDescription(data.description),
        caption_track: captionTrack ?? undefined,
      },
      captionTrack,
    };
  } catch {
    return { source: { type: "youtube", url }, captionTrack: null };
  }
}

const CAPTION_RETRY_DELAY_MS = 5_000;

/** Captions for a downloaded video: from disk, else one delayed retry (YouTube's 429s are short-lived). */
async function getYouTubeCaptions(
  url: string,
  videoPath: string,
  track: YouTubeCaptionTrackMetadata | null,
): Promise<YouTubeCaptionResult | null> {
  if (!track) return null;
  const cached = readCaptionsBesideVideo(videoPath, track);
  if (cached) return cached;

  await new Promise((done) => setTimeout(done, CAPTION_RETRY_DELAY_MS));
  try {
    await execFileAsync(
      "yt-dlp",
      ["--skip-download", "--no-playlist", "--no-warnings", "--restrict-filenames", ...captionArgs(track), ...outputArgs(url), url],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" },
    );
  } catch {
    // Still rate-limited or no track: the caller falls back to local Whisper.
  }
  return readCaptionsBesideVideo(videoPath, track);
}

export function getTranscriptCoverageSeconds(transcription: TranscriptionSegment[]): number {
  let maxEnd = 0;
  for (const segment of transcription) {
    try {
      maxEnd = Math.max(maxEnd, parseHMS(segment.end));
    } catch {
      // Ignore malformed timestamps from external captions.
    }
  }
  return maxEnd;
}

export function getCaptionFallbackReason(
  captions: YouTubeCaptionResult | undefined,
  durationSeconds: number,
): string | null {
  if (!captions) return "no YouTube caption track found";
  if (captions.transcription.length === 0) return "YouTube caption track was empty";
  const coverageRatio = durationSeconds > 0 ? captions.coverage_seconds / durationSeconds : 1;
  if (durationSeconds >= 30 && coverageRatio < 0.5) {
    return `YouTube captions cover only ${Math.round(coverageRatio * 100)}% of the video`;
  }
  return null;
}

export function buildCaptionAudioResult(
  captions: YouTubeCaptionResult,
  range?: { startTime?: string; endTime?: string },
): AudioResult {
  const startSeconds = range?.startTime ? parseHMS(range.startTime) : 0;
  const endSeconds = range?.endTime ? parseHMS(range.endTime) : Number.POSITIVE_INFINITY;

  const transcription = captions.transcription
    .map((segment) => {
      const segmentStart = parseHMS(segment.start);
      const segmentEnd = parseHMS(segment.end);
      if (segmentEnd < startSeconds || segmentStart > endSeconds) return null;
      return {
        ...segment,
        start: formatHMS(Math.max(0, segmentStart - startSeconds)),
        end: formatHMS(Math.max(0, segmentEnd - startSeconds)),
      };
    })
    .filter((segment): segment is TranscriptionSegment => segment !== null);

  return {
    backend: "youtube-captions",
    transcription,
    transcription_source: captions.source === "subtitles" ? "youtube_subtitles" : "youtube_auto_captions",
    transcription_source_detail: `${captions.language} (${captions.source})`,
  };
}

export async function resolveVideoInputDetailed(input: string): Promise<ResolvedVideoInput> {
  if (isYouTubeUrl(input)) {
    const info = await fetchYouTubeInfo(input);
    const path = await downloadYouTubeVideo(input, info.captionTrack);
    const captions = await getYouTubeCaptions(input, path, info.captionTrack);
    return { path, source: info.source, captions: captions ?? undefined };
  }

  if (/^https?:\/\//i.test(input)) {
    throw new Error("URL input currently supports YouTube URLs only. Download other videos locally first.");
  }

  return { path: validateVideoPath(input) };
}

export async function resolveVideoInput(input: string): Promise<string> {
  const resolvedInput = await resolveVideoInputDetailed(input);
  return resolvedInput.path;
}

export function getDownloadsDir(): string {
  return DOWNLOADS_DIR;
}
