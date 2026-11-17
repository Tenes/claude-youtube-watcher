import type { AudioResult, TranscriptionSegment } from "../types.js";

export function parseHMS(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid HH:MM:SS timestamp: ${timestamp}`);
  }
  const [h, m, s] = parts;
  return h * 3600 + m * 60 + s;
}

export function formatHMS(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Renders a transcript as `[HH:MM:SS] text` lines, merging consecutive segments into blocks of
 * about blockSeconds. Far cheaper in tokens than JSON with start/end/text per caption cue.
 */
export function formatTranscript(segments: TranscriptionSegment[], blockSeconds = 20): string {
  const lines: string[] = [];
  let blockStart: string | null = null;
  let texts: string[] = [];
  for (const segment of segments) {
    if (blockStart !== null && parseHMS(segment.start) - parseHMS(blockStart) >= blockSeconds) {
      lines.push(`[${blockStart}] ${texts.join(" ")}`);
      blockStart = null;
      texts = [];
    }
    blockStart ??= segment.start;
    texts.push(segment.text);
  }
  if (blockStart !== null) lines.push(`[${blockStart}] ${texts.join(" ")}`);
  return lines.join("\n");
}

/** Audio result as prompt text: compact JSON for the metadata, transcript as timestamped lines. */
export function formatAudioResult(result: AudioResult): string {
  const { transcription, ...rest } = result;
  const transcript = transcription.length > 0
    ? formatTranscript(transcription)
    : result.backend === "none" ? "(audio not transcribed)" : "(no speech detected)";
  return `${JSON.stringify(rest)}

### Transcript
${transcript}`;
}

export function shiftAudioResult(
  result: AudioResult,
  offsetSeconds: number,
): AudioResult {
  if (offsetSeconds === 0) {
    return result;
  }

  return {
    ...result,
    transcription: result.transcription.map((entry) => ({
      ...entry,
      start: formatHMS(parseHMS(entry.start) + offsetSeconds),
      end: formatHMS(parseHMS(entry.end) + offsetSeconds),
    })),
  };
}
