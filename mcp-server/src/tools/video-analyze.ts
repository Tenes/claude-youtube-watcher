import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { resolveVideoInputDetailed } from "../utils/video-source.js";
import { getVideoMetadata } from "../extractors/frames.js";
import { formatTranscript } from "../utils/timestamps.js";
import { getTranscript } from "../utils/transcript.js";
import {
  buildAnalysisCommand,
  DEFAULT_SCDET_THRESHOLD,
  sceneChangeThreshold,
  runAnalysisCommand,
  parseScdetOutput,
  parseScdetFromMetaFile,
  parseBlackdetectOutput,
  parseSilenceOutput,
  parseFreezeOutput,
  parseSitiOutput,
  parseBlurOutput,
  parseSignalstatsOutput,
  parseEbur128Output,
  deriveContentProfile,
} from "../extractors/analyzers.js";
import {
  getSessionDir,
  loadManifest,
  saveManifest,
  computeVideoHash,
} from "../session/manager.js";
import { createManifest } from "../session/manifest.js";
import type { AnalysisFilters, VideoAnalysis, AudioResult } from "../types.js";


const CONFIG_PATH = join(homedir(), ".claude-video-vision", "config.json");
const SESSIONS_DIR = join(homedir(), ".claude-video-vision", "sessions");

export const sceneChangesSchema = z
  .union([
    z.boolean(),
    z.object({ threshold: z.number().min(0).max(100) }),
  ])
  .default(false)
  .describe(
    `Detect scene cuts (scdet). \`true\` keeps cuts scoring >= ${DEFAULT_SCDET_THRESHOLD} (hard cuts). ` +
    "Pass { threshold: N } (0-100) to tune: lower catches softer transitions but adds camera-motion noise, " +
    "higher keeps only the most abrupt cuts.",
  );

