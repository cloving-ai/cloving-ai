import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";

export const feedWorkflow = `${queueWorkflow}
export async function readFeed(input) {
  "use step";
  const { appendFileSync } = await import("node:fs");
  appendFileSync("feed-calls", JSON.stringify([input]) + "\\n");
  return JSON.parse(readFileSync("feed-result", "utf8"));
}
export async function triageFeed() {
  "use workflow";
  return await readFeed();
}
`;

export const feedPrelude = `${queuePrelude}
const feedDefinition = Object.values(compiled.workflows).flatMap(Object.values).find(row => row.workflowId.endsWith("//triageFeed"));
writeFileSync("feed.workflow.json", JSON.stringify({
  schemaVersion: 1, name: "triageFeed", workflowId: feedDefinition.workflowId,
  steps: [], capabilities: ["claude", "github"], resources: [], artifacts: "artifacts"
}));
settings.manifests.triageFeed = directory + "/feed.workflow.json";
settings.workflows.triageFeed = workflows.triageFeed;
settings.declarations = [{ ...projectWorkflow, functionName: "develop", queue: { lanes: 2, feed: "triageFeed", feedEffectLimit: 1 } }];
delete settings.ticketCommand;
delete settings.nextCommand;
`;
