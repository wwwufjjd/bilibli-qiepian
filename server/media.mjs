import path from "node:path";

export function normalizeMediaSettings(input = {}) {
  const videoCrf = Number(input.videoCrf ?? input.crf ?? 23);
  const audioBitrateKbps = Number(input.audioBitrateKbps ?? input.audioBitrate ?? 160);
  const videoPreset = String(input.videoPreset || "veryfast").trim().toLowerCase();
  return {
    flvOutputMode: String(input.flvOutputMode || "same-dir"),
    deleteSourceAfterConvert: Boolean(input.deleteSourceAfterConvert),
    skipIfMp4Exists: input.skipIfMp4Exists !== false,
    videoTranscodeMode: normalizeVideoTranscodeMode(input.videoTranscodeMode || input.videoMode || "compress"),
    videoCrf: Number.isFinite(videoCrf) ? Math.max(0, Math.min(51, Math.round(videoCrf))) : 23,
    videoPreset: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].includes(videoPreset) ? videoPreset : "veryfast",
    audioTranscodeMode: normalizeAudioTranscodeMode(input.audioTranscodeMode || input.audioMode || "aac"),
    audioBitrateKbps: Number.isFinite(audioBitrateKbps) ? Math.max(64, Math.min(512, Math.round(audioBitrateKbps))) : 160
  };
}

export function getFfmpegInvocation(args, env = process.env) {
  const command = String(env.BILIVE_FFMPEG_COMMAND || env.FFMPEG_PATH || "ffmpeg");
  let prefix = [];
  if (env.BILIVE_FFMPEG_ARGS_PREFIX) {
    try {
      const parsed = JSON.parse(env.BILIVE_FFMPEG_ARGS_PREFIX);
      prefix = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      prefix = [];
    }
  }
  return { command, args: [...prefix, ...args] };
}

export function getFfprobeInvocation(args, env = process.env) {
  const command = String(env.BILIVE_FFPROBE_COMMAND || env.FFPROBE_PATH || "ffprobe");
  let prefix = [];
  if (env.BILIVE_FFPROBE_ARGS_PREFIX) {
    try {
      const parsed = JSON.parse(env.BILIVE_FFPROBE_ARGS_PREFIX);
      prefix = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      prefix = [];
    }
  }
  return { command, args: [...prefix, ...args] };
}

export function getFlvTargetPath(file, mediaSettings = {}) {
  const extless = file.replace(/\.flv$/i, "");
  if (mediaSettings?.flvOutputMode === "compressed-dir") {
    return path.join(path.dirname(file), "_compressed", `${path.basename(extless)}.mp4`);
  }
  return `${extless}.mp4`;
}

export function buildFlvConvertArgs(file, target, mediaSettings = {}) {
  const settings = normalizeMediaSettings(mediaSettings);
  const args = ["-y", "-i", file, "-map", "0:v:0", "-map", "0:a?"];
  if (settings.videoTranscodeMode === "copy") {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", settings.videoPreset, "-crf", String(settings.videoCrf));
  }
  if (settings.audioTranscodeMode === "copy") {
    args.push("-c:a", "copy");
  } else if (settings.audioTranscodeMode === "lossless") {
    args.push("-c:a", "alac");
  } else {
    args.push("-c:a", "aac", "-b:a", `${settings.audioBitrateKbps}k`);
  }
  args.push("-movflags", "+faststart", target);
  return args;
}

function normalizeVideoTranscodeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["copy", "stream-copy", "remux"].includes(normalized)) return "copy";
  return "compress";
}

function normalizeAudioTranscodeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["copy", "stream-copy", "remux"].includes(normalized)) return "copy";
  if (["lossless", "alac", "无损"].includes(normalized)) return "lossless";
  return "aac";
}
