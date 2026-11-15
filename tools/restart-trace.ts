export function restartTrace(phase: string): void {
  if (process.env["CLOVING_RESTART_TRACE"] !== "1") return;
  process.stderr.write(
    JSON.stringify({ phase, at: Date.now(), processId: process.pid }) + "\n",
  );
}
