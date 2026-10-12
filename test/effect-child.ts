import { join } from "node:path";
import type { AuthorityOptions } from "../src/broker/actor/authority.ts";
import { fastTiming, openedAuthority } from "./authority-actor-fixture.ts";
import {
  effectRequest,
  fileDestination,
  noon,
  runningRun,
  sender,
} from "./effect-fixture.ts";
import { launchingDelivery } from "./effect-launch-fixture.ts";

const [directory = "", scenario = ""] = process.argv.slice(2);
const file = join(directory, "destination.log");
const held: unknown[] = [];

function hang(): Promise<void> {
  setInterval(() => held, 60_000);
  return new Promise(() => undefined);
}

let sent = false;
let requesting = false;

const scenarios: Readonly<Record<string, AuthorityOptions>> = {
  "send-then-hang": {
    delivery: fileDestination(file, {
      afterSend: () => {
        process.stdout.write("externally-accepted\n");
        return hang();
      },
    }),
  },
  "stop-in-reconciliation": {
    delivery: {
      deliver: (intent) =>
        intent.kind === "protected-effect"
          ? Promise.reject(new Error("the reply is lost"))
          : Promise.resolve({ receipt: "receipt-run" }),
      reconcile: (intent) => {
        if (intent.purpose === "reconcile")
          process.kill(process.pid, "SIGKILL");
        return Promise.resolve({ kind: "absent" });
      },
    },
  },
  "launch-then-stop": {
    delivery: launchingDelivery(directory, {
      afterLaunch: () => {
        process.kill(process.pid, "SIGKILL");
        return Promise.resolve();
      },
    }),
  },
  "complete-then-stop": {
    delivery: fileDestination(file, {
      afterSend: () => {
        sent = true;
        return Promise.resolve();
      },
    }),
    instrumentation: (event) => {
      if (sent && event.name === "solid_objects.effect.completed")
        process.kill(process.pid, "SIGKILL");
    },
  },
  "stop-in-request": {
    instrumentation: (event) => {
      if (requesting && event.name === "solid_objects.message.started")
        process.kill(process.pid, "SIGKILL");
    },
  },
};

const options = scenarios[scenario];
const authority = await openedAuthority(directory, {
  ...options,
  clock: () => noon,
  timing: fastTiming,
});
held.push(authority);
const send = sender(authority, { now: noon });
await runningRun(send, { effectLimit: 5 });
process.stdout.write("ready\n");
const request = effectRequest({ commandId: "c-request", round: 1 });
requesting = true;
const receipt = await send(request.command, request.documents);
process.stdout.write(`receipt ${JSON.stringify(receipt)}\n`);
process.stdout.write("committed\n");
if (options?.delivery !== undefined)
  await authority.deliver(new AbortController().signal);
await hang();
