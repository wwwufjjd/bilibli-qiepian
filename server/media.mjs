import path from "node:path";
import { spawnSync } from "node:child_process";

let cachedHwEncoders = null;
let cachedHwEncodersAt = 0;

export function normalizeMediaSettings(input = {}) {
  const videoCrf = Number(input.videoCrf ?? input.crf ?? 23);
  const audioBitrateKbps = Number(input.audioBitrateKbps ?? input.audioBitrate ?? 160);
  const videoPreset = String(input.videoPreset || "veryfast").trim().toLowerCase();
  const convertConcurrency = Number(input.convertConcurrency ?? input.concurrency ?? 1);
  return {
    flvOutputMode: String(input.flvOutputMode || "same-dir"),
    deleteSourceAfterConvert: Boolean(input.deleteSourceAfterConvert),
    skipIfMp4Exists: input.skipIfMp4Exists !== false,
    // Default to stream copy for daily clipping speed; compress is an archive mode.
    videoTranscodeMode: normalizeVideoTranscodeMode(input.videoTranscodeMode || input.videoMode || "copy"),
    videoEncoder: normalizeVideoEncoder(input.videoEncoder || input.encoder || "auto"),
    videoCrf: Number.isFinite(videoCrf) ? Math.max(0, Math.min(51, Math.round(videoCrf))) : 23,
    videoPreset: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "p1", "p2", "p3", "p4", "p5", "p6", "p7"].includes(videoPreset)
      ? videoPreset
      : "veryfast",
    audioTranscodeMode: normalizeAudioTranscodeMode(input.audioTranscodeMode || input.audioMode || "copy"),
    audioBitrateKbps: Number.isFinite(audioBitrateKbps) ? Math.max(64, Math.min(512, Math.round(audioBitrateKbps))) : 160,
    convertConcurrency: Number.isFinite(convertConcurrency) ? Math.max(1, Math.min(4, Math.round(convertConcurrency))) : 1
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

export function detectHwEncoders(env = process.env, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();
  if (!forceRefresh && cachedHwEncoders && now - cachedHwEncodersAt < 5 * 60 * 1000) {
    return cachedHwEncoders;
  }
  const invocation = getFfmpegInvocation(["-hide_banner", "-encoders"], env);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const detected = {
    nvenc: /\bh264_nvenc\b/i.test(output),
    qsv: /\bh264_qsv\b/i.test(output),
    amf: /\bh264_amf\b/i.test(output),
    checkedAt: new Date().toISOString(),
    ok: result.status === 0
  };
  cachedHwEncoders = detected;
  cachedHwEncodersAt = now;
  return detected;
}

export function resolveVideoEncoder(mediaSettings = {}, env = process.env) {
  const settings = normalizeMediaSettings(mediaSettings);
  if (settings.videoTranscodeMode === "copy") {
    return { encoder: "copy", codecArgs: ["-c:v", "copy"], label: "stream-copy" };
  }
  const preferred = settings.videoEncoder;
  const hw = preferred === "libx264" ? { nvenc: false, qsv: false, amf: false } : detectHwEncoders(env);
  const pick = preferred === "auto"
    ? (hw.nvenc ? "h264_nvenc" : hw.qsv ? "h264_qsv" : hw.amf ? "h264_amf" : "libx264")
    : preferred === "nvenc"
      ? (hw.nvenc ? "h264_nvenc" : "libx264")
      : preferred === "qsv"
        ? (hw.qsv ? "h264_qsv" : "libx264")
        : preferred === "amf"
          ? (hw.amf ? "h264_amf" : "libx264")
          : "libx264";

  if (pick === "h264_nvenc") {
    const preset = mapNvencPreset(settings.videoPreset);
    const cq = Math.max(0, Math.min(51, Number(settings.videoCrf || 23)));
    return {
      encoder: pick,
      codecArgs: ["-c:v", "h264_nvenc", "-preset", preset, "-rc", "vbr", "-cq", String(cq), "-b:v", "0"],
      label: `nvenc/${preset}/cq${cq}`
    };
  }
  if (pick === "h264_qsv") {
    const preset = mapQsvPreset(settings.videoPreset);
    const globalQuality = Math.max(1, Math.min(51, Number(settings.videoCrf || 23)));
    return {
      encoder: pick,
      codecArgs: ["-c:v", "h264_qsv", "-preset", preset, "-global_quality", String(globalQuality)],
      label: `qsv/${preset}/gq${globalQuality}`
    };
  }
  if (pick === "h264_amf") {
    const quality = mapAmfQuality(settings.videoPreset);
    const qp = Math.max(0, Math.min(51, Number(settings.videoCrf || 23)));
    return {
      encoder: pick,
      codecArgs: ["-c:v", "h264_amf", "-quality", quality, "-rc", "cqp", "-qp_i", String(qp), "-qp_p", String(qp)],
      label: `amf/${quality}/qp${qp}`
    };
  }

  const softPreset = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].includes(settings.videoPreset)
    ? settings.videoPreset
    : "veryfast";
  return {
    encoder: "libx264",
    codecArgs: ["-c:v", "libx264", "-preset", softPreset, "-crf", String(settings.videoCrf)],
    label: `libx264/${softPreset}/crf${settings.videoCrf}`
  };
}

