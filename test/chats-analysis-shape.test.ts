import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import {
  candidate,
  itemAt,
  records,
  structure,
} from "./chats-analysis-fixture.ts";

for (const input of [null, true, 3, "inert", []])
  await test(`CLV-114 refuses a non-object analysis root ${JSON.stringify(input)}`, () => {
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["invalid-shape"],
    });
  });

for (const process of [null, [], "inert"])
  await test(`CLV-114 refuses a malformed process ${JSON.stringify(process)}`, () => {
    assert.deepEqual(
      validateAnalysis({ schemaVersion: 1, process }, { records, structure }),
      { accepted: false, codes: ["invalid-shape"] },
    );
  });

const changes = [
  {
    name: "missing inputs",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(v.process, "inputs");
    },
  },
  {
    name: "non-array inputs",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(v.process, "inputs", {});
    },
  },
  {
    name: "non-object stage",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(v.process.stages, "0", null);
    },
  },
  {
    name: "blank ID",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.inputs).id = " ";
    },
  },
  {
    name: "blank description",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.inputs).description = " ";
    },
  },
  {
    name: "blank name",
    change: (v: ReturnType<typeof candidate>) => {
      v.process.name = " ";
    },
  },
  {
    name: "missing scope",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(v.process, "scope");
    },
  },
  {
    name: "unknown activity",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.stages).activity = "unknown";
    },
  },
  {
    name: "non-array source refs",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(itemAt(v.process.stages), "sourceRefs", {});
    },
  },
  {
    name: "non-object source ref",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(itemAt(v.process.stages).sourceRefs, "0", null);
    },
  },
  {
    name: "fractional occurrence",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(itemAt(v.process.stages).sourceRefs).recordIndex = 1.5;
    },
  },
  {
    name: "unsafe occurrence",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(itemAt(v.process.stages).sourceRefs).recordIndex =
        Number.MAX_SAFE_INTEGER + 1;
    },
  },
  {
    name: "blank source ID",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(itemAt(v.process.stages).sourceRefs).sourceId = " ";
    },
  },
  {
    name: "extra reference field",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.set(itemAt(itemAt(v.process.stages).sourceRefs), "extra", true);
    },
  },
  {
    name: "blank gate link",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.gates).stageId = "";
    },
  },
  {
    name: "duplicate loop stage",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.loops).stageIds = ["review", "review"];
    },
  },
  {
    name: "empty loop stages",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.loops).stageIds = [];
    },
  },
  {
    name: "missing loop exit",
    change: (v: ReturnType<typeof candidate>) => {
      Reflect.deleteProperty(itemAt(v.process.loops), "exitCondition");
    },
  },
  {
    name: "blank branch condition",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.branches).condition = "";
    },
  },
  {
    name: "unknown non-gate reason",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.nonGates).reason = "unknown";
    },
  },
  {
    name: "broken non-gate link",
    change: (v: ReturnType<typeof candidate>) => {
      itemAt(v.process.nonGates).stageId = "missing";
    },
  },
];
for (const { name, change } of changes)
  await test(`CLV-114 refuses shape defect: ${name}`, () => {
    const input = candidate();
    change(input);
    assert.deepEqual(validateAnalysis(input, { records, structure }), {
      accepted: false,
      codes: ["invalid-shape"],
    });
  });

await test("CLV-114 accepts empty optional collections and preserves explicit stage order", () => {
  const input = candidate();
  input.process.inputs = [];
  input.process.branches = [];
  input.process.loops = [];
  input.process.artifacts = [];
  input.process.gates = [];
  input.process.stages.reverse();
  const validation = validateAnalysis(input, { records, structure });
  assert.equal(validation.accepted, true);
  assert.deepEqual(
    validation.result.process.stages.map((stage) => stage.id),
    input.process.stages.map((stage) => stage.id),
  );
});
