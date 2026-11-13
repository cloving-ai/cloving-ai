import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflowCandidate } from "../src/workflow-candidate.ts";
import { workflowRefusals } from "../src/workflow-refusals.ts";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";

import {
  feedDeclaration as declaration,
  feedEffect as effect,
  feedSource as source,
} from "./workflow-feed-fixture.ts";

function check(
  text: string,
  options: {
    readonly helpers?: Readonly<Record<string, string>>;
    readonly declaration?: unknown;
  } = {},
) {
  return checkWorkflowCandidate({
    declaration: options.declaration ?? declaration,
    ...analyzeWorkflowCandidate(text, {
      packageRoot: candidatePackageRoot,
      helpers: options.helpers ?? {},
    }),
  });
}

await test("CLV-362 a read-only feed has a separate effect budget from its work workflow", () => {
  assert.deepEqual(check(source(`return ${effect("issues")};`)), []);
  assert.deepEqual(
    check(source('return await runCommand({ name: "list", input: {} });')),
    [],
  );
  assert.deepEqual(check(source("return { picks: [], skipped: [] };")), []);
});

await test("CLV-362 the feed name must identify the second exported workflow", () => {
  const text = source("return { picks: [], skipped: [] };");
  for (const changed of [
    text.replace("function triageFeed", "function otherFeed"),
    text.replace(
      "export async function triageFeed",
      "async function triageFeed",
    ),
    text.replace('  "use workflow";\n  return { picks', "  return { picks"),
  ])
    assert.ok(check(changed).includes("queue-feed-missing"));
  assert.deepEqual(
    check(text.slice(0, text.indexOf("export async function triageFeed")), {
      declaration: {
        ...declaration,
        workflow: { ...declaration.workflow, queue: { feed: "triage" } },
      },
    }),
    ["queue-feed-missing"],
  );
});

await test("CLV-362 a feed refuses writes and workflow handoffs with its named refusal", () => {
  for (const body of [
    `return ${effect("create-issue")};`,
    'return await handoff({ workflowId: "triage", input: {} });',
  ])
    assert.ok(check(source(body)).includes("feed-method-not-read-only"));
  const codes = ["feed-method-not-read-only", "queue-feed-missing"];
  assert.deepEqual(
    workflowRefusals([{ scope: "project", label: "triage.ts", codes }]),
    [{ scope: "project", label: "triage.ts", codes }],
  );
});

await test("CLV-362 feed effects through imported helpers obey read-only and budget checks", () => {
  const text =
    'import { list } from "./feed/list.ts";\n' + source("return await list();");
  const helper = (
    body: string,
  ) => `import { protectedEffect } from "cloving/workflows";
export async function list() { ${body} }`;
  assert.deepEqual(
    check(text, {
      helpers: { "feed/list.ts": helper(`return ${effect("issues")};`) },
    }),
    [],
  );
  assert.ok(
    check(text, {
      helpers: {
        "feed/list.ts": helper(`return ${effect("create-issue")};`),
      },
    }).includes("feed-method-not-read-only"),
  );
  assert.ok(
    check(text, {
      helpers: {
        "feed/list.ts": helper(
          `${effect("issues")}; return ${effect("issues")};`,
        ),
      },
    }).includes("effect-limit"),
  );
});

await test("CLV-362 the feed effect limit and declared commands stay bounded", () => {
  assert.ok(
    check(source(`${effect("issues")}; return ${effect("issues")};`)).includes(
      "effect-limit",
    ),
  );
  assert.ok(
    check(
      source('return await runCommand({ name: "other", input: {} });'),
    ).includes("undeclared-effect"),
  );
  const facts = analyzeWorkflowCandidate(source("return 1;"), {
    packageRoot: candidatePackageRoot,
  });
  assert.ok(
    checkWorkflowCandidate({
      ...facts,
      declaration: {
        ...declaration,
        workflow: {
          ...declaration.workflow,
          queue: { feed: "triageFeed", feedEffectLimit: 101 },
        },
      },
    }).includes("effect-limit-above-maximum"),
  );
});

await test("CLV-362 feed lookup requires an own exported function and command declaration", () => {
  for (const feed of ["constructor", "toString", "__proto__"])
    assert.ok(
      check(source("return 1;"), {
        declaration: {
          ...declaration,
          workflow: { ...declaration.workflow, queue: { feed } },
        },
      }).includes("queue-feed-missing"),
    );
  assert.ok(
    check(source('return await runCommand({ name: "other", input: {} });'), {
      declaration: {
        ...declaration,
        methods: { ...declaration.methods, command: ["run:other"] },
      },
    }).includes("undeclared-effect"),
  );
});

await test("CLV-362 work-only writes stay outside feed authority and each budget is checked", () => {
  const text = source(`return ${effect("issues")};`).replace(
    'capability: "claude", method: "run-turn"',
    'capability: "github", method: "create-issue"',
  );
  assert.deepEqual(check(text), []);
  const over = text.replace(
    '  "use workflow";',
    `  "use workflow"; ${effect("issues")};`,
  );
  assert.ok(check(over).includes("effect-limit"));
  assert.deepEqual(
    check(text, {
      declaration: {
        ...declaration,
        workflow: { ...declaration.workflow, queue: { feed: "triageFeed" } },
      },
    }),
    [],
  );
});

await test("CLV-362 a feed can call the pure ticket status helper", () => {
  const text = source(
    'const status = ticketStatus("Ticket status: complete"); return { picks: [], skipped: [], status };',
  ).replace(
    "{ protectedEffect, runCommand, handoff }",
    "{ protectedEffect, runCommand, handoff, ticketStatus }",
  );
  assert.deepEqual(check(text), []);
});

await test("CLV-362 a feed refuses workflow controls through an arrow helper", () => {
  const text = source("await pause(); return { picks: [], skipped: [] };")
    .replace(
      "{ protectedEffect, runCommand, handoff }",
      "{ protectedEffect, runCommand, handoff, sleep }",
    )
    .concat("\nconst pause = async () => { await sleep({ seconds: 1 }); };");
  assert.deepEqual(check(text), ["feed-method-not-read-only"]);
});

await test("CLV-362 a feed refuses workflow controls through a function expression helper", () => {
  const text = source("await pause(); return { picks: [], skipped: [] };")
    .replace(
      "{ protectedEffect, runCommand, handoff }",
      "{ protectedEffect, runCommand, handoff, sleep }",
    )
    .concat(
      "\nconst pause = async function () { await sleep({ seconds: 1 }); };",
    );
  assert.deepEqual(check(text), ["feed-method-not-read-only"]);
});

await test("CLV-362 a feed refuses workflow controls through object property helpers", () => {
  for (const helper of [
    "async () => { await sleep({ seconds: 1 }); }",
    "async function () { await sleep({ seconds: 1 }); }",
  ]) {
    const text = source(
      "await controls.pause(); return { picks: [], skipped: [] };",
    )
      .replace(
        "{ protectedEffect, runCommand, handoff }",
        "{ protectedEffect, runCommand, handoff, sleep }",
      )
      .concat(`\nconst controls = { pause: ${helper} };`);
    assert.deepEqual(check(text), ["feed-method-not-read-only"]);
  }
});

await test("CLV-362 a feed refuses workflow controls through indexed helpers", () => {
  const text = source("await pauses[0](); return { picks: [], skipped: [] };")
    .replace(
      "{ protectedEffect, runCommand, handoff }",
      "{ protectedEffect, runCommand, handoff, sleep }",
    )
    .concat("\nconst pauses = [async () => { await sleep({ seconds: 1 }); }];");
  assert.deepEqual(check(text), ["feed-method-not-read-only"]);
});
