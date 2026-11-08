import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runnerCommand,
  runnerRefusal,
  seatbeltSettings,
} from "../src/turn-runner.ts";
import { isProfilesFile } from "../src/turn-profile.ts";
import { resolveSettings } from "../src/project-settings.ts";

const places = {
  directory: "/state/worktrees/ticket-one",
  commonFolder: "/projects/app/.git",
  attachments: "/state/attachments/ticket-one",
  temporary: "/state/journal/key/runner/tmp",
  settingsFile: "/state/journal/key/runner/srt-settings.json",
  name: "cloving-run-1-key",
  volume: "cloving-modules-ticket-one-0123456789abcdef",
  variables: ["CLOVING_TURN_ID", "HOME", "PATH", "ANTHROPIC_API_KEY"],
};
const harness = ["claude", "-p", "--output-format", "stream-json"];
const probe = [
  "sh",
  "-c",
  'test -w "$1" || { echo runner-git-readonly >&2; exit 78; }; shift; exec "$@"',
  "cloving-runner",
  "/projects/app/.git",
];

await test("CLV-311 a container runner mounts the work tree and the git common folder at the same absolute paths", () => {
  assert.deepEqual(
    runnerCommand(
      { kind: "container", engine: "/fake/engine", image: "cloving-turn" },
      { command: harness, places },
    ),
    [
      "/fake/engine",
      "run",
      "--rm",
      "-i",
      "--name",
      "cloving-run-1-key",
      "-v",
      "/state/worktrees/ticket-one:/state/worktrees/ticket-one",
      "-v",
      "/projects/app/.git:/projects/app/.git",
      "-v",
      "/projects/app/.git/hooks:/projects/app/.git/hooks:ro",
      "-v",
      "/projects/app/.git/config:/projects/app/.git/config:ro",
      "-v",
      "/state/attachments/ticket-one:/state/attachments/ticket-one",
      "-v",
      "cloving-modules-ticket-one-0123456789abcdef:/state/worktrees/ticket-one/node_modules",
      "-w",
      "/state/worktrees/ticket-one",
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=safe.directory",
      "-e",
      "GIT_CONFIG_VALUE_0=*",
      "-e",
      "CLOVING_TURN_ID",
      "-e",
      "ANTHROPIC_API_KEY",
      "cloving-turn",
      ...probe,
      ...harness,
    ],
  );
});

await test("CLV-311 a seatbelt runner starts the turn under the sandbox runtime with its settings file", () => {
  assert.deepEqual(
    runnerCommand(
      { kind: "seatbelt", network: ["api.anthropic.com"] },
      { command: harness, places },
    ),
    [
      "srt",
      "--settings",
      "/state/journal/key/runner/srt-settings.json",
      "--",
      ...probe,
      ...harness,
    ],
  );
  assert.deepEqual(
    runnerCommand(
      { kind: "seatbelt", command: "/tools/srt" },
      { command: harness, places },
    ).slice(0, 2),
    ["/tools/srt", "--settings"],
  );
});

await test("CLV-311 seatbelt settings allow writes only to the work tree, the git common folder, the attachments and the temp folder", () => {
  assert.deepEqual(
    seatbeltSettings(
      { kind: "seatbelt", network: ["api.anthropic.com", "github.com"] },
      places,
    ),
    {
      network: {
        allowedDomains: ["api.anthropic.com", "github.com"],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [
          "/state/worktrees/ticket-one",
          "/projects/app/.git",
          "/state/attachments/ticket-one",
          "/state/journal/key/runner/tmp",
        ],
        denyWrite: ["/projects/app/.git/hooks", "/projects/app/.git/config"],
      },
    },
  );
  const { directory, commonFolder, temporary } = places;
  assert.deepEqual(
    seatbeltSettings(
      { kind: "seatbelt" },
      { directory, commonFolder, temporary },
    ),
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowWrite: [
          "/state/worktrees/ticket-one",
          "/projects/app/.git",
          "/state/journal/key/runner/tmp",
        ],
        denyWrite: ["/projects/app/.git/hooks", "/projects/app/.git/config"],
      },
    },
  );
});

