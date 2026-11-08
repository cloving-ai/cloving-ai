import { appendFile, readFile } from "node:fs/promises";
import { recordOutput } from "./review-record.mts";

const output = await recordOutput({
  commandArguments: process.argv.slice(2),
  input: await readFile("/dev/stdin", "utf8"),
  decidedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  runId: process.env["CLOVING_RUN_ID"] ?? null,
  append: (path, lines) =>
    appendFile(path, lines, { encoding: "utf8", mode: 0o600 }),
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
