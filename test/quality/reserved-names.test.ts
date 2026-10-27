import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import type { DependencyPolicy } from "../../quality/dependency-policy.ts";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { inspectReservedMembers } from "../../quality/reserved-members.ts";
import { inspectReservedNames } from "../../quality/reserved-names.ts";
import { checkedTree, type AddedModule } from "./sender-fixture.ts";

const transmitFile = "node_modules/solid-objects/dist/transmit.d.ts";
const workerFile = "node_modules/solid-objects/dist/effect-worker.d.ts";
const startFile = "node_modules/@workflow/core/dist/runtime/start.d.ts";
const transmit = '"../../node_modules/solid-objects/dist/transmit.js"';
const worker = '"../../node_modules/solid-objects/dist/effect-worker.js"';
const sdk = '"../../node_modules/@workflow/core/dist/runtime/start.js"';
const send = "(operation: string) => Promise<void>";
const flow = "(input: string) => Promise<string>";

const library: Readonly<Record<string, AddedModule>> = {
  [transmitFile]: {
    role: "actor-runtime",
    source: `export declare function registerTransmit(options: { deliver: ${send} }): void; export declare function receiveTransmitEnvelope(operation: string): Promise<string>;`,
  },
  [workerFile]: {
    role: "actor-runtime",
    source:
      "export declare class EffectWorker { constructor(runtime: object); runOnce(): Promise<number>; }",
  },
};

const adapter: Readonly<Record<string, AddedModule>> = {
  [startFile]: {
    role: "sdk-runtime",
    source: `export declare function start(workflow: ${flow}, input: string): Promise<{ runId: string }>; export declare function start(workflow: ${flow}): Promise<{ runId: string }>;`,
  },
  "src/host/start-delivery.ts": {
    role: "host-bridge",
    source: `import { start } from ${sdk}; export interface StartDelivery { readonly deliver: (intent: string) => Promise<string> } export function startDelivery(workflow: ${flow}): StartDelivery { return { deliver: async (intent) => (await start(workflow, intent)).runId }; }`,
  },
};

function broker(source: string): AddedModule {
  return { role: "broker", source };
}

function host(source: string): AddedModule {
  return { role: "host-bridge", source };
}

async function checked(
  modules: Readonly<Record<string, AddedModule>>,
  changed: (policy: DependencyPolicy) => DependencyPolicy = (policy) => policy,
): Promise<string> {
  return await checkedTree(modules, (program, policy) => {
    try {
      checkArchitecture(program, changed(policy));
      return "accepted";
    } catch (error) {
      return String(error);
    }
  });
}

await test("CLV-054 the protected check rejects a module that registers a transmit handler or makes an effect worker of the actor library", async () => {
  for (const source of [
    `import { registerTransmit } from ${transmit}; export function second(deliver: ${send}): void { registerTransmit({ deliver }); }`,
    `import { registerTransmit as register } from ${transmit}; export const second = register;`,
    `import * as actors from ${transmit}; export function second(deliver: ${send}): void { actors.registerTransmit({ deliver }); }`,
    `import * as actors from ${transmit}; export const second = actors["registerTransmit"];`,
    `import * as actors from ${transmit}; export const { registerTransmit: second } = actors;`,
    `import * as actors from ${transmit}; export const second = { ...actors };`,
    `import { registerTransmit } from ${transmit}; export const second = { registerTransmit };`,
    `export { registerTransmit } from ${transmit};`,
    `export { registerTransmit as second } from ${transmit};`,
    `import { registerTransmit } from ${transmit}; export { registerTransmit as second };`,
  ])
    assert.match(
      await checked({
        ...library,
        "src/broker/second-sender.ts": broker(source),
      }),
      /reserved-name:[^]*src\/broker\/second-sender\.ts[^]*"name": "registerTransmit"/,
      source,
    );
  assert.match(
    await checked({
      ...library,
      "src/broker/second-worker.ts": broker(
        `import { EffectWorker } from ${worker}; export function second(runtime: object): Promise<number> { return new EffectWorker(runtime).runOnce(); }`,
      ),
    }),
    /reserved-name:[^]*src\/broker\/second-worker\.ts[^]*"name": "EffectWorker"/,
  );
});

