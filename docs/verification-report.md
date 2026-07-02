# 1-6 Workflow Verification Report

Last updated: 2026-06-20

This report maps the requested 1-6 workflow to concrete verification evidence in the current worktree. It is intentionally practical: every item names the command, browser flow, or test that proves the behavior.

## 1. Add Bilibili live rooms and enable automatic recording

Status: verified.

Evidence:

- Frontend acceptance covers per-room recording switch behavior and automatic live state display:
  - `tests/acceptance/bilibili-live-pipeline.spec.ts`
  - `room recording switch disables manual start`
  - `room overview presents automatic live state without manual sweep`
- Server tests cover full Bilibili live URLs, enabled-room wait state, automatic live monitor sweeps, and danmaku LIVE event startup:
  - `recording rooms accept full Bilibili live URLs`
  - `enabled rooms expose monitoring wait state before first sweep`
  - `recording monitor sweep starts live rooms and keeps offline rooms waiting`
  - `auto monitor starts recording from danmaku LIVE event without manual sweep`
- Latest full server run: `npm run test:server` passed 34/34.

## 2. Automatically record video and XML danmaku, then import material

Status: verified with real Bilibili live rooms.

Evidence:

- Real smoke command with forced real danmaku:

```powershell
$env:REAL_BILI_ROOM_ID="545068"
$env:REAL_BILI_SAMPLE_SECONDS="45"
$env:REAL_BILI_REQUIRE_DANMAKU="1"
npm run test:real-live-api
```

- Latest real smoke result:
  - Room: `545068`
  - Sample length: 45 seconds
  - FLV size: 10.0 MB
  - Running speed sample: 1.4 MB/s
  - XML danmaku entries: 21
  - raw JSONL lines: 21
  - full event chain included `InternalRecorderStartedEvent`, `LiveBeganEvent`, `VideoFileCreatedEvent`, `DanmakuFileCreatedEvent`, `RecordingFinishedEvent`, `VideoFileCompletedEvent`, `DanmakuFileCompletedEvent`, and `RawDanmakuFileCompletedEvent`.
- The smoke script now fails when `REAL_BILI_REQUIRE_DANMAKU=1` and no real `<d>` danmaku entries are captured.
- Isolated material API scan of room `545068` found:
  - 1 video
  - 1 XML
  - 9 parsed danmaku rows in an earlier sample
- Server tests also cover internal recorder FLV/XML writing, reconnect, postprocess, and websocket danmaku capture:
  - `internal Bilibili recorder writes FLV/XML and emits recording completion events`
  - `internal recorder automatically reconnects after transient stream failure`
  - `internal recorder postprocesses completed segments with cover, remux, and source cleanup`
  - `internal recorder captures websocket danmaku into xml and raw jsonl`

## 3. Open a single-room clipping workbench

Status: verified.

Evidence:

- Browser verification opened the TES room and confirmed the workbench sidebar only showed that room's two materials.
- Acceptance coverage:
  - `workspace sidebar is scoped to the opened live room materials`
  - `same Bilibili room material folders merge into one card and one workspace`
  - `fixed live room without local material still opens its workspace`
  - `workspace marks the actively recording material and keeps finished material editable`
- Latest full acceptance run: `npm run test:acceptance` passed 44/44 with 2 real-live env-gated skips.

## 4. Generate few, high-confidence AI clips with evidence and human-readable reasons

Status: verified.

Evidence:

- Real model gateway:
  - endpoint: local OpenAI-compatible gateway on IPv4 loopback
  - wire API: `chat-completions`
  - model: `gpt-5.5`
  - `/responses` is intentionally not used for this gateway because it returned `invalid_responses_request`.
- Browser verification generated real UI candidates for the TES sample:
  - 2 high-score candidates
  - each candidate had 5 evidence chips
  - clicking a `0:23` evidence chip moved the workbench time to `0:23` and updated danmaku sync to the same time window.
