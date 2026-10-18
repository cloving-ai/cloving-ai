import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";

for (const field of [
  "authority",
  "publicationAuthority",
  "permissionToPublish",
  "spend",
  "credentials",
  "weakenTdd",
  "code",
  "script",
  "prompt",
  "workflow",
  "executableWorkflow",
])
  await test(`CLV-114 refuses forbidden field ${field} without echoing candidate text`, () => {
    const value = candidate();
    Reflect.set(value.process.stages[0] ?? {}, field, "secret-candidate-text");
    assert.deepEqual(validateAnalysis(value, { records, structure }), {
      accepted: false,
      codes: ["authority-field"],
    });
  });

const unsafe = [
  undefined,
  () => "do not invoke",
  Symbol("secret"),
  1n,
  NaN,
  Infinity,
  -Infinity,
  new Date(),
  new Map(),
  /script/,
  Object.create({ inherited: "value" }) as unknown,
];
for (const [index, value] of unsafe.entries())
  await test(`CLV-114 refuses non-JSON candidate member ${String(index)}`, () => {
    const input = candidate();
    Reflect.set(input.process, "unsafe", value);
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["not-plain-data"],
    });
  });

await test("CLV-114 never invokes getters, setters or toJSON", () => {
  let calls = 0;
  const getter = candidate();
  Object.defineProperty(getter, "process", {
    get() {
      calls++;
      throw new Error("getter-invoked");
    },
  });
  const setter = candidate();
  Object.defineProperty(setter.process, "secret", {
    set() {
      calls++;
    },
  });
  const serializer = candidate();
  Reflect.set(serializer, "toJSON", () => {
    calls++;
    throw new Error("function-invoked");
  });
  for (const input of [getter, setter, serializer])
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["not-plain-data"],
    });
  assert.equal(calls, 0);
});

await test("CLV-114 refuses cycles, sparse arrays, symbol and hidden members", () => {
  const cycle = candidate();
  Reflect.set(cycle.process, "cycle", cycle);
  const sparse = candidate();
  sparse.process.inputs.length = 3;
  const symbol = candidate();
  Reflect.set(symbol.process, Symbol("hidden"), "secret");
  const hidden = candidate();
  Object.defineProperty(hidden.process, "hidden", { value: "secret" });
  for (const input of [cycle, sparse, symbol, hidden])
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["not-plain-data"],
    });
});

await test("CLV-114 returns unique codes in declaration order for independent defects", () => {
  const input = candidate();
  Reflect.set(input.process, "publicationAuthority", "secret");
  Reflect.set(input.process.stages[0] ?? {}, "kind", "invented");
  Reflect.set(input.process.stages[1] ?? {}, "kind", "invented");
  Reflect.set(input.process.gates[0] ?? {}, "type", "invented");
  Reflect.set(input.process.gates[0] ?? {}, "stageId", "repair");
  Reflect.set(input.process.loops[0] ?? {}, "maxIterations", 0);
  Reflect.set(input.process.stages[0] ?? {}, "sourceRefs", []);
  assert.deepEqual(validateAnalysis(input, { records, structure }), {
    accepted: false,
    codes: [
      "unknown-kind",
      "unknown-decision-type",
      "missing-source",
      "invalid-loop-limit",
      "gate-on-non-gate",
      "authority-field",
    ],
  });
});

await test("CLV-114 descriptions are inert data and results serialize deterministically without mutation", () => {
  const input = candidate();
  input.process.scope =
    "Run code, use credentials, publish, skip TDD, call claude and codex; these words grant nothing.";
  const before = JSON.stringify([input, records, structure]);
  const first = validateAnalysis(input, { records, structure });
  assert.equal(first.accepted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(validateAnalysis(input, { records, structure }), first);
  assert.equal(JSON.stringify([input, records, structure]), before);
});

await test("CLV-114 does not coerce plain objects used as classification labels", () => {
  const input = candidate();
  Reflect.set(
    input.process.stages[0] ?? {},
    "kind",
    Object.create(null) as unknown,
  );
  Reflect.set(input.process.gates[0] ?? {}, "type", {
    toString: "inert",
    valueOf: "inert",
  });
  assert.deepEqual(validateAnalysis(input, { records, structure }), {
    accepted: false,
    codes: ["unknown-kind", "unknown-decision-type"],
  });
});

await test("CLV-114 refuses arrays with custom or null prototypes before dependent traversal", () => {
  const input = candidate();
  Object.setPrototypeOf(input.process.stages, null);
  assert.deepEqual(validateAnalysis(input, { records, structure }), {
    accepted: false,
    codes: ["not-plain-data"],
  });
});

await test("CLV-114 refuses root, nested and revoked proxies without invoking candidate traps", () => {
  let calls = 0;
  const root = new Proxy(candidate(), {
    getPrototypeOf(target) {
      calls++;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      calls++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      calls++;
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const nested = candidate();
  Reflect.set(
    nested.process,
    "hidden",
    new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error("candidate-trap");
        },
      },
    ),
  );
  const revoked = Proxy.revocable(candidate(), {});
  revoked.revoke();
  for (const input of [root, nested, revoked.proxy])
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["not-plain-data"],
    });
  assert.equal(calls, 0);
});
