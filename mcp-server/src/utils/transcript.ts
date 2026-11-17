import { join } from "path";
import { homedir } from "os";
import { extractAudio } from "../extractors/audio.js";
import { detectWhisperEngine, transcribeWithWhisper } from "../backends/local.js";
import { buildCaptionAudioResult, getCaptionFallbackReason, type ResolvedVideoInput } from "./video-source.js";
import type { AudioResult, WhisperModel } from "../types.js";

const MODEL_DIR = join(homedir(), ".claude-video-vision", "models");

/**
 * Transcript for a video window, using only what is on this machine:
 * 1. YouTube captions (uploader's subtitles, then auto-captions)
 * 2. local Whisper, if installed (whisper.cpp's whisper-cli, or openai-whisper)
 * 3. nothing, with a note saying why
 * Timestamps are relative to startTime; callers shift them onto the video timeline.
 */
export async function getTranscript(
  resolved: ResolvedVideoInput,
  durationSeconds: number,
  options: { startTime?: string; endTime?: string; workDir: string; whisperModel: WhisperModel },
): Promise<AudioResult> {
  const { startTime, endTime, workDir, whisperModel } = options;
  const range = { startTime, endTime };
  const captionProblem = resolved.source?.type === "youtube"
    ? getCaptionFallbackReason(resolved.captions, durationSeconds)
    : "local file has no captions";

  if (captionProblem === null && resolved.captions) {
    return buildCaptionAudioResult(resolved.captions, range);
  }

  const engine = await detectWhisperEngine();
  if (engine) {
    const wavPath = await extractAudio(resolved.path, join(workDir, "audio"), range);
    const result = await transcribeWithWhisper(wavPath, { engine, model: whisperModel, modelDir: MODEL_DIR });
    return { ...result, transcript_note: `${captionProblem}; transcribed locally with Whisper` };
  }

  // Partial captions beat no transcript at all.
  if (resolved.captions && resolved.captions.transcription.length > 0) {
    return { ...buildCaptionAudioResult(resolved.captions, range), transcript_note: `${captionProblem}; local Whisper not installed` };
  }

  return {
    backend: "none",
    transcription: [],
    transcript_note: `${captionProblem}; install local Whisper (pip install openai-whisper) to transcribe the audio`,
  };
}
