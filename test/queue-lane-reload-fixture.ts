import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import type { Scene } from "./self-host-fixture.ts";

const preload = `
import childProcess from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
const root = process.env.CLOVING_LANE_PROBE;
const trace = value => appendFileSync(root + "/reload-trace.jsonl", JSON.stringify({ at:Date.now(), pid:process.pid, ...value }) + "\\n");
globalThis.clovingLaneProbe = trace;
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!/service\\/dispatcher\\.(?:js|ts)$/.test(url)) return loaded;
  const original = "queueSetting(context, request.parameters)";
  const replacement = '(globalThis.clovingLaneProbe({event:"command-lock-enter", commandId:request.parameters.commandId}), ' + original + ').then(reply => (globalThis.clovingLaneProbe({event:"command-lock-exit", commandId:request.parameters.commandId, kind:reply.kind}), reply))';
  return {...loaded, source:String(loaded.source).replace(original, replacement)};
}});
const spawn = childProcess.spawn;
const execFile = childProcess.execFile;
const promised = execFile[promisify.custom];
function executed(...parameters) { return execFile(...parameters); }
executed[promisify.custom] = async (...parameters) => {
  if (!existsSync(root + "/arm-reload")) return promised(...parameters);
  trace({event:"reload-enter", arguments:parameters[1]});
  try {
    const output = await promised(...parameters);
    trace({event:"reload-exit", code:0, stdout:output.stdout, stderr:output.stderr});
    return output;
  } catch (error) {
    trace({event:"reload-exit", code:error.code, signal:error.signal, stdout:error.stdout, stderr:error.stderr});
    throw error;
  }
};
childProcess.execFile = executed;
childProcess.spawn = (...parameters) => {
  const child = spawn(...parameters);
  if (existsSync(root + "/arm-reload")) {
    trace({ event:"spawn", child:child.pid, arguments:parameters[1] });
    child.once("exit", (code, signal) => trace({event:"exit", child:child.pid, code, signal}));
  }
  return child;
};
syncBuiltinESMExports();
if (process.argv[1]?.includes("compile-workflows") && existsSync(root + "/arm-reload")) {
  trace({event:"compiler-waiting"});
  while (!existsSync(root + "/release-reload")) await delay(10);
  trace({event:"compiler-released"});
}
`;

export async function laneReloadProbe(fixture: Scene) {
  const file = join(fixture.root, "reload-probe.mjs");
  await writeFile(file, preload);
  return {
    environment: {
      CLOVING_LANE_PROBE: fixture.root,
      NODE_OPTIONS: ["calm-host.mjs", "reload-probe.mjs"]
        .map(
          (name) => `--import=${pathToFileURL(join(fixture.root, name)).href}`,
        )
        .join(" "),
    },
    started: (child: ChildProcess) => {
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
      return () => output;
    },
    arm: () => writeFile(join(fixture.root, "arm-reload"), ""),
    release: () => writeFile(join(fixture.root, "release-reload"), ""),
  };
}

export async function withLaneReloadProbe(
  fixture: Scene,
  check: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly body: () => Promise<void>;
  },
) {
  const probe = await laneReloadProbe(fixture);
  const output = probe.started(
    await fixture.start({ ...check.environment, ...probe.environment }),
  );
  try {
    await check.body();
  } catch (error) {
    throw new Error(
      JSON.stringify({
        output: output(),
        saved: await laneReloadDiagnostics(fixture),
      }),
      { cause: error },
    );
  } finally {
    await probe.release();
  }
}

export async function laneReloadDiagnostics(
  fixture: Scene,
): Promise<Readonly<Record<string, string>>> {
  const files = {
    private: privateSettingsPath(
      { XDG_CONFIG_HOME: join(fixture.root, "config") },
      fixture.repository,
    ),
    journal: join(fixture.directory, "queue-settings/queue-commands.json"),
    reload: join(fixture.root, "reload-trace.jsonl"),
  };
  return Object.fromEntries<string>(
    await Promise.all(
      Object.entries(files).map(
        async ([key, file]): Promise<readonly [string, string]> => [
          key,
          await readFile(file, "utf8").catch((error: unknown) => String(error)),
        ],
      ),
    ),
  );
}
