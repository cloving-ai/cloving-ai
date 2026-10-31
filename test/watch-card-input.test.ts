import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { watchCardForms } from "../src/cli/watch-card-forms.ts";
import { cardRunRequest } from "../src/cli/watch-run-input.ts";
import { withHarness } from "./service-fixture.ts";

await test("CLV-228 no declarations means no watch forms", () =>
  withHarness(async (harness) => {
    assert.deepEqual(await watchCardForms(harness.projectDirectory), []);
  }));

await test("CLV-228 former bundled IDs use only their declared fields", () =>
  withHarness(async (harness) => {
    const declarations = [
      "develop-issue",
      "develop-ticket",
      "develop-prd",
      "develop-prompt",
    ].map((workflowId) => ({
      workflowId,
      functionName: "projectWorkflow",
      capabilities: ["claude"],
      effectLimit: 1,
      input: { maximumBytes: 4096, fields: { subject: { type: "string" } } },
    }));
    await writeFile(
      join(harness.projectDirectory, "declarations.json"),
      JSON.stringify(declarations),
    );
    assert.deepEqual(
      await watchCardForms(harness.projectDirectory),
      declarations.map(({ workflowId }) => ({
        workflowId,
        source: "input",
        fields: [
          {
            name: "subject",
            label: "subject",
            multiline: false,
            optional: false,
          },
        ],
      })),
    );
  }));

await test("CLV-217 declared ticket forms show Ticket ID and submit the ticket string", () =>
  withHarness(async (harness) => {
    const directory = harness.projectDirectory;
    await writeFile(
      join(directory, "declarations.json"),
      JSON.stringify([
        {
          workflowId: "ticket-workflow",
          capabilities: ["claude"],
          effectLimit: 1,
          input: {
            maximumBytes: 4096,
            fields: {
              ticket: { type: "ticket" },
              note: { type: "string", optional: true },
            },
          },
        },
      ]),
    );
    const forms = await watchCardForms(directory);
    const form = forms.find((item) => item.workflowId === "ticket-workflow");
    assert.deepEqual(form?.fields, [
      { name: "ticket", label: "Ticket ID", multiline: false, optional: false },
      { name: "note", label: "note", multiline: false, optional: true },
    ]);
    assert.partialDeepStrictEqual(
      cardRunRequest(forms, {
        workflowId: "ticket-workflow",
        commandId: "ticket-form",
        fields: { ticket: "312" },
      }),
      { parameters: { submission: { ticket: "312" } } },
    );
  }));

await test("CLV-135 forms exclude malformed and nonstring declarations and preserve optional string fields", () =>
  withHarness(async (harness) => {
    const directory = join(harness.projectDirectory, "declarations");
    await mkdir(directory);
    await writeDeclarations(directory);
    const forms = await watchCardForms(directory);
    assert.equal(forms.length, 2);
    const form = forms.find((item) => item.workflowId === "declared");
    assert.deepEqual(form, {
      workflowId: "declared",
      source: "input",
      fields: [
        { name: "title", label: "title", multiline: false, optional: false },
        { name: "extra", label: "extra", multiline: false, optional: true },
      ],
    });
    assert.deepEqual(await watchCardForms(join(directory, "missing")), []);
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

await test("CLV-228 unreadable, malformed and non-array declaration catalogs have no forms", () =>
  withHarness(async (harness) => {
    for (const text of ["{", "null", "{}", "42", '"text"', "[null, 42, []]"]) {
      await writeFile(
        join(harness.projectDirectory, "declarations.json"),
        text,
      );
      assert.deepEqual(await watchCardForms(harness.projectDirectory), []);
    }
  }));

async function writeDeclarations(directory: string): Promise<void> {
  const declaration = {
    workflowId: "declared",
    capabilities: ["claude"],
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
    join(directory, "declarations.json"),
    JSON.stringify([
      declaration,
      {},
      {
        ...declaration,
        workflowId: "number",
        input: { maximumBytes: 4096, fields: { count: { type: "integer" } } },
      },
      { ...declaration, workflowId: "develop-issue" },
      declaration,
    ]),
  );
}
