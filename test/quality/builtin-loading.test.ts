import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import { checkedTree } from "./sender-fixture.ts";

async function checked(
  module: { readonly file: string; readonly role: string },
  source: string,
): Promise<string> {
  return await checkedTree(
    { [module.file]: { role: module.role, source } },
    (program, policy) => {
      try {
        checkArchitecture(program, policy);
        return "accepted";
      } catch (error) {
        return String(error);
      }
    },
  );
}

const storage = { file: "src/storage/statements.ts", role: "storage" };

await test("CLV-054 the protected check rejects a module that loads a built-in module with no import", async () => {
  for (const module of [
    storage,
    { file: "src/steps/second-store.ts", role: "step" },
    { file: "src/broker/socket-address.ts", role: "broker" },
    { file: "src/service/expiry.ts", role: "service" },
    { file: "src/host/world-runs.ts", role: "host-bridge" },
  ])
    assert.match(
      await checked(
        module,
        'export function secondStore(path: string): unknown { const { DatabaseSync } = process.getBuiltinModule("node:sqlite"); return new DatabaseSync(path); }',
      ),
      new RegExp(`unsupported-loading: [^\\n]*${module.file}`),
      module.role,
    );
  for (const body of [
    'return process["getBuiltinModule"]("node:https");',
    'return process?.["getBuiltinModule"]("node:https");',
    'return globalThis.process.getBuiltinModule("node:https");',
    'const { getBuiltinModule } = process; return getBuiltinModule("node:https");',
    'const { getBuiltinModule: load } = process; return load("node:https");',
    'return Reflect.get(process, "getBuiltinModule");',
    "return Reflect.get(process, `getBuiltinModule`);",
    'const names = ["getBuiltinModule"] as const; return process[names[0]]("node:https");',
    'const name: "getBuiltinModule" = String(process.pid) as "getBuiltinModule"; return process[name]("node:https");',
  ])
    assert.match(
      await checked(storage, `export function loaded(): unknown { ${body} }`),
      /unsupported-loading: [^\n]*src\/storage\/statements\.ts/,
      body,
    );
});

await test("CLV-054 the protected check accepts a module that names the built-in loader in a text or an object key only", async () => {
  assert.equal(
    await checked(
      storage,
      'export const note = "process.getBuiltinModule is not permitted"; export const names = { getBuiltinModule: note, "getBuiltinModule ": note }; export function rows(): number { return process.pid; }',
    ),
    "accepted",
  );
});
