export const feedDeclaration = {
  workflow: {
    workflowId: "triage",
    effectLimit: 1,
    capabilities: ["claude", "github", "command"],
    commands: ["list"],
    input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
    queue: { feed: "triageFeed", feedEffectLimit: 1 },
  },
  methods: {
    claude: ["run-turn"],
    github: ["issues", "create-issue"],
    command: ["run:list"],
  },
};

export const feedEffect = (method: string) => `await protectedEffect({
  scope: { phase: "feed", operation: "read", round: 1 },
  capability: "github", method: "${method}", target: "issues", payload: "{}", units: 1
})`;

export function feedSource(body: string): string {
  return `import { protectedEffect, runCommand, handoff } from "cloving/workflows";
export async function triage() {
  "use workflow";
  return await protectedEffect({
    scope: { phase: "work", operation: "turn", round: 1 },
    capability: "claude", method: "run-turn", target: "ticket", payload: "{}", units: 1
  });
}
export async function triageFeed() {
  "use workflow";
  ${body}
}`;
}
