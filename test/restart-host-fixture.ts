import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { restartText, type RestartTime } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

export async function fakeNpm(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "npm");
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
const line = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(join(root, "npm-calls"))}, line + "\\n");
appendFileSync(${JSON.stringify(join(root, "npm-daemon"))}, (existsSync(${JSON.stringify(join(root, "daemon-stopped"))}) ? "stopped" : "running") + "\\n");
const blocking = ${JSON.stringify(join(root, "build-blocks"))};
if (line === "run build" && existsSync(blocking)) {
  rmSync(blocking);
  writeFileSync(${JSON.stringify(join(root, "building"))}, String(process.pid));
  const release = ${JSON.stringify(join(root, "build-release"))};
  setInterval(() => existsSync(release) && process.exit(0), 20);
  setTimeout(() => process.exit(0), 20000);
}
const counted = ${JSON.stringify(join(root, "build-fails-count"))};
if (line === "run build" && existsSync(counted) && Number(readFileSync(counted, "utf8")) > 0) {
  writeFileSync(counted, String(Number(readFileSync(counted, "utf8")) - 1));
  process.stderr.write("error TS2322: the build broke\\n");
  process.exit(2);
}
const failing = ${JSON.stringify(join(root, "build-fails"))};
if (line === "run build" && existsSync(failing)) {
  rmSync(failing);
  mkdirSync("dist/src", { recursive: true });
  writeFileSync("dist/src/cli.js", "export const partial = true;\\n");
  const later = new Date(Date.now() + 86400000);
  utimesSync("dist/src/cli.js", later, later);
  process.stdout.write("> tsc --project tsconfig.build.json\\n");
  process.stderr.write("error TS2322: Type 'string' is not assignable\\n");
  process.exit(2);
}
`,
  );
  await chmod(executable, 0o755);
  return bin;
}

export function npmPath(bin: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
}

export function updateMark(at: RestartTime, commandId: string): string {
  return restartText({
    at,
    requestedAt: Date.now(),
    commandId,
    resumeQueue: false,
    update: true,
  });
}

export async function freshDist(repository: string): Promise<void> {
  const output = join(repository, "dist", "src", "cli.js");
  await mkdir(join(repository, "dist", "src"), { recursive: true });
  await writeFile(output, "export {};\n");
  await writeFile(join(repository, ".git", "info", "exclude"), "dist\n");
  const record = join(repository, "dist", ".restart-build");
  await writeFile(record, "");
  const later = new Date(Date.now() + 60_000);
  await utimes(output, later, later);
  await utimes(record, later, later);
}

export async function withUpdateHost(
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly git: (argumentsList: readonly string[]) => string;
    readonly old: string;
    readonly target: string;
    readonly hosted: () => Promise<number>;
  }) => Promise<void>,
  options: { readonly updateMilliseconds?: number } = {},
): Promise<void> {
  await withUpdateRepository(async ({ root, repository, git, old, target }) => {
    const paths = await programs(root);
    const bin = await fakeNpm(root);
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    await freshDist(repository);
    await body({
      root,
      directory,
      git,
      old,
      target,
      hosted: () =>
        hostedPrograms({
          ...paths,
          environment: npmPath(bin),
          repository,
          checkout: repository,
          runtime: join(directory, "run"),
          directory,
          watchPort: "off",
          phoneRelay: "off",
          updateMilliseconds: options.updateMilliseconds,
          restartMilliseconds: 50,
        }),
    });
  });
}
