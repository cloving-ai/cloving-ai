import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startRelay } from "../src/relay/relay-service.ts";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { parseInvocation } from "../src/cli/arguments.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { fields, items, withHarness } from "./service-fixture.ts";

const execute = promisify(execFile);
const entry = resolve("src/cli.ts");

await test("CLV-204 an incomplete repository selector refuses without selecting the current repository", () => {
  for (const argumentsList of [
    ["status", "--repository"],
    ["run", "develop", "--prompt", "task", "--repository"],
    ["phone", "status", "--repository"],
  ])
    assert.deepEqual(parseInvocation(argumentsList), {
      kind: "usage-error",
      code: "missing-value",
      json: false,
    });
});

await test("CLV-204 empty and repeated repository selectors refuse instead of choosing a service", () => {
  assert.deepEqual(parseInvocation(["status", "--repository="]), {
    kind: "usage-error",
    code: "missing-value",
    json: false,
  });
  assert.deepEqual(
    parseInvocation([
      "status",
      "--repository",
      "/example/A",
      "--repository",
      "/example/B",
    ]),
    { kind: "usage-error", code: "repeated-option", json: false },
  );
});

await test("CLV-204 start refuses incomplete selectors and positional arguments", () =>
  withFiles(
    {
      "repo/file": "",
      "block-start.mjs": `
import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  if (url === ${JSON.stringify(pathToFileURL(resolve("tools/self-host.ts")).href)})
    return { format: "module", source: 'process.stderr.write("self-host-was-dispatched"); process.exit(1);', shortCircuit: true };
  return next(url, context);
} });
`,
    },
    async (root) => {
      const directory = join(root, "repo");
      execFileSync("git", ["init", "-q", directory]);
      for (const [argumentsList, code] of [
        [["start", "--repository"], "missing-value"],
        [["start", "--", "--repository", directory], "unexpected-argument"],
      ] as const)
        await assert.rejects(
          cli(
            {
              directory,
              state: join(root, "state"),
              environment: {
                NODE_OPTIONS: `--import=${pathToFileURL(join(root, "block-start.mjs")).href}`,
              },
            },
            argumentsList,
          ),
          (error: unknown) => {
            assert.ok(error instanceof Error && "stderr" in error);
            assert.ok(
              String(error.stderr).includes(code),
              String(error.stderr),
            );
            return true;
          },
        );
    },
  ));

async function cli(
  location: {
    readonly directory: string;
    readonly state: string;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
  },
  argumentsList: readonly string[],
) {
  return execute(process.execPath, [entry, ...argumentsList], {
    cwd: location.directory,
    env: {
      ...process.env,
      CLOVING_RUNTIME_DIR: undefined,
      XDG_RUNTIME_DIR: "",
      XDG_STATE_HOME: location.state,
      ...location.environment,
    },
    timeout: 10000,
  });
}

await test("CLV-204 clients in two repositories and explicit selections reach only their service", () =>
  withFiles({ "project/file": "", "site/file": "" }, (root) =>
    withHarness((project) =>
      withHarness(async (site) => {
        const state = join(root, "state");
        for (const name of ["project", "site"])
          execFileSync("git", ["init", "-q", join(root, name)]);
        const projectRuntime = runtimeDirectory(
          { XDG_STATE_HOME: state },
          join(root, "project"),
        );
        const siteRuntime = runtimeDirectory(
          { XDG_STATE_HOME: state },
          join(root, "site"),
        );
        assert.ok(projectRuntime);
        assert.ok(siteRuntime);
        await mkdir(projectRuntime, { recursive: true, mode: 0o700 });
        await mkdir(siteRuntime, { recursive: true, mode: 0o700 });
        await project.start({ runtimeDirectory: projectRuntime });
        await site.start({ runtimeDirectory: siteRuntime });
        const admitted = await cli(
          { directory: join(root, "project"), state },
          ["run", "develop", "--prompt", "project only", "--json"],
        );
        assert.match(admitted.stdout, /run-admitted/);
        const empty = await cli({ directory: join(root, "site"), state }, [
          "status",
          "--json",
        ]);
        assert.equal(items(fields(JSON.parse(empty.stdout))["runs"]).length, 0);
        const own = await cli({ directory: join(root, "project"), state }, [
          "status",
          "--json",
        ]);
        assert.equal(items(fields(JSON.parse(own.stdout))["runs"]).length, 1);
        await mkdir(join(root, "site/nested"));
        assert.equal(
          (
            await cli({ directory: join(root, "site/nested"), state }, [
              "status",
              "--json",
            ])
          ).stdout,
          empty.stdout,
        );
        for (const cwd of [root, join(root, "project")]) {
          const selected = await cli({ directory: cwd, state }, [
            "status",
            "--repository",
            join(root, "site"),
            "--json",
          ]);
          assert.equal(selected.stdout, empty.stdout);
        }
      }),
    ),
  ));

await test("CLV-204 outside git refuses with repository-unknown and a repository hint", () =>
  withFiles({}, async (root) => {
    await assert.rejects(
      cli({ directory: root, state: join(root, "state") }, [
        "status",
        "--json",
      ]),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error);
        const output: unknown = JSON.parse(String(error.stdout));
        assert.ok(
          output !== null &&
            typeof output === "object" &&
            "code" in output &&
            "detail" in output,
        );
        assert.equal(output.code, "repository-unknown");
        assert.match(
          String(output.detail),
          /change.*repository|repository.*change/i,
        );
        assert.match(String(output.detail), /--repository/);
        return true;
      },
    );
  }));

await test("CLV-204 phone clients use the repository default and explicit repository selection", () =>
  withFiles({ "A/file": "", "B/file": "" }, async (root) => {
    const repository = join(root, "B");
    const state = join(root, "state");
    for (const name of ["A", "B"])
      execFileSync("git", ["init", "-q", join(root, name)]);
    const runtime = runtimeDirectory({ XDG_STATE_HOME: state }, repository);
    assert.ok(runtime);
    const relay = await startRelay({
      runtimeDirectory: runtime,
      phoneDirectory: join(root, "phone"),
    });
    try {
      const own = await cli({ directory: repository, state }, [
        "phone",
        "status",
        "--json",
      ]);
      assert.equal(fields(JSON.parse(own.stdout))["relay"], "on");
      const other = await cli({ directory: join(root, "A"), state }, [
        "phone",
        "status",
        "--json",
      ]);
      assert.deepEqual(JSON.parse(other.stdout), { relay: "off" });
      for (const directory of [root, join(root, "A")]) {
        for (const argumentsList of [
          ["--repository", repository, "phone", "status", "--json"],
          ["phone", "status", "--json", `--repository=${repository}`],
        ]) {
          const selected = await cli({ directory, state }, argumentsList);
          assert.equal(selected.stdout, own.stdout);
        }
      }
    } finally {
      await relay.close();
    }
  }));

await test("CLV-204 phone clients outside git give the repository refusal and hint", () =>
  withFiles({}, async (root) => {
    await assert.rejects(
      cli({ directory: root, state: join(root, "state") }, [
        "phone",
        "status",
        "--json",
      ]),
      (error: unknown) => {
        assert.ok(error instanceof Error && "stderr" in error);
        assert.match(String(error.stderr), /^repository-unknown: /);
        assert.match(String(error.stderr), /--repository/);
        return true;
      },
    );
  }));
