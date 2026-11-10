import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRunLabel,
  isRunTitle,
  manualNameOf,
  runLabel,
  runName,
  runTitle,
  type NameSources,
} from "../src/run-name.ts";

const empty: NameSources = {
  manual: null,
  ticket: { id: null, text: null, issueNumber: null },
  pullRequestTitle: null,
  input: null,
  prompt: null,
  fallback: "develop task-0123456789ab",
};

await test("CLV-334 the title comes from the first source that exists: manual, ticket, pull request, input, prompt, fallback", () => {
  const full: NameSources = {
    manual: { title: "Manual name", label: null },
    ticket: { id: "CLV-9", text: "# Ticket title\nBody", issueNumber: null },
    pullRequestTitle: "Pull request title",
    input: { title: "Input title" },
    prompt: "Prompt line",
    fallback: "develop task-0123456789ab",
  };
  const steps = [
    { sources: full, title: "Manual name", titleSource: "manual" },
    {
      sources: { ...full, manual: null },
      title: "Ticket title",
      titleSource: "ticket",
    },
    {
      sources: { ...full, manual: null, ticket: empty.ticket },
      title: "Pull request title",
      titleSource: "pull-request",
    },
    {
      sources: {
        ...full,
        manual: null,
        ticket: empty.ticket,
        pullRequestTitle: null,
      },
      title: "Input title",
      titleSource: "input",
    },
    {
      sources: { ...empty, input: { title: " \n " }, prompt: "Prompt line" },
      title: "Prompt line",
      titleSource: "prompt",
    },
    {
      sources: empty,
      title: "develop task-0123456789ab",
      titleSource: "fallback",
    },
  ];
  for (const step of steps) {
    const name = runName(step.sources);
    assert.deepEqual(
      [name.title, name.titleSource],
      [step.title, step.titleSource],
    );
  }
});

await test("CLV-334 a prompt title is its first line that is not empty, with no leading '# ', cut at 80 characters at a word end", () => {
  const prompt = (text: string) => runName({ ...empty, prompt: text }).title;
  assert.equal(
    prompt("Fix the flaky retention test in record-retention-loop"),
    "Fix the flaky retention test in record-retention-loop",
  );
  assert.equal(prompt("\n  \n# Heading line\nBody"), "Heading line");
  const words = `${"word ".repeat(20)}end`;
  const cut = prompt(words);
  assert.equal(cut, "word ".repeat(16).trim());
  assert.ok(Array.from(cut).length <= 80);
  assert.equal(prompt("x".repeat(90)), "x".repeat(80));
  assert.equal(prompt(`${"y".repeat(79)} next`), "y".repeat(79));
  assert.equal(prompt(`${"z".repeat(80)} next`), "z".repeat(80));
});

await test("CLV-334 the ticket text gives the ticket title from its '# ' first line, else the first line that is not empty", () => {
  const ticket = (text: string) =>
    runName({ ...empty, ticket: { id: "7", text, issueNumber: null } });
  assert.deepEqual(
    [
      ticket("# Issue title\r\nDetails").title,
      ticket("# Issue title").titleSource,
    ],
    ["Issue title", "ticket"],
  );
  assert.deepEqual(
    [ticket("No heading\n# Later").title, ticket("No heading").titleSource],
    ["No heading", "prompt"],
  );
  assert.equal(ticket(`# ${"t".repeat(250)}`).title, "t".repeat(200));
  assert.equal(ticket("# \nSecond line").title, "Second line");
  assert.equal(ticket(" \n\t\n").titleSource, "fallback");
});

