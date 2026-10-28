import assert from "node:assert/strict";
import { test } from "node:test";
import {
  doctorExitCode,
  doctorFixes,
  type DoctorCheck,
} from "../src/doctor-report.ts";
import { nodeObservation } from "../src/cli/doctor-local.ts";

await test("CLV-207 optional failures do not fail the command; required failures and skips do", () => {
  const optional: DoctorCheck = {
    code: "service",
    result: "fail",
    required: false,
    detail: "unavailable",
    fix: doctorFixes.service,
  };
  assert.equal(doctorExitCode([optional]), 0);
  assert.equal(doctorExitCode([{ ...optional, required: true }]), 1);
  assert.equal(
    doctorExitCode([{ ...optional, required: true, result: "skip" }]),
    1,
  );
  assert.equal(
    doctorExitCode([{ ...optional, required: true, result: "ok" }]),
    0,
  );
});

await test("CLV-207 the Node check matches the workflow admission range", () => {
  for (const version of ["v24.22.1", "v26.9.0", "v26.12.1"])
    assert.equal(nodeObservation(version).result, "ok", version);
  for (const version of ["v24.0.0", "v25.9.0", "v26.8.0", "v27.0.0"])
    assert.equal(nodeObservation(version).result, "fail", version);
  assert.equal(
    nodeObservation("v25.9.0").detail,
    "Node v25.9.0; workflow admission requires Node >=24.22.1 <25 || >=26.9.0 <27",
  );
  assert.match(doctorFixes["node-version"], /nvm install 26 && nvm use 26$/);
});

await test("CLV-207 the private-text repair command contains valid JSON for the shell", () => {
  const value = /CLOVING_PRIVATE_TEXTS='([^']+)'/.exec(
    doctorFixes["private-texts"],
  )?.[1];
  assert.ok(value);
  assert.deepEqual(JSON.parse(value), ["TEXT TO KEEP PRIVATE"]);
});
