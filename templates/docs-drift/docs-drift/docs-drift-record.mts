import { readFile, rename, writeFile } from "node:fs/promises";
import { absentFile, recordOutput } from "./docs-record.mts";

const chunks: string[] = [];
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) chunks.push(String(chunk));
const output = await recordOutput({
  commandArguments: process.argv.slice(2),
  input: chunks.join(""),
  read: (file) =>
    readFile(file, "utf8").catch((error: unknown) => absentFile(error)),
  write: async (file, content) => {
    const temporary = `${file}.${String(process.pid)}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, file);
  },
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