await test("CLV-334 the label is the manual label, then the issue number or the ticket ID, then a ticket key at the start of the title, else none", () => {
  const titled = {
    ...empty,
    pullRequestTitle: "SID-4820: Filter and page Notion database files",
  };
  assert.deepEqual(runName(titled), {
    title: "SID-4820: Filter and page Notion database files",
    titleSource: "pull-request",
    label: "SID-4820",
    labelSource: "title",
  });
  assert.deepEqual(
    runName({ ...titled, manual: { title: "Own name", label: "mine" } }),
    {
      title: "Own name",
      titleSource: "manual",
      label: "mine",
      labelSource: "manual",
    },
  );
  assert.deepEqual(
    runName({ ...titled, manual: { title: "AB-12 renamed", label: null } }),
    {
      title: "AB-12 renamed",
      titleSource: "manual",
      label: "AB-12",
      labelSource: "title",
    },
  );
  const ticket = { id: "CLV-261", text: "# Ticket", issueNumber: null };
  assert.deepEqual(
    [
      runName({ ...titled, ticket }).label,
      runName({ ...titled, ticket }).labelSource,
    ],
    ["CLV-261", "ticket"],
  );
  assert.equal(
    runName({ ...titled, ticket: { ...ticket, id: "42" } }).label,
    "#42",
  );
  assert.equal(
    runName({ ...titled, ticket: { ...ticket, issueNumber: 699 } }).label,
    "#699",
  );
  assert.equal(
    runName({ ...titled, ticket: { id: "", text: null, issueNumber: null } })
      .label,
    "SID-4820",
  );
  const prompt = runName({
    ...empty,
    prompt: "Fix the flaky retention test in record-retention-loop",
  });
  assert.deepEqual([prompt.label, prompt.labelSource], [null, null]);
});

await test("CLV-334 a ticket key has two or more capital letters or digits with one letter, a hyphen and a number", () => {
  const label = (title: string) =>
    runName({ ...empty, pullRequestTitle: title }).label;
  assert.equal(label("SID-4820: Filter"), "SID-4820");
  assert.equal(label("CLV-334 Name runs"), "CLV-334");
  assert.equal(label("3DS-12 fix"), "3DS-12");
  assert.equal(label("A-12 short prefix"), null);
  assert.equal(label("sid-4820 lower case"), null);
  assert.equal(label("2024-11-09 notes"), null);
  assert.equal(label("SID-4820x glued"), null);
  assert.equal(label("Fix SID-4820 later"), null);
  assert.equal(label("SID-"), null);
});

await test("CLV-334 a title has 1 to 200 characters after trimming on one line with no control characters", () => {
  assert.equal(runTitle("  Rename me  "), "Rename me");
  assert.equal(runTitle("\u{1F600}".repeat(200)), "\u{1F600}".repeat(200));
  assert.equal(runTitle("x".repeat(201)), undefined);
  assert.equal(runTitle("   "), undefined);
  assert.equal(runTitle("Two\nlines"), undefined);
  assert.equal(runTitle("Bell\u0007"), undefined);
  assert.equal(runTitle("Delete\u007f"), undefined);
  assert.equal(runTitle(7), undefined);
  assert.equal(isRunTitle("Rename me"), true);
  assert.equal(isRunTitle(" Rename me"), false);
});

await test("CLV-334 a label has 1 to 32 characters from letters, digits and #!._/-", () => {
  assert.equal(runLabel("SID-4820"), "SID-4820");
  assert.equal(runLabel("#686"), "#686");
  assert.equal(runLabel("a.b_c/d!e"), "a.b_c/d!e");
  assert.equal(runLabel("Ärger-1"), "Ärger-1");
  assert.equal(runLabel(" PR-1 "), "PR-1");
  assert.equal(runLabel("x".repeat(32)), "x".repeat(32));
  assert.equal(runLabel("x".repeat(33)), undefined);
  assert.equal(runLabel(""), undefined);
  assert.equal(runLabel("two words"), undefined);
  assert.equal(runLabel("semi;colon"), undefined);
  assert.equal(runLabel(null), undefined);
  assert.equal(isRunLabel("SID-4820"), true);
  assert.equal(isRunLabel(" SID"), false);
});

await test("CLV-334 the newest rename event gives the manual name, and a rename with no title removes it", () => {
  assert.equal(manualNameOf([]), null);
  assert.deepEqual(
    manualNameOf([{ title: "First" }, { title: "Second", label: "L-1" }]),
    { title: "Second", label: "L-1" },
  );
  assert.equal(manualNameOf([{ title: "First" }, {}]), null);
  assert.deepEqual(manualNameOf([{}, { title: "Again" }]), {
    title: "Again",
    label: null,
  });
});
