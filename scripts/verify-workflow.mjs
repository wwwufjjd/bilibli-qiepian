import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const includeRealLive = ["1", "true", "yes"].includes(String(process.env.VERIFY_REAL_LIVE || "").toLowerCase());
const skipAcceptance = ["1", "true", "yes"].includes(String(process.env.VERIFY_SKIP_ACCEPTANCE || "").toLowerCase());

const steps = [
  ["typecheck", ["run", "typecheck"]],
  ["server tests", ["run", "test:server"]],
  ...(!skipAcceptance ? [["acceptance tests", ["run", "test:acceptance"]]] : []),
  ["build", ["run", "build"]]
];

if (includeRealLive) {
  if (!String(process.env.REAL_BILI_ROOM_ID || "").trim()) {
    console.error("VERIFY_REAL_LIVE=1 requires REAL_BILI_ROOM_ID to point at a currently live Bilibili room.");
    process.exit(2);
  }
  steps.push(["real live recording smoke", ["run", "test:real-live-api"]]);
}

const startedAt = Date.now();
const results = [];

for (const [label, args] of steps) {
  const stepStartedAt = Date.now();
  console.log(`\n[verify-workflow] ${label}`);
  const code = await run(npmCommand, args);
  const elapsedSeconds = Math.round((Date.now() - stepStartedAt) / 1000);
  results.push({ label, code, elapsedSeconds });
  if (code !== 0) {
    printSummary(results, startedAt);
    process.exit(code);
  }
}

printSummary(results, startedAt);

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true
    });
    child.on("error", (error) => {
      console.error(`[verify-workflow] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function printSummary(items, startedAt) {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log("\n[verify-workflow] summary");
  for (const item of items) {
    const status = item.code === 0 ? "passed" : `failed (${item.code})`;
    console.log(`- ${item.label}: ${status} in ${item.elapsedSeconds}s`);
  }
  console.log(`- total: ${elapsedSeconds}s`);
}
