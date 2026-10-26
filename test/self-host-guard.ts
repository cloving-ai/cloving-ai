import { spawn } from "node:child_process";

const [parentText, command, ...argumentsList] = process.argv.slice(2);
const parent = Number(parentText);
if (!Number.isSafeInteger(parent) || parent <= 0 || command === undefined)
  throw new Error("self-host-guard needs a parent process ID and a command");
if (process.ppid !== parent) process.exit(1);

const daemon = spawn(command, argumentsList, { stdio: "inherit" });
let orphaned = false;

function stopGroup(): void {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    daemon.kill("SIGKILL");
    process.exit(1);
  }
}

function stopAfterParent(): void {
  if (orphaned) return;
  orphaned = true;
  daemon.kill("SIGTERM");
  setTimeout(stopGroup, 5000);
}

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => daemon.kill(signal));

setInterval(() => {
  if (process.ppid !== parent) stopAfterParent();
}, 200).unref();

daemon.once("exit", (code, signal) => {
  if (orphaned) {
    stopGroup();
    return;
  }
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
