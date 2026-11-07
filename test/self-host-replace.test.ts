import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { record } from "../src/protocol.ts";
import { testMilliseconds } from "./test-timing.ts";

async function hostScript(root: string): Promise<string> {
  const script = join(root, "host.ts");
  const module = pathToFileURL(resolve("tools/self-host-replace.ts")).href;
  await writeFile(
    script,
    `import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { replacedHost } from ${JSON.stringify(module)};
let launches = [];
try { launches = JSON.parse(readFileSync("launches.json", "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const shown = (field) => execFileSync("ps", ["-o", field + "=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
launches.push({
  pid: process.pid,
  parent: process.ppid,
  arguments: process.argv.slice(2),
  terminal: shown("tty"),
  output: process.stdout.isTTY === true,
  mergeMode: process.env.CLOVING_MERGE_MODE ?? null,
  marker: process.env.CLOVING_TEST_MARKER ?? null,
  startedAt: performance.timeOrigin,
});
writeFileSync("launches.json", JSON.stringify(launches));
if (launches.length === 1) writeFileSync("restart-settings", "files");
process.exitCode = await replacedHost({
  directory: process.cwd(),
  runtime: ${JSON.stringify(join(root, "adopted", "run"))},
  status: launches.length === 1 ? 75 : 0,
});
`,
  );
  return script;
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function inTerminal(command: readonly string[]): readonly string[] {
  if (process.platform === "darwin")
    return ["script", "-q", "/dev/null", ...command];
  return ["script", "-qec", command.map(quoted).join(" "), "/dev/null"];
}

await test("CLV-320 a host that ends with 75 replaces itself in place, in the same terminal, with the restart settings", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-replace-")),
  );
  try {
    const [file = "script", ...rest] = inTerminal([
      process.execPath,
      await hostScript(root),
      "--runtime",
      join(root, "legacy", "run"),
      "--legacy-runtime",
      join(root, "legacy", "run"),
      "--adoption-record",
      join(root, "record.json"),
      "--repository",
      root,
      "--reset-queue",
    ]);
    const result = spawnSync(file, rest, {
      cwd: root,
      env: {
        ...process.env,
        CLOVING_MERGE_MODE: "queue",
        CLOVING_TEST_MARKER: "kept",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: testMilliseconds(15000),
    });
    assert.equal(result.error, undefined, result.stderr);
    const launches: unknown = JSON.parse(
      await readFile(join(root, "launches.json"), "utf8"),
    );
    assert.ok(Array.isArray(launches), result.stderr);
    const [first, second, ...others] = launches.map(
      (launch: unknown) => record(launch) ?? {},
    );
    assert.ok(first !== undefined && second !== undefined, result.stderr);
    assert.deepEqual(others, []);
    assert.equal(second["pid"], first["pid"]);
    assert.equal(second["parent"], first["parent"]);
    assert.ok(Number(second["startedAt"]) > Number(first["startedAt"]));
    assert.deepEqual(second["arguments"], [
      "--runtime",
      join(root, "adopted", "run"),
      "--repository",
      root,
    ]);
    assert.equal(first["mergeMode"], "queue");
    assert.equal(second["mergeMode"], null);
    assert.equal(second["marker"], "kept");
    for (const launch of [first, second]) {
      assert.equal(launch["output"], true);
      assert.notEqual(launch["terminal"], "??");
    }
    assert.equal(second["terminal"], first["terminal"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
