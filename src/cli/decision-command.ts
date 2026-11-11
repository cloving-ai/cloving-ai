import { part } from "./run-command-render.ts";
import { show } from "./terminal-text.ts";

function binding(decision: unknown): string {
  return `--expected-revision ${show(part(decision, "revision"))} --generation ${show(part(decision, "generation"))} --subject-digest ${show(part(decision, "subjectDigest"))}`;
}

export function decisionCommand(
  decision: unknown,
  command: { readonly name: unknown; readonly client: string },
): string {
  const { name, client } = command;
  const reference = part(decision, "label") ?? part(decision, "decisionId");
  const head = `  ${client} ${show(name)} ${show(reference)}`;
  const tail = binding(decision);
  if (name === "answer") return `${head} --text <answer> ${tail}`;
  if (name === "deny") return `${head} --text "<feedback>" ${tail}`;
  return `${head} ${tail}`;
}