await test("CLV-054 the protected check rejects a reserved name that a module gets through a second module or through the library entry", async () => {
  assert.match(
    await checked({
      ...library,
      "src/broker/relay.ts": broker(`export * from ${transmit};`),
      "src/service/second-sender.ts": {
        role: "service",
        source: `import { registerTransmit } from "../broker/relay.js"; export function second(deliver: ${send}): void { registerTransmit({ deliver }); }`,
      },
    }),
    /reserved-name:[^]*src\/service\/second-sender\.ts[^]*"name": "registerTransmit"/,
  );
  assert.match(
    await checked(
      {
        ...library,
        "node_modules/solid-objects/dist/index.d.ts": {
          role: "actor-runtime",
          source:
            'export { registerTransmit, receiveTransmitEnvelope } from "./transmit.js";',
        },
        "src/broker/second-sender.ts": broker(
          `import { registerTransmit, receiveTransmitEnvelope } from "../../node_modules/solid-objects/dist/index.js"; export function second(deliver: ${send}): Promise<string> { registerTransmit({ deliver }); return receiveTransmitEnvelope("operation"); }`,
        ),
      },
      (policy) => ({
        ...policy,
        allowed: { ...policy.allowed, "actor-runtime": ["actor-runtime"] },
      }),
    ),
    /reserved-name:[^]*src\/broker\/second-sender\.ts[^]*"name": "registerTransmit"/,
  );
});

await test("CLV-054 the protected check rejects a second module that starts an SDK run", async () => {
  for (const source of [
    `import { start } from ${sdk}; export async function restarted(workflow: ${flow}): Promise<string> { return (await start(workflow)).runId; }`,
    `import { start as begin } from ${sdk}; export const restarted = begin;`,
    `import * as runs from ${sdk}; export async function restarted(workflow: ${flow}): Promise<string> { return (await runs.start(workflow, "input")).runId; }`,
  ])
    assert.match(
      await checked({
        ...adapter,
        "src/host/world-reconciliation.ts": host(source),
      }),
      /reserved-name:[^]*src\/host\/world-reconciliation\.ts[^]*"name": "start"/,
      source,
    );
  assert.match(
    await checked({
      ...adapter,
      "src/host/start-delivery.ts": host(
        `export { start } from ${sdk}; export interface StartDelivery { readonly deliver: (intent: string) => Promise<string> }`,
      ),
      "src/host/world-reconciliation.ts": host(
        `import { start } from "./start-delivery.js"; export async function restarted(workflow: ${flow}): Promise<string> { return (await start(workflow)).runId; }`,
      ),
    }),
    /reserved-name:[^]*src\/host\/world-reconciliation\.ts[^]*"name": "start"/,
  );
});

await test("CLV-054 the protected check gives one finding for each use of a reserved name that has more than one declaration", async () => {
  const result = await checked({
    ...adapter,
    "src/host/world-reconciliation.ts": host(
      `import { start } from ${sdk};\nexport async function restarted(workflow: ${flow}): Promise<string> {\n  return (await start(workflow)).runId;\n}`,
    ),
  });
  assert.deepEqual(
    [...result.matchAll(/"line": (\d+),\s+"name": "start"/g)].map(
      ([, line]) => line,
    ),
    ["1", "3"],
  );
});

