import { get } from "node:http";
import type { DoctorObservation } from "../doctor-report.ts";
import { record, type Fields } from "../protocol.ts";
import { stallDescription } from "./thread-pool-render.ts";

interface PoolPart {
  readonly result: "ok" | "warn" | "fail";
  readonly text: string;
}

function checkPart(value: unknown): PoolPart {
  const stall = stallDescription(value);
  if (stall !== undefined) return { result: "fail", text: `stalled; ${stall}` };
  return {
    result: "ok",
    text: record(value)?.["result"] === "ok" ? "ok" : "no check yet",
  };
}

function parsedHealth(text: string): Fields | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function health(port: number): Promise<Fields | undefined> {
  return new Promise((settle) => {
    const request = get(
      { host: "127.0.0.1", port, path: "/health.json", agent: false },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          settle(response.statusCode === 200 ? parsedHealth(text) : undefined);
        });
      },
    );
    request.setTimeout(5000, () => {
      request.destroy();
    });
    request.on("error", () => {
      settle(undefined);
    });
  });
}

async function watchPart(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PoolPart> {
  const port = environment["CLOVING_WATCH_PORT"] ?? "3663";
  if (port === "off") return { result: "ok", text: "off" };
  const number = Number(port);
  const answer =
    /^\d{1,5}$/.test(port) && number >= 1 && number <= 65_535
      ? await health(number)
      : undefined;
  if (answer === undefined)
    return { result: "warn", text: `no answer on port ${port}` };
  return checkPart(answer["threadPool"]);
}

export async function threadPoolObservation(
  status: Fields | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<DoctorObservation> {
  if (status === undefined)
    return { result: "skip", detail: "Service prerequisite unavailable" };
  const daemon = checkPart(status["threadPool"]);
  const watch = await watchPart(environment);
  const results = [daemon.result, watch.result];
  return {
    result:
      (["fail", "warn"] as const).find((level) => results.includes(level)) ??
      "ok",
    detail: `Daemon: ${daemon.text}. Watch page: ${watch.text}`,
  };
}
