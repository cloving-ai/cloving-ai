import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function collectVerificationOutput(
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  overflow: () => void,
): { stdout: string; stderr: string } {
  const output = { stdout: "", stderr: "" };
  let bytes = 0;
  for (const channel of ["stdout", "stderr"] as const) {
    child[channel].setEncoding("utf8");
    child[channel].on("data", (data: string) => {
      if (bytes > 1024 * 1024) return;
      bytes += Buffer.byteLength(data);
      if (bytes > 1024 * 1024) {
        overflow();
        return;
      }
      output[channel] += data;
    });
  }
  return output;
}
