import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkspace, workspaceFile } from "../src/workspace.ts";

function workspaceText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

await test("CLV-312 reads the repositories of a workspace file with a default name from the path", () => {
  assert.deepEqual(
    parseWorkspace(
      JSON.stringify({
        version: 1,
        repositories: [
          { path: "/work/cloving-ai/" },
          { path: "/work/apps/ios", name: "phone.ios_2" },
        ],
      }),
    ),
    {
      repositories: [
        { name: "cloving-ai", path: "/work/cloving-ai" },
        { name: "phone.ios_2", path: "/work/apps/ios" },
      ],
      limits: {},
    },
  );
});

await test("CLV-312 reads the workspace lanes and the workspace daily spend limit", () => {
  assert.deepEqual(
    parseWorkspace(
      JSON.stringify({
        version: 1,
        repositories: [{ path: "/work/app" }],
        lanes: 2,
        dailySpendLimitUsd: 12.5,
      }),
    ).limits,
    { lanes: 2, dailySpendLimitUsd: 12.5 },
  );
});

const invalidCases: readonly (readonly [unknown, string])[] = [
  ["{", "the file is not JSON"],
  [[], "the file must hold one object"],
  [{ version: 2, repositories: [] }, "version must be 1"],
  [{ version: 1, repositories: [], port: 2 }, "the field port is not known"],
  ...[0, 65, 1.5, "2", null].map(
    (lanes) =>
      [
        { version: 1, repositories: [{ path: "/a" }], lanes },
        "lanes must be a whole number from 1 to 64",
      ] as const,
  ),
  ...[0, -1, "5", null, [5]].map(
    (dailySpendLimitUsd) =>
      [
        { version: 1, repositories: [{ path: "/a" }], dailySpendLimitUsd },
        "dailySpendLimitUsd must be a number above 0",
      ] as const,
  ),
  [{ version: 1 }, "repositories must list one or more repositories"],
  [
    { version: 1, repositories: [] },
    "repositories must list one or more repositories",
  ],
  [{ version: 1, repositories: ["/a"] }, "repository 1 must be an object"],
  [
    { version: 1, repositories: [{ path: "a" }] },
    "repository 1 needs an absolute path",
  ],
  [
    { version: 1, repositories: [{ path: "/a\u0000" }] },
    "repository 1 needs an absolute path",
  ],
  [
    { version: 1, repositories: [{ path: "/a", port: 1 }] },
    "repository 1 has the field port, which is not known",
  ],
  ...["", "-a", "a b", "é", "a".repeat(65), 7].map(
    (name) =>
      [
        { version: 1, repositories: [{ path: "/a" }, { path: "/b", name }] },
        "repository 2 needs a name of 1 to 64 letters, digits, dots, dashes or underscores",
      ] as const,
  ),
  [
    { version: 1, repositories: [{ path: "/" }] },
    "repository 1 needs a name of 1 to 64 letters, digits, dots, dashes or underscores",
  ],
  [
    {
      version: 1,
      repositories: [{ path: "/one/app" }, { path: "/two/app" }],
    },
    "the name app is used two times",
  ],
  [
    {
      version: 1,
      repositories: [
        { path: "/one/app", name: "one" },
        { path: "/one/app/", name: "two" },
      ],
    },
    "the path /one/app is used two times",
  ],
];
await test("CLV-312 refuses a workspace file that is not valid", () => {
  for (const [value, detail] of invalidCases)
    assert.throws(() => parseWorkspace(workspaceText(value)), {
      message: `invalid-workspace: ${detail}`,
    });
});

await test("CLV-312 the workspace file is in the folder of the user workflows", () => {
  assert.equal(
    workspaceFile({ XDG_CONFIG_HOME: "/configuration" }, "/home/one"),
    "/configuration/cloving/workspace.json",
  );
  assert.equal(
    workspaceFile({ XDG_CONFIG_HOME: "relative" }, "/home/one"),
    "/home/one/.config/cloving/workspace.json",
  );
  assert.equal(
    workspaceFile({ HOME: "/home/two" }, "/home/one"),
    "/home/two/.config/cloving/workspace.json",
  );
});
