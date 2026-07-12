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
  recording?: RecordingConfigResponse;
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
  biliupArgsPrefix?: string[];
  biliupVersion: string | null;
  testedBiliupVersion: string;
  cookiePath: string;
  cookieExists: boolean;
  cookieSource?: string;
  cookieCandidates?: UploadCookieCandidate[];
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

export type UploadCookieCandidate = {
  path: string;
  exists: boolean;
  source: string;
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
  materialRooms?: Room[];
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
  danmakuCount?: number;
  danmakuDuration?: number;
  subtitles: FileRef[];
  remuxTarget?: null | (FileRef & { exists: boolean; size: number });
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
  timebase?: "segment" | "global" | string;
  originalTimebase?: "segment" | "global" | string;
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
  signal?: {
    funnyHits: number;
    reactionHits: number;
    questionHits: number;
    danmakuCount: number;
    subtitleCount: number;
    peakCount: number;
    hotText: string;
  };
  automation?: {
    eligibleForAutoUpload: boolean;
    confidence: "high" | "review" | string;
    score: number;
    signalFamilies: string[];
    policyReason: string;
  };
};

export type AiSliceDiagnostics = {
  engine: "model-only" | string;
  modelStatus: "ok" | "error" | "not-configured" | "no-candidates" | "empty-response" | string;
  modelUsed: boolean;
  endpoint?: string;
  wireApi?: string;
  model?: string;
  mediaImagesRequested?: number;
  mediaImagesUsed?: number;
  warnings?: string[];
  message: string;
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
  uploadPolicy?: "manual-confirm" | "review" | "auto-public" | "auto-only-self" | string;
  automationPolicy?: "manual-confirm" | "review" | "auto-public" | "auto-only-self" | string;
  automation?: {
    eligibleForAutoUpload?: boolean;
    score?: number;
    clipScore?: number;
    evidenceCount?: number;
    signalFamilies?: string[];
  };
  autoApproval?: UploadDraft["automation"];
  clipScore?: number;
  evidence?: string[];
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
  recording: RecordingSettings;
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
    wireApi: "chat-completions" | "responses" | string;
    endpoint: string;
    apiKey: string;
    model: string;
    sendFrames: boolean;
    sendAudio: boolean;
    sendSubtitles: boolean;
    sendDanmaku: boolean;
    frameSampleCount: number;
    audioSpectrum: boolean;
    sliceTemperature: number;
    slicePrompt: string;
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
    videoTranscodeMode: "compress" | "copy" | string;
    videoEncoder?: "auto" | "libx264" | "nvenc" | "qsv" | "amf" | string;
    videoCrf: number;
    videoPreset: string;
    audioTranscodeMode: "aac" | "copy" | "lossless" | string;
    audioBitrateKbps: number;
    convertConcurrency?: number;
  };
  automation: AutomationSettings;
};

export type AutomationSettings = {
  enabled: boolean;
  triggerOnRecordingComplete: boolean;
  autoAnalyze: boolean;
  autoExport: boolean;
  autoUpload: boolean;
  uploadPolicy: "manual-confirm" | "review" | "auto-public" | "auto-only-self" | string;
  clipDuration: number;
  clipCount: number;
  sources: string[];
  minScore: number;
  minEvidenceCount: number;
  requireHighConfidence: boolean;
  burnSubtitles: boolean;
};

