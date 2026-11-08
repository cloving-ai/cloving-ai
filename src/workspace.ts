import { configurationRoot } from "./project-settings.ts";
import { record, type Fields } from "./protocol.ts";

export interface WorkspaceRepository {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceLimits {
  readonly lanes?: number;
  readonly dailySpendLimitUsd?: number;
}

export interface Workspace {
  readonly repositories: readonly WorkspaceRepository[];
  readonly limits: WorkspaceLimits;
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function refused(detail: string): never {
  throw new Error(`invalid-workspace: ${detail}`);
}

export function workspaceFile(
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string {
  return `${configurationRoot(environment, home)}/cloving/workspace.json`;
}

function parsed(text: string): Fields {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    refused("the file is not JSON");
  }
  return record(value) ?? refused("the file must hold one object");
}

function unknownField(
  fields: Fields,
  known: readonly string[],
): string | undefined {
  return Object.keys(fields).find((name) => !known.includes(name));
}

function repository(value: unknown, position: number): WorkspaceRepository {
  const label = `repository ${String(position)}`;
  const fields = record(value) ?? refused(`${label} must be an object`);
  const unknown = unknownField(fields, ["path", "name"]);
  if (unknown !== undefined)
    refused(`${label} has the field ${unknown}, which is not known`);
  const path = fields["path"];
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("\u0000")
  )
    refused(`${label} needs an absolute path`);
  const trimmed = path.replace(/(?<=.)\/+$/, "");
  const name = fields["name"] ?? trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (typeof name !== "string" || !namePattern.test(name))
    refused(
      `${label} needs a name of 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  return { name, path: trimmed };
}

function unique(
  repositories: readonly WorkspaceRepository[],
  key: keyof WorkspaceRepository,
): void {
  const seen = new Set<string>();
  for (const entry of repositories) {
    if (seen.has(entry[key]))
      refused(`the ${key} ${entry[key]} is used two times`);
    seen.add(entry[key]);
  }
}

function workspaceLimits(fields: Fields): WorkspaceLimits {
  const { lanes, dailySpendLimitUsd } = fields;
  if (
    lanes !== undefined &&
    !(Number.isSafeInteger(lanes) && Number(lanes) >= 1 && Number(lanes) <= 64)
  )
    refused("lanes must be a whole number from 1 to 64");
  if (
    dailySpendLimitUsd !== undefined &&
    !(typeof dailySpendLimitUsd === "number" && dailySpendLimitUsd > 0)
  )
    refused("dailySpendLimitUsd must be a number above 0");
  return {
    ...(lanes === undefined ? {} : { lanes: Number(lanes) }),
    ...(dailySpendLimitUsd === undefined ? {} : { dailySpendLimitUsd }),
  };
}

export function parseWorkspace(text: string): Workspace {
  const fields = parsed(text);
  if (fields["version"] !== 1) refused("version must be 1");
  const unknown = unknownField(fields, [
    "version",
    "repositories",
    "lanes",
    "dailySpendLimitUsd",
  ]);
  if (unknown !== undefined) refused(`the field ${unknown} is not known`);
  const listed = fields["repositories"];
  if (!Array.isArray(listed) || listed.length === 0)
    refused("repositories must list one or more repositories");
  const repositories = Array.from<unknown>(listed).map((value, index) =>
    repository(value, index + 1),
  );
  unique(repositories, "name");
  unique(repositories, "path");
  return { repositories, limits: workspaceLimits(fields) };
}
