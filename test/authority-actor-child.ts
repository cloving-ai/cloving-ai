import { testMilliseconds } from "./test-timing.ts";
import { join } from "node:path";
import {
  openAuthority,
  type AuthorityOptions,
} from "../src/broker/actor/authority.ts";
import { fileService } from "./authority-actor-service.ts";
import { recorded } from "./authority-fixture.ts";
import {
  manifest,
  storedGate,
  testAuthorityTiming,
} from "./authority-store-fixture.ts";

const [directory = "", scenario = ""] = process.argv.slice(2);
const service = join(directory, "external.log");

const held: unknown[] = [];

function hang(): Promise<void> {
  setInterval(() => held, 60_000);
  return new Promise(() => undefined);
}

function strandFirstCommand(): NonNullable<
  AuthorityOptions["instrumentation"]
> {
  return (event) => {
    if (event.name === "solid_objects.activation.lost")
      process.stdout.write("activation-lost\n");
    if (event.name !== "solid_objects.message.started") return;
    if (event.attributes["operation"] !== "execute") return;
    const until = performance.now() + testMilliseconds(400);
    while (performance.now() < until);
  };
}

const scenarios: Readonly<Record<string, AuthorityOptions>> = {
  commit: {},
  strand: {
    timing: {
      ...testAuthorityTiming,
      leaseMilliseconds: testMilliseconds(100),
      renewalMilliseconds: testMilliseconds(30),
      heartbeatMilliseconds: testMilliseconds(50),
      aliveThresholdMilliseconds: testMilliseconds(300),
      cleanupIntervalMilliseconds: testMilliseconds(100),
      callTimeoutMilliseconds: testMilliseconds(5_000),
    },
    instrumentation: strandFirstCommand(),
  },
  "send-then-hang": {
    delivery: fileService(service, {
      afterSend: (receipt) => {
        process.stdout.write(`externally-accepted ${receipt}\n`);
        return hang();
      },
    }),
  },
  "complete-then-stop": {
    delivery: fileService(service),
    instrumentation: (event) => {
      if (event.name === "solid_objects.effect.completed")
        process.kill(process.pid, "SIGKILL");
    },
  },
};

if (scenario === "open") {
  process.stdout.write("ready\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  const attempt = await openAuthority(directory);
  held.push(attempt);
  process.stdout.write(
    attempt.kind === "opened" ? "opened\n" : `refused ${attempt.reason}\n`,
  );
  await hang();
}

const opening = await openAuthority(directory, scenarios[scenario] ?? {});
held.push(opening);
if (opening.kind !== "opened") {
  process.stdout.write(`refused ${opening.reason}\n`);
  process.exit(3);
}
const receipt = await opening.authority.execute(storedGate[0], {
  ...recorded,
  manifest,
});
process.stdout.write(`receipt ${JSON.stringify(receipt)}\n`);
if (scenario === "commit") {
  process.stdout.write("awaiting-dispatch\n");
  await hang();
}
await opening.authority.deliver(new AbortController().signal);
