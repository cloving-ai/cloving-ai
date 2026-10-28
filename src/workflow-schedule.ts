import { record, type Fields } from "./protocol.ts";
import { checkSubmission, type SubmissionContract } from "./submission.ts";

export interface WorkflowSchedule {
  readonly everySeconds: number;
  readonly input: Fields;
}

export type ScheduleCheck =
  | { readonly kind: "valid"; readonly schedule: WorkflowSchedule }
  | { readonly kind: "rejected"; readonly code: string };

interface ScheduleSource {
  readonly workflowId: string;
  readonly input: SubmissionContract;
  readonly schedule?: WorkflowSchedule;
}

export function parseSchedulesSetting(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    throw new Error("invalid-schedules");
  }
}

export function configuredSchedules(
  declarations: readonly ScheduleSource[],
  overrides: unknown,
): Readonly<Record<string, WorkflowSchedule>> {
  const settings = record(overrides);
  if (settings === undefined) throw new Error("invalid-schedules");
  if (
    Object.keys(settings).some(
      (id) => !declarations.some((entry) => entry.workflowId === id),
    )
  )
    throw new Error("unknown-schedule-workflow");
  const schedules: [string, WorkflowSchedule][] = [];
  for (const declaration of declarations) {
    const { workflowId } = declaration;
    const selected = Object.hasOwn(settings, workflowId)
      ? settings[workflowId]
      : declaration.schedule;
    if (selected === undefined && !Object.hasOwn(settings, workflowId))
      continue;
    const checked = checkWorkflowSchedule(declaration.input, selected);
    if (checked.kind === "rejected") throw new Error(checked.code);
    schedules.push([workflowId, checked.schedule]);
  }
  return Object.fromEntries(schedules);
}

export function checkWorkflowSchedule(
  contract: SubmissionContract,
  value: unknown,
): ScheduleCheck {
  const fields = record(value);
  const seconds = fields?.["everySeconds"];
  if (
    fields === undefined ||
    Object.keys(fields).some(
      (key) => !["everySeconds", "input"].includes(key),
    ) ||
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 60 ||
    seconds > 86400
  )
    return { kind: "rejected", code: "invalid-schedule-interval" };
  const checked = checkSubmission(contract, {
    workflowId: "schedule",
    source: "declared",
    submission: fields["input"],
  });
  if (checked.kind === "rejected")
    return { kind: "rejected", code: "invalid-schedule-input" };
  return {
    kind: "valid",
    schedule: { everySeconds: seconds, input: checked.submission },
  };
}
