import argparse
import json
import re
import subprocess
from pathlib import Path

from funasr import AutoModel


PUNCTUATION_SPLIT = set("。！？!?；;")
PUNCTUATION_SOFT = set("，、：:,")
TOKEN_SKIP = set(" \t\r\n")


def build_model(model_id: str, device: str, enable_vad: bool = False):
    kwargs = {
        "model": model_id,
        "hub": "hf",
        "trust_remote_code": True,
        "device": device,
        "disable_update": True,
    }
    if enable_vad:
        kwargs["vad_model"] = "fsmn-vad"
        kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}
    return AutoModel(**kwargs)


def should_consume_timestamp(token: str) -> bool:
    if not token:
        return False
    if token in TOKEN_SKIP:
        return False
    return not re.match(r"\s+", token)


def normalize_time(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number > 1000:
        return round(number / 1000.0, 3)
    return round(number, 3)


def normalize_timestamps(raw_timestamps):
    normalized = []
    for item in raw_timestamps or []:
        start = None
        end = None
        token = ""
        if isinstance(item, dict):
            start = normalize_time(item.get("start_time"))
            end = normalize_time(item.get("end_time"))
            token = str(item.get("token") or "")
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            start = normalize_time(item[0])
            end = normalize_time(item[1])
        if start is None or end is None:
            continue
        normalized.append({
            "start": start,
            "end": max(end, start),
            "token": token,
        })
    return normalized


def split_text_by_punctuation(text: str):
    clean_text = str(text or "").strip()
    if not clean_text:
        return []
    pieces = []
    current = []
    for char in clean_text:
        current.append(char)
        joined = "".join(current).strip()
        if not joined:
            continue
        if char in PUNCTUATION_SPLIT:
            pieces.append(joined)
            current = []
        elif char in PUNCTUATION_SOFT and len(joined) >= 24:
            pieces.append(joined)
            current = []
        elif len(joined) >= 38:
            pieces.append(joined)
            current = []
    tail = "".join(current).strip()
    if tail:
        pieces.append(tail)
    return pieces


def segment_text(text: str, timestamps, default_start: float = 0.0, default_end: float | None = None):
    clean_text = str(text or "").strip()
    if not clean_text:
      return []

    normalized_ts = normalize_timestamps(timestamps)
    if not normalized_ts:
        duration_end = default_end if default_end is not None else max(default_start + 2.0, default_start)
        return [{
            "text": clean_text,
            "start": round(float(default_start), 3),
            "end": round(float(duration_end), 3),
        }]

    ts_index = 0
    current_chars = []
    current_start = None
    current_end = None
    sentences = []

    def flush():
        nonlocal current_chars, current_start, current_end
        sentence = "".join(current_chars).strip()
        if not sentence:
            current_chars = []
            current_start = None
            current_end = None
            return
        start_value = current_start if current_start is not None else default_start
        end_value = current_end if current_end is not None else max(start_value + 0.8, default_end or start_value + 0.8)
        sentences.append({
            "text": sentence,
            "start": round(float(start_value), 3),
            "end": round(max(float(end_value), float(start_value) + 0.3), 3),
        })
        current_chars = []
        current_start = None
        current_end = None

    for char in clean_text:
        ts = None
        if should_consume_timestamp(char) and ts_index < len(normalized_ts):
            ts = normalized_ts[ts_index]
            ts_index += 1
        current_chars.append(char)
        if ts:
            if current_start is None:
                current_start = ts["start"]
            current_end = ts["end"]

        joined = "".join(current_chars).strip()
        should_flush = False
        if char in PUNCTUATION_SPLIT:
            should_flush = True
        elif char in PUNCTUATION_SOFT and len(joined) >= 24:
            should_flush = True
        elif len(joined) >= 38:
            should_flush = True
        if should_flush:
            flush()

    flush()
    return sentences


def subtitles_from_item(item, item_index: int):
    text = str(item.get("text") or item.get("text_tn") or "").strip()
    if not text:
        return []

    timestamps = (
        item.get("timestamps")
        or item.get("timestamp")
        or item.get("ctc_timestamps")
        or []
    )
    normalized_ts = normalize_timestamps(timestamps)
    start_hint = normalized_ts[0]["start"] if normalized_ts else 0.0
    end_hint = normalized_ts[-1]["end"] if normalized_ts else None
    subtitles = segment_text(text, timestamps, start_hint, end_hint)
    for cue_index, cue in enumerate(subtitles, start=1):
        cue["id"] = f"funasr-{item_index + 1}-{cue_index}"
        cue["source"] = "funasr-local"
    return subtitles


def normalize_result(result):
    items = result if isinstance(result, list) else [result or {}]
    subtitles = []
    texts = []
    raw_keys = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        raw_keys.update(item.keys())
        text = str(item.get("text") or item.get("text_tn") or "").strip()
        if text:
            texts.append(text)
        subtitles.extend(subtitles_from_item(item, index))

    if not subtitles:
        joined_text = " ".join(texts).strip()
        fallback_parts = split_text_by_punctuation(joined_text)
        if fallback_parts:
            cursor = 0.0
            for index, part in enumerate(fallback_parts, start=1):
                duration = max(1.0, min(6.0, len(part) * 0.18))
                subtitles.append({
                    "id": f"funasr-fallback-{index}",
                    "source": "funasr-local",
                    "text": part,
                    "start": round(cursor, 3),
                    "end": round(cursor + duration, 3),
                })
                cursor += duration

    return {
        "ok": True,
        "text": " ".join(texts).strip(),
        "subtitles": subtitles,
        "rawKeys": sorted(raw_keys),
    }


def audio_duration(audio_path: str):
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                audio_path,
            ],
            check=True,
            capture_output=True,
        )
        return float(result.stdout.decode("utf-8", errors="replace").strip())
    except Exception:
        return 0.0


