import { describe, it, expect } from "vitest";
import { parseSubtitleContent } from "../../src/utils/video-source.js";
import { formatTranscript, formatAudioResult } from "../../src/utils/timestamps.js";

// Shape of YouTube auto-captions: each cue repeats the previous line, plus 10 ms "hold" cues.
const ROLLING_VTT = `WEBVTT
Kind: captions
Language: en

00:00:04.280 --> 00:00:06.830 align:start position:0%

This<00:00:04.760><c> is</c><00:00:04.960><c> a</c><00:00:05.000><c> three.</c>

00:00:06.830 --> 00:00:06.840 align:start position:0%
This is a three.


00:00:06.840 --> 00:00:08.350 align:start position:0%
This is a three.
and<00:00:07.040><c> rendered</c><00:00:07.360><c> low</c>

00:00:08.350 --> 00:00:08.360 align:start position:0%
and rendered low

`;

describe("compact transcripts", () => {
  it("keeps each rolling auto-caption line once", () => {
    const segments = parseSubtitleContent(ROLLING_VTT);
    expect(segments.map((s) => s.text)).toEqual(["This is a three.", "and rendered low"]);
  });

  it("merges segments into blocks of about blockSeconds", () => {
    const text = formatTranscript(
      [
        { start: "00:00:00", end: "00:00:05", text: "one" },
        { start: "00:00:10", end: "00:00:15", text: "two" },
        { start: "00:00:21", end: "00:00:25", text: "three" },
      ],
      20,
    );
    expect(text).toBe("[00:00:00] one two\n[00:00:21] three");
  });

  it("renders audio metadata compactly without the transcription array", () => {
    const text = formatAudioResult({
      backend: "youtube-captions",
      transcription: [{ start: "00:00:01", end: "00:00:02", text: "hi" }],
      transcription_source: "youtube_auto_captions",
    });
    expect(text).toBe(
      '{"backend":"youtube-captions","transcription_source":"youtube_auto_captions"}\n\n### Transcript\n[00:00:01] hi',
    );
  });
});
