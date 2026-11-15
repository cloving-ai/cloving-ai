import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { scene, withoutChildren } from "./self-host-fixture.ts";
import { call, eventually } from "./service-fixture.ts";
import {
  restartCli,
  replacementPhases,
} from "./restart-diagnostics-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { productCopy } from "./restart-product-fixture.ts";
import { rememberedBuild } from "../tools/restart-build.ts";
import { isRestartRequest } from "../src/restart-request.ts";
import { field, items } from "./self-host-fixture.ts";

async function coveredScripts(directory: string): Promise<readonly string[]> {
  const scripts: string[] = [];
  for (const name of await readdir(directory)) {
    const report: unknown = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    );
    scripts.push(
      ...items(field(report, "result")).map((entry) =>
        String(field(entry, "url")),
      ),
    );
  }
  return scripts;
}

await test(
  "CLV-347 fresh product setup excludes compiler coverage and retains public CLI coverage",
  { timeout: 120_000 },
  () =>
    withFiles({}, async (root) => {
      const coverage = join(root, "coverage");
      const probe = join(root, "probe.mjs");
      await mkdir(coverage);
      await writeFile(
        probe,
        `import { writeFileSync } from "node:fs";
const compiler = process.argv[1].endsWith("/typescript/bin/tsc");
writeFileSync(new URL(compiler ? "compiler.json" : "runtime.json", import.meta.url), JSON.stringify({ coverage: process.env.NODE_V8_COVERAGE ?? null, compileCache: process.env.NODE_DISABLE_COMPILE_CACHE ?? null }));`,
      );
      const environment = { ...process.env };
      process.env["NODE_V8_COVERAGE"] = coverage;
      process.env["NODE_DISABLE_COMPILE_CACHE"] = "1";
      process.env["NODE_OPTIONS"] = `--import=${pathToFileURL(probe).href}`;
      try {
        const started = performance.now();
        const product = await productCopy(root);
        console.info(
          "Product setup milliseconds:",
          performance.now() - started,
        );
        const compiler: unknown = JSON.parse(
          await readFile(join(root, "compiler.json"), "utf8"),
        );
        assert.equal(field(compiler, "coverage"), null);
        assert.equal(field(compiler, "compileCache"), "1");
        assert.equal(process.env["NODE_V8_COVERAGE"], coverage);
        const executable = join(product, "dist/src/cli.js");
        execFileSync(process.execPath, [executable, "--version"], {
          cwd: product,
          timeout: 10_000,
        });
        const runtime: unknown = JSON.parse(
          await readFile(join(root, "runtime.json"), "utf8"),
        );
        assert.equal(field(runtime, "coverage"), coverage);
        const scripts = await coveredScripts(coverage);
        assert.ok(scripts.includes(pathToFileURL(executable).href));
        assert.equal(
          scripts.some((url) => url.includes("/typescript/lib/_tsc.js")),
          false,
        );
      } finally {
        process.env = environment;
      }
    }),
);

async function queueStartupGate(root: string): Promise<string> {
  const file = join(root, "queue-startup.mjs");
  await writeFile(
    file,
    `import files from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
if (process.argv[1]?.endsWith("/start.mjs")) {
  const original = files.rm;
  files.rm = async (path, ...parameters) => {
    if (typeof path === "string" && path.endsWith("/queue-submission") && existsSync(${JSON.stringify(join(root, "arm-queues"))})) {
      writeFileSync(${JSON.stringify(join(root, "queues-held"))}, String(process.pid));
      while (!existsSync(${JSON.stringify(join(root, "release-queues"))})) await delay(10);
    }
    return original(path, ...parameters);
  };
  syncBuiltinESMExports();
}`,
  );
  return `--import=${pathToFileURL(file).href}`;
}

async function assertRetainedQueueSetting(
  fixture: Awaited<ReturnType<typeof scene>>,
): Promise<void> {
  const refused = await call(fixture, {
    operation: "queue-setting",
    parameters: {
      scope: "workflow",
      field: "lanes",
      action: "set",
      workflowId: "queued",
      value: 3,
      expectedValue: 4,
      commandId: "after-restart",
    },
  });
  assert.equal(
    refused["code"],
    "queue-setting-failed",
    JSON.stringify(refused),
  );
  assert.match(
    String(refused["detail"]),
    /CLOVING_QUEUES.*environment.*retained start/,
  );
}

await test(
  "CLV-347 restart waits for replacement queue controls before it reports recovery complete",
  { timeout: 120_000 },
  () =>
    withFiles({}, async (root) => {
      const product = await productCopy(root);
      await rememberedBuild(product);
      await withoutChildren(async () => {
        const fixture = await scene(
          undefined,
          join(product, "dist/src/cli.js"),
        );
        await writeQueueWorkflow(
          join(fixture.repository, ".cloving/workflows"),
        );
        await fixture.start({
          NODE_OPTIONS: await queueStartupGate(root),
          CLOVING_PHONE_RELAY: "off",
          CLOVING_NEXT_COMMAND: '["false"]',
          CLOVING_QUEUE_SECONDS: "3600",
          CLOVING_QUEUES: '{"queued":{"lanes":4}}',
        });
        const before = await call(fixture, {
          operation: "status",
          parameters: {},
        });
        await writeFile(join(root, "arm-queues"), "");
        const completion = { finished: false };
        const restarting = restartCli(fixture, { arguments: [] }).then(
          (reply) => {
            completion.finished = true;
            return reply;
          },
        );
        try {
          await eventually(() =>
            readFile(join(root, "queues-held")).then(
              () => true,
              () => undefined,
            ),
          );
          const held = await call(fixture, {
            operation: "status",
            parameters: {},
          });
          assert.notEqual(held["serviceStartedAt"], before["serviceStartedAt"]);
          assert.equal(field(held["turnRecovery"], "state"), "recovering");
          assert.equal(completion.finished, false);
          await writeFile(join(root, "release-queues"), "");
          const reply = await restarting;
          assert.equal(reply.status, 0, reply.stdout + reply.stderr);
          await assertRetainedQueueSetting(fixture);
        } finally {
          await writeFile(join(root, "release-queues"), "");
          await restarting;
        }
      });
    }),
);

