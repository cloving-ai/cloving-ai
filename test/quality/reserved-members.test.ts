import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { checkedSenderTree, type AddedModule } from "./sender-fixture.ts";

const port = 'import type { Delivery } from "./actor/delivery-intents.js";';
const actor =
  'import type { Actor } from "../../node_modules/solid-objects/dist/actor.js";';
const runtime =
  'import type { SolidObjectsRuntime } from "../../node_modules/solid-objects/dist/runtime.js";';

function broker(source: string): AddedModule {
  return { role: "broker", source };
}

async function rejected(
  added: Readonly<Record<string, AddedModule>>,
  expected: RegExp,
): Promise<void> {
  await checkedSenderTree(added, (program, policy) => {
    assert.throws(() => {
      checkArchitecture(program, policy);
    }, expected);
  });
}

await test("CLV-054 the protected check rejects a module that reaches the adapter port outside the native effect handler", async () => {
  for (const body of [
    "return delivery.deliver(intent);",
    'return delivery["reconcile"](intent);',
    "return delivery[name](intent);",
    "return delivery.stop?.(intent);",
    "const { deliver } = delivery; return deliver(intent);",
    "const { ...members } = delivery; return members;",
    "return { ...delivery };",
  ])
    await rejected(
      {
        "src/service/alternate.ts": {
          role: "service",
          source: `import type { Delivery } from "../broker/actor/delivery-intents.js"; export function send(delivery: Delivery, intent: string, name: "deliver" | "reconcile"): unknown { ${body} }`,
        },
      },
      /reserved-member:[^]*src\/service\/alternate\.ts/,
    );
  await rejected(
    {
      "src/broker/alternate.ts": broker(
        `${port} export function send({ reconcile }: Delivery, intent: string): unknown { return reconcile(intent); }`,
      ),
    },
    /reserved-member:[^]*src\/broker\/alternate\.ts/,
  );
});

await test("CLV-054 the protected check rejects a module that reaches the adapter port through a second module", async () => {
  await rejected(
    {
      "src/broker/relay.ts": broker(
        `${port} export function relayed(delivery: Delivery, intent: string): Promise<string> { return delivery.deliver(intent); }`,
      ),
      "src/service/alternate.ts": {
        role: "service",
        source:
          'import type { Delivery } from "../broker/actor/delivery-intents.js"; import { relayed } from "../broker/relay.js"; export function send(delivery: Delivery): Promise<string> { return relayed(delivery, "intent"); }',
      },
    },
    /reserved-member:[^]*src\/broker\/relay\.ts/,
  );
});

await test("CLV-054 the protected check rejects a second place that stages a native effect, and a second place that registers an effect handler", async () => {
  await rejected(
    {
      "src/broker/second-stage.ts": broker(
        `${actor} export function staged(instance: Actor): string { return instance.emit("cloving.deliver").id; }`,
      ),
    },
    /reserved-member:[^]*src\/broker\/second-stage\.ts/,
  );
  for (const parameter of [
    "SolidObjectsRuntime",
    'Pick<SolidObjectsRuntime, "registerEffect">',
  ])
    await rejected(
      {
        "src/broker/second-registration.ts": broker(
          `${runtime} export function registered(library: ${parameter}): void { library.registerEffect("cloving.second", (value) => Promise.resolve(value)); }`,
        ),
      },
      /reserved-member:[^]*src\/broker\/second-registration\.ts/,
    );
});

await test("CLV-054 the protected check rejects a module that imports the native effect handler or its registration", async () => {
  await rejected(
    {
      "src/service/alternate.ts": {
        role: "service",
        source:
          'import type { Delivery } from "../broker/actor/delivery-intents.js"; import { deliveryHandler } from "../broker/actor/authority-delivery.js"; export function send(delivery: Delivery): Promise<string> { return deliveryHandler(delivery)("intent"); }',
      },
    },
    /reserved-import: [^\n]*src\/service\/alternate\.ts -> [^\n]*authority-delivery\.ts/,
  );
  await rejected(
    {
      "src/broker/alternate.ts": broker(
        'import { observeRun } from "./actor/effect-delivery.js"; export const observed = observeRun;',
      ),
    },
    /reserved-import: [^\n]*src\/broker\/alternate\.ts -> [^\n]*effect-delivery\.ts/,
  );
  await rejected(
    {
      "src/broker/alternate.ts": broker(
        'import { trackedDelivery } from "./actor/authority-release.js"; export const registered = trackedDelivery;',
      ),
    },
    /reserved-import: [^\n]*src\/broker\/alternate\.ts -> [^\n]*authority-release\.ts/,
  );
});

await test("CLV-054 the protected check accepts the native effect handler, the stage call and the registration in their files, and a module that passes the adapter port with no use", async () => {
  await checkedSenderTree(
    {
      "src/service/host.ts": {
        role: "service",
        source:
          'import type { Delivery } from "../broker/actor/delivery-intents.js"; import type { deliveryHandler } from "../broker/actor/authority-delivery.js"; export interface ServiceOptions { readonly delivery?: Delivery; readonly handle?: ReturnType<typeof deliveryHandler> } export function configured(options: ServiceOptions): { readonly delivery: Delivery | undefined } { return { delivery: options.delivery }; }',
      },
      "src/broker/turns.ts": broker(
        `${actor} export function committed(instance: Actor): void { instance.commitAction("persist"); }`,
      ),
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
    },
  );
});

