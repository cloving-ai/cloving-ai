import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { record } from "../src/protocol.ts";

interface ChoicePoint {
  readonly id: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly requires: Readonly<Record<string, readonly string[]>>;
  }[];
}

const choiceLine = /^- ([a-z-]+): \*\*([^*]+)\*\* \(`([a-z0-9-]+)`\)$/gm;

await test("the first-run recipe selects every develop choice and each choice is allowed", async () => {
  const readme = await readFile("README.md", "utf8");
  const section = readme.split("### A first useful run")[1]?.split("### ")[0];
  assert.ok(section);
  const documented = documentedChoices(section);
  const parsed: unknown = JSON.parse(
    await readFile("templates/develop/template.json", "utf8"),
  );
  const points = choicePoints(parsed);
  const choices = Object.fromEntries(
    points.map((point) => [point.id, documented[point.id]?.id]),
  );
  for (const point of points) assertChoice(point, documented[point.id]);
  assert.deepEqual(requirementProblems(points, choices), []);
  assert.ok(
    requirementProblems(points, {
      ...choices,
      recovery: "person",
      lessons: "file",
    }).length > 0,
  );
});

function documentedChoices(section: string) {
  return Object.fromEntries(
    [...section.matchAll(choiceLine)].map((match) => [
      String(match[1]),
      { label: String(match[2]), id: String(match[3]) },
    ]),
  );
}

function assertChoice(
  point: ChoicePoint,
  selected: { readonly label: string; readonly id: string } | undefined,
) {
  assert.ok(selected, point.id);
  const option = point.options.find((item) => item.id === selected.id);
  assert.equal(option?.label, selected.label, point.id);
}

function choicePoints(value: unknown): readonly ChoicePoint[] {
  const points = record(value)?.["points"];
  if (!Array.isArray(points)) throw new Error("invalid-template");
  return points.flatMap(choicePoint);
}

function choicePoint(value: unknown): readonly ChoicePoint[] {
  const fields = record(value);
  const options = fields?.["options"];
  if (typeof fields?.["id"] !== "string" || !Array.isArray(options)) return [];
  return [{ id: fields["id"], options: options.flatMap(choiceOption) }];
}

function choiceOption(value: unknown): ChoicePoint["options"][number][] {
  const fields = record(value);
  const requires = record(fields?.["requires"]) ?? {};
  if (typeof fields?.["id"] !== "string" || typeof fields["label"] !== "string")
    return [];
  return [
    {
      id: fields["id"],
      label: fields["label"],
      requires: Object.fromEntries(
        Object.entries(requires).flatMap(([key, allowed]) =>
          Array.isArray(allowed) &&
          allowed.every((item) => typeof item === "string")
            ? [[key, allowed]]
            : [],
        ),
      ),
    },
  ];
}

function requirementProblems(
  points: readonly ChoicePoint[],
  choices: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return points.flatMap((point) => {
    const selected = choices[point.id];
    const option = point.options.find((item) => item.id === selected);
    if (option === undefined) return [`${point.id}: missing`];
    return Object.entries(option.requires).flatMap(([other, allowed]) =>
      allowed.includes(choices[other] ?? "")
        ? []
        : [`${point.id} requires ${other}`],
    );
  });
}
