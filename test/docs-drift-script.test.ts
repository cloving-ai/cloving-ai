import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import {
  ghCalls,
  git,
  pushSeed,
  runScript,
  withDocsRepository,
  type DocsPlace,
} from "./docs-drift-script-fixture.ts";

const issuesPath =
  "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20docs&per_page=100";
const patterns = ["README.md", "templates/*/README.md", "AGENTS.md", "*.txt"];

function newest(place: DocsPlace): string {
  return git(join(place.root, "seed"), ["rev-parse", "HEAD"]).trim();
}

async function candidates(place: DocsPlace) {
  const result = await runScript(place, {
    script: "docs-candidates.mts",
    args: [place.login, place.record, ...patterns],
  });
  assert.equal(result.status, 0, result.stderr);
  return record(JSON.parse(result.stdout));
}

await test("CLV-317 docs-candidates prints the docs that name changed code, with the newest main commit and no record", () =>
  withDocsRepository([[]], async (place) => {
    const printed = await candidates(place);
    assert.deepEqual(printed, {
      commit: newest(place),
      candidates: [
        {
          doc: "README.md",
          since: null,
          code: ["src/settings.ts"],
          codeCount: 1,
        },
        {
          doc: "templates/x/README.md",
          since: null,
          code: ["templates/x/x/run.mts"],
          codeCount: 1,
        },
      ],
      more: 0,
    });
    assert.deepEqual(await ghCalls(place), [
      {
        command: `gh api --paginate --slurp ${issuesPath}`,
        cwd: place.repository,
        github: place.login,
      },
    ]);
  }));

await test("CLV-317 a doc that the title of an open cloving: docs issue names is not a candidate, and a pull request does not count", () =>
  withDocsRepository(
    [
      [
        { number: 4, title: "Make `README.md` match the code on main" },
        {
          number: 5,
          title: "Make `templates/x/README.md` match",
          pull_request: {},
        },
      ],
    ],
    async (place) => {
      const printed = await candidates(place);
      const listed = printed?.["candidates"];
      assert.ok(Array.isArray(listed));
      assert.deepEqual(
        listed.map((item: unknown) => record(item)?.["doc"]),
        ["templates/x/README.md"],
      );
    },
  ));

await test("CLV-317 after docs-drift-record, the next run lists only the code that changed after the recorded commit", () =>
  withDocsRepository([[]], async (place) => {
    const first = newest(place);
    const recorded = await runScript(place, {
      script: "docs-drift-record.mts",
      args: [place.record],
      payload: JSON.stringify({
        commit: first,
        docs: ["README.md", "templates/x/README.md"],
      }),
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(recorded.stdout), { recorded: 2 });
    const second = await pushSeed(place, {
      "templates/x/x/run.mts": 'throw new Error("invalid-input: x");\n',
      "src/other.ts": "export const queueSeconds = 61;\n",
    });
    assert.deepEqual(await candidates(place), {
      commit: second,
      candidates: [
        {
          doc: "templates/x/README.md",
          since: first,
          code: ["templates/x/x/run.mts"],
          codeCount: 1,
        },
      ],
      more: 0,
    });
  }));

await test("CLV-317 docs-drift-record keeps the commits of the other docs and an unknown recorded commit counts as no record", () =>
  withDocsRepository([[]], async (place) => {
    const old = "f".repeat(40);
    await writeFile(
      place.record,
      JSON.stringify({
        version: 1,
        docs: { "README.md": old, "gone.md": old },
      }),
    );
    const recorded = await runScript(place, {
      script: "docs-drift-record.mts",
      args: [place.record],
      payload: JSON.stringify({ commit: "a".repeat(40), docs: ["AGENTS.md"] }),
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(await readFile(place.record, "utf8")), {
      version: 1,
      docs: {
        "AGENTS.md": "a".repeat(40),
        "README.md": old,
        "gone.md": old,
      },
    });
    const printed = await candidates(place);
    const listed = printed?.["candidates"];
    assert.ok(Array.isArray(listed));
    assert.deepEqual(
      listed.map((item: unknown) => [
        record(item)?.["doc"],
        record(item)?.["since"],
      ]),
      [
        ["README.md", null],
        ["templates/x/README.md", null],
      ],
    );
  }));

await test("CLV-317 docs-candidates prints at most 15 docs, the docs with the most code first, and counts the others", () =>
  withDocsRepository([[]], async (place) => {
    const docs = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `templates/t${String(index).padStart(2, "0")}/README.md`,
        "Set `queue.seconds`.\n",
      ]),
    );
    await pushSeed(
      place,
      Object.assign(docs, {
        "templates/t16/README.md": "Set `queue.seconds` and `invalid-input`.\n",
      }),
    );
    const printed = await candidates(place);
    const listed = printed?.["candidates"];
    assert.ok(Array.isArray(listed));
    assert.deepEqual(
      listed.map((item: unknown) => record(item)?.["doc"]),
      [
        "templates/t16/README.md",
        "README.md",
        "templates/t00/README.md",
        "templates/t01/README.md",
        "templates/t02/README.md",
        "templates/t03/README.md",
        "templates/t04/README.md",
        "templates/t05/README.md",
        "templates/t06/README.md",
        "templates/t07/README.md",
        "templates/t08/README.md",
        "templates/t09/README.md",
        "templates/t10/README.md",
        "templates/t11/README.md",
        "templates/t12/README.md",
      ],
    );
    assert.equal(printed?.["more"], 4);
  }));

