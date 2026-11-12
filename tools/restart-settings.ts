import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import {
  absoluteWorkflowFolder,
  settingVariables,
  type SettingSource,
} from "../src/project-settings.ts";
import { turnHarness } from "../src/harness-defaults.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { workflowLimits } from "../src/workflow-limits.ts";
import {
  restartedEnvironment,
  type RestartMark,
  type ValidateRestart,
} from "../src/restart-request.ts";
import { projectConfiguration, topLevel } from "./project-configuration.ts";
import {
  queueLimits,
  queuePlan,
  queueSpendLimit,
  readyTicketCommand,
} from "./self-host-queue.ts";
import { workflowPackageRoot } from "./workflow-bundle-dependencies.ts";
import { loadWorkflowFolders } from "./workflow-folders.ts";
import { selfUpdateMilliseconds } from "./self-update-host.ts";

async function checkedQueueSettings(given: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly sources: Readonly<Record<string, SettingSource>>;
}): Promise<void> {
  const { repository, environment, sources } = given;
  const folders = await loadWorkflowFolders(
    {
      repository,
      home: homedir(),
      xdgConfigHome: environment["XDG_CONFIG_HOME"],
      userFolder: absoluteWorkflowFolder(
        environment["CLOVING_WORKFLOW_FOLDER"],
      ),
      limits: workflowLimits(environment),
    },
    {
      packageRoot: await workflowPackageRoot(
        resolve(import.meta.dirname, ".."),
      ),
    },
  );
  const plan = queuePlan(environment, {
    declarations: folders.workflows.flatMap(({ admitted, declaration }) =>
      admitted && isCandidateDeclaration(declaration)
        ? [declaration.workflow]
        : [],
    ),
    sources,
  });
  queueLimits(environment, plan);
  queueSpendLimit(environment, plan);
  readyTicketCommand(environment, plan);
}

function changedSettingKey(mark: RestartMark, detail: string): string {
  const variables = mark.variables ?? {};
  const related = {
    "harness.name": "harness-no-worker",
    "queue.workingLanes": "invalid-queue-working-lanes",
    "tickets.nextCommand": "queue-needs-next-command",
    "tickets.command": "queue-needs-ticket-command",
    "selfUpdate.everySeconds": "self-update-needs-own-repository",
  };
  const key = Object.entries(related).find(
    ([key, code]) =>
      detail.includes(code) &&
      Object.hasOwn(variables, settingVariables[key] ?? ""),
  )?.[0];
  if (key !== undefined) return key;
  return (
    Object.entries(settingVariables).find(
      ([key, variable]) =>
        (key.startsWith("queue.") ||
          key === "queues" ||
          key === "spend.scope" ||
          key === "tickets.readyCommand" ||
          key === "workflows.folder") &&
        Object.hasOwn(variables, variable),
    )?.[0] ?? "queue"
  );
}

export function restartSettings(start: {
  readonly repository: string;
  readonly fileVariables: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): ValidateRestart {
  const names = new Set(start.fileVariables);
  const environment = Object.fromEntries(
    Object.entries(start.environment).filter(([name]) => !names.has(name)),
  );
  return async (mark) => {
    try {
      const next = restartedEnvironment(environment, {
        settings: mark.settings ?? "environment",
        variables: JSON.stringify(mark.variables ?? {}),
      });
      const configuration = await projectConfiguration(start.repository, next);
      turnHarness({
        worker: configuration.environment["CLOVING_WORKER"] ?? "claude",
        ...(configuration.harness === undefined
          ? {}
          : { harness: configuration.harness }),
      });
      const product = resolve(import.meta.dirname, "..");
      await selfUpdateMilliseconds({
        seconds: configuration.environment["CLOVING_SELF_UPDATE_SECONDS"],
        repository: start.repository,
        product:
          extname(import.meta.filename) === ".ts" ? topLevel(product) : product,
      });
      await checkedQueueSettings({
        repository: start.repository,
        environment: configuration.environment,
        sources: configuration.sources,
      });
      return undefined;
    } catch (error) {
      const detail = String(Reflect.get(Object(error), "message"));
      return {
        key: changedSettingKey(mark, detail),
        detail,
      };
    }
  };
}
