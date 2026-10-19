import assert from "node:assert/strict";
import { request } from "node:http";
import type { Watching } from "./watch-fixture.ts";

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
