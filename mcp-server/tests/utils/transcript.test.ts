import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedVideoInput } from "../../src/utils/video-source.js";

const whisper = vi.hoisted(() => ({ engine: null as "cpp" | "python" | null }));

vi.mock("../../src/backends/local.js", () => ({
  detectWhisperEngine: async () => whisper.engine,
  transcribeWithWhisper: async () => ({
    backend: "local-whisper",
    transcription: [{ start: "00:00:00", end: "00:00:02", text: "from whisper" }],
  }),
}));
vi.mock("../../src/extractors/audio.js", () => ({ extractAudio: async () => "/tmp/audio.wav" }));

const { getTranscript } = await import("../../src/utils/transcript.js");

const OPTS = { workDir: "/tmp", whisperModel: "auto" as const };

function youtube(transcription: { start: string; end: string; text: string }[], coverage: number): ResolvedVideoInput {
  return {
    path: "/tmp/v.mp4",
    source: { type: "youtube", url: "https://youtu.be/x" } as ResolvedVideoInput["source"],
    captions: { source: "automatic_captions", language: "en", transcription, coverage_seconds: coverage },
  } as ResolvedVideoInput;
}

describe("getTranscript", () => {
  beforeEach(() => {
    whisper.engine = null;
  });

  it("uses YouTube captions when they cover the video, even if Whisper is installed", async () => {
    whisper.engine = "python";
    const result = await getTranscript(youtube([{ start: "00:00:01", end: "00:00:02", text: "caption" }], 60), 60, OPTS);
    expect(result.backend).toBe("youtube-captions");
    expect(result.transcript_note).toBeUndefined();
  });

  it("falls back to local Whisper when there are no captions", async () => {
    whisper.engine = "cpp";
    const result = await getTranscript({ path: "/tmp/v.mp4" } as ResolvedVideoInput, 60, OPTS);
    expect(result.backend).toBe("local-whisper");
    expect(result.transcription[0].text).toBe("from whisper");
    expect(result.transcript_note).toContain("transcribed locally");
  });

  it("keeps partial captions, with a note, when Whisper is not installed", async () => {
    const result = await getTranscript(youtube([{ start: "00:00:01", end: "00:00:02", text: "partial" }], 10), 600, OPTS);
    expect(result.backend).toBe("youtube-captions");
    expect(result.transcription).toHaveLength(1);
    expect(result.transcript_note).toContain("not installed");
  });

  it("returns no transcript, with install advice, when nothing is available", async () => {
    const result = await getTranscript({ path: "/tmp/v.mp4" } as ResolvedVideoInput, 60, OPTS);
    expect(result.backend).toBe("none");
    expect(result.transcription).toEqual([]);
    expect(result.transcript_note).toContain("pip install openai-whisper");
  });
});