export type AutomationJob = {
  id: string;
  roomId: string;
  videoPath: string;
  trigger: string;
  triggerEventId: string | null;
  uploadPolicy: string;
  status: "queued" | "running" | "ready" | "error" | string;
  stage: string;
  message: string;
  candidates: ClipCandidate[];
  acceptedClips: ClipDraft[];
  exportedClips: ClipDraft[];
  uploadDraftPath?: string | null;
  uploadPreflight?: unknown;
  uploadJobId?: string | null;
  projectPath: string | null;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type RecordingMonitorStatus = {
  enabled: boolean;
  running: boolean;
  scheduled: boolean;
  nextRunAt: string | null;
  lastResult: {
    status: string;
    checked: number;
    started: number;
    waiting: number;
    skipped: number;
    errors: number;
    messages?: string[];
    updatedAt?: string;
    nextDelayMs?: number;
  } | null;
  intervalSeconds: number;
  enabledRooms: number;
  activeRecordings: number;
  waitingRooms: number;
  updatedAt: string;
};

export type RecordingEvent = {
  id: string;
  type: string;
  date: string;
  roomId: string;
  path: string | null;
  data?: Record<string, unknown>;
  receivedAt?: string;
};

export type RecordingSettings = {
  backend: "internal" | string;
  outputDir: string;
  host: string;
  port: number;
  apiKey: string;
  maxConfiguredRooms: number;
  maxConcurrentRecordings: number;
  autoMonitorEnabled: boolean;
  stabilityHours: number;
  enableWebhooks: boolean;
  webhookUrl: string;
  biliApiBase: string;
  biliWebApiBase?: string;
  cookiePath?: string;
  enableWbiSigning?: boolean;
  roomFolderTemplate: string;
  filenameTemplate: string;
  segmentSeconds: number;
  fileSizeLimitMb: number;
  qualityNumber: number;
  streamFormat: "flv" | "fmp4" | "ts" | string;
  streamCodec: "avc" | "hevc" | string;
  recordingMode: "standard" | "raw" | string;
  bufferSizeKb: number;
  requestTimeoutSeconds: number;
  streamTimeoutSeconds: number;
  disconnectionTimeoutSeconds: number;
  pollIntervalSeconds: number;
  reconnectSeconds: number;
  enableDanmaku: boolean;
  saveRawDanmaku: boolean;
  danmakuServer: string;
  danmuUname: boolean;
  recordGiftSend: boolean;
  recordFreeGifts: boolean;
  recordGuardBuy: boolean;
  recordSuperChat: boolean;
  saveCover: boolean;
  coverSaveStrategy: string;
  remuxToMp4: boolean;
  injectExtraMetadata: boolean;
  deleteSourceAfterRemux: string;
  mergeReconnectSegments: boolean;
  reconnectMergeWindowSeconds: number;
  mergedSegmentArchiveDir: string;
  shortRecordingCleanupEnabled: boolean;
  shortRecordingMinSeconds: number;
  shortRecordingArchiveDir: string;
  spaceCheckIntervalSeconds: number;
  spaceThresholdMb: number;
  recycleRecords: boolean;
};

export type RecordingLimits = {
  maxConfiguredRooms: number;
  maxConcurrentRecordings: number;
  stabilityHours: number;
};

export type RecordingInternalHealth = {
  available: boolean;
  activeRooms: number;
  outputDir: string;
  backend: string;
  message: string;
};

export type FixedRoom = {
  roomId: string;
  inputRoomId: string;
  name: string;
  title?: string;
  realRoomId?: string;
  shortId?: string;
  anchorName?: string;
  anchorUid?: string;
  avatarUrl?: string;
  coverUrl?: string;
  keyframeUrl?: string;
  areaName?: string;
  parentAreaName?: string;
  biliLiveStatus?: "live" | "offline" | "replay" | "unknown" | string;
  liveTime?: string;
  metadataUpdatedAt?: string | null;
  enabled: boolean;
  priority: number;
  createdAt?: string | null;
  updatedAt?: string | null;
} & RecordingRoomStatus;

export type RecordingRoomStatus = {
  taskStatus: "idle" | "starting" | "waiting" | "recording" | "finalizing" | "completed" | "error" | string;
  liveStatus: "unknown" | "live" | "offline" | string;
  recordingPath: string | null;
  danmakuPath: string | null;
  videoSize: number;
  bytesWritten?: number;
  segmentBytes?: number;
  speedBytesPerSecond?: number;
  averageSpeedBytesPerSecond?: number;
  elapsedSeconds?: number;
  staleSeconds?: number;
  lastBytesAt?: string | null;
  stalled?: boolean;
  startedAt?: string | null;
  monitorCheckedAt?: string | null;
  nextMonitorAt?: string | null;
  danmakuSize: number;
  danmakuCount: number;
  danmakuStatus?: {
    enabled?: boolean;
    connected?: boolean;
    authenticated?: boolean;
    source?: string;
    cookieLoaded?: boolean;
    uidPresent?: boolean;
    buvidPresent?: boolean;
    tokenPresent?: boolean;
    reconnects?: number;
    lastMessageAt?: string | null;
    lastCloseCode?: number | null;
    lastCloseReason?: string;
    message?: string;
  } | null;
  refreshed: boolean;
  sync?: string;
  message: string;
  nextAction: string;
  log: string;
  updatedAt?: string | null;
};

export type RecordingConfigResponse = {
  settings?: RecordingSettings;
  recorder: RecordingInternalHealth;
  internal?: RecordingInternalHealth;
  limits: RecordingLimits;
  rooms?: FixedRoom[];
};

export type RecordingJob = {
  id: string;
  type: string;
  status: "running" | "ready" | "error" | string;
  progress: number;
  message: string;
  log: string;
  command: string;
  outputPath?: string | null;
  startedAt?: string;
  updatedAt: string;
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
  rangeStart: number;
  rangeEnd: number | null;
  timebase: "global" | "segment" | string;
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
  bytesWritten?: number;
  speedBytesPerSecond?: number;
  averageSpeedBytesPerSecond?: number;
  elapsedSeconds?: number;
  staleSeconds?: number;
  stalled?: boolean;
  danmakuCount?: number;
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
  policy?: {
    policy: string;
    canRun: boolean;
    issues: string[];
    warnings: string[];
    effectiveDraft: UploadDraft;
  };
  command: string;
  cookie?: UploadCookieCandidate & { candidates?: UploadCookieCandidate[] };
  tools: UploadTools;
};

export type UploadHistoryItem = {
  bvid: string;
  aid?: number | null;
  title: string;
  status: string;
  partCount?: number;
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
  needsLogin?: boolean;
  exitCode?: number | string | null;
  source?: string;
  memberApiError?: string;
  cookie?: UploadCookieCandidate & { candidates?: UploadCookieCandidate[] };
  tools?: UploadTools;
  archives?: UploadHistoryItem[];
};

export type UploadArchiveResponse = {
  ok: boolean;
  message?: string;
  command?: string;
  output?: string;
  needsLogin?: boolean;
  exitCode?: number | string | null;
  source?: string;
  memberApiError?: string;
  cookie?: UploadCookieCandidate & { candidates?: UploadCookieCandidate[] };
  tools?: UploadTools;
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
