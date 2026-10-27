import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  alive,
  git,
  intent,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { networkCommand } from "./network-worker-fixture.ts";
import { origin, withBlockedGit, stopGit } from "./retry-git-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-229 drop during origin fetch cancels git and starts no retry", () =>
  withScene(async (scene) => {
    origin(scene);
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: () => {
        git(scene.turns()[0]?.directory ?? "", ["push", "origin", "HEAD"]);
        return Promise.resolve();
      },
    });
    await withBlockedGit("fetch", async (blocked) => {
      await worker.deliver(intent(), signal);
      await until(() => blocked() !== undefined || scene.reports.length > 0);
      assert.ok(blocked());
      assert.equal((await worker.stop(intent(), signal)).kind, "stopped");
      assert.equal(scene.turns().length, 1);
      await until(() => !alive(blocked() ?? 0));
      assert.equal(scene.reports[0]?.outcome, "stopped");
    });
  }));

await test("CLV-229 drop cancels a pending initial head read before an attempt starts", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["done"]),
    });
    await withBlockedGit("head", async (blocked) => {
      const delivering = worker
        .deliver(intent(), signal)
        .catch(() => undefined);
      await until(() => blocked() !== undefined);
      const kills: number[] = [];
      const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
      assert.ok(descriptor);
      const kill = process.kill.bind(process);
      Object.defineProperty(process, "kill", {
        value: (pid: number, sent?: number | NodeJS.Signals) => {
          kills.push(pid);
          return kill(pid, sent);
        },
      });
      const stopping = worker.stop(intent(), signal);
      try {
        await nextTurn();
        assert.ok(kills.includes(-(blocked() ?? 0)));
      } finally {
        try {
          stopGit(blocked());
          await delivering;
          await stopping;
        } finally {
          Object.defineProperty(process, "kill", descriptor);
        }
      }
      assert.equal(scene.turns().length, 0);
    });
  }));
