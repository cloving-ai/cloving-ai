import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { manifest } from "./develop-template-fixture.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";

await test("CLV-200 review-day declares two choices, daily commands and a bounded handoff", async () => {
  const root = new URL("../templates/review-day/", import.meta.url);
  const document = manifest(
    JSON.parse(await readFile(new URL("template.json", root), "utf8")),
  );
  assert.equal(document.name, "review-day");
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => option.id),
    ]),
    [
      ["post", ["privacy", "result"]],
      ["next", ["idea", "nothing"]],
    ],
  );
  for (const point of document.points)
    for (const option of point.options) assert.ok(Array.isArray(option.needs));
  const declaration: unknown = JSON.parse(
    await readFile(new URL("review-day.declaration.json", root), "utf8"),
  );
  assert.ok(isCandidateDeclaration(declaration));
  assert.deepEqual(declaration.workflow.schedule, {
    everySeconds: 86400,
    input: {},
  });
  assert.deepEqual(declaration.workflow.commands, [
    "report",
    "reviews",
    "improvements",
  ]);
  assert.deepEqual(declaration.workflow.capabilities, [
    "command",
    "claude",
    "github",
  ]);
  assert.deepEqual(declaration.workflow.handoffs, ["idea-to-issue"]);
  assert.deepEqual(declaration.methods, {
    command: ["run:report", "run:reviews", "run:improvements"],
    claude: ["run-turn"],
    github: ["create-issue", "label"],
  });
  const readme = await readFile(new URL("README.md", root), "utf8");
  for (const requirement of [
    "private workflow folder",
    "CLOVING_COMMANDS",
    "maxBudgetUsd",
    "cloving report --since 24 --json",
    "next.nothing",
    "cloving: ready",
    "skips",
    "loop",
  ])
    assert.ok(readme.includes(requirement), requirement);
});
