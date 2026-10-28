import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function templateTurnFiles(directory: string) {
  return {
    "repo/.cloving/workflows/develop.ts": `import { developTurn, type DevelopTurnInput } from "./develop/turn.ts";
export async function develop(input: DevelopTurnInput) {
  "use workflow";
  return await developTurn(input);
}`,
    "repo/.cloving/workflows/develop/turn.ts": await readFile(
      join(directory, "develop/turn.ts"),
      "utf8",
    ),
    "repo/.cloving/workflows/develop/partial.ts": await readFile(
      join(directory, "develop/partial.ts"),
      "utf8",
    ),
    "repo/.cloving/workflows/develop/queue-partial.ts": await readFile(
      join(directory, "develop/queue-partial.ts"),
      "utf8",
    ),
    "repo/.cloving/workflows/develop.test.ts": await readFile(
      join(directory, "develop.test.ts"),
      "utf8",
    ),
  };
}

export function turnDeclaration(input: "ticket" | "prompt") {
  return JSON.stringify({
    workflow: {
      workflowId: "template-turn",
      effectLimit: 1,
      capabilities: ["claude"],
      input: {
        maximumBytes: 65536,
        fields: { [input]: { type: input === "ticket" ? "ticket" : "string" } },
      },
    },
    methods: { claude: ["run-turn"] },
  });
}

export function partialComposition(option: "queue" | "person") {
  const operation = option === "queue" ? "queuePartial" : "reviewPartial";
  const input = option === "queue" ? "QueuePartialInput" : "PartialWorkInput";
  const helper = option === "queue" ? "queue-partial" : "partial";
  return {
    "repo/.cloving/workflows/develop.ts": `import { ${operation}, type ${input} } from "./develop/${helper}.ts";
export async function develop(input: ${input}) {
  "use workflow";
  return await ${operation}(input);
}`,
    "repo/.cloving/workflows/develop.declaration.json": JSON.stringify({
      workflow: {
        workflowId: "template-partial",
        effectLimit: 1,
        capabilities: option === "queue" ? ["github"] : ["claude"],
        input: { maximumBytes: 65536, fields: {} },
      },
      methods:
        option === "queue"
          ? { github: ["partial-issue"] }
          : { claude: ["run-turn"] },
    }),
  };
}
