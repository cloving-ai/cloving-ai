import type { Advisory, Candidate } from "./candidates.ts";
import { failure } from "./fields.ts";
import type { BreakingChange, TicketPlan } from "./plan.ts";

export const ticketBytes = 48000;

export function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.slice(-1).join("")}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function advisoryRow(advisory: Advisory, name: string): string {
  return `| [${advisory.id}](${advisory.url}) | ${advisory.severity} | ${name} | ${cell(advisory.title)} | ${cell(advisory.vulnerableRange)} | ${cell(advisory.patchedRange ?? "none")} |`;
}

function pathLines(candidate: Candidate): readonly string[] {
  const more = candidate.pathCount - candidate.paths.length;
  const rest =
    more === 1
      ? `- 1 more path of ${candidate.name}. Run \`npm ls --all ${candidate.name}\` to see it.`
      : `- ${String(more)} more paths of ${candidate.name}. Run \`npm ls --all ${candidate.name}\` to see them.`;
  return candidate.paths
    .map((path) => `- \`${path}\``)
    .concat(more > 0 ? [rest] : []);
}

function changeLine(plan: TicketPlan): string {
  const change = plan.change;
  const step =
    change.kind === "pin"
      ? `Pin \`${change.package}\` at \`${change.to}\` in \`package.json\``
      : `Add the entry \`"${change.package}": "${change.to}"\` to \`overrides\` in \`package.json\``;
  return `1. ${step} (installed: \`${change.from}\`). Then update \`package-lock.json\` with \`npm install --ignore-scripts\`.`;
}

function breakingLine(item: BreakingChange): string {
  const code =
    item.uses.length === 0
      ? `Not used: ${item.action}`
      : `Code: ${item.uses.map((use) => `\`${use}\``).join(", ")}. Change: ${item.action}`;
  return `   - \`${item.version}\`: ${item.change} ${code}`;
}

function breakingLines(plan: TicketPlan): readonly string[] {
  const range = `between \`${plan.change.from}\` and \`${plan.change.to}\``;
  if (plan.breakingChanges.length === 0)
    return [`2. The release notes ${range} list no breaking change.`];
  return [`2. Change the code for each breaking change ${range}:`].concat(
    plan.breakingChanges.map((item) => breakingLine(item)),
  );
}

function title(plan: TicketPlan, names: string): string {
  const verb = plan.change.kind === "pin" ? "Upgrade" : "Override";
  return `# ${verb} ${plan.change.package} to ${plan.change.to} for the ${plan.severity} advisories of ${names}`;
}

function problem(plan: TicketPlan): readonly string[] {
  return [
    "## Problem",
    "",
    "`npm audit --json` on the newest default branch lists these critical and high advisories:",
    "",
    "| Advisory | Severity | Package | Title | Vulnerable range | Patched range |",
    "| --- | --- | --- | --- | --- | --- |",
  ].concat(
    plan.packages.flatMap((item) =>
      item.advisories.map((advisory) => advisoryRow(advisory, item.name)),
    ),
    ["", "These paths install the packages (`npm ls --all`):", ""],
    plan.packages.flatMap((item) => pathLines(item)),
  );
}

function outcome(plan: TicketPlan, names: string): readonly string[] {
  const first = plan.packages.at(0)?.advisories.at(0)?.id ?? "";
  return [
    "## Desired outcome",
    "",
    `\`npm audit --json\` lists none of the advisories of the table, and the lock file has no version of ${names} in a vulnerable range.`,
    "",
    "## Concrete scenario",
    "",
    `Today \`npm audit --json\` lists ${first} for ${names}. After the change, \`npm ci --ignore-scripts\` installs ${plan.change.package} ${plan.change.to}, and \`npm audit --json\` lists none of the advisories of the table.`,
  ];
}

function scope(plan: TicketPlan): readonly string[] {
  return ["## Scope", "", changeLine(plan)].concat(breakingLines(plan), [
    "3. Give the new version the same exact pin and the same justification as the current version.",
    "4. Inspect the installed packed artifact with scripts disabled.",
  ]);
}

function criteria(names: string): readonly string[] {
  return [
    "## Non-goals",
    "",
    "- No upgrade of other packages, except the change of item 1 of the scope.",
    "- No change for moderate or low advisories.",
    "",
    "## Acceptance criteria",
    "",
    "1. `npm audit --json` on the branch lists none of the advisories of the table.",
    `2. The lock file has no version of ${names} in a vulnerable range of the table.`,
    "3. Each breaking change has its code change, or the reason that the project does not use it.",
    "4. The developer gate passes.",
    "",
    "## First tests",
    "",
    "1. Before the change, `npm audit --json` lists each advisory of the table.",
    "2. For each breaking change that the project uses, write a test of the code at its place. The test fails with the new version before the code change.",
  ];
}

function utf8Bytes(text: string): number {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, "x").length;
}

export function ticketText(plan: TicketPlan): string {
  const names = listed(plan.packages.map((item) => item.name));
  const sources =
    plan.sources.length === 0
      ? ["None."]
      : plan.sources.map((source) => `- ${source}`);
  const text = [title(plan, names), ""]
    .concat(
      problem(plan),
      [""],
      outcome(plan, names),
      [""],
      scope(plan),
      [""],
      criteria(names),
      ["", "## Sources", ""],
      sources,
    )
    .join("\n")
    .concat("\n");
  if (utf8Bytes(text) > ticketBytes) failure("audit-ticket-too-large");
  return text;
}
