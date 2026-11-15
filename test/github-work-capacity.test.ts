import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { until } from "./claude-worker-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import {
  start,
  request,
  mergeWorker,
  deliverMerge,
} from "./queue-work-fixture.ts";
import { capacityCalls } from "../src/daemon/github-work-capacity.ts";
import { setImmediate } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";

after(removeTemporaryDirectories);

await test("CLV-377 a temporary authority failure waits before verification and repeated released replies fail without executing", async () => {
  let attempts = 0;
  let checks = 0;
  const base = {
    intent: {
      runId: "run",
      operationId: "operation",
      inputDigest: `sha256:${"a".repeat(64)}`,
      leaseGeneration: 1,
      method: "merge",
    },
    signal: AbortSignal.timeout(testMilliseconds(2000)),
  };
  const source = {
    gh: () => Promise.resolve(""),
    git: () => Promise.resolve(""),
    run: () => {
      checks++;
      return Promise.resolve("checked");
    },
  };
  const recovered = capacityCalls(source, {
    ...base,
    work: () => {
      attempts++;
      return Promise.resolve(
        attempts === 1
          ? { kind: "failed", reason: "storage-unavailable", detail: "retry" }
          : { kind: "accepted", sequence: 1, intents: [] },
      );
    },
  });
  assert.equal(await recovered.run(["configured-check"], "."), "checked");
  assert.equal(checks, 1);
  const refused = capacityCalls(source, {
    ...base,
    work: () =>
      Promise.resolve({ kind: "rejected", reason: "work-stage-released" }),
  });
  await assert.rejects(
    refused.run(["configured-check"], "."),
    /github-operation-stopped/,
  );
  assert.equal(checks, 1);
});

await test("CLV-377 a lost work reservation reply retries one identity and executes verification once", async () => {
  const ids: string[] = [];
  let checks = 0;
  const calls = capacityCalls(
    {
      gh: () => Promise.resolve(""),
      git: () => Promise.resolve(""),
      run: () => {
        checks++;
        return Promise.resolve("checked");
      },
    },
    {
      intent: {
        runId: "run",
        operationId: "operation",
        inputDigest: `sha256:${"a".repeat(64)}`,
        leaseGeneration: 1,
        method: "merge",
      },
      signal: new AbortController().signal,
      work: (stage) => {
        if (stage.action === "enter") ids.push(stage.commandId);
        return stage.action === "enter" && ids.length === 1
          ? Promise.reject(new Error("lost accepted reply"))
          : Promise.resolve({ kind: "duplicate", sequence: 1, intents: [] });
      },
    },
  );
  assert.equal(await calls.run(["configured-check"], "."), "checked");
  assert.equal(checks, 1);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 1);
});

await test("CLV-377 a refused retired work owner cannot execute a verification command", async () => {
  let checks = 0;
  const calls = capacityCalls(
    {
      gh: () => Promise.resolve(""),
      git: () => Promise.resolve(""),
      run: () => {
        checks++;
        return Promise.resolve("");
      },
    },
    {
      intent: {
        runId: "run",
        operationId: "operation",
        inputDigest: `sha256:${"a".repeat(64)}`,
        leaseGeneration: 1,
        method: "merge",
      },
      signal: new AbortController().signal,
      work: () =>
        Promise.resolve({
          kind: "rejected",
          reason: "retired-lease-generation",
        }),
    },
  );
  await assert.rejects(
    calls.run(["configured-check"], "."),
    /github-operation-stopped/,
  );
  assert.equal(checks, 0);
});

