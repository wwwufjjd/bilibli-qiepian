import { spawn } from "node:child_process";

const nodeCommand = process.execPath;
const testName = "AI clipping workflow validates candidates export draft preflight and upload gate";

console.log("[verify-ai-clipping-workflow] checking candidates -> export -> draft -> preflight -> upload gate");

const code = await run(nodeCommand, [
  "--test",
  "--test-name-pattern",
  testName,
  "tests/server/routes.test.mjs"
]);

if (code !== 0) {
  console.error(`[verify-ai-clipping-workflow] failed with exit code ${code}`);
  process.exit(code);
}

console.log("[verify-ai-clipping-workflow] passed");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", (error) => {
      console.error(`[verify-ai-clipping-workflow] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on("close", (status) => resolve(status ?? 1));
  });
}
