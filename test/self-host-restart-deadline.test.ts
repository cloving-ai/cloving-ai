import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartText } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { eventually } from "./service-fixture.ts";

await test("CLV-320 a restart that reaches its deadline with an active run is cancelled, ends the queue hold and names the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-deadline-"));
  try {
    const paths = await programs(root, {
      statusRuns: [
        { runId: "run-busy", workflowId: "develop", state: "running" },
      ],
    });
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(directory, "run"),
      directory,
      watchPort: "off",
      phoneRelay: "off",
      updateMilliseconds: undefined,
      restartMilliseconds: 50,
    });
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const requestedAt = Date.now();
    await writeFile(
      join(directory, "pending-restart-one"),
      restartText({
        at: "gap",
        requestedAt,
        commandId: "restart-late",
        resumeQueue: false,
        deadline: requestedAt + 1000,
      }),
    );
    const failure = join(directory, "restart-failure");
    await eventually(() => (existsSync(failure) ? true : undefined));
    assert.deepEqual(JSON.parse(await readFile(failure, "utf8")), {
      commandId: "restart-late",
      requestedAt,
      code: "restart-deadline",
      step: "wait",
      output: "Active runs: run-busy",
    });
    await eventually(async () =>
      (await readdir(directory)).some((name) =>
        name.startsWith("pending-restart"),
      )
        ? undefined
        : true,
    );
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    process.emit("SIGTERM");
    assert.equal(await hosting, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-320 a restart past its deadline is removed even when its failure note cannot be saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-deadline-"));
  try {
    const paths = await programs(root, {
      statusRuns: [
        { runId: "run-busy", workflowId: "develop", state: "running" },
      ],
    });
    const directory = join(root, "host");
    await mkdir(join(directory, "restart-failure", "blocked"), {
      recursive: true,
    });
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(directory, "run"),
      directory,
      watchPort: "off",
      phoneRelay: "off",
      updateMilliseconds: undefined,
      restartMilliseconds: 50,
    });
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const requestedAt = Date.now();
    await writeFile(
      join(directory, "pending-restart-one"),
      restartText({
        at: "gap",
        requestedAt,
        commandId: "restart-unsaved",
        resumeQueue: false,
        deadline: requestedAt + 500,
      }),
    );
    await eventually(async () =>
      (await readdir(directory)).some((name) =>
        name.startsWith("pending-restart"),
      )
        ? undefined
        : true,
    );
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    process.emit("SIGTERM");
    assert.equal(await hosting, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
