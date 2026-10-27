import { resumeHook } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { setTimeout as delay } from "node:timers/promises";
import { decisionToken } from "../decision-wait.ts";
import { namesRunIntent } from "../authority/operations.ts";

interface RunIntent {
  readonly runId: string;
  readonly gateId?: string;
  readonly decision?: string;
  readonly answer?: string | null;
}

interface ResumeParts {
  readonly runs: () => Promise<
    readonly { readonly operationId: string | null; readonly receipt: string }[]
  >;
  readonly document: (digest: string) => Promise<string | undefined>;
}

interface ResumeSubject {
  readonly runId: string;
  readonly token: string;
  readonly hookId: string | undefined;
  readonly received: boolean;
}

async function runSubject(
  receipt: string,
  token: string,
): Promise<ResumeSubject> {
  const world = await getWorld();
  let page = await world.events.list({
    runId: receipt,
    resolveData: "none",
    pagination: { limit: 1000, sortOrder: "asc" },
  });
  const events = [...page.data];
  while (page.hasMore && page.cursor !== null) {
    page = await world.events.list({
      runId: receipt,
      resolveData: "none",
      pagination: { limit: 1000, sortOrder: "asc", cursor: page.cursor },
    });
    events.push(...page.data);
  }
  const created = events.find(
    (event) =>
      event.eventType === "hook_created" && event.eventData.token === token,
  );
  const hookId = created?.correlationId;
  return {
    runId: receipt,
    token,
    hookId,
    received:
      hookId !== undefined &&
      events.some(
        (event) =>
          event.eventType === "hook_received" && event.correlationId === hookId,
      ),
  };
}

async function subject(
  parts: ResumeParts,
  intent: RunIntent,
): Promise<ResumeSubject> {
  if (intent.gateId === undefined) throw new Error("missing-decision-gate");
  const token = decisionToken(intent.runId, intent.gateId);
  const runs = (await parts.runs()).filter((run) =>
    namesRunIntent(run.operationId ?? "", intent.runId),
  );
  const latest = runs.at(-1);
  if (latest === undefined) throw new Error("missing-decision-run");
  const matches: ResumeSubject[] = [];
  for (const run of runs) {
    const found = await runSubject(run.receipt, token);
    if (found.hookId !== undefined) matches.push(found);
  }
  if (matches.length > 1) throw new Error("conflicting-decision-hooks");
  return (
    matches[0] ?? {
      runId: latest.receipt,
      token,
      hookId: undefined,
      received: false,
    }
  );
}

export async function reconciledDecision(
  parts: ResumeParts,
  intent: RunIntent,
): Promise<
  | { readonly kind: "accepted"; readonly receipt: string }
  | { readonly kind: "absent" }
> {
  const found = await subject(parts, intent);
  return found.received
    ? { kind: "accepted", receipt: found.runId }
    : { kind: "absent" };
}

export async function deliveredDecision(
  parts: ResumeParts,
  request: {
    readonly intent: RunIntent;
    readonly signal: AbortSignal | undefined;
  },
): Promise<{ readonly receipt: string }> {
  const { intent, signal } = request;
  let found = await subject(parts, intent);
  while (!found.received && found.hookId === undefined) {
    await delay(20, undefined, signal === undefined ? {} : { signal });
    found = await subject(parts, intent);
  }
  if (found.received) return { receipt: found.runId };
  if (intent.decision === undefined) throw new Error("missing-decision");
  const answer =
    intent.answer === undefined || intent.answer === null
      ? null
      : await parts.document(intent.answer);
  if (answer === undefined) throw new Error("missing-decision-answer");
  await resumeHook(found.token, { decision: intent.decision, answer });
  return { receipt: found.runId };
}

export async function stoppedDecision(
  parts: ResumeParts & {
    readonly cancel: (receipt: string) => Promise<string>;
  },
  intent: RunIntent,
): Promise<
  | { readonly kind: "stopped"; readonly receipt: string }
  | { readonly kind: "unknown"; readonly evidence: string }
> {
  const found = await subject(parts, intent);
  const status = await parts.cancel(found.runId);
  return ["cancelled", "completed", "failed"].includes(status)
    ? { kind: "stopped", receipt: found.runId }
    : { kind: "unknown", evidence: `world-run:${found.runId} ${status}` };
}
