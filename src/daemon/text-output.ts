import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { WriteStream } from "node:fs";
import { usageOf } from "../worker-usage.ts";
import { ticketStatusStream } from "../ticket-status-stream.ts";

export function textOutput(
  child: ChildProcessWithoutNullStreams,
  options: { readonly output: WriteStream; readonly limit: number },
) {
  const { output, limit } = options;
  const status = ticketStatusStream(limit);
  let text = "";
  let error = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    error = (error + chunk).slice(-limit);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text = (text + chunk).slice(-limit);
    status.write(chunk);
    if (!output.write(chunk)) {
      child.stdout.pause();
      output.once("drain", () => {
        child.stdout.resume();
      });
    }
  });
  return async (exitCode: number | null) => {
    await new Promise<void>((resolve) => output.end(resolve));
    return {
      ...status.result(),
      text: exitCode === 0 ? text : error,
      failed: exitCode !== 0,
      model: null,
      costUsd: null,
      usage: usageOf(null),
      sessionId: null,
      turns: null,
    };
  };
}
