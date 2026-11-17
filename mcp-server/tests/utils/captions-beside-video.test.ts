import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readCaptionsBesideVideo } from "../../src/utils/video-source.js";

const track = { source: "automatic_captions" as const, language: "en" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cvv-captions-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCaptionsBesideVideo", () => {
  it("reads the caption file yt-dlp wrote next to the video", () => {
    const video = join(dir, "abc123-VIDEOID.mp4");
    writeFileSync(video, "");
    writeFileSync(join(dir, "abc123-VIDEOID.en.srt"), "1\n00:00:01,000 --> 00:00:03,000\nhello there\n\n2\n00:00:03,000 --> 00:00:05,000\ngeneral\n");
    const result = readCaptionsBesideVideo(video, track);
    expect(result?.transcription.map((s) => s.text)).toEqual(["hello there", "general"]);
    expect(result?.coverage_seconds).toBe(5);
    expect(result?.source).toBe("automatic_captions");
  });

  it("ignores captions of other videos and returns null when none exist", () => {
    const video = join(dir, "abc123-VIDEOID.mp4");
    writeFileSync(video, "");
    writeFileSync(join(dir, "def456-OTHER.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nnot mine\n");
    expect(readCaptionsBesideVideo(video, track)).toBeNull();
  });
});
