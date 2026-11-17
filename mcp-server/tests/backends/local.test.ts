import { describe, it, expect } from "vitest";
import { parseWhisperJson } from "../../src/backends/local.js";

describe("parseWhisperJson", () => {
  it("parses openai-whisper output (segments in seconds)", () => {
    const raw = JSON.stringify({
      text: "Hello there. General Kenobi.",
      segments: [
        { start: 0.0, end: 2.4, text: " Hello there." },
        { start: 65.2, end: 67.9, text: " General Kenobi." },
      ],
    });
    expect(parseWhisperJson(raw)).toEqual([
      { start: "00:00:00", end: "00:00:02", text: "Hello there." },
      { start: "00:01:05", end: "00:01:07", text: "General Kenobi." },
    ]);
  });

  it("parses whisper.cpp output (offsets in milliseconds)", () => {
    const raw = JSON.stringify({
      transcription: [
        { timestamps: { from: "00:00:01,000", to: "00:00:03,500" }, offsets: { from: 1000, to: 3500 }, text: " First line" },
        { timestamps: { from: "01:00:00,000", to: "01:00:02,000" }, offsets: { from: 3600000, to: 3602000 }, text: "Second" },
      ],
    });
    expect(parseWhisperJson(raw)).toEqual([
      { start: "00:00:01", end: "00:00:03", text: "First line" },
      { start: "01:00:00", end: "01:00:02", text: "Second" },
    ]);
  });

  it("drops empty segments", () => {
    const raw = JSON.stringify({ segments: [{ start: 0, end: 1, text: "  " }, { start: 1, end: 2, text: "ok" }] });
    expect(parseWhisperJson(raw)).toEqual([{ start: "00:00:01", end: "00:00:02", text: "ok" }]);
  });
});
