import type {
  AsrJob,
  AsrPrepareResponse,
  ClipCandidate,
  ClipDraft,
  CoverGenerationResponse,
  FlvConvertResponse,
  PreviewStatus,
  RecordingRootCandidate,
  ServiceSettings,
  Settings,
  SubtitleCue,
  TitleGenerationResponse,
  UploadArchiveResponse,
  UploadDraft,
  UploadHistoryResponse,
  UploadJob,
  UploadPreflight,
  WorkbenchTask
} from "./types";

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

export function loadSettings() {
  return getJson<Settings>("/api/settings");
}

export function loadRecordingRootCandidates() {
  return getJson<{ candidates: RecordingRootCandidate[] }>("/api/recording-roots");
}

export function requestSliceCandidates(body: {
  videoKey: string;
  sources: string[];
  clipDuration: number;
  clipCount: number;
  subtitles?: SubtitleCue[];
  danmakuEdits?: Record<string, string>;
}) {
  return postJson<{ candidates: ClipCandidate[] }>("/api/ai/slices", body);
}

export function loadPreviewStatus(videoKey: string) {
  return getJson<PreviewStatus>(`/api/preview/status?key=${encodeURIComponent(videoKey)}`);
}

export function startPreview(videoKey: string) {
  return postJson<PreviewStatus>("/api/preview/start", { videoKey });
}

export function saveUploadDraft(body: UploadDraft & { clips: unknown[] }) {
  return postJson<{ ok: boolean; path: string }>("/api/upload/draft", body);
}

export function saveServiceSettings(body: ServiceSettings) {
  return postJson<{ ok: boolean; settings: ServiceSettings }>("/api/service-settings", body);
}

export function loadTasks() {
  return getJson<{ tasks: WorkbenchTask[] }>("/api/tasks");
}

export function generateClipTitle(body: {
  videoKey: string;
  clip: ClipDraft;
  subtitles?: SubtitleCue[];
  danmakuEdits?: Record<string, string>;
}) {
  return postJson<TitleGenerationResponse>("/api/ai/title", body);
}

export function generateCover(body: {
  videoKey: string;
  clip: ClipDraft;
  subtitles?: SubtitleCue[];
  danmakuEdits?: Record<string, string>;
}) {
  return postJson<CoverGenerationResponse>("/api/covers/generate", body);
}

export function generateUploadCommand(body: UploadDraft) {
  return postJson<{ ok: boolean; mode: string; executablePath: string; args: string[]; command: string; notes: string[] }>("/api/upload/command", { draft: body });
}

export function preflightUpload(body: UploadDraft) {
  return postJson<UploadPreflight>("/api/upload/preflight", { draft: body });
}

export function installBiliup() {
  return postJson<UploadJob | { ok: true; skipped: true; message: string }>("/api/upload/install-biliup", {});
}

export function startBiliupLogin(body: { cookiePath?: string }) {
  return postJson<UploadJob>("/api/upload/login", body);
}

export function getUploadJob(jobId: string) {
  return getJson<UploadJob>(`/api/upload/jobs/${jobId}`);
}

export function runBiliupUpload(body: UploadDraft) {
  return postJson<UploadJob>("/api/upload/run", { draft: body, confirm: true });
}

export function loadUploadHistory(body: { cookiePath?: string; maxPages?: number }) {
  return postJson<UploadHistoryResponse>("/api/upload/history", body);
}

export function loadArchiveDetail(body: { cookiePath?: string; vid: string }) {
  return postJson<UploadArchiveResponse>("/api/upload/show", body);
}

export function packageModelAssets(body: {
  videoKey: string;
  title: string;
  start: number;
  end: number;
  subtitles: unknown[];
  frameCount?: number;
  includeAudio?: boolean;
}) {
  return postJson<{ ok: boolean; path: string; framePaths: string[]; audioPath: string | null; subtitlePath: string | null; contextPath: string }>("/api/model-assets/package", body);
}

export function extractCover(body: { videoKey: string; title: string; time: number }) {
  return postJson<{ ok: boolean; path: string; mediaUrl: string }>("/api/covers/extract", body);
}

export function startAsr(body: { videoKey: string; start?: number; end?: number; asrOverride?: Partial<ServiceSettings["asr"]> }) {
  return postJson<AsrJob>("/api/asr/start", body);
}

export function getAsrJob(jobId: string) {
  return getJson<AsrJob>(`/api/asr/status/${jobId}`);
}

export function prepareAsrModel(body: { provider: string; model: string; modelSize?: string; device?: string }) {
  return postJson<AsrPrepareResponse>("/api/asr/prepare", body);
}

export function convertAllFlv(body?: { roomKey?: string }) {
  return postJson<FlvConvertResponse>("/api/media/convert-flv", body || {});
}

export function testVisionSettings(body: Partial<ServiceSettings["vision"]>) {
  return postJson<{ ok: boolean; elapsedMs: number; endpoint: string; model: string; response: unknown }>("/api/vision/test", body);
}

async function readError(response: Response) {
  try {
    const payload = await response.json();
    return payload.error || payload.message || response.statusText;
  } catch {
    return response.statusText;
  }
}
