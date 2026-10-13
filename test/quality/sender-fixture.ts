import { resolve } from "node:path";
import type ts from "typescript";
import type { DependencyPolicy } from "../../quality/dependency-policy.ts";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { withProgram } from "./program-fixture.ts";

const actorLibrary = "node_modules/solid-objects/dist/actor.d.ts";
const runtimeLibrary = "node_modules/solid-objects/dist/runtime.d.ts";
const databaseLibrary = "node_modules/solid-objects/dist/database/sqlite.d.ts";

const sender: Readonly<Record<string, readonly [string, string]>> = {
  [actorLibrary]: [
    "actor-runtime",
    "export declare abstract class Actor { emit(name: string): { id: string }; commitAction(name: string): void; }",
  ],
  [runtimeLibrary]: [
    "actor-runtime",
    "export declare class SolidObjectsRuntime { registerEffect(name: string, handler: (value: string) => Promise<string>): void; close(): Promise<void>; }",
  ],
  [databaseLibrary]: [
    "actor-runtime",
    "export declare function sqlite(options: { path: string }): { close(): Promise<void> };",
  ],
  "node_modules/solid-objects/package.json": [
    "metadata",
    '{"name":"solid-objects","type":"module","exports":{"./database/sqlite":{"types":"./dist/database/sqlite.d.ts"}}}',
  ],
  "src/storage/domain-schema.ts": [
    "storage",
    'import { DatabaseSync } from "node:sqlite"; export function openDomain(path: string): DatabaseSync { return new DatabaseSync(path); }',
  ],
  "src/broker/actor/delivery-intents.ts": [
    "broker",
    "export interface Delivery { readonly deliver: (intent: string) => Promise<string>; readonly reconcile: (intent: string) => Promise<string>; readonly stop?: (intent: string) => Promise<string>; }",
  ],
  "src/broker/actor/effect-delivery.ts": [
    "broker",
    'import type { Delivery } from "./delivery-intents.js"; export function observeRun(delivery: Delivery, name: "reconcile" | "stop"): Promise<string> | undefined { return delivery[name]?.bind(delivery)("intent"); }',
  ],
  "src/broker/actor/authority-delivery.ts": [
    "broker",
    'import type { Delivery } from "./delivery-intents.js"; import { observeRun } from "./effect-delivery.js"; export function deliveryHandler(delivery: Delivery): (intent: string) => Promise<string> { return async (intent) => { await observeRun(delivery, "reconcile"); return delivery["deliver"](intent); }; }',
  ],
  "src/broker/actor/authority-actor.ts": [
    "broker",
    'import type { Actor } from "../../../node_modules/solid-objects/dist/actor.js"; export const deliverEffect = "cloving.deliver"; export function applyPlan(actor: Actor): string { return actor.emit(deliverEffect).id; }',
  ],
  "src/broker/actor/authority-release.ts": [
    "broker",
    'import type { SolidObjectsRuntime } from "../../../node_modules/solid-objects/dist/runtime.js"; import { deliverEffect } from "./authority-actor.js"; import type { deliveryHandler } from "./authority-delivery.js"; export function trackedDelivery(registration: { readonly runtime: Pick<SolidObjectsRuntime, "registerEffect" | "close">; readonly handle: ReturnType<typeof deliveryHandler> }): void { registration.runtime.registerEffect(deliverEffect, registration.handle); }',
  ],
  "src/broker/actor/authority-runtime.ts": [
    "broker",
    'import type { SolidObjectsRuntime } from "../../../node_modules/solid-objects/dist/runtime.js"; import type { Delivery } from "./delivery-intents.js"; import { deliveryHandler } from "./authority-delivery.js"; import { trackedDelivery } from "./authority-release.js"; import { sqlite } from "solid-objects/database/sqlite"; export const opened = sqlite; export function authorityRuntime(parts: { readonly runtime: SolidObjectsRuntime; readonly delivery: Delivery }): void { trackedDelivery({ runtime: parts.runtime, handle: deliveryHandler(parts.delivery) }); }',
  ],
};

export interface AddedModule {
  readonly role: string;
  readonly source: string;
}

export async function checkedSenderTree<Result>(
  added: Readonly<Record<string, AddedModule>>,
  inspect: (program: ts.Program, policy: DependencyPolicy) => Result,
): Promise<Result> {
  return await checkedTree(
    {
      ...Object.fromEntries(
        Object.entries(sender).map(([file, [role, source]]) => [
          file,
          { role, source },
        ]),
      ),
      ...added,
    },
    inspect,
  );
}

export async function checkedTree<Result>(
  modules: Readonly<Record<string, AddedModule>>,
  inspect: (program: ts.Program, policy: DependencyPolicy) => Result,
): Promise<Result> {
  const sources = Object.fromEntries(
    Object.entries(modules).map(([file, module]) => [file, module.source]),
  );
  return await withProgram(sources, (program) => {
    const first = program.getRootFileNames()[0] ?? "";
    const name = Object.keys(sources).find((file) => !file.endsWith(".json"));
    const directory = first.slice(0, -(name ?? "").length);
    const proposed = proposedModulePolicy(directory);
    const roles = Object.fromEntries(
      Object.entries(modules).map(([file, module]) => [
        resolve(directory, file),
        module.role,
      ]),
    );
    return inspect(program, {
      ...proposed,
      roles: { ...proposed.roles, ...roles },
    });
  });
}