await test("CLV-054 the protected check rejects each other form that takes a reserved member", async () => {
  const holder = "{ readonly delivery: Delivery }";
  for (const declaration of [
    'send(delivery: Delivery, intent: string): unknown { let deliver: Delivery["deliver"]; ({ deliver } = delivery); return deliver(intent); }',
    `send(holder: ${holder}, intent: string): unknown { let reconcile: Delivery["reconcile"]; ({ delivery: { reconcile } } = holder); return reconcile(intent); }`,
    'send(ports: readonly [Delivery], intent: string): unknown { let deliver: Delivery["deliver"]; [{ deliver }] = ports; return deliver(intent); }',
    'send(ports: readonly Delivery[], intent: string): unknown { let deliver: Delivery["deliver"] | undefined; for ({ deliver } of ports) void deliver(intent); return deliver; }',
    "send(delivery: Delivery): unknown { let members: object; ({ ...members } = delivery); return members; }",
    `send({ delivery: { deliver } }: ${holder}, intent: string): unknown { return deliver(intent); }`,
    'send(delivery: Delivery, intent: string): unknown { const key = "deliver" as const; const { [key]: taken } = delivery; return taken(intent); }',
    "send<Key extends keyof Delivery>(delivery: Delivery, key: Key): unknown { const { [key]: taken } = delivery; return taken; }",
    "send<Key extends keyof Delivery>(delivery: Delivery, key: Key): unknown { return delivery[key]; }",
    "send<Port extends Delivery>(port: Port, intent: string): unknown { return port.deliver(intent); }",
    "send(delivery: Partial<Delivery>, intent: string): unknown { return delivery.deliver?.(intent); }",
    "send(delivery: Required<Delivery>, intent: string): unknown { return delivery.stop(intent); }",
    'send(delivery: Omit<Delivery, "stop"> & { readonly name: string }, intent: string): unknown { return delivery.reconcile(intent); }',
    "send(delivery: Delivery | undefined, intent: string): unknown { return delivery?.deliver(intent); }",
    "send(delivery: Delivery | { readonly name: string }): unknown { return { ...delivery }; }",
  ])
    await rejected(
      {
        "src/broker/alternate.ts": broker(
          `${port} export function ${declaration}`,
        ),
      },
      /reserved-member:[^]*src\/broker\/alternate\.ts/,
    );
  for (const body of [
    'return this.emit("cloving.deliver").id;',
    'return super.emit("cloving.deliver").id;',
  ])
    await rejected(
      {
        "src/broker/second-stage.ts": broker(
          `${actor} declare const Base: abstract new () => Actor; export abstract class Second extends Base { stage(): string { ${body} } }`,
        ),
      },
      /reserved-member:[^]*"member": "Actor\.emit"/,
    );
});

await test("CLV-054 the protected check accepts a form that takes no reserved member", async () => {
  await checkedSenderTree(
    {
      "src/broker/turns.ts": broker(
        `${actor} ${port} export function committed(instance: Actor, key: "commitAction"): void { instance["commitAction"]("persist"); instance[key]("persist"); const { commitAction } = instance; void commitAction; } export function held(holder: { readonly delivery: Delivery; readonly name: string }): unknown { let delivery: Delivery; let name: string; ({ delivery, name } = holder); const { delivery: second } = holder; return [{ ...holder }, delivery, name, second]; } export type Sender = ({ deliver }: Delivery) => void; export interface Senders { send({ reconcile }: Delivery): void }`,
      ),
      "node_modules/solid-objects/dist/actor.d.ts": {
        role: "actor-runtime",
        source:
          "export declare abstract class Actor { emit(name: string): { id: string }; transmit(): { relayed(): void }; commitAction(name: string): void; } export declare function staged({ emit }: Actor): void;",
      },
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
    },
  );
});