await test("CLV-377 a paused work-stage refusal waits without failing the owned GitHub operation", async () => {
  let attempts = 0;
  const calls = capacityCalls(
    {
      gh: () => Promise.resolve(""),
      git: () => Promise.resolve(""),
      run: () => Promise.resolve("checked"),
    },
    {
      intent: {
        runId: "run",
        operationId: "operation",
        inputDigest: `sha256:${"a".repeat(64)}`,
        leaseGeneration: 1,
        method: "merge",
      },
      signal: new AbortController().signal,
      work: (stage) => {
        attempts++;
        return Promise.resolve(
          stage.action === "enter" && attempts === 1
            ? { kind: "rejected", reason: "run-work-held" }
            : { kind: "accepted", sequence: 1, intents: [] },
        );
      },
    },
  );
  assert.equal(await calls.run(["configured-check"], "."), "checked");
  assert.equal(attempts, 3);
});

await test("CLV-377 a transient refused work release cannot resume remote CI until the same release is confirmed", async () => {
  const seen = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const leaveIds: string[] = [];
  let continued = false;
  const calls = capacityCalls(
    {
      gh: () => Promise.resolve(""),
      git: () => Promise.resolve(""),
      run: () => Promise.resolve("checked"),
    },
    {
      intent: {
        runId: "run",
        operationId: "operation",
        inputDigest: `sha256:${"a".repeat(64)}`,
        leaseGeneration: 1,
        method: "merge",
      },
      signal: new AbortController().signal,
      work: async (stage) => {
        if (stage.action === "leave") {
          leaveIds.push(stage.commandId);
          if (leaveIds.length === 1) seen.resolve(undefined);
          else await release.promise;
        }
        return stage.action === "leave" && leaveIds.length === 1
          ? { kind: "rejected", reason: "service-busy" }
          : { kind: "accepted", sequence: 1, intents: [] };
      },
    },
  );
  const result = calls.run(["configured-check"], ".").then((value) => {
    continued = true;
    return value;
  });
  try {
    await seen.promise;
    await setImmediate();
    assert.equal(continued, false);
    release.resolve(undefined);
    assert.equal(await result, "checked");
    assert.equal(leaveIds.length, 2);
    assert.equal(new Set(leaveIds).size, 1);
  } finally {
    release.resolve(undefined);
  }
});

await test("CLV-377 a real GitHub verification waits for its owned work permit and releases it before remote merge work", () =>
  withGithub(async (scene) => {
    const setup = scene.worker();
    const commit = await opened(scene, setup);
    const marker = join(scene.directory, "check-started");
    const release = join(scene.directory, "check-release");
    let attempted = false;
    const limits = { capacity: 5, queueLimit: 4, queueWorkingLimit: 1 };
    const authority = await openedAuthority(await temporaryDirectory(), {
      clock: () => noon,
      leaseLimits: () => limits,
    });
    try {
      await start(authority, { runId: "agent" });
      await request(authority, { runId: "agent" });
      await start(authority, { runId: "merge" });
      const operation = await request(authority, {
        runId: "merge",
        capability: "github",
        payload: JSON.stringify({ number: 1, commit }),
      });
      const stages: string[] = [];
      const worker = mergeWorker(scene, {
        authority,
        operation,
        commit,
        marker,
        release,
        stages,
        onAttempt: () => {
          attempted = true;
        },
      });
      await deliverMerge(worker, operation);
      await until(() => attempted);
      assert.equal(existsSync(marker), false);
      assert.deepEqual(stages, ["enter:rejected"]);
      limits.queueWorkingLimit = 2;
      await until(() => existsSync(marker));
      limits.queueWorkingLimit = 1;
      await start(authority, { runId: "next" });
      assert.equal(
        (await request(authority, { runId: "next" })).status,
        "waiting",
      );
      assert.equal(existsSync(marker), true);
      writeFileSync(release, "go");
      await until(() => stages.includes("leave:accepted"));
      assert.equal((await authority.effects.budget("merge"))?.spent, 1);
      await until(() =>
        scene.reports.some((report) => report.runId === "merge"),
      );
      const report = scene.reports.find((item) => item.runId === "merge");
      assert.equal(report?.outcome, "completed");
    } finally {
      writeFileSync(release, "go");
      await authority.close();
    }
  }));
