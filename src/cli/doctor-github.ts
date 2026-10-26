import { shellArgument } from "./runtime-directory.ts";
import type { DoctorCode, DoctorObservation } from "../doctor-report.ts";
import { record } from "../protocol.ts";
import { listedSetting } from "./doctor-local.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { prRepository, type PrRepository } from "./watch-pr-identity.ts";

interface GithubContext {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly command: readonly string[];
  readonly probe: ProbeRunner;
}

async function read(
  context: GithubContext,
  argumentsList: readonly string[],
): Promise<string> {
  const output = await context.probe(context.command[0] ?? "", {
    arguments: [...context.command.slice(1), ...argumentsList],
    env: context.environment,
    directory: context.repository,
    bytes: 8 * 1024 * 1024,
  });
  if (output.reason !== null)
    throw new Error(
      output.reason === "probe-timeout"
        ? "GitHub read timed out after 10 seconds"
        : "GitHub command failed: " + output.reason,
    );
  return output.stdout;
}

async function origin(context: GithubContext): Promise<{
  readonly observation: DoctorObservation;
  readonly identity: PrRepository | null;
}> {
  const output = await context.probe("git", {
    arguments: ["remote", "get-url", "origin"],
    env: context.environment,
    directory: context.repository,
  });
  const identity =
    output.reason === null ? prRepository(output.stdout.trim()) : null;
  const valid = identity?.host === "github.com";
  return {
    observation: {
      result: valid ? "ok" : "fail",
      detail: valid
        ? `GitHub origin ${identity.owner}/${identity.repository}`
        : "origin is absent or is not on GitHub",
    },
    identity: valid ? identity : null,
  };
}

function list(text: string): readonly unknown[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("Invalid GitHub response");
  return Array.from<unknown>(value).flatMap((item) =>
    Array.isArray(item) ? Array.from<unknown>(item) : [item],
  );
}

async function botActivity(
  context: GithubContext,
  pull: { readonly identity: PrRepository; readonly number: number },
): Promise<boolean> {
  const { identity, number } = pull;
  for (const endpoint of [
    `pulls/${String(number)}/reviews`,
    `issues/${String(number)}/comments`,
    `pulls/${String(number)}/comments`,
  ]) {
    const entries = list(
      await read(context, [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        `repos/${identity.owner}/${identity.repository}/${endpoint}?per_page=100`,
      ]),
    );
    if (
      entries.some(
        (entry) =>
          record(record(entry)?.["user"])?.["login"] === "greptile-apps[bot]",
      )
    )
      return true;
  }
  return false;
}

async function greptile(
  context: GithubContext,
  identity: PrRepository,
): Promise<DoctorObservation> {
  const pulls = list(
    await read(context, [
      "pr",
      "list",
      "--repo",
      `${identity.owner}/${identity.repository}`,
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "number",
    ]),
  );
  if (pulls.length === 0)
    return { result: "skip", detail: "No pull requests in this repository" };
  for (const pull of pulls.slice(0, 20)) {
    const number = record(pull)?.["number"];
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      throw new Error("Invalid GitHub pull request");
    if (await botActivity(context, { identity, number }))
      return {
        result: "ok",
        detail:
          "Recent activity of greptile-apps[bot]; this does not establish a usable review",
      };
  }
  return {
    result: "fail",
    detail:
      "No Greptile review or comment found on the last 20 pull requests. This does not prove Greptile is not installed",
  };
}

export async function githubObservations(
  repository: string,
  options: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly probe: ProbeRunner;
  },
): Promise<{
  readonly observations: Partial<Record<DoctorCode, DoctorObservation>>;
  readonly loginFix: string;
}> {
  const { environment, probe } = options;
  const command =
    environment["CLOVING_GH_COMMAND"] === undefined
      ? ["gh"]
      : (listedSetting(environment["CLOVING_GH_COMMAND"]) ?? []);
  const context = { repository, environment, command, probe };
  const found = await origin(context);
  const observations: Partial<Record<DoctorCode, DoctorObservation>> = {
    "github-origin": found.observation,
    "greptile-review": {
      result: "skip",
      detail: "GitHub login or origin prerequisite unavailable",
    },
  };
  const loginFix = `Log in with the configured command: ${command.map(shellArgument).join(" ")} auth login`;
  try {
    await read(context, ["auth", "status", "--hostname", "github.com"]);
    observations["gh-login"] = {
      result: "ok",
      detail: "Configured GitHub command is authenticated",
    };
  } catch (error) {
    observations["gh-login"] = {
      result: "fail",
      detail:
        error instanceof Error ? error.message : "GitHub login unavailable",
    };
    return { observations, loginFix };
  }
  if (found.identity !== null) {
    try {
      observations["greptile-review"] = await greptile(context, found.identity);
    } catch (error) {
      observations["greptile-review"] = {
        result: "fail",
        detail: error instanceof Error ? error.message : "GitHub read failed",
      };
    }
  }
  return { observations, loginFix };
}
