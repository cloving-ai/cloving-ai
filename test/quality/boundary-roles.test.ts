import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import {
  admittedModulePolicy,
  proposedModulePolicy,
} from "../../quality/module-policy.ts";
import { productionInventory } from "../../quality/production-inventory.ts";
import {
  checkedSenderTree,
  checkedTree,
  type AddedModule,
} from "./sender-fixture.ts";

const control = ["workflow", "step", "host-bridge", "sdk-runtime"];

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

await test("CLV-054 the protected check rejects a second module that opens the authority database or imports the SQLite driver", async () => {
  await rejected(
    {
      "src/broker/second-store.ts": {
        role: "broker",
        source:
          'import { sqlite } from "solid-objects/database/sqlite"; export const second = sqlite;',
      },
    },
    /reserved-import: [^\n]*src\/broker\/second-store\.ts -> [^\n]*database\/sqlite\.d\.ts/,
  );
  for (const [file, role] of [
    ["src/broker/second-store.ts", "broker"],
    ["src/storage/second-schema.ts", "storage"],
  ] as const)
    await rejected(
      {
        [file]: {
          role,
          source:
            'import { DatabaseSync } from "node:sqlite"; export const second = DatabaseSync;',
        },
      },
      /reserved-import: [^\n]*second-(store|schema)\.ts -> node:sqlite/,
    );
  await checkedSenderTree(
    {
      "src/storage/rows.ts": {
        role: "storage",
        source:
          'import type { DatabaseSync } from "node:sqlite"; export function rows(database: DatabaseSync): unknown[] { return database.prepare("SELECT 1").all(); }',
      },
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
    },
  );
});

await test("CLV-054 the protected check rejects an authority module that reaches the workflow, a step, the host bridge or the SDK runtime", async () => {
  const lists = proposedModulePolicy("/candidate").forbiddenReachability;
  assert.deepEqual(lists["broker"], [...control, "inspector"]);
  assert.deepEqual(lists["storage"], [...control, "inspector"]);
  for (const role of ["workflow", "host-bridge", "sdk-runtime", "step"])
    assert.ok(lists["pure"]?.includes(role), role);
  for (const role of control)
    await checkedTree(
      {
        "src/broker/turns.ts": {
          role: "broker",
          source: 'export { relayed } from "../harness/relay.js";',
        },
        "src/harness/relay.ts": {
          role: "harness",
          source: 'export { relayed } from "../control.js";',
        },
        "src/control.ts": { role, source: "export const relayed = 1;" },
      },
      (program, policy) => {
        assert.throws(() => {
          checkArchitecture(program, {
            ...policy,
            allowed: { ...policy.allowed, harness: [role] },
          });
        }, /forbidden-reachability: [^\n]*src\/broker\/turns\.ts -> [^\n]*src\/control\.ts/);
      },
    );
});

await test("CLV-054 the protected check rejects a workflow helper or a step that reaches a storage module", async () => {
  const storage = {
    "src/broker/files.ts": {
      role: "broker",
      source: 'export { rows } from "../storage/rows.js";',
    },
    "src/storage/rows.ts": {
      role: "storage",
      source: "export const rows = 1;",
    },
    "src/steps/load.ts": {
      role: "step",
      source: 'export { rows } from "../broker/files.js";',
    },
  };
  await checkedTree(storage, (program, policy) => {
    assert.throws(() => {
      checkArchitecture(program, policy);
    }, /forbidden-reachability: [^\n]*src\/steps\/load\.ts -> [^\n]*src\/storage\/rows\.ts/);
  });
  await checkedTree(
    {
      ...storage,
      "src/helpers.ts": {
        role: "workflow",
        source: 'export { rows } from "./steps/load.js";',
      },
    },
    (program, policy) => {
      assert.throws(() => {
        checkArchitecture(program, policy);
      }, /forbidden-reachability: [^\n]*src\/helpers\.ts -> [^\n]*src\/storage\/rows\.ts/);
    },
  );
});

await test("CLV-054 the protected check accepts a module with the host bridge role and a pure domain module", async () => {
  await checkedTree(
    {
      "node_modules/workflow/dist/runtime.d.ts": {
        role: "sdk-runtime",
        source: "export declare function start(name: string): Promise<string>;",
      },
      "src/authority/identity.ts": {
        role: "pure",
        source: "export const identity = (name: string): string => name;",
      },
      "src/host/names.ts": {
        role: "host-bridge",
        source:
          'import { basename } from "node:path"; import { identity } from "../authority/identity.js"; export const named = (file: string): string => identity(basename(file));',
      },
      "src/host/bridge.ts": {
        role: "host-bridge",
        source:
          'import type { start } from "../../node_modules/workflow/dist/runtime.js"; import { named } from "./names.js"; export function bridged(run: typeof start, file: string): Promise<string> { return run(named(file)); }',
      },
    },
    (program, policy) => {
      assert.doesNotThrow(() => {
        checkArchitecture(program, policy);
      });
      const files = program
        .getRootFileNames()
        .filter((file) => !file.endsWith(".d.ts"));
      assert.deepEqual(
        productionInventory(program, { files, roles: policy.roles }).map(
          (file) => file.slice(file.indexOf("src/")),
        ),
        [
          "src/authority/identity.ts",
          "src/host/bridge.ts",
          "src/host/names.ts",
        ],
      );
    },
  );
});

await test("CLV-054 a candidate cannot give a new file the host bridge role or the SDK runtime role, or change a reserved list, with no review", () => {
  const files = ["/candidate/src/workflows.ts", "/candidate/src/host.ts"];
  for (const role of ["host-bridge", "sdk-runtime"])
    assert.throws(
      () =>
        admittedModulePolicy("/candidate", {
          files,
          roles: { "src/host.ts": role },
        }),
      /mapping-requires-review: src\/host\.ts/,
    );
  const admitted = admittedModulePolicy("/candidate", {
    files,
    roles: { "src/host.ts": "pure" },
  });
  assert.ok(admitted.reserved);
  assert.deepEqual(
    admitted.reserved,
    proposedModulePolicy("/candidate").reserved,
  );
});

await test("CLV-055 the protected check has the product host in the host bridge role, and only that role can import the SDK runtime", () => {
  const policy = proposedModulePolicy("/candidate");
  assert.equal(
    policy.roles["/candidate/src/host/world-host.ts"],
    "host-bridge",
  );
  assert.equal(
    policy.roles["/candidate/node_modules/workflow/dist/runtime.d.ts"],
    "sdk-runtime",
  );
  const importers = (role: string): string[] =>
    Object.entries(policy.allowed)
      .filter(([, targets]) => targets.includes(role))
      .map(([name]) => name);
  assert.deepEqual(importers("sdk-runtime"), ["host-bridge"]);
  assert.deepEqual(importers("host-bridge"), ["host-bridge"]);
});
