import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function startTree(
  root: string,
  statuses: readonly number[],
): Promise<void> {
  await mkdir(join(root, "tools"));
  await writeFile(
    join(root, "hook.mjs"),
    `
import { registerHooks } from "node:module";
const program = ${JSON.stringify(pathToFileURL(resolve("tools/self-host.ts")).href)};
const fake = ${JSON.stringify(pathToFileURL(join(root, "tools/self-host.ts")).href)};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url === program ? nextResolve(fake, context) : resolved;
} });
`,
  );
  await writeFile(
    join(root, "tools/self-host.ts"),
    `
import { readFileSync, writeFileSync } from "node:fs";
let launches = [];
try { launches = JSON.parse(readFileSync("launches.json", "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
launches.push({ arguments: process.argv.slice(2), marker: process.env.CLOVING_TEST_MARKER });
writeFileSync("launches.json", JSON.stringify(launches));
const status = ${JSON.stringify(statuses)}[launches.length - 1] ?? 2;
if (process.env.CLOVING_TEST_SIGNAL && launches.length === 1) {
  process.on(process.env.CLOVING_TEST_SIGNAL, () => {});
  process.kill(process.ppid, process.env.CLOVING_TEST_SIGNAL);
  setTimeout(() => process.exit(status), 30);
} else process.exit(status);
`,
  );
}

async function started(
  statuses: readonly number[],
  options: { readonly signal?: string } = {},
): Promise<{
  readonly status: number | null;
  readonly launches: readonly unknown[];
  readonly expected: {
    readonly arguments: readonly string[];
    readonly marker: string;
  };
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-start-")));
  try {
    await startTree(root, statuses);
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "start", "--repository", "chosen"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLOVING_RUNTIME_DIR: join(root, "run"),
          CLOVING_TEST_MARKER: "preserved",
          CLOVING_TEST_SIGNAL: options.signal,
          NODE_OPTIONS: `--import=${pathToFileURL(join(root, "hook.mjs")).href}`,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined, result.stderr);
    const launches: unknown = JSON.parse(
      await readFile(join(root, "launches.json"), "utf8"),
    );
    assert.ok(Array.isArray(launches));
    return {
      status: result.status,
      launches: launches.map((value: unknown) => value),
      expected: {
        arguments: [
          "--runtime",
          join(root, "run"),
          "--repository",
          root,
          "--client",
          `CLOVING_RUNTIME_DIR=${join(root, "run")} cloving`,
          "--repository",
          "chosen",
        ],
        marker: "preserved",
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("CLV-085 start restarts exit 75 with the same arguments and environment", async () => {
  const result = await started([75, 0]);
  assert.equal(result.status, 0);
  assert.equal(result.launches.length, 2);
  assert.deepEqual(result.launches[0], result.launches[1]);
  assert.deepEqual(result.launches[0], result.expected);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  await test(`CLV-085 ${signal} during an update prevents restart on exit 75`, async () => {
    const result = await started([75, 0], { signal });
    assert.equal(result.status, 0);
    assert.equal(result.launches.length, 1);
  });
}

await test("CLV-085 start does not restart exit 1", async () => {
  const result = await started([1]);
  assert.equal(result.status, 1);
  assert.equal(result.launches.length, 1);
});
