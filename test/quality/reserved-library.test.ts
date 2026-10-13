import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import { checkedSenderTree, type AddedModule } from "./sender-fixture.ts";

const actor =
  'import type { Actor } from "../../node_modules/solid-objects/dist/actor.js";';

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

const adapterTree: Readonly<Record<string, AddedModule>> = {
  "node_modules/@workflow/core/dist/runtime/start.d.ts": {
    role: "sdk-runtime",
    source: "export declare function start(intent: string): Promise<string>;",
  },
  "src/host/start-delivery.ts": {
    role: "host-bridge",
    source:
      'import { start } from "../../node_modules/@workflow/core/dist/runtime/start.js"; export interface StartDelivery { readonly reconcile: (intent: string) => Promise<string>; readonly deliver: (intent: string) => Promise<string>; readonly stop: (intent: string) => Promise<string> } export function startDelivery(): StartDelivery { return { reconcile: start, deliver: start, stop: start }; }',
  },
};

await test("CLV-054 the protected check rejects a transmit stage, a second commit action, an effect worker, a component or a direct effect run of the actor library", async () => {
  await rejected(
    {
      "src/broker/second-stage.ts": broker(
        `${actor} export function staged(instance: Actor): void { instance.transmit().relayed(); }`,
      ),
    },
    /reserved-member:[^]*src\/broker\/second-stage\.ts[^]*"member": "Actor\.transmit"/,
  );
  for (const [call, member] of [
    [
      'registerCommitAction("cloving.second", () => Promise.resolve())',
      "registerCommitAction",
    ],
    ["registerComponent(() => ({}))", "registerComponent"],
    ["effectWorker().runOnce()", "effectWorker"],
    ['executeEffect({ id: "effect-1" })', "executeEffect"],
  ] as const)
    await rejected(
      {
        "src/broker/actor/authority-policy.ts": broker(
          `import type { SolidObjectsRuntime } from "../../../node_modules/solid-objects/dist/runtime.js"; export function second(library: SolidObjectsRuntime): unknown { return library.${call}; }`,
        ),
      },
      new RegExp(
        `reserved-member:[^]*src/broker/actor/authority-policy\\.ts[^]*"member": "SolidObjectsRuntime\\.${member}"`,
      ),
    );
});

await test("CLV-054 the protected check rejects a second host module that calls the start adapter", async () => {
  for (const body of [
    "return adapter.deliver(intent);",
    "return adapter.reconcile(intent);",
    'return adapter["stop"](intent);',
    "const { deliver } = adapter; return deliver(intent);",
  ])
    await rejected(
      {
        ...adapterTree,
        "src/host/world-reconciliation.ts": {
          role: "host-bridge",
          source: `import type { StartDelivery } from "./start-delivery.js"; export function sentAgain(adapter: StartDelivery, intent: string): unknown { ${body} }`,
        },
      },
      /reserved-member:[^]*src\/host\/world-reconciliation\.ts[^]*"member": "StartDelivery\./,
    );
});

await test("CLV-054 the protected check accepts the one commit action in its file, the start adapter in its file and a module that passes the adapter with no use", async () => {
  await checkedSenderTree(
    {
      "src/broker/actor/runtime-parts.ts": broker(
        'import type { SolidObjectsRuntime } from "../../../node_modules/solid-objects/dist/runtime.js"; export function persisted(library: SolidObjectsRuntime): void { library.registerCommitAction("cloving.persist", () => Promise.resolve()); }',
      ),
      ...adapterTree,
      "src/host/composition.ts": {
        role: "host-bridge",
        source:
          'import { startDelivery, type StartDelivery } from "./start-delivery.js"; export function composed(): { readonly adapter: StartDelivery } { return { adapter: startDelivery() }; }',
      },
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
    },
  );
});
