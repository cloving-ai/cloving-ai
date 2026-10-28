import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandUsage, usage } from "../src/cli/usage.ts";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";

const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");

await test("CLV-201 the README names every scanned workflow folder", () => {
  const loader = readFileSync(
    join(import.meta.dirname, "../tools/workflow-folders.ts"),
    "utf8",
  );
  const folders = Array.from(loader.matchAll(/parts: \[([^\]]+)\]/g), (match) =>
    Array.from(String(match[1]).matchAll(/"([^"]+)"/g), (part) =>
      String(part[1]),
    ),
  )
    .filter((parts) => parts.length > 0)
    .map((parts) => parts.join("/") + "/");
  assert.ok(folders.length > 0);
  const development = readme
    .split("## Develop a workflow\n")[1]
    ?.split("\n## ")[0];
  assert.ok(development);
  for (const folder of [...folders, "workflows/"])
    assert.ok(development.includes("`" + folder + "`"), folder);
});

await test("CLV-201 the README folder workflow example passes candidate declaration checks", () => {
  const development = readme.split("## Develop a workflow\n")[1] ?? "";
  assert.match(development, /`<name>\.ts`/);
  assert.match(development, /`<name>\.declaration\.json`/);
  const example = development.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example);
  const declaration: unknown = JSON.parse(example);
  assert.deepEqual(
    checkWorkflowCandidate({
      declaration,
      analysis: {
        imports: [],
        effects: [],
        directEffects: [],
        unsupportedForms: [],
        knownCallCount: 0,
        knownUnitTotal: 0,
      },
      installedExports: {},
    }),
    [],
  );
  assert.match(development, /absolute `XDG_CONFIG_HOME`/);
  assert.match(development, /otherwise.*`~\/\.config`/);
});

await test("CLV-099 the README explains the developer gate time factor and default", () => {
  assert.match(
    readme,
    /CLOVING_CHECK_TIME_FACTOR.*whole number from 1 to 5.*default 1.*test and coverage.*time limits/,
  );
});