await test("CLV-317 the scripts refuse bad arguments with code 1 and run no command", () =>
  withDocsRepository([[]], async (place) => {
    for (const args of [
      [],
      ["login", place.record, "README.md"],
      [place.login, "record.json", "README.md"],
      [place.login, place.record],
      [place.login, place.record, "../README.md"],
      [place.login, place.record, "/README.md"],
    ]) {
      const result = await runScript(place, {
        script: "docs-candidates.mts",
        args,
      });
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Give the absolute path/);
    }
    for (const run of [
      { args: [], payload: "{}" },
      { args: ["record.json"], payload: "{}" },
      { args: [place.record], payload: "not json" },
      {
        args: [place.record],
        payload: JSON.stringify({ commit: "main", docs: [] }),
      },
      {
        args: [place.record],
        payload: JSON.stringify({ commit: "a".repeat(40), docs: ["../x.md"] }),
      },
    ]) {
      const result = await runScript(place, {
        script: "docs-drift-record.mts",
        args: run.args,
        payload: run.payload,
      });
      assert.equal(result.status, 1, JSON.stringify(run));
      assert.equal(result.stdout, "");
    }
    assert.deepEqual(await ghCalls(place), []);
    await assert.rejects(readFile(place.record, "utf8"));
  }));

await test("CLV-317 a bad record file or a failed gh call prints no candidates and ends with code 1", () =>
  withDocsRepository([[]], async (place) => {
    await writeFile(place.record, "{");
    const bad = await runScript(place, {
      script: "docs-candidates.mts",
      args: [place.login, place.record, "README.md"],
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /is not a docs-drift record/);
    const record = await runScript(place, {
      script: "docs-drift-record.mts",
      args: [place.record],
      payload: JSON.stringify({ commit: "a".repeat(40), docs: [] }),
    });
    assert.equal(record.status, 1);
    assert.match(record.stderr, /is not a docs-drift record/);
    await writeFile(place.record, JSON.stringify({ version: 1, docs: {} }));
    const loggedOut = await runScript(place, {
      script: "docs-candidates.mts",
      args: [place.command, place.record, "README.md"],
    });
    assert.equal(loggedOut.status, 1);
    assert.equal(loggedOut.stdout, "");
    assert.match(loggedOut.stderr, /not logged into any GitHub hosts/);
  }));