- Sparse real sample behavior was also verified: a 45-second real recording with too little signal returned 0 candidates, preserving the "few and accurate" requirement instead of forcing weak clips.
- Acceptance coverage:
  - `workbench evidence, danmaku, and subtitle rows seek the same timeline`
  - `task center shows automation clips, exports, and upload draft path`
- Server coverage:
  - `automation jobs use model-enhanced slice titles and reasons`
  - `queues and runs high-confidence automation from completed recording events`
  - `automation can keep recording-complete events from auto-queueing clips`
  - `automation reconciles stable recording files that missed completion events`

## 5. Run ASR, align subtitles, generate title and cover

Status: verified.

Evidence:

- Real ASR sample previously completed with global timeline cues and rewrote `result.srt` to global time.
- Server tests lock the ASR alignment behavior:
  - `normalizes segment-local ASR cues to the global video timeline`
  - `does not offset ASR cues that are already global`
  - `ASR jobs expose completed status and rewrite subtitle files to the global timeline`
- Browser/acceptance coverage verifies evidence, danmaku, and subtitle rows seek the same timeline.
- Real AI title generation was verified against the configured gateway and returned Chinese title alternatives and reasons.
- Cover extraction/template generation was verified and produced non-empty JPG output.

## 6. Prepare upload draft, preflight, and require explicit final confirmation

Status: verified up to the intentionally gated public side effect.

Evidence:

- Acceptance coverage:
  - `upload does not publish before final confirmation`
  - `upload execution stays disabled until cookie exists`
- Server coverage:
  - `blocks auto-public uploads without high-confidence clip evidence`
  - `accepts high-confidence auto-public upload policy`
  - `upload policy can simulate final execution during preflight`
  - `confirmed upload run executes a local biliup command without bypassing the gate`
- The confirmed-upload server test uses a local fake `biliup` command:
  - `/api/upload/run` without `confirm=true` returns 400.
  - `/api/upload/run` with `confirm=true`, cookie, and video creates a `biliup-run` job.
  - The job executes the local command, passes `upload` and `--is-only-self`, and reaches `ready`.
  - No real Bilibili account or public upload is touched.
- Windows `.cmd/.bat` execution is covered by `runProcessJob`, which now uses shell execution for command shims.

Important safety boundary:

- Real public posting is not executed by automated tests.
- It requires a valid Bilibili cookie and explicit user confirmation at action time.

## Latest Regression Commands

Verified in the current run:

```powershell
npm run test:workflow
```

The workflow command runs typecheck, server tests, acceptance tests, and build. To include a real Bilibili live smoke in the same run:

```powershell
$env:REAL_BILI_ROOM_ID="545068"
$env:REAL_BILI_SAMPLE_SECONDS="45"
$env:REAL_BILI_REQUIRE_DANMAKU="1"
$env:VERIFY_REAL_LIVE="1"
npm run test:workflow
```

Equivalent single-step commands:

```powershell
npm run typecheck
npm run build
npm run test:server
npm run test:acceptance
```

Current latest results:

- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run test:server`: 34/34 passed
- `npm run test:acceptance`: 44 passed, 2 real-live env-gated skips
- `npm run test:workflow`: passed; typecheck, server tests, acceptance tests, and build all passed in 140s
- `VERIFY_REAL_LIVE=1 npm run test:workflow`: passed; typecheck, server tests, acceptance tests, build, and real live smoke all passed in 216s
- `npm run test:real-live-api`: passed for room `545068`; 45s FLV/XML/raw-danmaku sample captured 21 real danmaku rows
- `REAL_BILI_UI=1 npx playwright test tests/acceptance/real-live-verification.spec.ts`: passed for room `545068`; Chromium ran the real UI recording flow, mobile skipped to avoid duplicate external recording, and cleanup left the room stopped.

## Remaining External Gate

The only intentionally unexecuted public side effect is real Bilibili publishing. It should stay gated until the operator provides a valid cookie and explicitly confirms the final upload.