export function buildFlvConvertArgs(file, target, mediaSettings = {}, env = process.env) {
  const settings = normalizeMediaSettings(mediaSettings);
  const video = resolveVideoEncoder(settings, env);
  const args = ["-y", "-i", file, "-map", "0:v:0", "-map", "0:a?", ...video.codecArgs];
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

export function describeMediaPipeline(mediaSettings = {}, env = process.env) {
  const settings = normalizeMediaSettings(mediaSettings);
  const video = resolveVideoEncoder(settings, env);
  const audio = settings.audioTranscodeMode === "copy"
    ? "copy"
    : settings.audioTranscodeMode === "lossless"
      ? "alac"
      : `aac ${settings.audioBitrateKbps}k`;
  return {
    videoTranscodeMode: settings.videoTranscodeMode,
    videoEncoder: settings.videoEncoder,
    resolvedVideoEncoder: video.encoder,
    videoLabel: video.label,
    audio,
    convertConcurrency: settings.convertConcurrency,
    flvOutputMode: settings.flvOutputMode,
    hw: detectHwEncoders(env)
  };
}

export function mediaPresetConfig(presetName = "clip-fast") {
  const name = String(presetName || "clip-fast");
  if (name === "archive-compress") {
    return {
      flvOutputMode: "compressed-dir",
      deleteSourceAfterConvert: false,
      skipIfMp4Exists: true,
      videoTranscodeMode: "compress",
      videoEncoder: "auto",
      videoCrf: 23,
      videoPreset: "veryfast",
      audioTranscodeMode: "aac",
      audioBitrateKbps: 160,
      convertConcurrency: 1
    };
  }
  if (name === "balanced") {
    return {
      flvOutputMode: "same-dir",
      deleteSourceAfterConvert: false,
      skipIfMp4Exists: true,
      videoTranscodeMode: "copy",
      videoEncoder: "auto",
      videoCrf: 23,
      videoPreset: "veryfast",
      audioTranscodeMode: "copy",
      audioBitrateKbps: 160,
      convertConcurrency: 2
    };
  }
  // clip-fast: remux only, max speed for editing
  return {
    flvOutputMode: "same-dir",
    deleteSourceAfterConvert: false,
    skipIfMp4Exists: true,
    videoTranscodeMode: "copy",
    videoEncoder: "auto",
    videoCrf: 23,
    videoPreset: "veryfast",
    audioTranscodeMode: "copy",
    audioBitrateKbps: 160,
    convertConcurrency: 2
  };
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

function normalizeVideoEncoder(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["auto", "libx264", "nvenc", "qsv", "amf"].includes(normalized)) return normalized;
  if (normalized === "h264_nvenc") return "nvenc";
  if (normalized === "h264_qsv") return "qsv";
  if (normalized === "h264_amf") return "amf";
  return "auto";
}

function mapNvencPreset(preset) {
  const value = String(preset || "veryfast").toLowerCase();
  if (["p1", "p2", "p3", "p4", "p5", "p6", "p7"].includes(value)) return value;
  if (["ultrafast", "superfast", "veryfast"].includes(value)) return "p1";
  if (["faster", "fast"].includes(value)) return "p3";
  if (value === "medium") return "p4";
  if (["slow", "slower"].includes(value)) return "p5";
  if (value === "veryslow") return "p7";
  return "p4";
}

function mapQsvPreset(preset) {
  const value = String(preset || "veryfast").toLowerCase();
  if (["veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].includes(value)) return value;
  if (["ultrafast", "superfast"].includes(value)) return "veryfast";
  return "medium";
}

function mapAmfQuality(preset) {
  const value = String(preset || "veryfast").toLowerCase();
  if (["ultrafast", "superfast", "veryfast", "faster"].includes(value)) return "speed";
  if (["slow", "slower", "veryslow"].includes(value)) return "quality";
  return "balanced";
}