await test("CLV-054 the protected check fails closed when a reserved declaration is absent", async () => {
  await rejected(
    {
      "node_modules/solid-objects/dist/runtime.d.ts": {
        role: "actor-runtime",
        source:
          "export declare class SolidObjectsRuntime { registerHandler(name: string, handler: (value: string) => Promise<string>): void; close(): Promise<void>; }",
      },
      "src/broker/actor/authority-release.ts": broker(
        'import type { SolidObjectsRuntime } from "../../../node_modules/solid-objects/dist/runtime.js"; import { deliverEffect } from "./authority-actor.js"; import type { deliveryHandler } from "./authority-delivery.js"; export function trackedDelivery(registration: { readonly runtime: Pick<SolidObjectsRuntime, "registerHandler" | "close">; readonly handle: ReturnType<typeof deliveryHandler> }): void { registration.runtime.registerHandler(deliverEffect, registration.handle); }',
      ),
    },
    /reserved-missing: [^\n]*runtime\.d\.ts#SolidObjectsRuntime\.registerEffect/,
  );
  await checkedSenderTree({}, (program, policy) => {
    const reserved = policy.reserved;
    assert.ok(reserved);
    const [entry] = reserved.members;
    assert.ok(entry);
    const absent = entry.file.replace("delivery-intents", "absent");
    const checked = (changed: Partial<typeof entry>): void => {
      checkArchitecture(program, {
        ...policy,
        reserved: { ...reserved, members: [{ ...entry, ...changed }] },
      });
    };
    assert.throws(() => {
      checked({ type: "Port" });
    }, /reserved-missing: [^\n]*delivery-intents\.ts#Port/);
    assert.throws(() => {
      checked({ file: absent });
    }, /reserved-missing: [^\n]*absent\.ts#Delivery/);
    assert.throws(() => {
      checked({ members: ["deliver", "send"] });
    }, /reserved-missing: [^\n]*delivery-intents\.ts#Delivery\.send/);
    assert.doesNotThrow(() => {
      checked({ file: absent, users: [absent.replace("absent", "no-user")] });
    });
  });
});

await test("CLV-054 the protected check does not examine a module with a development role", async () => {
  await checkedSenderTree(
    {
      "test/port.test.ts": {
        role: "test",
        source:
          'import type { Delivery } from "../src/broker/actor/delivery-intents.js"; import { deliveryHandler } from "../src/broker/actor/authority-delivery.js"; export function fake(delivery: Delivery): Promise<string> { return deliveryHandler(delivery)("intent").then(() => delivery.deliver("intent")); }',
      },
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
    },
  );
});

const actorDirectory = "/candidate/src/broker/actor/";
const library = "/candidate/node_modules/solid-objects/dist/";
const reservedMembers = [
  {
    file: `${actorDirectory}delivery-intents.ts`,
    type: "Delivery",
    members: [],
    users: [
      `${actorDirectory}authority-delivery.ts`,
      `${actorDirectory}effect-delivery.ts`,
      "/candidate/src/daemon/delivery-router.ts",
    ],
  },
  {
    file: `${library}actor.d.ts`,
    type: "Actor",
    members: ["emit"],
    users: [
      `${actorDirectory}authority-actor.ts`,
      "/candidate/src/relay/phone-delivery.ts",
    ],
  },
  {
    file: `${library}runtime.d.ts`,
    type: "SolidObjectsRuntime",
    members: ["registerEffect"],
    users: [
      `${actorDirectory}authority-release.ts`,
      "/candidate/src/relay/relay-store.ts",
    ],
  },
  {
    file: `${library}actor.d.ts`,
    type: "Actor",
    members: ["transmit"],
    users: [],
  },
  {
    file: `${library}runtime.d.ts`,
    type: "SolidObjectsRuntime",
    members: ["registerCommitAction"],
    users: [`${actorDirectory}runtime-parts.ts`],
  },
  {
    file: `${library}runtime.d.ts`,
    type: "SolidObjectsRuntime",
    members: ["registerComponent", "effectWorker", "executeEffect"],
    users: [],
  },
  {
    file: "/candidate/src/host/start-delivery.ts",
    type: "StartDelivery",
    members: [],
    users: ["/candidate/src/daemon/delivery-router.ts"],
  },
];

await test("CLV-054 the protected check of the product tree has the reserved members and imports of the one sender", () => {
  const reserved = proposedModulePolicy("/candidate").reserved;
  assert.ok(reserved);
  assert.deepEqual(reserved.members, reservedMembers);
  assert.deepEqual(reserved.imports, {
    "/candidate/node_modules/workflow/dist/api.d.ts": [
      "/candidate/src/host/decision-resume.ts",
      "/candidate/src/host/start-delivery.ts",
      "/candidate/src/host/world-runs.ts",
    ],
    "/candidate/node_modules/workflow/dist/runtime.d.ts": [
      "/candidate/src/host/decision-resume.ts",
      "/candidate/src/host/world-host.ts",
      "/candidate/src/host/world-runs.ts",
    ],
    "/candidate/node_modules/workflow/dist/index.d.ts": [
      "/candidate/src/host/step-bridge-host.ts",
      "/candidate/src/host/run-wait.ts",
      "/candidate/src/steps/wait-for-decision.ts",
      "/candidate/src/steps/sleep.ts",
    ],
    [`${actorDirectory}authority-delivery.ts`]: [
      `${actorDirectory}authority-runtime.ts`,
    ],
    [`${actorDirectory}effect-delivery.ts`]: [
      `${actorDirectory}authority-delivery.ts`,
    ],
    [`${actorDirectory}authority-release.ts`]: [
      `${actorDirectory}authority-runtime.ts`,
    ],
    [`${library}database/sqlite.d.ts`]: [
      `${actorDirectory}authority-runtime.ts`,
      "/candidate/src/relay/relay-store.ts",
    ],
    "node:sqlite": ["/candidate/src/storage/domain-schema.ts"],
  });
  assert.deepEqual(reserved.exempt, [
    "test",
    "quality",
    "build",
    "configuration",
    "tooling",
  ]);
});
