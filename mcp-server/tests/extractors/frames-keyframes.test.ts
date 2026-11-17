import { describe, it, expect, afterEach } from "vitest";
import {
  extractKeyframes,
  keyframeFilter,
  parseShowinfoTimes,
  defaultMaxGapSeconds,
} from "../../src/extractors/frames.js";
import { join } from "path";
import { rmSync, existsSync } from "fs";
import { tmpdir } from "os";

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");
const OUT_DIR = join(tmpdir(), "cvv-keyframes-test-" + Date.now());

describe("keyframe extraction", () => {
  afterEach(() => {
    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  });

  it("builds a filter that scales, dedupes, selects and logs in that order", () => {
    const filter = keyframeFilter(512, 0.3, 30);
    expect(filter).toBe(
      "scale=512:-2,mpdecimate,select='isnan(prev_selected_t)+gt(scene,0.3)*gte(t-prev_selected_t,2)+gte(t-prev_selected_t,30)',showinfo,setpts=N/FRAME_RATE/TB",
    );
  });

  it("parses pts_time from showinfo lines only", () => {
    const stderr = [
      "[Parsed_showinfo_3 @ 000001] n:   0 pts:      0 pts_time:0       duration:1",
      "[out#0/image2 @ 000002] pts_time:99 should be ignored",
      "[Parsed_showinfo_3 @ 000001] n:   1 pts:  61440 pts_time:4.8     duration:1",
      "[Parsed_showinfo_3 @ 000001] n:   2 pts: 153600 pts_time:12      duration:1",
    ].join("\n");
    expect(parseShowinfoTimes(stderr)).toEqual([0, 4.8, 12]);
  });

  it("scales the default max gap with window length, clamped to 15-120 s", () => {
    expect(defaultMaxGapSeconds(60)).toBe(15);
    expect(defaultMaxGapSeconds(1500)).toBe(30);
    expect(defaultMaxGapSeconds(36000)).toBe(120);
  });

  it("extracts timestamped keyframes from a real video", async () => {
    const frames = await extractKeyframes(FIXTURE, {
      resolution: 160,
      outputDir: OUT_DIR,
      maxGapSeconds: 1,
      windowSeconds: 3,
    });
    // 3 s video with a 1 s max gap: at least the first frame plus gap frames, far fewer than 30 fps would give.
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames.length).toBeLessThanOrEqual(10);
    expect(frames[0].timestamp).toBe("00:00:00");
    expect(frames.every((f) => f.image && f.image.length > 0)).toBe(true);
    const times = frames.map((f) => f.timestamp);
    expect([...times].sort()).toEqual(times);
  });

  it("falls back to full decoding when the window holds no I-frame", async () => {
    // The fixture's only I-frame is at 0 s, so 1-3 s has none; the 1 fps fallback must still return frames.
    const frames = await extractKeyframes(FIXTURE, {
      resolution: 160,
      outputDir: OUT_DIR,
      startTime: "00:00:01",
      endTime: "00:00:03",
      maxGapSeconds: 1,
      windowSeconds: 2,
    });
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it("offsets timestamps by start_time", async () => {
    const frames = await extractKeyframes(FIXTURE, {
      resolution: 160,
      outputDir: OUT_DIR,
      startTime: "00:00:01",
      endTime: "00:00:03",
      maxGapSeconds: 1,
      windowSeconds: 2,
    });
    expect(frames[0].timestamp).toBe("00:00:01");
  });

  it("stops at maxFrames", async () => {
    const frames = await extractKeyframes(FIXTURE, {
      resolution: 160,
      outputDir: OUT_DIR,
      maxFrames: 1,
      maxGapSeconds: 0.1,
      windowSeconds: 3,
    });
    expect(frames).toHaveLength(1);
  });
});
