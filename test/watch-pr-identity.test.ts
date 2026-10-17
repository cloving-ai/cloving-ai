import assert from "node:assert/strict";
import { test } from "node:test";
import { prIdentity, prRepository } from "../src/cli/watch-pr-identity.ts";

const repository = {
  host: "github.example",
  owner: "fixture",
  repository: "demo",
};
const pullRequest = {
  number: 7,
  url: "https://github.example/fixture/demo/pull/7",
};

await test("CLV-093 one local origin establishes the host and repository without a browser or cwd", () => {
  for (const origin of [
    "https://github.example/Fixture/Demo.git",
    "git@github.example:fixture/demo.git",
    "ssh://git@github.example/fixture/demo.git",
  ])
    assert.deepEqual(prRepository(origin + "\n"), repository);
  for (const origin of [
    "",
    "https://github.example/fixture/demo\nhttps://other.example/fixture/demo",
    "/tmp/demo",
    "http://github.example/fixture/demo",
    "https://github.example:fixture/demo",
    "git@github.example/fixture/demo",
    "https://github..example/fixture/demo",
    "\ngit@github.example:fixture/demo.git\n",
    "git@github.example:fixture/demo.git\n\n",
    "https://token@github.example/fixture/demo",
    "https://github.example/fixture/demo?x",
    "https://github.example/fixture/../demo",
    "https://github.example:443/fixture/demo",
  ])
    assert.equal(prRepository(origin), null, origin);
});

await test("CLV-093 a recorded HTTPS URL must match its safe PR number and local origin", () => {
  assert.deepEqual(prIdentity(repository, pullRequest), {
    ...repository,
    number: 7,
  });
  for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(prIdentity(repository, { ...pullRequest, number }), null);
  for (const url of [
    "https://other.example/fixture/demo/pull/7",
    "https://github.example/other/demo/pull/7",
    "https://github.example/fixture/other/pull/7",
    "https://github.example/fixture/demo/pull/8",
    "http://github.example/fixture/demo/pull/7",
    "https://token@github.example/fixture/demo/pull/7",
    pullRequest.url + "?x",
    pullRequest.url + "#x",
    "https://github.example/fixture/demo/pull/07",
    "https://github.example/fixture/%64emo/pull/7",
    "https://github.example:443/fixture/demo/pull/7",
  ])
    assert.equal(prIdentity(repository, { ...pullRequest, url }), null, url);
});

await test("CLV-093 dotted repository names retain exact identity while dot segments are refused", () => {
  const context = { ...repository, repository: ".github" };
  assert.deepEqual(
    prRepository("git@github.example:fixture/.github.git"),
    context,
  );
  assert.deepEqual(
    prIdentity(context, {
      number: 7,
      url: "https://github.example/fixture/.github/pull/7",
    }),
    { ...context, number: 7 },
  );
  for (const name of [".", "..", ".git", "-fixture/other"])
    assert.equal(prRepository(`https://github.example/fixture/${name}`), null);
});
