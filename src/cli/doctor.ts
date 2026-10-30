import { shellArgument } from "./runtime-directory.ts";
import { dirname, delimiter, join } from "node:path";
import {
  doctorCodes,
  doctorExitCode,
  doctorFixes,
  requiredDoctorCodes,
  type DoctorCheck,
  type DoctorCode,
  type DoctorObservation,
} from "../doctor-report.ts";
import { privateSettingsPath, projectSettings } from "./project-settings.ts";
import { githubObservations } from "./doctor-github.ts";
import {
  bundledDoctorWorkflows,
  doctorWorkflows,
  workflowObservation,
} from "./doctor-workflows.ts";
import { runtimeObservation, serviceObservation } from "./doctor-runtime.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { harnessObservations } from "./doctor-harness.ts";
import {
  commandObservation,
  nodeObservation,
  privateTextsObservation,
  queueObservation,
} from "./doctor-local.ts";

interface DoctorOptions {
  readonly repository: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
}
type Observations = Partial<
  Record<DoctorCode, DoctorObservation & { readonly fix?: string }>
>;

function settings(
  repository: string,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  try {
    const resolved = projectSettings(environment, repository);
    return {
      environment: resolved.environment,
      harness: resolved.harness,
      observation: {
        result: "ok",
        detail: "Settings files are valid",
      } as const,
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Invalid settings files";
    const files = [
      join(repository, ".cloving/config.json"),
      privateSettingsPath(environment, repository),
    ];
    return {
      environment,
      observation: {
        result: "fail",
        detail,
        fix: `Edit the invalid settings: \${EDITOR:-vi} ${files.map(shellArgument).join(" ")}`,
      } as const,
    };
  }
}

export async function doctorReport(
  options: DoctorOptions,
): Promise<{ readonly version: 1; readonly checks: readonly DoctorCheck[] }> {
  const repository = options.repository;
  const found =
    repository === undefined
      ? {
          observations: {},
          required: requiredDoctorCodes([]),
        }
      : await repositoryObservations({ ...options, repository });
  const git =
    repository === undefined
      ? { result: "fail" as const, detail: "No git repository" }
      : await gitObservation({ ...options, repository });
  const observations: Observations = {
    ...found.observations,
    "node-version": nodeObservation(process.version),
    "git-repository": git,
  };
  const checks = doctorCodes.map((code): DoctorCheck => ({
    code,
    required: found.required.includes(code),
    fix: doctorFixes[code],
    ...(observations[code] ?? {
      result: "skip",
      detail: "Repository prerequisite unavailable",
    }),
  }));
  return { version: 1, checks };
}

async function repositoryObservations(
  options: DoctorOptions & { readonly repository: string },
) {
  const { repository, probe } = options;
  const configured = settings(repository, options.environment);
  const { environment } = configured;
  const observations: Observations = {
    "settings-files": configured.observation,
  };
  const settingsValid = configured.observation.result === "ok";
  const location = await runtimeObservation(repository, { environment, probe });
  observations["runtime-directory"] = location.observation;
  observations["service"] = await serviceObservation(location, {
    environment,
    probe,
  });
  const project = location.project;
  const serviceEnvironment = {
    ...environment,
    PATH: [dirname(process.execPath), environment["PATH"]].join(delimiter),
  };
  const harnesses = await harnessObservations(environment, {
    directory: repository,
    settingsValid,
    probe,
    commandEnvironment: serviceEnvironment,
    harness: "harness" in configured ? configured.harness : undefined,
  });
  observations["harnesses"] = harnesses.harnesses;
  observations["default-harness"] = harnesses.selected;
  const workflowContext = await workflowRequirements(repository, {
    settingsValid,
    environment,
  });
  observations["no-workflow"] = workflowObservation(workflowContext);
  const required = requiredDoctorCodes(workflowContext.workflows);
  const dependent = await configuredObservations(
    { ...options, environment },
    { prerequisite: workflowContext.prerequisite, project, serviceEnvironment },
  );
  return { observations: { ...observations, ...dependent }, required };
}

async function workflowRequirements(
  repository: string,
  context: {
    readonly settingsValid: boolean;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
) {
  if (!context.settingsValid)
    return {
      workflows: bundledDoctorWorkflows,
      prerequisite: "Settings files are invalid",
    };
  try {
    return {
      workflows: await doctorWorkflows(repository, context.environment),
      prerequisite: undefined,
    };
  } catch (error) {
    return {
      workflows: bundledDoctorWorkflows,
      prerequisite: `Workflow requirements unavailable: ${error instanceof Error ? error.message : "discovery failed"}`,
    };
  }
}

async function configuredObservations(
  options: DoctorOptions & { readonly repository: string },
  location: {
    readonly prerequisite: string | undefined;
    readonly project: string | undefined;
    readonly serviceEnvironment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<Observations> {
  const { environment, repository, probe } = options;
  const observations: Observations = {};
  if (location.prerequisite !== undefined) {
    for (const code of [
      "gh-login",
      "github-origin",
      "greptile-review",
      "ticket-command",
      "next-command",
      "check-command",
      "queue-interval",
      "private-texts",
    ] as const)
      observations[code] = {
        result: "skip",
        detail: location.prerequisite,
      };
    return observations;
  }
  for (const [code, variable, directory] of [
    ["ticket-command", "CLOVING_TICKET_COMMAND", location.project],
    ["next-command", "CLOVING_NEXT_COMMAND", location.project],
    ["check-command", "CLOVING_CHECK_COMMAND", repository],
  ] as const)
    observations[code] =
      directory === undefined
        ? { result: "skip", detail: "Runtime project prerequisite unavailable" }
        : await commandObservation(environment[variable], {
            directory,
            environment: location.serviceEnvironment,
          });
  const github = await githubObservations(repository, { environment, probe });
  Object.assign(observations, github.observations);
  const login = observations["gh-login"];
  if (login !== undefined)
    observations["gh-login"] = { ...login, fix: github.loginFix };
  observations["queue-interval"] = queueObservation(
    environment["CLOVING_QUEUE_SECONDS"],
  );
  observations["private-texts"] = privateTextsObservation(
    environment["CLOVING_PRIVATE_TEXTS"],
  );
  return observations;
}

async function gitObservation(
  options: DoctorOptions & { readonly repository: string },
): Promise<DoctorObservation> {
  const given = { env: options.environment, directory: options.repository };
  const branch = await options.probe("git", {
    ...given,
    arguments: ["symbolic-ref", "--short", "HEAD"],
  });
  const detached =
    branch.reason === null
      ? branch
      : await options.probe("git", {
          ...given,
          arguments: ["rev-parse", "--short", "HEAD"],
        });
  return {
    result: detached.reason === null ? "ok" : "fail",
    detail: `git repository ${options.repository}, branch ${detached.stdout.trim() || "unavailable"}`,
  };
}

export async function doctorCommand(
  options: DoctorOptions & { readonly json: boolean },
): Promise<number> {
  const report = await doctorReport(options);
  process.stdout.write(
    options.json
      ? JSON.stringify(report) + "\n"
      : report.checks
          .map(
            (check) =>
              `${check.result.padEnd(6)}${check.code}  ${check.detail}${check.result === "ok" ? "" : ". " + check.fix}${check.required ? " (required)" : ""}\n`,
          )
          .join(""),
  );
  return doctorExitCode(report.checks);
}
