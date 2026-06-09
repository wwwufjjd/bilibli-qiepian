export type Settings = {
  recordingsRoot: string;
  rootExists: boolean;
  recordingRootCandidates: RecordingRootCandidate[];
  ffmpeg: boolean;
  ffprobe: boolean;
  uploadTools: UploadTools;
  uploadDefaults: UploadDraft;
  serviceSettings: ServiceSettings;
  asrTools: LocalAsrStatus;
};

export type RecordingRootCandidate = {
  path: string;
  label: string;
  exists: boolean;
  roomCount: number;
  videoCount: number;
  reason: string;
};

export type UploadTools = {
  biliup: boolean;
  bilitool: boolean;
  biliupPath: string | null;
  bilitoolPath: string | null;
  biliupSource: "system" | "workspace" | null;
  biliupVersion: string | null;
  testedBiliupVersion: string;
  cookiePath: string;
  cookieExists: boolean;
  workspaceInstallPath: string;
  capabilities: {
    uploadMultiPart: boolean;
    appendParts: boolean;
    listArchives: boolean;
    showArchive: boolean;
    onlySelfVisible: boolean;
    commandHelpVerifiedAt: string;
    unsupportedOrUnverified: string[];
  };
};

export type Room = {
  key: string;
  path: string;
  folderName: string;
  roomId: string;
  name: string;
  videoCount: number;
  xmlCount: number;
  latestVideo: null | {
    key: string;
    name: string;
    mtime: string;
    size: number;
  };
  coverUrl: string | null;
};

export type RoomDetail = {
  key: string;
  path: string;
  folderName: string;
  roomId: string;
  name: string;
  videos: VideoAsset[];
  xmlFiles: number;
  subtitleFiles: number;
};

export type VideoAsset = {
  key: string;
  path: string;
  name: string;
  extension: string;
  size: number;
  mtime: string | null;
  duration: number;
  width: number | null;
  height: number | null;
  playable: boolean;
  xml: null | FileRef;
  subtitles: FileRef[];
  thumbnailUrl: string;
};

export type FileRef = {
  key: string;
  path: string;
  name: string;
};

export type DanmakuItem = {
  id: string;
  time: number;
  mode: number;
  size: number;
  color: number;
  date: number;
  user: string;
  uid: string;
  text: string;
};

export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
  source?: string;
};

export type HistogramBin = {
  index: number;
  start: number;
  end: number;
  count: number;
  score: number;
};

export type VideoContext = {
  key: string;
  path: string;
  name: string;
  extension: string;
  room: {
    roomId: string;
    name: string;
  };
  media: {
    duration: number;
    width: number | null;
    height: number | null;
  };
  playable: boolean;
  mediaUrl: string;
  thumbnailUrl: string;
  preview: PreviewStatus;
  xml: FileRef | null;
  danmaku: DanmakuItem[];
  danmakuTotal: number;
  danmakuMetadata: Record<string, unknown>;
  subtitles: SubtitleCue[];
  histogram: HistogramBin[];
  duration: number;
};

export type PreviewStatus = {
  status: "idle" | "running" | "ready" | "error";
  progress: number;
  path: string | null;
  mediaUrl: string | null;
  message: string;
  updatedAt: string | null;
};

export type ClipCandidate = {
  id: string;
  title: string;
  start: number;
  end: number;
  score: number;
  reason: string;
  evidence: string[];
};

export type ClipDraft = ClipCandidate & {
  status?: "draft" | "exported";
  exportPath?: string;
  coverPath?: string;
  burnSubtitles?: boolean;
};

export type UploadPart = {
  id: string;
  title: string;
  path: string;
  source?: string;
};

export type UploadDraft = {
  publishMode?: "upload" | "append";
  vid?: string;
  visibility?: "public" | "onlySelf";
  isOnlySelf?: number;
  autoSubmit?: boolean;
  parts?: UploadPart[];
  cookiePath?: string;
  submit?: string;
  line?: string;
  limit?: number;
  copyright?: number;
  source?: string;
  tid?: number;
  cover?: string;
  title?: string;
  desc?: string;
  descFormatId?: number;
  dynamic?: string;
  tag?: string;
  dtime?: string;
  noReprint?: number;
  openElec?: number;
  dolby?: number;
  hires?: number;
  subtitleOpen?: number;
  subtitleLan?: string;
  upSelectionReply?: boolean;
  upCloseReply?: boolean;
  upCloseDanmu?: boolean;
  missionId?: string;
  extraFields?: string;
};

