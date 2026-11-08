import { appendFile } from "node:fs/promises";
import { recordOutput } from "./review-record.mts";

async function standardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

const output = await recordOutput({
  commandArguments: process.argv.slice(2),
  input: await standardInput(),
  decidedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  runId: process.env["CLOVING_RUN_ID"] ?? null,
  append: (path, lines) =>
    appendFile(path, lines, { encoding: "utf8", mode: 0o600 }),
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
