import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import type { VideoMetadata, Frame, FrameFormat, Segment } from "../types.js";
import { formatHMS, parseHMS } from "../utils/timestamps.js";

const execFileAsync = promisify(execFile);

export async function getVideoMetadata(videoPath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    videoPath,
  ]);

  const probe = JSON.parse(stdout);
  const videoStream = probe.streams.find((s: any) => s.codec_type === "video");
  const audioStream = probe.streams.find((s: any) => s.codec_type === "audio");
  const format = probe.format;

  const durationSec = parseFloat(format.duration || videoStream?.duration || "0");
  const minutes = Math.floor(durationSec / 60);
  const seconds = Math.floor(durationSec % 60);
  const duration = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  const fileSizeBytes = parseInt(format.size || "0", 10);
  const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(1);

  const fpsStr = videoStream?.r_frame_rate || "30/1";
  const [num, den] = fpsStr.split("/").map(Number);
  const originalFps = Math.round(num / (den || 1));

  return {
    duration,
    duration_seconds: durationSec,
    resolution: `${videoStream?.width || 0}x${videoStream?.height || 0}`,
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    codec: videoStream?.codec_name || "unknown",
    original_fps: originalFps,
    file_size: `${fileSizeMB}MB`,
    has_audio: !!audioStream,
  };
}

export function calculateAutoFps(durationSeconds: number): number {
  if (durationSeconds < 60) return 2;
  if (durationSeconds < 300) return 1;
  if (durationSeconds < 900) return 0.5;
  if (durationSeconds < 3600) return 0.2;
  return 0.1;
}

export interface ExtractFramesOptions {
  fps: number;
  resolution: number;
  outputDir: string;
  format?: FrameFormat;
  startTime?: string;
  endTime?: string;
  maxFrames?: number;
}

export function frameFormatExtension(format: FrameFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function frameFormatMimeType(format: FrameFormat): string {
  return `image/${format}`;
}

function frameQualityArgs(format: FrameFormat): string[] {
  if (format === "jpeg") return ["-q:v", "5"];
  if (format === "webp") return ["-quality", "80"];
  return [];
}

function isMissingWebpEncoderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("codec webp") &&
    (message.includes("encoder not found") ||
      message.includes("error selecting an encoder") ||
      message.includes("encoder for format image2") ||
      message.includes("disabled"))
  );
}