export type ServiceSettings = {
  recordingsRoot: string;
  asr: {
    mode: "extract-audio" | "funasr-local" | "qwen3-local" | "local-command" | "cloud-endpoint" | string;
    provider: "funasr-nano" | "qwen3-asr-gguf" | "custom-command" | "cloud-endpoint" | string;
    model: string;
    modelSize: string;
    endpoint: string;
    apiKey: string;
    localCommand: string;
    qwenCommand: string;
    language: string;
    outputFormat: string;
    device: "cpu" | "cuda" | "auto" | string;
    autoPrepareModel: boolean;
    chunkSeconds: number;
    qwenContextTokens: number;
    defaultScope: "selection" | "full" | string;
    replaceMode: "range" | "append" | "all" | string;
  };
  vision: {
    provider: string;
    endpoint: string;
    apiKey: string;
    model: string;
    sendFrames: boolean;
    sendAudio: boolean;
    sendSubtitles: boolean;
    sendDanmaku: boolean;
  };
  cover: {
    provider: string;
    endpoint: string;
    apiKey: string;
    model: string;
    stylePrompt: string;
  };
  media: {
    flvOutputMode: "same-dir" | "compressed-dir" | string;
    deleteSourceAfterConvert: boolean;
    skipIfMp4Exists: boolean;
  };
};

export type LocalAsrStatus = {
  pythonPath: string | null;
  runtimeReady: boolean;
  funAsrInstalled: boolean;
  torchInstalled: boolean;
  torchVersion?: string;
  torchBuild?: string;
  cudaAvailable?: boolean;
  funAsrDownloaded: boolean;
  qwenModelPresent: boolean;
  llamaCppFound: boolean;
  qwen?: {
    toolReady: boolean;
    exePath: string | null;
    releaseDir: string;
    modelRoot: string;
    releaseZipUrl: string;
    models: Array<{
      size: string;
      ready: boolean;
      path: string;
      missingFiles: string[];
    }>;
  };
  cacheRoot: string;
  downloadedModels: string[];
  notes: string[];
};

export type AsrJob = {
  id: string;
  status: "running" | "ready" | "error";
  progress: number;
  message: string;
  outDir: string;
  audioPath: string;
  subtitlePath: string | null;
  subtitles: SubtitleCue[];
  log: string;
  command?: string;
  startedAt?: string;
  updatedAt: string;
};

export type UploadJob = {
  id: string;
  type: "install-biliup" | "biliup-login" | "biliup-run" | string;
  status: "running" | "ready" | "error";
  progress: number;
  message: string;
  log: string;
  command: string;
  scriptPath?: string;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
};

export type WorkbenchTask = {
  id: string;
  source: "upload" | "asr" | "preview" | "model" | "transcode" | string;
  type: string;
  label: string;
  status: "running" | "ready" | "error" | "idle" | string;
  progress: number;
  message: string;
  log: string;
  command?: string;
  outputPath?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
};

export type TitleGenerationResponse = {
  ok: boolean;
  title: string;
  alternatives?: string[];
  reason?: string;
  evidence?: string[];
  job?: WorkbenchTask;
};

export type CoverGenerationResponse = {
  ok: boolean;
  path: string;
  mediaUrl?: string;
  prompt?: string;
  provider?: string;
  templateFallback?: boolean;
  job?: WorkbenchTask;
};

export type UploadPreflight = {
  ok: boolean;
  issues: string[];
  warnings: string[];
  command: string;
  tools: UploadTools;
};

export type UploadHistoryItem = {
  bvid: string;
  title: string;
  status: string;
};

export type RemoteArchiveInfo = {
  bvid: string;
  aid: number | null;
  title: string;
  cover: string;
  tag: string;
  tid: number | null;
  duration: number;
  isOnlySelf: number;
  state: number | null;
  stateDesc: string;
};

export type RemoteArchivePart = {
  index: number;
  title: string;
  duration: number;
  status: number;
  statusDesc: string;
  cid: number | null;
  filename: string;
  failDesc: string;
};

export type UploadHistoryResponse = {
  ok: boolean;
  message?: string;
  command?: string;
  output?: string;
  archives?: UploadHistoryItem[];
};

export type UploadArchiveResponse = {
  ok: boolean;
  message?: string;
  command?: string;
  output?: string;
  archive?: RemoteArchiveInfo;
  videos?: RemoteArchivePart[];
};

export type AsrPrepareResponse = {
  ok: boolean;
  job: WorkbenchTask;
  asrTools: LocalAsrStatus;
};

export type FlvConvertResponse = {
  ok: boolean;
  job: WorkbenchTask;
};
