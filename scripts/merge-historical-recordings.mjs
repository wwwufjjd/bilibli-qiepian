import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordingsRoot = path.resolve(process.argv[2] || path.join(repoRoot, ".workbench", "recordings"));
const apply = process.argv.includes("--apply");
const gapSeconds = Number(process.env.MERGE_GAP_SECONDS || 120);
const maxGroupMb = Number(process.env.MERGE_MAX_GROUP_MB || 0);
const videoExt = new Set([".mp4", ".flv", ".ts", ".mkv"]);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(item));
    else if (videoExt.has(path.extname(entry.name).toLowerCase())) out.push(item);
  }
  return out;
}

function preferredRank(file) {
  const ext = path.extname(file).toLowerCase();
  return { ".mp4": 0, ".mkv": 1, ".flv": 2, ".ts": 3 }[ext] ?? 9;
}

function baseKey(file) {
  return path.join(path.dirname(file), path.basename(file, path.extname(file))).toLowerCase().replace(/\.merged$/, "");
}

function timestampFromName(file) {
  const match = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_/);
  if (!match) return null;
  const value = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}+08:00`).getTime();
  return Number.isFinite(value) ? value : null;
}

function probeDuration(file) {
  try {
    const output = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file
    ], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return Number(output.trim()) || 0;
  } catch {
    return 0;
  }
}

function nextAvailable(file) {
  if (!fs.existsSync(file)) return file;
  const parsed = path.parse(file);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function ffconcatPath(file) {
  return path.resolve(file).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function moveToArchive(file, archiveDir) {
  if (!file || !fs.existsSync(file)) return null;
  await fsp.mkdir(archiveDir, { recursive: true });
  const target = nextAvailable(path.join(archiveDir, path.basename(file)));
  try {
    await fsp.rename(file, target);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fsp.copyFile(file, target);
    await fsp.rm(file, { force: true });
  }
  return target;
}

async function mergeXml(files, outputXml) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<i>"];
  for (const file of files) {
    const xml = companion(file, ".xml");
    if (!xml || !fs.existsSync(xml)) continue;
    const body = await fsp.readFile(xml, "utf8").catch(() => "");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("<?xml") || trimmed === "<i>" || trimmed === "</i>") continue;
      lines.push(line);
    }
  }
  lines.push("</i>", "");
  await fsp.writeFile(outputXml, lines.join("\n"), "utf8");
}

function companion(file, ext) {
  return file.replace(/\.[^.]+$/, ext);
}

function collectGroups() {
  const byBase = new Map();
  for (const file of walk(recordingsRoot)) {
    if (/\.merged\.|\.history-merged\./i.test(file)) continue;
    const list = byBase.get(baseKey(file)) || [];
    list.push(file);
    byBase.set(baseKey(file), list);
  }
  const chosen = [...byBase.values()]
    .map((group) => group
      .map((file) => ({ file, duration: probeDuration(file), size: fs.statSync(file).size }))
      .filter((item) => item.duration > 0 && item.size > 0)
      .sort((a, b) => preferredRank(a.file) - preferredRank(b.file))[0]?.file)
    .filter(Boolean);
  const items = chosen
    .map((file) => ({
      file,
      dir: path.dirname(file),
      name: path.basename(file),
      start: timestampFromName(file),
      duration: probeDuration(file),
      size: fs.statSync(file).size
    }))
    .filter((item) => item.start != null)
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.start - b.start);

  const groups = [];
  let current = [];
  for (const item of items) {
    const previous = current[current.length - 1];
    const gap = previous ? (item.start - (previous.start + Math.max(0, previous.duration) * 1000)) / 1000 : Infinity;
    const sameGroup = previous && previous.dir === item.dir && gap >= -30 && gap <= gapSeconds;
    if (!sameGroup) {
      if (current.length >= 2) groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length >= 2) groups.push(current);
  return groups;
}

async function mergeGroup(group, index) {
  const first = group[0].file;
  const output = nextAvailable(first.replace(/\.[^.]+$/, ".history-merged.mp4"));
  const listPath = nextAvailable(output.replace(/\.mp4$/, ".concat.txt"));
  await fsp.writeFile(listPath, group.map((item) => `file '${ffconcatPath(item.file)}'`).join("\n") + "\n", "utf8");
  try {
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-map",
      "0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ], { stdio: "pipe", timeout: 1000 * 60 * 60 });
  } finally {
    await fsp.rm(listPath, { force: true }).catch(() => null);
  }
  const duration = probeDuration(output);
  if (!duration) throw new Error(`merged output failed validation: ${output}`);
  await mergeXml(group.map((item) => item.file), output.replace(/\.mp4$/, ".xml"));

  const roomName = path.basename(path.dirname(output)).replace(/[<>:"/\\|?*]+/g, "_");
  const archiveDir = path.join(repoRoot, ".workbench", "merged-segments", "history", roomName, `group-${String(index).padStart(3, "0")}`);
  const archived = [];
  for (const item of group) {
    archived.push(await moveToArchive(item.file, archiveDir));
    archived.push(await moveToArchive(companion(item.file, ".xml"), archiveDir));
    archived.push(await moveToArchive(companion(item.file, ".cover.jpg"), archiveDir));
    archived.push(await moveToArchive(companion(item.file, ".raw.jsonl"), archiveDir));
  }
  return { output, duration: Math.round(duration), archived: archived.filter(Boolean).length };
}

const groups = collectGroups();
const selectedGroups = maxGroupMb > 0
  ? groups.filter((group) => group.reduce((sum, item) => sum + item.size, 0) / 1024 / 1024 <= maxGroupMb)
  : groups;
console.log(JSON.stringify({
  recordingsRoot,
  apply,
  gapSeconds,
  maxGroupMb,
  skippedBySize: groups.length - selectedGroups.length,
  groups: selectedGroups.map((group, index) => ({
    index: index + 1,
    dir: group[0].dir,
    count: group.length,
    totalDuration: Math.round(group.reduce((sum, item) => sum + item.duration, 0)),
    first: group[0].name,
    last: group[group.length - 1].name,
    files: group.map((item) => ({
      name: item.name,
      duration: Math.round(item.duration),
      mb: Math.round(item.size / 1024 / 1024)
    }))
  }))
}, null, 2));

if (apply) {
  const merged = [];
  for (let index = 0; index < selectedGroups.length; index += 1) {
    merged.push(await mergeGroup(selectedGroups[index], index + 1));
  }
  console.log(JSON.stringify({ merged }, null, 2));
}
