import {
  operationalDecision,
  privateWorkflow,
} from "../decision-visibility.ts";
import { record } from "../protocol.ts";
import type { DecisionReply, WatchDecision } from "./watch-render.ts";

const pageReplies: readonly DecisionReply[] = ["approve", "deny", "answer"];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function whole(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function repliesOf(allowed: unknown): readonly DecisionReply[] {
  if (!Array.isArray(allowed)) return [];
  const given: readonly unknown[] = allowed;
  return pageReplies.filter((reply) => given.includes(reply));
}

export function decisionCommands(
  decision: unknown,
  client: string,
): WatchDecision {
  const fields = record(decision) ?? {};
  const decisionId = text(fields["decisionId"]);
  const binding = `--expected-revision ${String(fields["revision"])} --generation ${String(fields["generation"])} --subject-digest ${text(fields["subjectDigest"])}`;
  const openedAt = fields["openedAt"];
  return {
    decisionId,
    type: text(fields["type"]),
    prompt: text(fields["prompt"]),
    openedAt: typeof openedAt === "string" ? openedAt : null,
    reference: decisionId,
    expectedRevision: whole(fields["revision"]),
    generation: whole(fields["generation"]),
    subjectDigest: text(fields["subjectDigest"]),
    replies: repliesOf(fields["allowed"]),
    approve: `${client} approve ${decisionId} ${binding}`,
    deny: `${client} deny ${decisionId} --text "<feedback>" ${binding}`,
    answer: `${client} answer ${decisionId} --text "<answer>" ${binding}`,
  };
}

export function runDecision(
  decision: unknown,
  view: { readonly workflowId: string; readonly client: string },
): WatchDecision {
  const { workflowId, client } = view;
  const shown = decisionCommands(
    operationalDecision(record(decision) ?? {}, workflowId),
    client,
  );
  return privateWorkflow(workflowId) ? { ...shown, private: true } : shown;
}
