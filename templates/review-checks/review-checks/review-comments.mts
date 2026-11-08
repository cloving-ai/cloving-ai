import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { factsOutput } from "./review-facts.mts";

const executed = promisify(execFile);
const commandArguments = process.argv.slice(2);
const [folder = "", decisionsFile = ""] = commandArguments;

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const output = await factsOutput({
  commandArguments,
  since: new Date(Date.now() - 7 * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z"),
  run: async (call) =>
    (
      await executed(call.command, call.args, {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: call.github
          ? { ...process.env, GH_CONFIG_DIR: folder }
          : process.env,
      })
    ).stdout,
  decisions: () =>
    readFile(decisionsFile, "utf8").catch((error: unknown) => {
      if (absent(error)) return "";
      throw error;
    }),
  qualityChecks: () =>
    readdir("quality").catch((error: unknown) => {
      if (absent(error)) return [];
      throw error;
    }),
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