export function registerVideoAnalyze(server: McpServer): void {
  server.tool(
    "video_analyze",
    "Analyze local video file or YouTube URL structure using ffmpeg filters. Returns scene changes, silence intervals, motion levels, and more. Use this before video_watch to plan which segments need detailed frame extraction. Does not extract frames. If `analysis.transcript_note` is present, the transcript is missing or partial — tell the user why. If `analysis.incomplete` is present, the ffmpeg pass stopped early and filter results only cover the source up to `analysis.incomplete.analyzed_until` — tell the user instead of treating later sections as empty.",
    {
      path: z.string().describe("Absolute/relative path to the video file, or a YouTube URL"),
      filters: z.object({
        scene_changes: sceneChangesSchema,
        black_intervals: z
          .boolean()
          .default(false)
          .describe("Detect black frames/transitions (blackdetect)"),
        silence: z
          .boolean()
          .default(false)
          .describe("Detect silence intervals (silencedetect)"),
        freeze: z
          .boolean()
          .default(false)
          .describe("Detect frozen/still segments (freezedetect)"),
        motion: z
          .boolean()
          .default(false)
          .describe("Measure visual complexity and motion level (siti)"),
        blur: z
          .boolean()
          .default(false)
          .describe("Measure blur/sharpness per frame (blurdetect)"),
        exposure: z
          .boolean()
          .default(false)
          .describe("Measure brightness and saturation per frame (signalstats)"),
        loudness: z
          .boolean()
          .default(false)
          .describe("Measure audio loudness — speech vs music (ebur128)"),
        transcription: z
          .boolean()
          .default(false)
          .describe("Include the transcript: YouTube captions, else local Whisper if installed"),
      }),
    },
    async (params) => {
      const config = loadConfig(CONFIG_PATH);
      const resolved = await resolveVideoInputDetailed(params.path);
      const safePath = resolved.path;
      const filters = params.filters as AnalysisFilters;

      // 1. Get video metadata
      const metadata = await getVideoMetadata(safePath);

      // 2. Create temp work dir
      const workDir = join(tmpdir(), `cvv-analyze-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      let analysis: VideoAnalysis = {
        scenes: [],
        black_intervals: [],
        silence_intervals: [],
        freeze_intervals: [],
        frame_stats: [],
        content_profile: "unknown",
      };

      try {
        // 3. Build and run ffmpeg analysis command (all filters except transcription)
        const ffmpegFilters: AnalysisFilters = { ...filters, transcription: false };
        const cmd = buildAnalysisCommand(safePath, ffmpegFilters, workDir);

        let stderr = "";

        if (cmd !== null) {
          // 4. Run ffmpeg (tolerates non-zero exits; flags a timeout as incomplete)
          const run = await runAnalysisCommand(cmd.args, metadata.duration_seconds);
          stderr = run.stderr;
          if (run.incomplete) {
            analysis.incomplete = run.incomplete;
          }

          // 5. Parse scene changes from metadata file (scdet writes to frame metadata, not stderr)
          const scdetThreshold = sceneChangeThreshold(filters.scene_changes);
          if (scdetThreshold !== null && existsSync(cmd.videoMetaFile)) {
            const metaContent = readFileSync(cmd.videoMetaFile, "utf-8");
            analysis.scenes = parseScdetFromMetaFile(metaContent, scdetThreshold);
            if (analysis.scenes.length === 0) {
              analysis.scenes = parseScdetOutput(stderr, scdetThreshold);
            }
          } else if (scdetThreshold !== null) {
            analysis.scenes = parseScdetOutput(stderr, scdetThreshold);
          }

          if (filters.black_intervals) {
            analysis.black_intervals = parseBlackdetectOutput(stderr);
          }

          if (filters.silence) {
            analysis.silence_intervals = parseSilenceOutput(stderr);
          }

          if (filters.freeze) {
            analysis.freeze_intervals = parseFreezeOutput(stderr);
          }

          if (filters.loudness) {
            const loudness = parseEbur128Output(stderr);
            if (loudness !== undefined) {
              analysis.loudness_summary = loudness;
            }
          }

          // 6. Parse metadata files for per-frame filter data (blur, exposure)
          if (filters.motion) {
            const sitiData = parseSitiOutput(stderr);
            // sitiData yields aggregate averages — fold them into content_profile
            analysis.content_profile = deriveContentProfile(sitiData.siAvg, sitiData.tiAvg);
          }

          if (filters.blur && existsSync(cmd.videoMetaFile)) {
            const videoMetaContent = readFileSync(cmd.videoMetaFile, "utf-8");
            const blurData = parseBlurOutput(videoMetaContent);

            // Merge blur data into frame_stats
            for (const entry of blurData) {
              const existing = analysis.frame_stats.find(
                (fs) => fs.timestamp === entry.timestamp,
              );
              if (existing) {
                existing.blur = entry.blur;
              } else {
                analysis.frame_stats.push({ timestamp: entry.timestamp, blur: entry.blur });
              }
            }
          }

          if (filters.exposure && existsSync(cmd.videoMetaFile)) {
            const videoMetaContent = readFileSync(cmd.videoMetaFile, "utf-8");
            const exposureData = parseSignalstatsOutput(videoMetaContent);

            // Merge exposure data into frame_stats
            for (const entry of exposureData) {
              const existing = analysis.frame_stats.find(
                (fs) => fs.timestamp === entry.timestamp,
              );
              if (existing) {
                existing.brightness = entry.brightness;
                existing.saturation = entry.saturation;
              } else {
                analysis.frame_stats.push({
                  timestamp: entry.timestamp,
                  brightness: entry.brightness,
                  saturation: entry.saturation,
                });
              }
            }
          }

          // Sort frame_stats by timestamp for consistent output
          analysis.frame_stats.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }

        // 7. Handle transcription separately (not an ffmpeg filter)
        if (filters.transcription && metadata.has_audio) {
          const audioResult = await getTranscript(resolved, metadata.duration_seconds, {
            workDir,
            whisperModel: config.whisper_model,
          });
          analysis.transcription = audioResult.transcription;
          if (audioResult.transcript_note) analysis.transcript_note = audioResult.transcript_note;
        }

        // Ensure content_profile is set when motion filter was not requested
        if (!filters.motion) {
          analysis.content_profile = "unknown (motion filter not enabled)";
        }

        // 8. If enable_index, persist analysis to session manifest
        if (config.enable_index) {
          const videoHash = computeVideoHash(safePath);
          const sessionDir = getSessionDir(SESSIONS_DIR, safePath);
          let manifest = loadManifest(sessionDir);

          if (!manifest) {
            manifest = createManifest(videoHash, safePath);
          }

          manifest.analysis = analysis;
          saveManifest(sessionDir, manifest);
        }
      } finally {
        // 10. Cleanup temp work dir
        rmSync(workDir, { recursive: true, force: true });
      }

      // 11. Return JSON as text content; the transcript goes as timestamped lines (much cheaper than JSON)
      const { transcription, ...analysisRest } = analysis;
      const output = {
        ...(resolved.source ? { source: resolved.source } : {}),
        metadata,
        analysis: analysisRest,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output, null, 2) +
              (transcription && transcription.length > 0 ? `\n\n## Transcript\n${formatTranscript(transcription)}` : ""),
          },
        ],
      };
    },
  );
}
