import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { auditOutput, commandFailure } from "./audit-run.mts";

function alive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

const executed = promisify(execFile);
const temporary = tmpdir();
const folder = await mkdtemp(
  join(temporary, `cloving-audit-${String(process.pid)}-`),
);
const output = await auditOutput({
  repository: process.cwd(),
  folder,
  commandArguments: process.argv.slice(2),
  alive,
  temporary: {
    names: () => readdir(temporary),
    remove: (name) =>
      rm(join(temporary, name), { recursive: true, force: true }),
  },
  run: (call) =>
    executed(call.file, call.args, {
      cwd: call.cwd,
      env: { ...process.env, ...call.environment },
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
