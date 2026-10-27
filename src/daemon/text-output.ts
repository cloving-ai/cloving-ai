import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { WriteStream } from "node:fs";
import { usageOf } from "../worker-usage.ts";
import { ticketStatus } from "../ticket-status.ts";

export function textOutput(
  child: ChildProcessWithoutNullStreams,
  output: WriteStream,
) {
  let text = "";
  let error = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    error += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    text += chunk;
    output.write(chunk);
  });
  return async (exitCode: number | null) => {
    await new Promise<void>((resolve) => output.end(resolve));
    return {
      ticketStatus: ticketStatus(text),
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