def extract_audio_chunk(audio_path: str, chunk_path: Path, start: float, end: float):
    chunk_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(max(0.0, start)),
            "-to",
            str(max(start + 0.1, end)),
            "-i",
            audio_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(chunk_path),
        ],
        check=True,
        capture_output=True,
    )


def offset_payload(payload, offset: float, chunk_index: int):
    adjusted = []
    for cue_index, cue in enumerate(payload.get("subtitles") or [], start=1):
        start = max(0.0, float(cue.get("start") or 0.0) + offset)
        end = max(start + 0.1, float(cue.get("end") or 0.0) + offset)
        adjusted.append({
            **cue,
            "id": f"funasr-chunk-{chunk_index}-{cue_index}",
            "start": round(start, 3),
            "end": round(end, 3),
            "source": cue.get("source") or "funasr-local",
        })
    return adjusted


def text_weight(text: str) -> int:
    # ASCII words take more screen/time space than one CJK character.
    weight = 0
    for char in str(text or ""):
        if char.isspace():
            continue
        weight += 1 if ord(char) > 127 else 0.55
    return max(1, int(round(weight)))


def timing_is_suspicious(subtitles, duration: float) -> bool:
    if not subtitles or duration <= 0:
        return False
    max_end = max(float(cue.get("end") or 0.0) for cue in subtitles)
    if max_end > duration + 1.0:
        return True
    for cue in subtitles:
        text = str(cue.get("text") or "").strip()
        start = float(cue.get("start") or 0.0)
        end = float(cue.get("end") or 0.0)
        cue_duration = max(0.0, end - start)
        if len(text) >= 4 and cue_duration >= 10 and len(text) / cue_duration < 1.2:
            return True
        if cue_duration > min(20.0, duration * 0.45):
            return True
    return False


def rebuild_subtitles_by_duration(payload, duration: float):
    text = str(payload.get("text") or "").strip()
    if not text:
        text = "".join(str(cue.get("text") or "") for cue in payload.get("subtitles") or []).strip()
    parts = split_text_by_punctuation(text)
    if not parts:
        return payload

    safe_duration = max(float(duration or 0.0), 0.5)
    weights = [text_weight(part) for part in parts]
    total_weight = max(1, sum(weights))
    cursor = 0.0
    rebuilt = []
    for index, (part, weight) in enumerate(zip(parts, weights), start=1):
        if index == len(parts):
            end = safe_duration
        else:
            piece_duration = safe_duration * (weight / total_weight)
            end = min(safe_duration, cursor + max(0.45, piece_duration))
        rebuilt.append({
            "id": f"funasr-balanced-{index}",
            "source": "funasr-local-balanced",
            "text": part,
            "start": round(cursor, 3),
            "end": round(max(end, cursor + 0.1), 3),
        })
        cursor = max(end, cursor + 0.1)
        if cursor >= safe_duration:
            break

    payload["subtitles"] = rebuilt
    payload["timingMode"] = "balanced_by_text_length"
    return payload


def stabilize_payload_timing(payload, duration: float):
    subtitles = payload.get("subtitles") or []
    if timing_is_suspicious(subtitles, duration):
        return rebuild_subtitles_by_duration(payload, duration)
    return payload


def transcribe_once(model, audio_path: str, language: str):
    result = model.generate(
        input=audio_path,
        batch_size_s=0,
        language=language or "auto",
    )
    return normalize_result(result)


def transcribe_chunked(model, audio_path: str, output: Path, language: str, chunk_seconds: float):
    duration = audio_duration(audio_path)
    if chunk_seconds <= 0 or duration <= chunk_seconds + 1:
        payload = transcribe_once(model, audio_path, language)
        payload = stabilize_payload_timing(payload, duration)
        payload["duration"] = duration
        payload["chunks"] = 1
        return payload

    chunks_dir = output.parent / "chunks"
    subtitles = []
    texts = []
    raw_keys = set()
    chunk_index = 1
    cursor = 0.0
    while cursor < duration:
        end = min(duration, cursor + chunk_seconds)
        chunk_path = chunks_dir / f"chunk-{chunk_index:04d}.wav"
        print(f"chunk {chunk_index}: {cursor:.3f}-{end:.3f}", flush=True)
        extract_audio_chunk(audio_path, chunk_path, cursor, end)
        payload = transcribe_once(model, str(chunk_path), language)
        payload = stabilize_payload_timing(payload, end - cursor)
        if payload.get("text"):
            texts.append(payload["text"])
        raw_keys.update(payload.get("rawKeys") or [])
        subtitles.extend(offset_payload(payload, cursor, chunk_index))
        cursor = end
        chunk_index += 1

    subtitles.sort(key=lambda cue: (cue["start"], cue["end"]))
    return {
        "ok": True,
        "text": " ".join(texts).strip(),
        "subtitles": subtitles,
        "rawKeys": sorted(raw_keys),
        "duration": duration,
        "chunks": chunk_index - 1,
        "chunkSeconds": chunk_seconds,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "transcribe"])
    parser.add_argument("--audio")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--chunk-seconds", type=float, default=0.0)
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    if args.action == "prepare":
        model = build_model(args.model_id, args.device, enable_vad=False)
        del model
        payload = {
            "ok": True,
            "prepared": True,
            "modelId": args.model_id,
            "device": args.device,
        }
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(output)
        return

    if not args.audio:
        raise SystemExit("--audio is required for transcribe")

    model = build_model(args.model_id, args.device, enable_vad=False)
    payload = transcribe_chunked(model, args.audio, output, args.language or "auto", args.chunk_seconds)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
