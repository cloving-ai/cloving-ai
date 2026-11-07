import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { auditOutput, commandFailure } from "./audit-run.mts";

const executed = promisify(execFile);
const folder = await mkdtemp(join(tmpdir(), "cloving-audit-"));
const output = await auditOutput({
  repository: process.cwd(),
  folder,
  run: (call) =>
    executed(call.file, call.args, {
      cwd: call.cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }).then(
      (ended) => ({ error: null, stdout: ended.stdout, stderr: ended.stderr }),
      (error: unknown) => commandFailure(error),
    ),
});
await rm(folder, { recursive: true, force: true });
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