await test("CLV-311 a runner refusal needs exit code 78 and the refusal line on standard error", () => {
  const runner = { kind: "container", engine: "docker", image: "x" } as const;
  const error = "Unable to find image 'x:1' locally\nrunner-git-readonly\n";
  assert.equal(
    runnerRefusal(runner, { exitCode: 78, error }),
    "runner-git-readonly",
  );
  assert.equal(
    runnerRefusal({ kind: "seatbelt" }, { exitCode: 78, error }),
    "runner-git-readonly",
  );
  for (const [kind, end] of [
    [runner, { exitCode: 78, error: "codex: invalid configuration\n" }],
    [runner, { exitCode: 78, error: "not runner-git-readonly\n" }],
    [runner, { exitCode: 1, error }],
    [runner, { exitCode: null, error }],
    [{ kind: "host" }, { exitCode: 78, error }],
    [undefined, { exitCode: 78, error }],
  ] as const)
    assert.equal(runnerRefusal(kind, end), undefined, JSON.stringify(end));
});

await test("CLV-311 a host runner or no runner keeps the turn command", () => {
  assert.deepEqual(
    runnerCommand({ kind: "host" }, { command: harness, places }),
    harness,
  );
  assert.deepEqual(
    runnerCommand(undefined, { command: harness, places }),
    harness,
  );
});

await test("CLV-311 a profile accepts runner host, seatbelt and container and refuses other runner values", () => {
  const profiles = (runner: unknown) =>
    isProfilesFile({ profiles: { boxed: { runner } } });
  for (const runner of [
    { kind: "host" },
    { kind: "seatbelt" },
    {
      kind: "seatbelt",
      command: "/tools/srt",
      network: ["api.anthropic.com", "*.github.com", "registry.npmjs.org:443"],
    },
    { kind: "container", engine: "docker", image: "cloving-turn:1" },
    {
      kind: "container",
      engine: "/opt/podman/bin/podman",
      image: "a/b@sha256:0",
    },
  ])
    assert.equal(profiles(runner), true, JSON.stringify(runner));
  for (const runner of [
    "container",
    null,
    [],
    {},
    { kind: "vm" },
    { kind: "host", image: "x" },
    { kind: "seatbelt", network: "api.anthropic.com" },
    { kind: "seatbelt", network: ["two words"] },
    { kind: "seatbelt", network: [""] },
    { kind: "seatbelt", command: "" },
    { kind: "seatbelt", image: "x" },
    { kind: "container", engine: "docker" },
    { kind: "container", image: "cloving-turn" },
    { kind: "container", engine: "", image: "cloving-turn" },
    { kind: "container", engine: "docker", image: "bad\0image" },
    { kind: "container", engine: "docker", image: "-v" },
    { kind: "container", engine: "docker", image: "x", network: [] },
  ])
    assert.equal(profiles(runner), false, JSON.stringify(runner));
});

await test("CLV-311 the private settings file accepts a profile runner and refuses an invalid one", () => {
  const runner = { kind: "container", engine: "docker", image: "cloving-turn" };
  const resolved = resolveSettings(
    {},
    {
      project: undefined,
      private: JSON.stringify({ version: 1, profiles: { boxed: { runner } } }),
    },
  );
  assert.deepEqual(resolved.profiles, { boxed: { runner } });
  for (const invalid of [
    { kind: "vm" },
    { kind: "container", engine: "docker" },
    { kind: "seatbelt", network: ["two words"] },
    { kind: "host", image: "x" },
  ])
    assert.throws(
      () =>
        resolveSettings(
          {},
          {
            project: undefined,
            private: JSON.stringify({
              version: 1,
              profiles: { boxed: { runner: invalid } },
            }),
          },
        ),
      /invalid-setting: profiles\.boxed\.runner/,
      JSON.stringify(invalid),
    );
});
