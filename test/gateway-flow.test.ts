import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  commandGateway,
  type Gateway,
  type Principal,
} from "../src/service/gateway.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import { noon, runningRun, sender } from "./effect-fixture.ts";

after(removeTemporaryDirectories);

interface Held {
  readonly authority: Authority;
  readonly gateway: Gateway;
  readonly received: unknown[];
  readonly release: () => void;
}

async function held(bound: number): Promise<Held> {
  const authority = await openedAuthority(await temporaryDirectory());
  await runningRun(sender(authority, { now: noon }), { effectLimit: 5 });
  const received: unknown[] = [];
  const gate = Promise.withResolvers<undefined>();
  const gateway = commandGateway({
    authority: {
      ...authority,
      execute: async (command, context) => {
        received.push({ command, documents: context.documents });
        await gate.promise;
        return authority.execute(command, context);
      },
    },
    registry: workflowRegistry([]),
    clock: () => noon,
    textBytes: 1000,
    pendingWorkerCommands: bound,
  });
  return {
    authority,
    gateway,
    received,
    release: () => {
      gate.resolve(undefined);
    },
  };
}

function part(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function reasonOf(receipt: unknown): unknown {
  return part(receipt, "reason");
}

function observation(commandId: string): Readonly<Record<string, unknown>> {
  return {
    kind: "report-observation",
    commandId,
    runId: "run-1",
    condition: "working",
    reason: "progress",
  };
}

await test("CLV-049 above the bound of worker commands in the authority the gateway replies service-busy, a command of a different principal has no bound, and the same command is accepted after a release", async () => {
  const { authority, gateway, release } = await held(2);
  const worker = (commandId: string): ReturnType<Gateway["execute"]> =>
    gateway.execute({ principal: "worker", command: observation(commandId) });
  const first = [worker("c-1"), worker("c-2")];
  assert.deepEqual(await worker("c-3"), {
    kind: "rejected",
    reason: "service-busy",
    detail:
      "The service has 2 worker commands in work. Send the command again with the same command ID.",
  });
  const others = [
    gateway.execute({
      principal: "operator",
      command: {
        kind: "pause-run",
        commandId: "c-pause",
        runId: "run-1",
        expectedRevision: 2,
      },
    }),
    gateway.execute({
      principal: "controller",
      command: {
        kind: "expire-gate",
        commandId: "c-expire",
        runId: "run-1",
        gateId: "design-1",
      },
    }),
  ];
  release();
  const settled = await Promise.all([...first, ...others]);
  assert.deepEqual(
    settled.map((receipt) => [receipt.kind, reasonOf(receipt)]),
    [
      ["accepted", undefined],
      ["accepted", undefined],
      ["accepted", undefined],
      ["rejected", "unknown-gate"],
    ],
  );
  assert.equal((await worker("c-3")).kind, "accepted");
  await authority.close();
});

await test("CLV-049 a worker command that fails in the authority frees its place in the bound", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const failing = commandGateway({
    authority: {
      ...authority,
      execute: () => Promise.reject(new Error("the authority failed")),
    },
    registry: workflowRegistry([]),
    clock: () => noon,
    textBytes: 1000,
    pendingWorkerCommands: 1,
  });
  for (const commandId of ["c-1", "c-2"])
    await assert.rejects(
      failing.execute({
        principal: "worker",
        command: observation(commandId),
      }),
      /the authority failed/,
    );
  await authority.close();
});

function flipping(forms: readonly unknown[]): {
  readonly toJSON: () => unknown;
} {
  let calls = 0;
  return {
    toJSON: () => {
      calls += 1;
      return forms[Math.min(calls, forms.length) - 1];
    },
  };
}

await test("CLV-049 the authority gets the checked copy of a worker command: a command that changes to cancel-run at its second conversion does not cancel the run", async () => {
  const { authority, gateway, received, release } = await held(2);
  release();
  const cancel = {
    kind: "cancel-run",
    commandId: "c-flip",
    runId: "run-1",
    expectedRevision: 2,
  };
  const receipt = await gateway.execute({
    principal: "worker",
    command: flipping([observation("c-flip"), cancel]),
  });
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [
    { command: observation("c-flip"), documents: [] },
  ]);
  assert.equal((await authority.state()).runs["run-1"]?.status, "running");
  assert.deepEqual(
    (await authority.events()).map((event) => event.type).slice(-1),
    ["run.observed"],
  );
  await authority.close();
});

await test("CLV-049 the authority gets the checked copy of the documents of a worker command: a list that changes to a longer text at its second conversion is not stored", async () => {
  const { authority, gateway, received, release } = await held(2);
  release();
  const long = "x".repeat(2000);
  const receipt = await gateway.execute({
    principal: "worker",
    command: {
      kind: "open-gate",
      commandId: "c-open",
      runId: "run-1",
      expectedRevision: 2,
      gateId: "design-1",
      gateKind: "question",
      prompt: digestOf(long),
      subject: digestOf(long),
    },
    documents: Object.assign(
      ["a short text"],
      flipping([["a short text"], [long]]),
    ),
  });
  assert.deepEqual(receipt, {
    kind: "rejected",
    reason: "missing-document",
    detail: digestOf(long),
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(received.map((item) => part(item, "documents")))),
    [["a short text"]],
  );
  assert.equal(await authority.queries.document(digestOf(long)), undefined);
  await authority.close();
});

await test("CLV-049 a worker command with an epoch that is not a number is rejected at the gateway", async () => {
  const { authority, gateway, received, release } = await held(2);
  release();
  assert.deepEqual(
    await gateway.execute({
      principal: "worker",
      command: observation("c-epoch"),
      epoch: Number.NaN,
    }),
    { kind: "rejected", reason: "invalid-command" },
  );
  assert.deepEqual(received, []);
  await authority.close();
});

const principals: readonly Principal[] = ["operator", "worker", "controller"];

for (const kind of ["grant-lease", "record-outcome", "record-dispatch"])
  await test(`CLV-049 no principal can send ${kind} through the gateway`, async () => {
    const { authority, gateway, received, release } = await held(2);
    release();
    for (const principal of principals)
      assert.deepEqual(
        await gateway.execute({
          principal,
          command: { kind, commandId: `c-${principal}`, runId: "run-1" },
        }),
        {
          kind: "rejected",
          reason: "permission-denied",
          detail: `${principal} cannot send ${kind}`,
        },
      );
    assert.deepEqual(received, []);
    await authority.close();
  });

await test("CLV-049 only a worker can send request-effect and report-effect, and only a controller can send expire-lease", async () => {
  const { authority, gateway, received, release } = await held(2);
  release();
  const denied: unknown[] = [];
  for (const [kind, permitted] of [
    ["request-effect", "worker"],
    ["report-effect", "worker"],
    ["expire-lease", "controller"],
  ] as const)
    for (const principal of principals.filter((item) => item !== permitted))
      denied.push(
        await gateway.execute({
          principal,
          command: {
            kind,
            commandId: `c-${kind}-${principal}`,
            runId: "run-1",
          },
        }),
      );
  assert.deepEqual(
    denied.map(reasonOf),
    Array.from({ length: 6 }, () => "permission-denied"),
  );
  assert.deepEqual(received, []);
  await authority.close();
});