await test("CLV-193 the README explains the phone relay, what cloving.ai can see, and where private analysis questions go", () => {
  const section =
    readme
      .split("### Answer decisions from a phone")[1]
      ?.split(/^#{2,3} /m)[0] ?? "";
  for (const fact of [
    "Connect a phone",
    "Accept",
    "6-digit code",
    "`cloving phone remove",
    "`cloving phone reset`",
    "`CLOVING_PHONE_RELAY`",
    "cloving.ai sees",
    "end-to-end",
    "`analyze-chats`",
    "your own paired phones",
    "Face ID",
    "device:",
  ])
    assert.ok(section.includes(fact), fact);
});

await test("CLV-201 installation describes the published package without a package version", () => {
  assert.match(readme, /^npm install --global cloving --ignore-scripts$/m);
  assert.doesNotMatch(readme, /npm install --global cloving@/);
  assert.match(readme, /replaces the older Cloving CLI/);
  assert.doesNotMatch(
    readme,
    /not published to npm|registry currently serves that older CLI|Once the operator publishes this package|do not install the npm package with the name cloving/,
  );
  assert.doesNotMatch(
    readme,
    /cloving@\d|cloving-\d+\.\d+\.\d+|Cloving(?: package)? v?\d+\.\d+\.\d+/i,
  );
  assert.match(readme, /Node 26\.9\.0 and npm 11\.19\.1/);
  assert.match(
    readme,
    /Workflow admission accepts the same Node range: Node 24\.22\.1 or a later Node 24 version, and Node 26\.9\.0 or a later Node 26 version\./,
  );
  assert.match(readme, /CI also runs the Ubuntu checks with Node 24\.22\.1\./);
  assert.match(
    readme,
    /The `quality_linux` check passes only when the Ubuntu checks pass on both Node versions\./,
  );
  assert.doesNotMatch(readme, /exactly Node/);
  assert.match(readme, /supports macOS and Linux on arm64 and x64/);
  assert.match(readme, /macOS 15 arm64 and Ubuntu 24\.04 x64/);
  assert.doesNotMatch(
    readme,
    /Chat import and redaction currently require macOS/,
  );
  assert.doesNotMatch(readme, /`platform-unsupported` before file access/);
  assert.match(readme, /without a source checkout/);
  assert.doesNotMatch(
    readme,
    /do not install it by name from npm|cloving-0\.4\.0\.tgz/,
  );
});

await test("CLV-203 the README omits retired chat commands and corpus sections", () => {
  assert.doesNotMatch(readme, /cloving chats (?:import|redact)/);
  assert.doesNotMatch(
    readme,
    /^### (?:Import selected chats|Redact an imported corpus|Validate process analysis data)$/m,
  );
});

await test("CLV-203 development setup refreshes installed dependencies after a merge", () => {
  const development = readme.split("## Development of Cloving\n")[1] ?? "";
  assert.match(
    development,
    /After a merge or branch update changes `package\.json` or `package-lock\.json`, rerun `npm ci --ignore-scripts` in the worktree before running checks/,
  );
});

await test("CLV-076 the README starts with the three exact lines of the product owner", () => {
  const opening = readme.split("\n").filter((line) => line.trim() !== "");
  assert.deepEqual(opening.slice(0, 4), [
    "# Cloving",
    "The world's easiest software factory.",
    "Build a software factory with simple TypeScript for your project, and your project can build itself.",
    "The end of vibe coding. This is agentic engineering.",
  ]);
});

await test("CLV-076 What works now says Cloving develops itself through develop-issue with a Greptile review and an automatic merge", () => {
  const working = readme
    .split("## Cloving\n")[1]
    ?.split("What works now:\n")[1]
    ?.split("What does not work yet:\n")[0];
  assert.ok(working);
  assert.match(
    working,
    /^- Cloving develops itself through `develop-issue`, with a Greptile review and an automatic merge\.$/m,
  );
});

const sections = [
  "Cloving",
  "Install",
  "First run",
  "Daily development",
  "Continuous process",
  "Prompts for a coding agent",
  "Develop a workflow",
  "Development of Cloving",
];

const settings = new Set(String(commandUsage["start"]).match(/CLOVING_\w+/g));

const commands = new Set(
  Array.from(usage.matchAll(/^ {2}([a-z][\w-]*)/gm), (match) =>
    String(match[1]),
  ),
);

function distinct(names: Iterable<string>): readonly string[] {
  return [...new Set(names)];
}

const expected = ["# Cloving", ...sections.map((name) => `## ${name}`)];

function readmeFindings(text: string): readonly string[] {
  const named = Array.from(
    text.matchAll(/(?<![\w./@-])cloving[ \t]+([a-z][\w-]*)/g),
    (match) => String(match[1]),
  );
  const headings = Array.from(
    text
      .split(/^[ \t]*`{3,}.*$/m)
      .filter((_, index) => index % 2 === 0)
      .join("\n")
      .matchAll(/^(#{1,2}) (.+)$/gm),
    (match) => `${String(match[1])} ${String(match[2]).trim()}`,
  );
  return [
    ...distinct(text.match(/\bCLOVING_\w+/g) ?? [])
      .filter(
        (name) =>
          !settings.has(name) &&
          ![
            "CLOVING_TURN_ID",
            "CLOVING_RUN_ID",
            "CLOVING_OPERATION_ID",
            "CLOVING_CHECK_TIME_FACTOR",
            "CLOVING_TEST_CONCURRENCY",
          ].includes(name),
      )
      .map((name) => `unknown-setting: ${name}`),
    ...distinct(named)
      .filter((name) => !commands.has(name))
      .map((name) => `unknown-command: ${name}`),
    ...distinct(
      text.match(/(?<![\w.~/-])\/(?:Users|home)\/[\w.-]+/g) ?? [],
    ).map((path) => `home-path: ${path}`),
    ...(headings.join("\n") === expected.join("\n")
      ? []
      : [`sections: ${headings.join(", ")}`]),
  ];
}

const valid = [
  "# Cloving",
  ...sections.map((section) => `## ${section}`),
  "Run `cloving --help`, then `cloving start` with CLOVING_WATCH_PORT=off.",
  "Import `cloving/workflows`. The state is in ~/.local/state/cloving/run.",
  "```sh\n# a comment in a code block\ncloving status\n```",
  "",
].join("\n\n");

await test("CLV-073 the README names only known settings and commands, has no path in the home folder of a named user, and has the eight sections in order", () => {
  assert.deepEqual(readmeFindings(readme), []);
});

await test("CLV-073 the README checks accept options, the package path and a path in the home folder of the reader", () => {
  assert.deepEqual(readmeFindings(valid), []);
});

await test("CLV-156 the README recognizes and documents test concurrency", () => {
  assert.deepEqual(
    readmeFindings(`${valid}Set CLOVING_TEST_CONCURRENCY to 3.\n`),
    [],
  );
  assert.match(
    readme,
    /CLOVING_TEST_CONCURRENCY.*whole number from 1 to 8.*Ubuntu CI sets it to 4/,
  );
});

await test("CLV-073 the README checks reject a setting that the help of cloving start does not name", () => {
  assert.deepEqual(
    readmeFindings(`${valid}Set CLOVING_NOT_A_SETTING to 1.\n`),
    ["unknown-setting: CLOVING_NOT_A_SETTING"],
  );
});

await test("CLV-073 the README checks reject a command that the help of cloving does not name", () => {
  assert.deepEqual(readmeFindings(`${valid}Run cloving not-a-command.\n`), [
    "unknown-command: not-a-command",
  ]);
});

await test("CLV-073 the README checks reject an absolute path in the home folder of a named user", () => {
  assert.deepEqual(
    readmeFindings(
      `${valid}Open /Users/example-user/project and /home/example-user/notes.\n`,
    ),
    ["home-path: /Users/example-user", "home-path: /home/example-user"],
  );
});

await test("CLV-073 the README checks reject sections that are missing or in a different order", () => {
  const swapped = valid
    .replace("## Install", "## Swap")
    .replace("## First run", "## Install")
    .replace("## Swap", "## First run");
  const later = sections.slice(3).map((name) => `## ${name}`);
  assert.deepEqual(readmeFindings(swapped), [
    `sections: ${["# Cloving", "## Cloving", "## First run", "## Install", ...later].join(", ")}`,
  ]);
  assert.deepEqual(readmeFindings(valid.replace("# Cloving\n\n", "")), [
    `sections: ${["## Cloving", "## Install", "## First run", ...later].join(", ")}`,
  ]);
});
