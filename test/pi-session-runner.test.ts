import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fakeEngine, fakeSandbox } from "./claude-runner-fixture.ts";
import { fakePi } from "./pi-fixture.ts";

for (const kind of ["container", "seatbelt"] as const)
  await test(`CLV-365 the Pi ${kind} runner exposes only the private session folder and keeps its process`, () =>
    withScene(async (scene) => {
      const fake =
        kind === "container"
          ? fakeEngine(scene.directory, { access: "write" })
          : fakeSandbox(scene.directory);
      const gate = join(scene.directory, "release");
      const runner =
        kind === "container"
          ? { kind, engine: fake.path, image: "pi-fixture" }
          : { kind, command: fake.path };
      const settings = {
        harness: { name: "pi", path: fakePi(scene, { gate }) },
        profiles: { native: { harness: "pi", runner } },
      };
      const call = intent({ method: "run-turn:native" });
      const signal = new AbortController().signal;
      const first = scene.worker("unused", settings);
      await first.deliver(call, signal);
      await until(() => existsSync(join(scene.directory, "observed.json")));
      const started = record(scene, "operation-1/started.json");
      const folder = dirname(
        String(field(field(started, "piSession"), "path")),
      );
      const observed = fake.calls()[0];
      const writes =
        kind === "container"
          ? observed
          : field(field(observed, "settings"), "filesystem");
      const locations =
        kind === "container" ? writes : field(writes, "allowWrite");
      assert.ok(Array.isArray(locations));
      assert.ok(
        locations.includes(
          kind === "container" ? `${folder}:${folder}` : folder,
        ),
      );
      assert.equal(locations.includes(scene.journal), false);
      await first.close({ turns: "keep" });
      const next = scene.worker("unused", settings);
      assert.equal((await next.reconcile(call, signal)).kind, "accepted");
      assert.deepEqual(
        field(record(scene, "operation-1/started.json"), "launch"),
        field(started, "launch"),
      );
      writeFileSync(gate, "release");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(resultOf(scene.reports[0].result)["turns"], 1);
    }));
