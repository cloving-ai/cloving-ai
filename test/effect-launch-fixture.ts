import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";

export interface Launch {
  readonly name: string;
  readonly worker: string;
}

export function workerName(operationId: string): string {
  return createHash("sha256").update(operationId).digest("hex").slice(0, 16);
}

export function launches(directory: string): readonly Launch[] {
  const file = join(directory, "launch.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): Launch => {
      const value: unknown = JSON.parse(line);
      return {
        name: String(Reflect.get(Object(value), "name")),
        worker: String(Reflect.get(Object(value), "worker")),
      };
    });
}

export function launchCalls(directory: string): readonly string[] {
  const file = join(directory, "launch-calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function observed(directory: string, intent: DeliveryIntent): AdapterOutcome {
  const name = workerName(intent.operationId);
  const launch = launches(directory).find((item) => item.name === name);
  if (launch === undefined) return { kind: "absent" };
  const result = join(directory, `${name}.result`);
  const receipt = `launch-${name}`;
  return existsSync(result)
    ? {
        kind: "completed",
        receipt,
        worker: launch.worker,
        result: readFileSync(result, "utf8"),
      }
    : { kind: "accepted", receipt, worker: launch.worker };
}

async function launched(
  directory: string,
  intent: DeliveryIntent,
): Promise<AdapterOutcome> {
  const name = workerName(intent.operationId);
  appendFileSync(join(directory, "launch-calls.log"), `${name}\n`);
  spawn(
    process.execPath,
    [
      join(import.meta.dirname, "effect-worker.ts"),
      directory,
      name,
      String(intent.payload),
    ],
    {
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      detached: true,
      stdio: "ignore",
    },
  ).unref();
  for (let waited = 0; waited < 5_000; waited += 10) {
    const outcome = observed(directory, intent);
    if (outcome.kind !== "absent") return outcome;
    await delay(10);
  }
  return { kind: "unknown", evidence: "the worker wrote no launch line" };
}

const absent: AdapterOutcome = { kind: "absent" };

export function launchingDelivery(
  directory: string,
  behavior: { readonly afterLaunch?: () => Promise<void> } = {},
): Delivery {
  return {
    reconcile: (intent) =>
      Promise.resolve(
        intent.kind === "protected-effect"
          ? observed(directory, intent)
          : absent,
      ),
    deliver: async (intent) => {
      if (intent.kind !== "protected-effect") return { receipt: "receipt-run" };
      const outcome = await launched(directory, intent);
      await behavior.afterLaunch?.();
      return outcome;
    },
  };
}
