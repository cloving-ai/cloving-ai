import { record } from "./protocol.ts";

export interface WorkflowRefusal {
  readonly scope: "project" | "user";
  readonly label: string;
  readonly codes: readonly string[];
}

const refusalCodes = new Set([
  "invalid-declaration",
  "forbidden-import",
  "missing-export",
  "unsupported-source",
  "dynamic-effect",
  "undeclared-effect",
  "effect-limit",
  "direct-effect",
  "workflow-conflict",
  "bundled-name-reserved",
  "unsafe-workflow-path",
  "workflow-read-failed",
  "workflow-source-changed",
  "compile-failed",
]);

function refusal(value: unknown): WorkflowRefusal[] {
  const { scope, label, codes } = record(value) ?? {};
  if (
    (scope !== "project" && scope !== "user") ||
    typeof label !== "string" ||
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ts|file-[a-f0-9]{16}|workflows\/)$/u.exec(
      label,
    )?.[0] !== label ||
    !Array.isArray(codes) ||
    codes.length === 0
  )
    return [];
  const known = codes.filter(
    (code: unknown) => typeof code === "string" && refusalCodes.has(code),
  );
  if (known.length !== codes.length) return [];
  return [{ scope, label, codes: [...new Set(known)].sort() }];
}

export function workflowRefusals(value: unknown): readonly WorkflowRefusal[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(refusal).sort((left, right) => {
    const a = `${left.scope}\0${left.label}`;
    const b = `${right.scope}\0${right.label}`;
    return a < b ? -1 : Number(a > b);
  });
}
