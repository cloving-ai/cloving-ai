import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  inRange,
  patchedRange,
} from "../templates/dependency-audit/dependency-audit/audit-ranges.mts";

await test("CLV-318 the patched range is every version outside the vulnerable range", () => {
  for (const [vulnerable, patched] of [
    ["<0.2.4", ">=0.2.4"],
    ["< 0.2.4", ">=0.2.4"],
    ["<=1.2.3", ">1.2.3"],
    [">=7.0.0 <7.30.1", "<7.0.0 || >=7.30.1"],
    [">1.0.0", "<=1.0.0"],
    ["=1.0.0", "<1.0.0 || >1.0.0"],
    ["1.0.0", "<1.0.0 || >1.0.0"],
    ["0.4.1 - 0.5.1", "<0.4.1 || >0.5.1"],
    [">=2.0.0 <2.0.2 || <1.0.5", ">=1.0.5 <2.0.0 || >=2.0.2"],
    ["<1.0.0 || >=1.0.0 <2.0.0", ">=2.0.0"],
    ["<=1.0.0 || >1.0.0 <2.0.0", ">=2.0.0"],
    ["<1.0.0 || >1.0.0", ">=1.0.0 <=1.0.0"],
    ["<3.0.0 || <2.0.0", ">=3.0.0"],
    ["<2.0.0 || >=1.0.0 <3.0.0", ">=3.0.0"],
    [">=1.0.0 >=1.2.0 <3.0.0 <2.0.0", "<1.2.0 || >=2.0.0"],
    [">1.0.0 >=1.0.0", "<=1.0.0"],
    [">=1.0.0 >1.0.0 <=2.0.0 <2.0.0", "<=1.0.0 || >=2.0.0"],
    [">=2.0.0 <1.0.0", "*"],
    ["<1.0.0-beta.2", ">=1.0.0-beta.2"],
    [">=1.0.0 <1.5.0 || >=1.0.0 <2.0.0", "<1.0.0 || >=2.0.0"],
  ] as const)
    assert.equal(patchedRange(vulnerable), patched, vulnerable);
});

await test("CLV-318 a range with no patched version or an unknown form has no patched range", () => {
  for (const vulnerable of [
    "*",
    "",
    "<2.0.0 || >=1.0.0",
    "^1.2.3",
    "<2",
    "1.0.0 - x",
    ">=1.0.0 <1.0.0.0",
  ])
    assert.equal(patchedRange(vulnerable), null, vulnerable);
});

await test("CLV-318 versions compare by numbers and then by prerelease identifiers", () => {
  for (const [left, right, order] of [
    ["1.2.3", "1.2.3", 0],
    ["v1.2.3", "1.2.3+build.5", 0],
    ["1.2.3", "1.10.0", -1],
    ["1.2.3", "1.2.4", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0", "1.0.0-alpha", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha", 1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-alpha.beta", "1.0.0-alpha.1", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
    ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-rc.1", "1.0.0-rc.1", 0],
  ] as const)
    assert.equal(compareVersions(left, right), order, `${left} ${right}`);
  assert.throws(() => compareVersions("next", "1.0.0"), /Not a version: next/);
  assert.throws(() => compareVersions("1.0.0", "1.0"), /Not a version: 1\.0$/);
});

await test("CLV-318 an installed version is in a vulnerable range or outside it", () => {
  for (const [version, range, inside] of [
    ["0.2.1", "<=0.2.3", true],
    ["0.2.3", "<=0.2.3", true],
    ["0.2.4", "<=0.2.3", false],
    ["7.18.0", "7.18.0 - 7.30.0", true],
    ["7.17.9", "7.18.0 - 7.30.0", false],
    ["1.2.8", ">1.2.8", false],
    ["2.0.0", "<1.0.0 || >=2.0.0", true],
    ["1.0.0", "*", true],
    ["1.0.0", "^1.0.0", undefined],
    ["latest", "<1.0.0", undefined],
  ] as const)
    assert.equal(inRange(version, range), inside, `${version} ${range}`);
});
