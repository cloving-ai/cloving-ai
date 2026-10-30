import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { CommandWorker } from "../src/daemon/command-worker.ts";
import { claimCommand } from "../src/daemon/command-journal.ts";
import type { Delivery } from "../src/broker/actor/authority.ts";
import { recoverCommands } from "../src/daemon/daemon-adapters.ts";
import { located, readRecord } from "../src/daemon/operation-journal.ts";
import { commandWaitHost } from "./command-wait-host-fixture.ts";
import { call, withHarness } from "./service-fixture.ts";
import { withCommandScene } from "./command-worker-fixture.ts";

export async function withWaitWorker(
  source: string,
  use: (scene: Awaited<ReturnType<typeof workerHost>>) => Promise<void>,
): Promise<void> {
  await withCommandScene(async (commands) => {
    await withHarness(async (harness) => {
      const scene = await workerHost({ commands, harness, source });
      harness.cleanup(async () => scene.worker().close());
      await use(scene);
    });
  });
}

type CommandScene = Parameters<Parameters<typeof withCommandScene>[0]>[0];
type Harness = Parameters<Parameters<typeof withHarness>[0]>[0];

function commandRoute(parts: {
  readonly worker: () => CommandWorker;
  readonly journal: string;
  readonly mode: { kind: "worker" | "claimed" };
  readonly stopping: { kind: "worker" | "unknown" | "thrown"; calls: number };
}): Delivery {
  return {
    deliver: async (intent, signal) => {
      if (intent.kind !== "protected-effect") return { receipt: "world-run" };
      if (parts.mode.kind === "worker")
        return parts.worker().deliver(intent, signal);
      const place = located(parts.journal, intent.operationId);
      assert.equal(await claimCommand(place.folder), true);
      return { receipt: place.key, worker: "command" };
    },
    reconcile: (intent, signal) =>
      intent.kind === "protected-effect"
        ? parts.worker().reconcile(intent, signal)
        : Promise.resolve({ kind: "absent" }),
    stop: (intent, signal) => {
      if (intent.kind !== "protected-effect")
        return Promise.resolve({ kind: "stopped" });
      parts.stopping.calls += 1;
      if (parts.stopping.kind === "thrown") throw new Error("stop-failed");
      return parts.stopping.kind === "unknown"
        ? Promise.resolve({ kind: "unknown" })
        : parts.worker().stop(intent, signal);
    },
  };
}

async function workerHost(parts: {
  readonly commands: CommandScene;
  readonly harness: Harness;
  readonly source: string;
}) {
  const { commands, harness } = parts;
  let current: CommandWorker | undefined;
  const worker = () => {
    assert.ok(current);
    return current;
  };
  const mode: { kind: "worker" | "claimed" } = { kind: "worker" };
  const stopping: { kind: "worker" | "unknown" | "thrown"; calls: number } = {
    kind: "worker",
    calls: 0,
  };
  const scene = await commandWaitHost(harness, {
    delivery: commandRoute({
      worker,
      journal: commands.journal,
      mode,
      stopping,
    }),
  });
  const reporting = { lost: false };
  const replace = (source: string) => {
    current = replacement({ commands, scene, reporting }, source);
  };
  replace(parts.source);
  return {
    ...scene,
    worker,
    replace,
    reporting,
    mode,
    stopping,
    journal: commands.journal,
    callsText: () => readFile(join(commands.directory, "calls"), "utf8"),
    result: (operationId: string) =>
      readRecord(located(commands.journal, operationId).folder, "result.json"),
    reopen: async () => {
      const service = await harness.start(scene.settings);
      await recoverCommands(worker(), scene.currentPorts());
      return service;
    },
    drop: async () =>
      call(harness, {
        operation: "run-command",
        parameters: {
          command: "drop",
          commandId: "drop",
          runId: scene.runId,
          expectedRevision: (await scene.currentPorts().state()).runs[
            scene.runId
          ]?.revision,
        },
      }),
  };
}

function replacement(
  parts: {
    readonly commands: CommandScene;
    readonly scene: Awaited<ReturnType<typeof commandWaitHost>>;
    readonly reporting: { readonly lost: boolean };
  },
  source: string,
): CommandWorker {
  const { commands, scene, reporting } = parts;
  return commands.worker(source, {
    commands: {
      "review-state": [
        "env",
        "-u",
        "NODE_V8_COVERAGE",
        process.execPath,
        "-e",
        source,
      ],
    },
    document: (digest) => scene.currentPorts().document(digest),
    report: (report) =>
      reporting.lost
        ? Promise.reject(new Error("lost-report"))
        : scene.currentPorts().reportEffect(report),
    commandClock: {
      now: () => scene.clock.now,
      timer: () => () => undefined,
    },
  });
}
