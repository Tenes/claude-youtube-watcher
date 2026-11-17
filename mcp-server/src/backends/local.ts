import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, createReadStream, readFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, join } from "path";
import { pipeline } from "stream/promises";
import { checkCommand, detectGpu } from "../utils/platform.js";
import { formatHMS } from "../utils/timestamps.js";
import type { AudioResult, TranscriptionSegment, WhisperModel } from "../types.js";

const execFileAsync = promisify(execFile);

export type WhisperEngine = "cpp" | "python";

/** Which local Whisper is installed: whisper.cpp's `whisper-cli` (faster) or openai-whisper's `whisper`. */
export async function detectWhisperEngine(): Promise<WhisperEngine | null> {
  if (await checkCommand("whisper-cli")) return "cpp";
  if (await checkCommand("whisper")) return "python";
  return null;
}

/** "auto" picks a model that finishes in reasonable time: big models are only practical with a GPU. */
export async function resolveWhisperModel(model: WhisperModel): Promise<string> {
  if (model !== "auto") return model;
  return (await detectGpu()) === "none" ? "base" : "large-v3-turbo";
}

// Transcribing a long video on CPU can take a while; MCP clients enforce their own limits anyway.
const TRANSCRIBE_TIMEOUT_MS = 60 * 60 * 1000;

export async function transcribeWithWhisper(
  wavPath: string,
  options: { engine: WhisperEngine; model: WhisperModel; modelDir: string },
): Promise<AudioResult> {
  const model = await resolveWhisperModel(options.model);
  const transcription = options.engine === "cpp"
    ? await transcribeWithWhisperCpp(wavPath, model, options.modelDir)
    : await transcribeWithWhisperPython(wavPath, model);
  return { backend: "local-whisper", transcription, transcription_source_detail: `${options.engine} ${model}` };
}

// SHA-256 checksums verified against HuggingFace Git LFS pointers
const KNOWN_CHECKSUMS: Record<string, string> = {
  "tiny":            "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  "tiny.en":         "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  "base":            "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  "base.en":         "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  "small":           "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  "small.en":        "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  "medium":          "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  "medium.en":       "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356",
  "large-v1":        "7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d",
  "large-v2":        "9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487",
  "large-v3":        "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
  "large-v3-turbo":  "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
};

async function downloadOnce(path: string, url: string, expectedSha?: string): Promise<void> {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  console.error(`[cvv] Downloading ${basename(path)} (one time)...`);
  await execFileAsync("curl", ["-fL", "-o", path, url], { timeout: 600_000 });
  if (!existsSync(path)) throw new Error(`Failed to download ${url}`);
  if (expectedSha) {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    const actual = hash.digest("hex");
    if (actual !== expectedSha) {
      rmSync(path, { force: true });
      throw new Error(`Checksum mismatch for ${basename(path)}: expected ${expectedSha}, got ${actual}. The download may be corrupt or tampered with.`);
    }
  }
}

async function transcribeWithWhisperCpp(wavPath: string, model: string, modelDir: string): Promise<TranscriptionSegment[]> {
  const modelPath = join(modelDir, `ggml-${model}.bin`);
  await downloadOnce(modelPath, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`, KNOWN_CHECKSUMS[model]);

  // Silero VAD (~2 MB): without it whisper-cli hallucinates text on silent / music-only audio.
  const vadModelPath = join(modelDir, "ggml-silero-v5.1.2.bin");
  await downloadOnce(vadModelPath, "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin");

  // --output-json writes a JSON *file* at <prefix>.json, not stdout.
  const outputPrefix = join(dirname(wavPath), basename(wavPath, ".wav"));
  await execFileAsync(
    "whisper-cli",
    [
      "--model", modelPath,
      "--file", wavPath,
      "--output-json",
      "--output-file", outputPrefix,
      "--language", "auto",
      "--vad",
      "--vad-model", vadModelPath,
    ],
    { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
  );
  return parseWhisperJson(readOutput(`${outputPrefix}.json`));
}

async function transcribeWithWhisperPython(wavPath: string, model: string): Promise<TranscriptionSegment[]> {
  // No --language: openai-whisper detects it from the first 30 s. Output goes next to the wav
  // (a temp dir) so the JSON file is cleaned up with it; stdout is human-readable, not JSON.
  const outputDir = dirname(wavPath);
  await execFileAsync(
    "whisper",
    [
      wavPath,
      "--model", model,
      "--output_format", "json",
      "--output_dir", outputDir,
      "--verbose", "False",
      "--fp16", "False",
    ],
    { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
  );
  return parseWhisperJson(readOutput(join(outputDir, `${basename(wavPath, ".wav")}.json`)));
}

function readOutput(jsonPath: string): string {
  if (!existsSync(jsonPath)) throw new Error(`Whisper did not produce the expected JSON output at ${jsonPath}`);
  const raw = readFileSync(jsonPath, "utf-8");
  rmSync(jsonPath, { force: true });
  return raw;
}

/**
 * Parses both output shapes: openai-whisper `{ segments: [{ start, end, text }] }` (seconds) and
 * whisper.cpp `{ transcription: [{ offsets: { from, to }, text }] }` (milliseconds).
 */
export function parseWhisperJson(raw: string): TranscriptionSegment[] {
  const parsed = JSON.parse(raw);
  const segments: any[] = parsed.segments ?? parsed.transcription ?? [];
  return segments
    .map((seg) => ({
      start: formatHMS(seg.start ?? (seg.offsets?.from ?? 0) / 1000),
      end: formatHMS(seg.end ?? (seg.offsets?.to ?? 0) / 1000),
      text: String(seg.text ?? "").trim(),
    }))
    .filter((seg) => seg.text.length > 0);
}