async function runFfmpeg(args: string[], format: FrameFormat): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
    return stderr;
  } catch (error) {
    if (format === "webp" && isMissingWebpEncoderError(error)) {
      throw new Error(
        "WebP frame extraction requires an ffmpeg build with a WebP encoder (libwebp). " +
          "Use frame_format='jpeg' or frame_format='png', or install an ffmpeg build such as ffmpeg-full.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions,
): Promise<Frame[]> {
  const {
    fps,
    resolution,
    outputDir,
    format = "jpeg",
    startTime,
    endTime,
    maxFrames = 100,
  } = options;
  const extension = frameFormatExtension(format);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const args: string[] = [];

  if (startTime) {
    args.push("-ss", startTime);
  }

  args.push("-i", videoPath);

  // With -ss as an input option ffmpeg resets timestamps to 0, so an output
  // -to would act as a duration. Pass the window length explicitly instead.
  if (endTime) {
    const durationSeconds = parseHMS(endTime) - (startTime ? parseHMS(startTime) : 0);
    args.push("-t", String(durationSeconds));
  }

  args.push(
    "-vf", `fps=${fps},scale=${resolution}:-1`,
    "-frames:v", String(maxFrames),
    ...frameQualityArgs(format),
    join(outputDir, `frame_%04d.${extension}`),
  );

  await runFfmpeg(args, format);

  const files = readdirSync(outputDir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(`.${extension}`))
    .sort();

  const offsetSeconds = startTime ? parseHMS(startTime) : 0;

  return files.map((file, index) => {
    const filePath = join(outputDir, file);
    const imageData = readFileSync(filePath);
    const base64 = imageData.toString("base64");
    const timestamp = formatHMS(offsetSeconds + index / fps);

    return {
      timestamp,
      image: base64,
      format,
      sourcePath: filePath,
    };
  });
}

// ---------------------------------------------------------------------------
// Keyframe extraction: one frame per visual change instead of a fixed rate
// ---------------------------------------------------------------------------

export const DEFAULT_SCENE_THRESHOLD = 0.1;
/** Minimum spacing between change-triggered frames: stops bursts on fast cuts and same-second timestamp collisions. */
const MIN_SCENE_SPACING_SECONDS = 2;

/** Default max gap between keyframes: ~50 gap frames over the window, clamped to 15-120 s. */
export function defaultMaxGapSeconds(windowSeconds: number): number {
  return Math.min(120, Math.max(15, Math.round(windowSeconds / 50)));
}

/**
 * ffmpeg filter chain for keyframe selection. Input is I-frames only (-skip_frame nokey),
 * typically 2-5 s apart, so fades and animated transitions register as changes.
 * - mpdecimate drops frames nearly identical to the previous one (static slides, pauses)
 * - select keeps the first frame, each scene change (at most one per 2 s), and at least
 *   one frame every maxGapSeconds of non-static video
 * - showinfo logs pts_time of each kept frame; setpts then renumbers so the image muxer
 *   writes one file per kept frame (portable alternative to -fps_mode vfr, which needs ffmpeg 5.1+)
 */
export function keyframeFilter(resolution: number, sceneThreshold: number, maxGapSeconds: number, prefilter = ""): string {
  return (
    `${prefilter}scale=${resolution}:-2,mpdecimate,` +
    `select='isnan(prev_selected_t)` +
    `+gt(scene,${sceneThreshold})*gte(t-prev_selected_t,${MIN_SCENE_SPACING_SECONDS})` +
    `+gte(t-prev_selected_t,${maxGapSeconds})',` +
    `showinfo,setpts=N/FRAME_RATE/TB`
  );
}

export function parseShowinfoTimes(stderr: string): number[] {
  return [...stderr.matchAll(/Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
}

export interface ExtractKeyframesOptions {
  resolution: number;
  outputDir: string;
  format?: FrameFormat;
  startTime?: string;
  endTime?: string;
  maxFrames?: number;
  sceneThreshold?: number;
  maxGapSeconds: number;
  /** Length of the window being scanned; used to detect when I-frames are too sparse. */
  windowSeconds: number;
}

// shortcut: dedupe only compares consecutive frames, so cutting back to an earlier slide yields a second copy; add perceptual hashing if that proves costly.
export async function extractKeyframes(
  videoPath: string,
  options: ExtractKeyframesOptions,
): Promise<Frame[]> {
  const {
    resolution,
    outputDir,
    format = "jpeg",
    startTime,
    endTime,
    maxFrames = 100,
    sceneThreshold = DEFAULT_SCENE_THRESHOLD,
    maxGapSeconds,
    windowSeconds,
  } = options;

  // Fast path: decode I-frames only (~40x faster). If the window holds too few I-frames
  // (narrow window, long-GOP recording), redo it decoding everything, sampled at 1 fps.
  const minExpected = Math.max(1, Math.floor(windowSeconds / maxGapSeconds / 2));
  try {
    const frames = await runKeyframePass(videoPath, options, true);
    if (frames.length >= Math.min(minExpected, maxFrames)) return frames;
  } catch {
    // ffmpeg fails outright when no I-frame falls inside the window; the fallback handles it.
  }
  rmSync(outputDir, { recursive: true, force: true });
  return runKeyframePass(videoPath, options, false);
}

async function runKeyframePass(
  videoPath: string,
  options: ExtractKeyframesOptions,
  iFramesOnly: boolean,
): Promise<Frame[]> {
  const {
    resolution,
    outputDir,
    format = "jpeg",
    startTime,
    endTime,
    maxFrames = 100,
    sceneThreshold = DEFAULT_SCENE_THRESHOLD,
    maxGapSeconds,
  } = options;
  const extension = frameFormatExtension(format);

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const args: string[] = ["-nostats"];
  if (iFramesOnly) args.push("-skip_frame", "nokey");
  if (startTime) args.push("-ss", startTime);
  args.push("-i", videoPath);
  if (endTime) {
    const durationSeconds = parseHMS(endTime) - (startTime ? parseHMS(startTime) : 0);
    args.push("-t", String(durationSeconds));
  }
  args.push(
    "-an",
    "-vf", keyframeFilter(resolution, sceneThreshold, maxGapSeconds, iFramesOnly ? "" : "fps=1,"),
    "-frames:v", String(maxFrames),
    ...frameQualityArgs(format),
    join(outputDir, `frame_%04d.${extension}`),
  );

  const times = parseShowinfoTimes(await runFfmpeg(args, format));

  const files = readdirSync(outputDir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(`.${extension}`))
    .sort();

  // showinfo may log a trailing frame past -frames:v, never fewer than were written.
  if (times.length < files.length) {
    throw new Error(`Keyframe timestamps missing: ${files.length} frames written but ${times.length} timestamps parsed from ffmpeg.`);
  }

  const offsetSeconds = startTime ? parseHMS(startTime) : 0;

  return files.map((file, index) => {
    const filePath = join(outputDir, file);
    return {
      timestamp: formatHMS(offsetSeconds + times[index]),
      image: readFileSync(filePath).toString("base64"),
      format,
      sourcePath: filePath,
    };
  });
}

// ---------------------------------------------------------------------------
// Segment-based frame extraction
// ---------------------------------------------------------------------------

export interface SegmentFrame extends Frame {
  resolution: number;
}

/**
 * Generates HH:MM:SS timestamp strings for every sample point within a
 * segment according to the segment's fps setting.
 *
 * The range is [start, end) — the end boundary is exclusive so that a segment
 * ending exactly at the next segment's start time never overlaps.
 */
export function generateTimestampsForSegment(segment: Segment): string[] {
  const startSec = parseHMS(segment.start);
  const endSec = parseHMS(segment.end);
  const interval = 1 / segment.fps;
  const timestamps: string[] = [];

  for (let t = startSec; t < endSec; t += interval) {
    timestamps.push(formatHMS(Math.round(t)));
  }

  return timestamps;
}

/**
 * Extracts frames for an ordered list of segments, each potentially at a
 * different resolution and fps.  Each segment is written into its own fresh
 * sub-directory (under one named after its resolution): ffmpeg numbers output
 * from frame_0001 on every run, and extractFrames returns every frame_* file
 * in its output directory, so a shared directory would mix segments together.
 */
export async function extractFramesBySegments(
  videoPath: string,
  segments: Segment[],
  baseOutputDir: string,
  format: FrameFormat = "jpeg",
): Promise<SegmentFrame[]> {
  const allFrames: SegmentFrame[] = [];

  for (const segment of segments) {
    const resolution = segment.resolution ?? 512;
    const resDir = join(baseOutputDir, String(resolution));

    if (!existsSync(resDir)) mkdirSync(resDir, { recursive: true });
    const segmentDir = mkdtempSync(join(resDir, "seg-"));

    const frames = await extractFrames(videoPath, {
      fps: segment.fps,
      resolution,
      outputDir: segmentDir,
      format,
      startTime: segment.start,
      endTime: segment.end,
      maxFrames: 1000,
    });

    for (const frame of frames) {
      allFrames.push({ ...frame, resolution });
    }
  }

  return allFrames;
}
