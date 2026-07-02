import type {
  AsrJob,
  AsrPrepareResponse,
  AiSliceDiagnostics,
  AutomationJob,
  ClipCandidate,
  ClipDraft,
  CoverGenerationResponse,
  FlvConvertResponse,
  PreviewStatus,
  RecordingEvent,
  FixedRoom,
  RecordingMonitorStatus,
  RecordingRoomStatus,
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
    throw await responseError(response);
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
    throw await responseError(response);
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
  clipCount: number;
  precisionMode?: "high" | "recall" | string;
  subtitles?: SubtitleCue[];
  danmakuEdits?: Record<string, string>;
}) {
  return postJson<{ candidates: ClipCandidate[]; diagnostics: AiSliceDiagnostics }>("/api/ai/slices", body);
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

export function loadAutomationJobs() {
  return getJson<{ jobs: AutomationJob[] }>("/api/automation/jobs");
}

export function analyzeVideoAutomation(body: { videoKey: string; uploadPolicy?: string }) {
  return postJson<{ ok: boolean; job: AutomationJob }>("/api/automation/analyze", body);
}

export function runAutomationJob(jobId: string) {
  return postJson<{ ok: boolean; job: AutomationJob }>(`/api/automation/jobs/${encodeURIComponent(jobId)}/run`, {});
}

export function runRecordingMonitorSweep() {
  return postJson<{
    ok: boolean;
    status: string;
    checked: number;
    started: number;
    waiting: number;
    skipped: number;
    errors: number;
    messages: string[];
    updatedAt: string;
  }>("/api/recording/monitor/sweep", {});
}

export function loadRecordingMonitorStatus() {
  return getJson<RecordingMonitorStatus>("/api/recording/monitor/status");
}

export function loadRecordingEvents(limit = 8) {
  return getJson<{ events: RecordingEvent[] }>(`/api/recording/events?limit=${encodeURIComponent(String(limit))}`);
}

export function loadFixedRooms(options: { enrich?: boolean } = {}) {
  const query = options.enrich === false ? "?enrich=0" : "";
  return getJson<{ rooms: FixedRoom[] }>(`/api/recording/rooms${query}`);
}

export function addFixedRoom(body: { roomId: string; name?: string }) {
  return postJson<{ ok: boolean; room: FixedRoom; rooms: FixedRoom[] }>("/api/recording/rooms", body);
}

export function updateFixedRoom(roomId: string, body: Partial<Pick<FixedRoom, "enabled" | "name" | "priority">>) {
  return fetch(`/api/recording/rooms/${encodeURIComponent(roomId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || response.statusText);
    return payload as { ok: boolean; room: FixedRoom; rooms: FixedRoom[] };
  });
}

export function deleteFixedRoom(roomId: string) {
  return fetch(`/api/recording/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE"
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || response.statusText);
    return payload as { ok: boolean; rooms: FixedRoom[] };
  });
}

export function deleteMaterialRoom(roomKey: string) {
  return fetch(`/api/rooms/${encodeURIComponent(roomKey)}`, {
    method: "DELETE"
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || response.statusText);
    return payload as { ok: boolean; rooms: import("./types").Room[] };
  });
}

export async function postRecordingRoomAction(roomId: string, action: "start" | "stop" | "retry") {
  const response = await fetch(`/api/recording/rooms/${encodeURIComponent(roomId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || response.statusText) as Error & { payload?: unknown };
    error.payload = payload;
    throw error;
  }
  return payload as RecordingRoomStatus & { roomId: string };
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

export function convertAllFlv(body?: { roomKey?: string; videoKeys?: string[] }) {
  return postJson<FlvConvertResponse>("/api/media/convert-flv", body || {});
}

export function testVisionSettings(body: Partial<ServiceSettings["vision"]>) {
  return postJson<{ ok: boolean; elapsedMs: number; endpoint: string; wireApi: string; model: string; response: unknown }>("/api/vision/test", body);
}

async function responseError(response: Response) {
  const payload = await readErrorPayload(response);
  const message = readablePayloadMessage(payload, response.statusText);
  const error = new Error(message) as Error & { payload?: unknown };
  error.payload = payload;
  return error;
}

async function readErrorPayload(response: Response) {
  try {
    return await response.json();
  } catch {
    return { error: response.statusText };
  }
}

function readablePayloadMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as { diagnostic?: { message?: unknown }; error?: unknown; message?: unknown };
    if (typeof record.diagnostic?.message === "string") return record.diagnostic.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return fallback;
}
