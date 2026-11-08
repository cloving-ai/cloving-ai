import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { absentFile } from "./docs-record.mts";
import { commandFailure, scanOutput } from "./docs-scan.mts";

const executed = promisify(execFile);
const output = await scanOutput({
  repository: process.cwd(),
  commandArguments: process.argv.slice(2),
  read: (file) =>
    readFile(file, "utf8").catch((error: unknown) => absentFile(error)),
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
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