async function analyzerBoundary(root: string): Promise<string> {
  const preload = join(root, "analyzer-boundary.mjs");
  await writeFile(
    preload,
    `import { registerHooks } from "node:module";
import { existsSync, appendFileSync } from "node:fs";
if (process.argv[1]?.endsWith("/start.mjs")) registerHooks({ load(url, context, next) {
  if (url.endsWith("/tools/restart-settings.js")) process.env.CLOVING_NEXT_COMMAND = '["false"]';
  if (url.endsWith("/tools/workflow-folders.js")) {
    appendFileSync(${JSON.stringify(join(root, "analyzer-loads"))}, String(process.pid) + "\\n");
    if (!existsSync(${JSON.stringify(join(root, "release-analyzer"))})) throw new Error("future-validator-analyzer-loaded-before-request");
  }
  return next(url, context);
} });`,
  );
  return `--import=${pathToFileURL(preload).href}`;
}

async function checkedRestart(
  fixture: Awaited<ReturnType<typeof scene>>,
  output: () => string,
) {
  const before = await call(fixture, { operation: "status", parameters: {} });
  const requested = Date.now();
  const reply = await restartCli(fixture, { arguments: [] });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const after = await call(fixture, { operation: "status", parameters: {} });
  assert.notEqual(after["serviceStartedAt"], before["serviceStartedAt"]);
  const startedAt = Date.parse(String(after["serviceStartedAt"]));
  assert.ok(startedAt - requested < 10_000);
  const { phases, ready } = await replacementPhases({
    output,
    requested,
    startedAt,
    required: [
      "product-commit-start",
      "product-commit-end",
      "launchers-start",
      "launchers-end",
      "daemon-spawn-start",
      "daemon-spawn-end",
      "daemon-entry",
      "daemon-modules-ready",
      "daemon-call",
      "registrations-start",
      "registrations-end",
      "adapters-start",
      "adapters-end",
      "service-identity",
      "listener-ready",
      "recovery-end",
    ],
  });
  assert.ok(ready.at - requested < 10_000);
  console.info("Cold validator restart phases:", JSON.stringify(phases));
}

async function freshValidation(
  fixture: Awaited<ReturnType<typeof scene>>,
  check: { readonly root: string; readonly cycle: number },
) {
  const { root, cycle } = check;
  await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
  const refusal = await call(fixture, {
    operation: "restart",
    parameters: {
      at: "keep",
      commandId: `invalid-${String(cycle)}`,
      set: { "queue.everySeconds": "60", "tickets.command": "[]" },
    },
  });
  assert.equal(
    refusal["code"],
    "invalid-restart-setting",
    JSON.stringify(refusal),
  );
  assert.match(String(refusal["detail"]), /queue-needs-next-command/);
  assert.equal(
    (await readFile(join(root, "analyzer-loads"), "utf8")).trim().split("\n")
      .length,
    cycle + 1,
  );
  const status = await call(fixture, { operation: "status", parameters: {} });
  assert.equal(status["restart"], null);
  assert.equal(
    (await readdir(fixture.directory)).some((name) => isRestartRequest(name)),
    false,
  );
  await rm(join(fixture.repository, ".cloving/workflows"), { recursive: true });
}

await test(
  "CLV-347 a cold future validator does not delay daemon readiness and validates fresh files before first and repeated restarts",
  { timeout: 120_000 },
  () =>
    withFiles({}, async (root) => {
      const product = await productCopy(root);
      await rememberedBuild(product);
      const options = await analyzerBoundary(root);
      await withoutChildren(async () => {
        const fixture = await scene(
          undefined,
          join(product, "dist/src/cli.js"),
        );
        const host = await fixture.start({
          NODE_OPTIONS: options,
          CLOVING_PHONE_RELAY: "off",
          CLOVING_RESTART_TRACE: "1",
        });
        let output = "";
        for (const stream of [host.stdout, host.stderr])
          stream?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
        await assert.rejects(readFile(join(root, "analyzer-loads")), {
          code: "ENOENT",
        });
        await writeFile(join(root, "release-analyzer"), "");
        for (let cycle = 0; cycle < 2; cycle += 1) {
          await freshValidation(fixture, { root, cycle });
          await checkedRestart(fixture, () => output);
          assert.equal(
            (await readFile(join(root, "analyzer-loads"), "utf8"))
              .trim()
              .split("\n").length,
            cycle + 1,
          );
        }
      });
    }),
);
