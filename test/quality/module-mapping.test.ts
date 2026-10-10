import assert from "node:assert/strict";
import { test } from "node:test";
import { mapModules } from "../../quality/module-mapping.ts";

const policy = {
  accepted: { "src/main.ts": "pure", "src/broker.ts": "broker" },
  automaticRoles: ["pure"],
};

await test("QG-19 automatically maps a pure extraction within the accepted catalog", () => {
  assert.deepEqual(
    mapModules(["src/main.ts", "src/helper.ts", "src/broker.ts"], {
      proposal: { "src/helper.ts": "pure" },
      policy,
    }),
    {
      "src/broker.ts": "broker",
      "src/helper.ts": "pure",
      "src/main.ts": "pure",
    },
  );
});

await test("QG-19 rejects missing mappings, privilege changes and unused proposals", () => {
  assert.throws(
    () => mapModules(["src/new.ts"], { proposal: {}, policy }),
    /unmapped-module/,
  );
  assert.throws(
    () =>
      mapModules(["src/main.ts"], {
        proposal: { "src/main.ts": "broker" },
        policy,
      }),
    /mapping-policy-change/,
  );
  assert.throws(
    () =>
      mapModules(["src/new.ts"], {
        proposal: { "src/new.ts": "broker" },
        policy,
      }),
    /mapping-requires-review/,
  );
  assert.throws(
    () =>
      mapModules(["src/main.ts"], {
        proposal: { "src/missing.ts": "pure" },
        policy,
      }),
    /unused-mapping/,
  );
  assert.throws(
    () => mapModules([], { proposal: {}, policy }),
    /empty-module-inventory/,
  );
});
