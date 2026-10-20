import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

function fields(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object");
  return { ...value };
}

function protocol(input: Writable, output: Readable) {
  let sequence = 0;
  let buffered = "";
  const pending = new Map<number, (reply: Record<string, unknown>) => void>();
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    let boundary = buffered.indexOf("\0");
    while (boundary >= 0) {
      const reply = fields(JSON.parse(buffered.slice(0, boundary)));
      buffered = buffered.slice(boundary + 1);
      if (typeof reply["id"] === "number") pending.get(reply["id"])?.(reply);
      boundary = buffered.indexOf("\0");
    }
  });
  return async (method: string, options: Record<string, unknown> = {}) => {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Chrome timed out: ${method}`));
          }, 15000);
          pending.set(id, resolve);
          input.write(JSON.stringify({ id, method, ...options }) + "\0");
        },
      );
      assert.equal(reply["error"], undefined, JSON.stringify(reply));
      return fields(reply["result"]);
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
}

export function browserExecutable(
  platform: string,
  override: string | undefined,
): string {
  return (
    override ??
    (platform === "linux"
      ? "/usr/bin/google-chrome"
      : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  );
}

export async function realBrowser() {
  const directory = await mkdtemp(join(tmpdir(), "cloving-watch-chrome-"));
  const executable = browserExecutable(
    process.platform,
    process.env["CLOVING_TEST_BROWSER"],
  );
  const child = spawn(
    executable,
    [
      "--headless",
      "--remote-debugging-pipe",
      `--user-data-dir=${directory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
    ],
    {
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  await once(child, "spawn").catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  assert.ok(input instanceof Writable && output instanceof Readable);
  const command = protocol(input, output);
  return {
    command,
    async [Symbol.asyncDispose]() {
      child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    },
    page: (viewport: { readonly width: number; readonly height: number }) =>
      browserPage(command, viewport),
  };
}

async function browserPage(
  command: ReturnType<typeof protocol>,
  viewport: { readonly width: number; readonly height: number },
) {
  const created = await command("Target.createTarget", {
    params: { url: "about:blank" },
  });
  const attached = await command("Target.attachToTarget", {
    params: { targetId: created["targetId"], flatten: true },
  });
  const sessionId = attached["sessionId"];
  await command("Emulation.setDeviceMetricsOverride", {
    sessionId,
    params: {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    },
  });
  const evaluate = async (expression: string) => {
    const reply = await command("Runtime.evaluate", {
      sessionId,
      params: { expression, awaitPromise: true, returnByValue: true },
    });
    assert.equal(reply["exceptionDetails"], undefined, JSON.stringify(reply));
    return fields(fields(reply["result"])["value"]);
  };
  return {
    async navigate(url: string) {
      const result = await command("Page.navigate", {
        sessionId,
        params: { url },
      });
      assert.equal(result["errorText"], undefined, JSON.stringify(result));
    },
    evaluate: (expression: string) => evaluate(expression),
    async scroll(expression: string) {
      const gesture = await evaluate(expression);
      await command("Input.synthesizeScrollGesture", {
        sessionId,
        params: { ...gesture, speed: 10000, gestureSourceType: "mouse" },
      });
      await evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({}))))",
      );
    },
  };
}
