import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkCommand, detectPlatform } from "../utils/platform.js";
import { detectWhisperEngine, resolveWhisperModel } from "../backends/local.js";

export function registerVideoSetup(server: McpServer): void {
  server.tool(
    "video_setup",
    "Check what is installed: ffmpeg (required), yt-dlp (YouTube URLs) and local Whisper (optional, transcribes videos without captions). Nothing needs configuring.",
    {},
    async () => {
      const { os } = detectPlatform();
      const install = (win: string, mac: string, linux: string) => (os === "windows" ? win : os === "macos" ? mac : linux);

      const [ffmpeg, ffprobe, ytDlp, whisper] = await Promise.all([
        checkCommand("ffmpeg"),
        checkCommand("ffprobe"),
        checkCommand("yt-dlp"),
        detectWhisperEngine(),
      ]);

      const lines = [
        "## Dependencies",
        ffmpeg && ffprobe
          ? "- ffmpeg: ready"
          : `- ffmpeg: **missing (required)** — \`${install("winget install Gyan.FFmpeg", "brew install ffmpeg", "sudo apt install ffmpeg")}\``,
        ytDlp
          ? "- yt-dlp: ready"
          : `- yt-dlp: missing (needed for YouTube URLs) — \`${install("winget install yt-dlp.yt-dlp", "brew install yt-dlp", "pipx install yt-dlp")}\``,
        whisper
          ? `- local Whisper: ready (${whisper === "cpp" ? "whisper.cpp" : "openai-whisper"}, model ${await resolveWhisperModel("auto")} by default)`
          : "- local Whisper: not installed (optional) — without it, videos with no YouTube captions and local files get no transcript. Install: `pip install openai-whisper`",
        "",
        ffmpeg && ffprobe ? "**Ready.** Restart Claude Code after installing anything so the new commands are on PATH." : "**Install ffmpeg, then restart Claude Code.**",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
