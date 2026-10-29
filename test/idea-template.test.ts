import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { configurationErrors, manifest } from "./develop-template-fixture.ts";

async function ideaManifest() {
  return manifest(
    JSON.parse(
      await readFile(
        new URL("../templates/idea-to-issue/template.json", import.meta.url),
        "utf8",
      ),
    ),
  );
}

await test("CLV-222 loads the idea-to-issue template manifest", async () => {
  const document: unknown = JSON.parse(
    await readFile(
      new URL("../templates/idea-to-issue/template.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest(document).name, "idea-to-issue");
});

await test("CLV-222 declares three decisions with hands-off defaults and private post prerequisites", async () => {
  const document = await ideaManifest();
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => option.id),
    ]),
    [
      ["review", ["turn", "person"]],
      ["post", ["privacy", "person"]],
      ["next", ["develop", "queue", "nothing"]],
    ],
  );
  assert.deepEqual(
    configurationErrors(document, {
      review: "turn",
      post: "privacy",
      next: "develop",
    }),
    [],
  );
  for (const option of document.points.find((point) => point.id === "post")
    ?.options ?? [])
    assert.ok(option.needs.includes("private-texts"));
});