await test("CLV-054 the protected check accepts the start adapter, a type import of a reserved name, a local function with the same name and a module with a development role", async () => {
  assert.equal(
    await checked({
      ...library,
      ...adapter,
      "src/host/world-reconciliation.ts": host(
        `import type { start } from ${sdk}; import { type start as Begin } from ${sdk}; import type * as runs from ${sdk}; export type Starter = typeof start | typeof Begin | typeof runs.start; export type { start as Start } from ${sdk}; export function begun(run: Starter, workflow: ${flow}): Promise<{ runId: string }> { return run(workflow); }`,
      ),
      "src/host/names.ts": host(
        "function start(): number { return 1; } function registerTransmit(): number { return 2; } export const begun = { start: start(), registerTransmit: registerTransmit() };",
      ),
      "src/broker/receiver.ts": broker(
        `import { receiveTransmitEnvelope } from ${transmit}; export const received = receiveTransmitEnvelope("operation");`,
      ),
      "test/start.test.ts": {
        role: "test",
        source:
          'import { EffectWorker } from "../node_modules/solid-objects/dist/effect-worker.js"; import { registerTransmit } from "../node_modules/solid-objects/dist/transmit.js"; export const used = [EffectWorker, registerTransmit];',
      },
    }),
    "accepted",
  );
});

await test("CLV-054 the protected check fails closed when the declaration of a reserved name is absent", async () => {
  assert.match(
    await checked({
      ...adapter,
      [startFile]: {
        role: "sdk-runtime",
        source: `export declare function begin(workflow: ${flow}): Promise<{ runId: string }>;`,
      },
      "src/host/start-delivery.ts": host(
        `import { begin } from ${sdk}; export interface StartDelivery { readonly deliver: (intent: string) => Promise<string> } export const started = begin;`,
      ),
    }),
    /reserved-missing: [^\n]*runtime\/start\.d\.ts#start/,
  );
  assert.match(
    await checked({
      "src/host/start-delivery.ts": host(
        "export interface StartDelivery { readonly deliver: (intent: string) => Promise<string> }",
      ),
    }),
    /reserved-missing: [^\n]*runtime\/start\.d\.ts#start/,
  );
  assert.match(
    await checked({
      [transmitFile]: {
        role: "actor-runtime",
        source: "export declare const version: string;",
      },
    }),
    /reserved-missing: [^\n]*transmit\.d\.ts#registerTransmit/,
  );
  assert.equal(
    await checked({
      "src/host/names.ts": host("export const named = 1;"),
    }),
    "accepted",
  );
});

await test("CLV-054 the protected check stops when a file of its inventory is not in the program", async () => {
  await checkedTree(
    {
      ...library,
      "node_modules/solid-objects/dist/actor.d.ts": {
        role: "actor-runtime",
        source:
          "export declare abstract class Actor { emit(name: string): void; transmit(): void; }",
      },
    },
    (program, policy) => {
      const scope = {
        files: [...program.getRootFileNames(), "/candidate/absent.ts"],
        policy,
      };
      assert.throws(
        () => inspectReservedNames(program, scope),
        /missing-reserved-source: \/candidate\/absent\.ts/,
      );
      assert.throws(
        () => inspectReservedMembers(program, scope),
        /missing-reserved-source: \/candidate\/absent\.ts/,
      );
    },
  );
});

await test("CLV-054 the protected check of the product tree has the reserved names of the transmit handler, the effect worker and the SDK start", () => {
  const actorLibrary = "/candidate/node_modules/solid-objects/dist/";
  const reserved = proposedModulePolicy("/candidate").reserved;
  assert.ok(reserved);
  assert.deepEqual(reserved.names, [
    {
      file: "/candidate/node_modules/@workflow/core/dist/create-hook.d.ts",
      name: "createHook",
      users: ["/candidate/src/steps/wait-for-decision.ts"],
    },
    {
      file: "/candidate/node_modules/@workflow/core/dist/runtime/resume-hook.d.ts",
      name: "resumeHook",
      users: ["/candidate/src/host/decision-resume.ts"],
    },
    {
      file: `${actorLibrary}transmit.d.ts`,
      name: "registerTransmit",
      users: [],
    },
    {
      file: `${actorLibrary}effect-worker.d.ts`,
      name: "EffectWorker",
      users: [],
    },
    {
      file: "/candidate/node_modules/@workflow/core/dist/runtime/start.d.ts",
      name: "start",
      users: ["/candidate/src/host/start-delivery.ts"],
    },
  ]);
});
