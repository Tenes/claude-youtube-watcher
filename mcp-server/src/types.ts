export type Backend = "youtube-captions" | "local-whisper" | "none";
export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo" | "large-v3" | "auto";
export type FrameMode = "images" | "descriptions";
export type FrameFormat = "jpeg" | "png" | "webp";
export type DescriberModel = "opus" | "sonnet" | "haiku";

export interface Config {
  /** Local Whisper model for videos without captions. "auto" = base on CPU, large-v3-turbo with a GPU. */
  whisper_model: WhisperModel;
  frame_mode: FrameMode;
  frame_format: FrameFormat;
  frame_resolution: number;
  default_fps: number | "auto";
  max_frames: number;
  frame_describer_model: DescriberModel;
  enable_index: boolean;
  session_max_age_days: number;
  downloads_max_age_days: number;
}

export interface VideoMetadata {
  duration: string;
  duration_seconds: number;
  resolution: string;
  width: number;
  height: number;
  codec: string;
  original_fps: number;
  file_size: string;
  has_audio: boolean;
}

export interface Frame {
  timestamp: string;
  image?: string;
  format?: FrameFormat;
  sourcePath?: string;
  description?: string;
}

export interface TranscriptionSegment {
  start: string;
  end: string;
  text: string;
}

export interface AudioResult {
  backend: Backend;
  transcription: TranscriptionSegment[];
  transcription_source?: "youtube_subtitles" | "youtube_auto_captions";
  transcription_source_detail?: string;
  /** Why there is no transcript, or why the one given is partial. */
  transcript_note?: string;
}

export interface VideoWatchResult {
  metadata: VideoMetadata;
  frames: Frame[];
  audio: AudioResult;
}

export interface SceneChangeOptions {
  /** Minimum scdet score (0-100) for a frame to count as a scene change. */
  threshold: number;
}

export interface AnalysisFilters {
  scene_changes: boolean | SceneChangeOptions;
  black_intervals: boolean;
  silence: boolean;
  freeze: boolean;
  motion: boolean;
  blur: boolean;
  exposure: boolean;
  loudness: boolean;
  transcription: boolean;
}

export interface SceneChange {
  time: string;
  score: number;
}

export interface Interval {
  start: string;
  end: string;
  duration: number;
}

export interface FrameStats {
  timestamp: string;
  si?: number;
  ti?: number;
  blur?: number;
  brightness?: number;
  saturation?: number;
}

export interface VideoAnalysis {
  scenes: SceneChange[];
  black_intervals: Interval[];
  silence_intervals: Interval[];
  freeze_intervals: Interval[];
  frame_stats: FrameStats[];
  loudness_summary?: { mean_lufs: number; range_lu: number };
  transcription?: TranscriptionSegment[];
  transcript_note?: string;
  /** Set when the ffmpeg pass stopped early: filter results only cover up to `analyzed_until`. */
  incomplete?: AnalysisIncomplete;
  content_profile: string;
}

export interface AnalysisIncomplete {
  analyzed_until: string;
  reason: string;
}

export interface SessionManifest {
  video_hash: string;
  video_path: string;
  created_at: string;
  resolutions: Record<string, {
    frames: Array<{ timestamp: string; file: string }>;
  }>;
  analysis?: VideoAnalysis;
}

export interface Segment {
  start: string;
  end: string;
  fps: number;
  resolution?: number;
}
