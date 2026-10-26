import { spawn } from "node:child_process";

const [command, ...argumentsList] = process.argv.slice(2);
if (command === undefined) throw new Error("self-host-guard needs a command");

const parent = process.ppid;
const daemon = spawn(command, argumentsList, { stdio: "inherit" });

function stopDaemon(): void {
  daemon.kill("SIGTERM");
  setTimeout(() => daemon.kill("SIGKILL"), 5000).unref();
}

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => daemon.kill(signal));

setInterval(() => {
  if (process.ppid !== parent) stopDaemon();
}, 200).unref();

daemon.once("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
