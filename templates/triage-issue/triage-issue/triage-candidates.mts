import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidateOutput } from "./triage-queue.mts";

const executed = promisify(execFile);
const output = await candidateOutput({
  gh: async (args) =>
    (
      await executed("gh", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout,
  operators: process.argv.slice(2),
  quietSince: new Date(Date.now() - 600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z"),
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
