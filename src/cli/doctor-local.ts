import { access, constants, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import { parseCommands } from "../command-settings.ts";
import type { DoctorObservation, DoctorWorkflow } from "../doctor-report.ts";
import {
  declaredQueueValues,
  parseQueuesSetting,
  queueIntervalValue,
  queuePollingConfigured,
  type QueueSource,
  type WorkflowQueueSetting,
} from "../queue-settings.ts";
import { queueOffDetail } from "../queue-state.ts";
import { declaresQueue } from "../workflow-declaration.ts";
import { mergeMode, mergeModeRefusal } from "../merge-mode.ts";
import { supportedNode, supportedNodes } from "./toolchain.ts";

export function listedSetting(
  text: string | undefined,
): readonly string[] | undefined {
  try {
    const list: unknown = JSON.parse(text ?? "null");
    if (
      Array.isArray(list) &&
      list.every(
        (item: unknown) => typeof item === "string" && !item.includes("\0"),
      )
    )
      return list.map(String);
  } catch {
    return undefined;
  }
  return undefined;
}

export function nodeObservation(version: string): DoctorObservation {
  return {
    result: supportedNode(version) ? "ok" : "fail",
    detail: `Node ${version}; workflow admission requires Node ${supportedNodes}`,
  };
}

export async function executableProgram(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<string | undefined> {
  return accessibleFile(program, { ...location, mode: constants.X_OK });
}

export async function accessibleFile(
  program: string,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly mode: number;
  },
): Promise<string | undefined> {
  const paths = program.includes("/")
    ? [program]
    : (location.environment["PATH"] ?? "")
        .split(delimiter)
        .map((directory) => resolve(location.directory, directory, program));
  for (const candidate of paths) {
    const path = resolve(location.directory, candidate);
    try {
      await access(path, location.mode);
      if ((await stat(path)).isFile()) return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function commandObservation(
  text: string | undefined,
  location: {
    readonly directory: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<DoctorObservation> {
  const command = listedSetting(text);
  const program = command?.[0];
  if (!program)
    return { result: "fail", detail: "An executable command list is required" };
  const path = await executableProgram(program, location);
  return {
    result: path === undefined ? "fail" : "ok",
    detail: `${JSON.stringify(command)} from ${location.directory}; ${path ?? "program is not executable"}. Availability now does not guarantee an untracked file exists in a later worktree`,
  };
}

export async function demoToolObservation(
  tool: string | undefined,
): Promise<DoctorObservation> {
  if (tool === undefined)
    return {
      result: "skip",
      detail:
        "demo.tool is not set. The record option of the develop demo point needs it.",
    };
  if (!isAbsolute(tool))
    return { result: "fail", detail: "demo.tool must be an absolute path" };
  try {
    await access(tool, constants.R_OK);
    return { result: "ok", detail: `demo.tool ${tool} is readable` };
  } catch {
    return {
      result: "fail",
      detail: `demo.tool ${tool} is missing or unreadable`,
    };
  }
}

const intervalRefusal: DoctorObservation = {
  result: "fail",
  detail: "queue.everySeconds must be a whole number from 10 to 3600",
};

function intervalSeconds(text: string | undefined): number | undefined {
  const seconds = Number(text);
  return text !== undefined &&
    /^\d+$/.test(text) &&
    seconds >= 10 &&
    seconds <= 3600
    ? seconds
    : undefined;
}

function queueSetting(
  environment: Readonly<NodeJS.ProcessEnv>,
  workflowId: string,
): WorkflowQueueSetting | undefined {
  return parseQueuesSetting(environment["CLOVING_QUEUES"])[workflowId];
}

function declaredInterval(
  given: QueueObservationInput,
  declared: DoctorWorkflow,
): DoctorObservation {
  const { environment, sources } = given;
  const seconds = intervalSeconds(environment["CLOVING_QUEUE_SECONDS"]);
  const setting = queueSetting(environment, declared.workflowId);
  if (setting?.state === "off")
    return { result: "ok", detail: queueOffDetail(declared.workflowId) };
  const source: QueueSource =
    sources["queue.everySeconds"] === "private" ||
    sources["queue.everySeconds"] === "project"
      ? "queue setting"
      : "environment";
  const configuration = {
    declared,
    setting,
    general:
      seconds === undefined ? {} : { everySeconds: { value: seconds, source } },
  };
  if (!queuePollingConfigured(configuration)) return intervalRefusal;
  const everySeconds = queueIntervalValue({
    ...configuration,
    declared: declaredQueueValues(declared),
  });
  return {
    result: "ok",
    detail: `${String(everySeconds.value)} seconds from the ${everySeconds.source}`,
  };
}

interface QueueObservationInput {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly sources: Readonly<Record<string, string>>;
  readonly workflows: readonly DoctorWorkflow[];
}

export function queueObservation(
  given: QueueObservationInput,
): DoctorObservation {
  const text = given.environment["CLOVING_QUEUE_SECONDS"];
  const seconds = intervalSeconds(text);
  if (text !== undefined && seconds === undefined) return intervalRefusal;
  const declared = given.workflows.find((workflow) =>
    declaresQueue(workflow.queue),
  );
  if (declared === undefined)
    return seconds === undefined
      ? intervalRefusal
      : { result: "ok", detail: `${String(seconds)} seconds` };
  try {
    return declaredInterval(given, declared);
  } catch {
    return {
      result: "fail",
      detail: "queues must map workflow IDs to queue settings",
    };
  }
}

export function privateTextsObservation(
  text: string | undefined,
): DoctorObservation {
  const valid =
    listedSetting(text)?.some((value) => value.trim().length > 0) === true;
  return {
    result: valid ? "ok" : "fail",
    detail: valid
      ? "Nonblank private texts configured"
      : "privateTexts needs at least one nonblank text",
  };
}

export function mergeModeObservation(
  text: string | undefined,
): DoctorObservation {
  try {
    return { result: "ok", detail: `merge.mode ${mergeMode(text)}` };
  } catch {
    return { result: "fail", detail: mergeModeRefusal };
  }
}

function ghCommandNames(
  text: string | undefined,
): readonly string[] | undefined {
  try {
    return Object.entries(parseCommands(text))
      .filter(([, command]) => basename(command[0] ?? "") === "gh")
      .map(([name]) => name)
      .toSorted();
  } catch {
    return undefined;
  }
}

export function commandLoginObservation(
  text: string | undefined,
): DoctorObservation {
  const names = ghCommandNames(text);
  if (names === undefined)
    return { result: "fail", detail: "invalid-commands: CLOVING_COMMANDS" };
  if (names.length === 0) return { result: "ok", detail: "No command runs gh" };
  return {
    result: "warn",
    detail: `These commands run gh, but a command gets no GitHub login: ${names.join(", ")}`,
  };
}
