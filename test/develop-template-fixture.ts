import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { doctorCodes } from "../src/doctor-report.ts";
import { record } from "../src/protocol.ts";

export interface TemplateOption {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly change: string;
  readonly requires: Readonly<Record<string, readonly string[]>>;
  readonly needs: readonly string[];
}

export interface TemplatePoint {
  readonly id: string;
  readonly question: string;
  readonly options: readonly TemplateOption[];
}

export interface TemplateManifest {
  readonly version: 1;
  readonly name: string;
  readonly summary: string;
  readonly points: readonly TemplatePoint[];
}

function text(value: unknown): string {
  assert.equal(typeof value, "string");
  assert.ok(typeof value === "string" && value.trim().length > 0);
  return value;
}

function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  const result = value.map(text);
  assert.equal(new Set(result).size, result.length);
  return result;
}

function option(value: unknown): TemplateOption {
  const fields = record(value);
  assert.ok(fields);
  assert.deepEqual(Object.keys(fields).sort(), [
    "change",
    "id",
    "label",
    "needs",
    "requires",
    "summary",
  ]);
  const requires = record(fields["requires"]);
  assert.ok(requires);
  return {
    id: text(fields["id"]),
    label: text(fields["label"]),
    summary: text(fields["summary"]),
    change: text(fields["change"]),
    requires: Object.fromEntries(
      Object.entries(requires).map(([point, choices]) => [
        point,
        strings(choices),
      ]),
    ),
    needs: strings(fields["needs"]),
  };
}

function point(value: unknown): TemplatePoint {
  const fields = record(value);
  assert.ok(fields);
  assert.deepEqual(Object.keys(fields).sort(), ["id", "options", "question"]);
  const options: unknown = fields["options"];
  assert.ok(Array.isArray(options) && options.length > 0);
  const parsed = options.map(option);
  assert.equal(new Set(parsed.map((choice) => choice.id)).size, parsed.length);
  return {
    id: text(fields["id"]),
    question: text(fields["question"]),
    options: parsed,
  };
}

export function manifest(value: unknown): TemplateManifest {
  const fields = record(value);
  assert.ok(fields);
  assert.deepEqual(Object.keys(fields).sort(), [
    "name",
    "points",
    "summary",
    "version",
  ]);
  assert.equal(fields["version"], 1);
  const points: unknown = fields["points"];
  assert.ok(Array.isArray(points) && points.length > 0);
  const parsed = points.map(point);
  assert.equal(new Set(parsed.map((item) => item.id)).size, parsed.length);
  const result = {
    version: 1 as const,
    name: text(fields["name"]),
    summary: text(fields["summary"]),
    points: parsed,
  };
  references(result);
  return result;
}

function references(document: TemplateManifest): void {
  const known = new Map(
    document.points.map((item) => [
      item.id,
      item.options.map((choice) => choice.id),
    ]),
  );
  for (const item of document.points) {
    for (const choice of item.options) {
      assert.ok(
        choice.needs.every((code) =>
          doctorCodes.some((known) => known === code),
        ),
      );
      for (const [required, alternatives] of Object.entries(choice.requires)) {
        assert.notEqual(required, item.id);
        assert.ok(alternatives.length > 0);
        assert.ok(
          alternatives.every((id) => known.get(required)?.includes(id)),
        );
      }
    }
  }
}

export async function developManifest(): Promise<TemplateManifest> {
  const document: unknown = JSON.parse(
    await readFile(
      new URL("../templates/develop/template.json", import.meta.url),
      "utf8",
    ),
  );
  return manifest(document);
}

export async function packedDevelopTemplate(
  packageRoot: string,
): Promise<void> {
  const document: unknown = JSON.parse(
    await readFile(
      join(packageRoot, "templates/develop/template.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest(document), await developManifest());
  assert.match(
    await readFile(join(packageRoot, "templates/develop/README.md"), "utf8"),
    /executable workflow is pending/,
  );
}

export function configurationErrors(
  document: TemplateManifest,
  selected: Readonly<Record<string, string>>,
): string[] {
  const errors: string[] = [];
  for (const item of document.points) {
    const choice = item.options.find(
      (choice) => choice.id === selected[item.id],
    );
    assert.ok(choice, `Unknown or missing choice for ${item.id}`);
    for (const [required, alternatives] of Object.entries(choice.requires)) {
      if (!alternatives.some((id) => id === selected[required]))
        errors.push(
          `${item.id}.${choice.id} requires ${required}: ${alternatives.join(" or ")}`,
        );
    }
  }
  return errors;
}

export const automatic = {
  input: "ticket",
  select: "queue",
  accept: "greptile",
  merge: "green",
  partial: "queue",
};

export const reviewed = {
  input: "ticket",
  select: "person",
  accept: "person",
  merge: "local",
  partial: "person",
};
