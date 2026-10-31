import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CardForm } from "../src/cli/watch-run-input.ts";
import { withWatchService } from "./watch-service-fixture.ts";
import type { Watching, WatchOptions } from "./watch-fixture.ts";

export const cardRequest = {
  workflowId: "develop-prd",
  fields: { prompt: "A useful idea" },
  commandId: "card-1",
};

export async function pageToken(watch: Watching): Promise<string> {
  const page = await (await fetch(watch.address)).text();
  const token = /const actionToken = "([a-f0-9]{64})";/.exec(page)?.[1];
  assert.ok(token, "The served page contains a random action token");
  return token;
}

export function postCard(
  watch: Watching,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<{
  readonly status: number | undefined;
  readonly body: string;
  readonly headers: unknown;
}> {
  return new Promise((resolve, reject) => {
    const sent = request(
      new URL("actions/run", watch.address),
      {
        method: "POST",
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body,
            headers: response.headers,
          });
        });
      },
    );
    sent.on("error", reject);
    sent.end(options.body ?? JSON.stringify(cardRequest));
  });
}

export function actionHeaders(
  watch: Watching,
  token: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: new URL(watch.address).origin,
    host: new URL(watch.address).host,
    "x-cloving-token": token,
  };
}

export async function declaredWatch(
  runtimeDirectory: string,
  workflowId = "review-corpus",
): Promise<WatchOptions> {
  const project = join(dirname(runtimeDirectory), "project");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "declarations.json"),
    JSON.stringify([
      {
        workflowId,
        functionName: "reviewCorpus",
        capabilities: ["claude"],
        effectLimit: 1,
        input: { maximumBytes: 4096, fields: { importId: { type: "string" } } },
      },
    ]),
  );
  return {};
}

export function exampleCardForms(): readonly CardForm[] {
  return [
    {
      workflowId: "develop-issue",
      source: "input",
      fields: [
        {
          name: "ticket",
          label: "Ticket ID",
          multiline: false,
          optional: false,
        },
      ],
    },
    {
      workflowId: "develop-prd",
      source: "input",
      fields: [
        { name: "prompt", label: "prompt", multiline: true, optional: false },
      ],
    },
  ];
}

export async function cardWatch(runtimeDirectory: string): Promise<void> {
  const project = join(dirname(runtimeDirectory), "project");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "declarations.json"),
    JSON.stringify([
      {
        workflowId: cardRequest.workflowId,
        functionName: "draftProposal",
        capabilities: ["claude"],
        effectLimit: 1,
        input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } },
      },
    ]),
  );
}

export function withCardService(
  configuration: Parameters<typeof withWatchService>[0],
  body: Parameters<typeof withWatchService>[1],
): Promise<void> {
  const settings =
    typeof configuration === "function"
      ? { answer: configuration, configure: undefined }
      : configuration;
  return withWatchService(
    {
      ...settings,
      configure: async (runtimeDirectory) => {
        await cardWatch(runtimeDirectory);
        return (await settings.configure?.(runtimeDirectory)) ?? {};
      },
    },
    body,
  );
}
