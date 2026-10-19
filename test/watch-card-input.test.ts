import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { watchCardForms } from "../src/cli/watch-card-forms.ts";
import {
  builtinCardForms,
  cardRunRequest,
} from "../src/cli/watch-run-input.ts";
import { withHarness } from "./service-fixture.ts";

await test("CLV-135 forms exclude malformed and nonstring declarations and preserve optional string fields", () =>
  withHarness(async (harness) => {
    const directory = join(harness.projectDirectory, "declarations");
    await mkdir(directory);
    await writeDeclarations(directory);
    const forms = await watchCardForms(directory);
    assert.equal(forms.length, 5);
    const form = forms.find((item) => item.workflowId === "declared");
    assert.deepEqual(form, {
      workflowId: "declared",
      source: "input",
      fields: [
        { name: "title", label: "title", multiline: false, optional: false },
        { name: "extra", label: "extra", multiline: false, optional: true },
      ],
    });
    assert.deepEqual(
      await watchCardForms(join(directory, "missing")),
      builtinCardForms(),
    );
    assert.deepEqual(
      cardRunRequest(forms, {
        workflowId: "declared",
        fields: { title: "Hello" },
        commandId: "form-1",
      }),
      {
        operation: "run",
        parameters: {
          workflowId: "declared",
          source: "input",
          submission: { title: "Hello" },
          commandId: "form-1",
        },
      },
    );
    assert.equal(cardRunRequest(forms, null), null);
    assert.equal(
      cardRunRequest(forms, {
        workflowId: "declared",
        fields: [],
        commandId: "form-1",
      }),
      null,
    );
    assert.equal(
      cardRunRequest(forms, {
        workflowId: "declared",
        fields: { title: " " },
        commandId: "form-1",
      }),
      null,
    );
  }));

async function writeDeclarations(directory: string): Promise<void> {
  const declaration = {
    workflowId: "declared",
    capabilities: ["chats"],
    effectLimit: 1,
    input: {
      maximumBytes: 4096,
      fields: {
        title: { type: "string" },
        extra: { type: "string", optional: true },
      },
    },
  };
  await writeFile(
    join(directory, "valid.declaration.json"),
    JSON.stringify(declaration),
  );
  await writeFile(join(directory, "bad.declaration.json"), "{");
  await writeFile(join(directory, "invalid.declaration.json"), "{}");
  await writeFile(
    join(directory, "number.declaration.json"),
    JSON.stringify({
      ...declaration,
      workflowId: "number",
      input: { maximumBytes: 4096, fields: { count: { type: "integer" } } },
    }),
  );
  await writeFile(
    join(directory, "builtin.declaration.json"),
    JSON.stringify({ ...declaration, workflowId: "develop-issue" }),
  );
}
