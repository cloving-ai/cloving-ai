import type { Drift, DriftRow } from "./audit.ts";
import { failure } from "./fields.ts";

export const ticketBytes = 48000;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function tableRow(row: DriftRow): string {
  const commit = row.commit === null ? "not known" : `\`${row.commit}\``;
  return `| ${String(row.line)} | ${cell(row.says)} | ${cell(row.code)} | \`${row.evidence}\` | ${commit} |`;
}

function problem(drift: Drift, commit: string): readonly string[] {
  const count = drift.rows.length;
  const statements =
    count === 1
      ? "1 statement that does not"
      : `${String(count)} statements that do not`;
  return [
    "## Problem",
    "",
    `\`${drift.doc}\` has ${statements} match the code on main at commit \`${commit.slice(0, 12)}\`. A reader who follows the doc fails.`,
    "",
    "| Doc line | The doc says | The code does | Evidence | Commit |",
    "| --- | --- | --- | --- | --- |",
  ].concat(drift.rows.map((row) => tableRow(row)));
}

function outcome(drift: Drift): readonly string[] {
  return [
    "## Desired outcome",
    "",
    `Each statement of the table matches the code on main, and every other statement of \`${drift.doc}\` stays.`,
    "",
    "## Concrete scenario",
    "",
  ].concat(
    drift.rows
      .slice(0, 1)
      .map(
        (row) =>
          `Today line ${String(row.line)} of \`${drift.doc}\` says: ${row.says} The code at \`${row.evidence}\` does this: ${row.code} After the change, line ${String(row.line)} matches the code.`,
      ),
  );
}

function scope(drift: Drift): readonly string[] {
  return ["## Scope", ""].concat(
    drift.rows.map(
      (row, index) =>
        `${String(index + 1)}. Line ${String(row.line)}: ${row.fix}`,
    ),
  );
}

function criteria(drift: Drift): readonly string[] {
  return [
    "## Non-goals",
    "",
    "- No change to the code, to the tests or to another doc.",
    "- No new statement in the doc, except the changes of the scope.",
    "",
    "## Acceptance criteria",
    "",
    "1. Each row of the table matches the code on main.",
    `2. The change touches only \`${drift.doc}\`.`,
    `3. Every other statement of \`${drift.doc}\` stays.`,
    "",
    "## First tests",
    "",
    "1. Before the change, compare each row of the table with its evidence. The doc line and the code do not match.",
  ];
}

function utf8Bytes(text: string): number {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, "x").length;
}

export function ticketText(drift: Drift, commit: string): string {
  const text = [`# Make \`${drift.doc}\` match the code on main`, ""]
    .concat(
      problem(drift, commit),
      [""],
      outcome(drift),
      [""],
      scope(drift),
      [""],
      criteria(drift),
    )
    .join("\n")
    .concat("\n");
  if (utf8Bytes(text) > ticketBytes) failure("drift-ticket-too-large");
  return text;
}
