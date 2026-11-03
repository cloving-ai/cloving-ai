import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { emptyAuthority, type RunState } from "../src/authority/reducer.ts";
import type { OperationView } from "../src/broker/actor/authority.ts";
import {
  adapters,
  type DaemonSettings,
} from "../src/daemon/daemon-adapters.ts";
import { workflowGenerations } from "../src/daemon/workflow-generations.ts";
import type { HostPorts } from "../src/service/service.ts";
import type { EffectReport } from "../src/service/worker-port.ts";
import { journalKey } from "./claude-worker-fixture.ts";
import { githubIntent } from "./github-worker-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const kept = {
  operationId: "operation-kept",
  runId: "run-7",
  inputDigest: `sha256:${"b".repeat(64)}`,
  leaseGeneration: 3,
};

const operation: OperationView = {
  ...kept,
  capability: "github",
  method: "prepare",
  target: "ticket/one",
  payload: "sha256:payload-kept",
  units: 1,
  leaseKey: "ticket/one",
  recoveryLimit: 3,
  status: "running",
  reason: null,
  attempts: 0,
  receipt: null,
  worker: "github",
  result: null,
  requestedSequence: 1,
  waitSequence: null,
  settledSequence: null,
  waitCause: null,
};

const saved = { ...kept, operationId: "operation-saved" };

function started(entry: typeof kept): string {
  return JSON.stringify({
    ...entry,
    method: operation.method,
    target: operation.target,
    startedAt: "2026-11-02T00:00:00.000Z",
    payloadText: JSON.stringify({ ticket: "CLV-900" }),
  });
}

const run: RunState = {
  runId: kept.runId,
  status: "completed",
  revision: 1,
  workflow: "sha256:pin",
  pausedFrom: null,
  gates: [],
};

function unused(): Promise<never> {
  return Promise.reject(new Error("unused-host-port"));
}

function hostPorts() {
  const documents: string[] = [];
  const reports: EffectReport[] = [];
  const ports: HostPorts = {
    commandWait: { open: unused, check: unused, read: unused },
    state: () =>
      Promise.resolve({ ...emptyAuthority, runs: { [run.runId]: run } }),
    submit: unused,
    input: unused,
    document: (digest) => {
      documents.push(digest);
      return Promise.resolve(undefined);
    },
    workflow: { id: unused, manifest: unused, available: unused },
    requestEffect: unused,
    operation: (operationId) =>
      Promise.resolve(
        [kept.operationId, saved.operationId].includes(operationId)
          ? { ...operation, operationId }
          : undefined,
      ),
    operations: unused,
    reportEffect: (report) => {
      reports.push(report);
      return Promise.resolve({
        receipt: { kind: "accepted", sequence: reports.length, intents: [] },
        disposition: null,
        operation: null,
      });
    },
    openGate: unused,
    registerWait: unused,
  };
  return { documents, reports, ports };
}

function daemonSettings(root: string): DaemonSettings {
  const handler = () => Promise.resolve(new Response(null, { status: 404 }));
  return {
    directory: join(root, "host"),
    runtimeDirectory: join(root, "host/run"),
    repository: join(root, "repository"),
    manifests: {},
    workflows: {},
    handler,
    command: ["true"],
    concurrency: 1,
    privateTexts: ["private text"],
  };
}

function journalFiles(): Record<string, string> {
  const folder = (entry: typeof kept) =>
    `host/github/${journalKey(entry.operationId)}`;
  return {
    [`${folder(kept)}/started.json`]: started(kept),
    [`${folder(saved)}/started.json`]: started(saved),
    [`${folder(saved)}/result.json`]: JSON.stringify({
      outcome: "completed",
      result: "prepared",
      endedAt: "2026-11-02T00:00:01.000Z",
    }),
  };
}

function scannedReports() {
  const commandId = (entry: typeof kept) =>
    `github:${journalKey(entry.operationId)}`;
  return [
    {
      ...kept,
      commandId: commandId(kept),
      worker: "github",
      outcome: "stopped",
    },
    {
      ...saved,
      commandId: commandId(saved),
      worker: "github",
      outcome: "completed",
      result: "prepared",
    },
  ];
}

function builtAdapters(root: string, ports: HostPorts) {
  const settings = daemonSettings(root);
  return adapters(settings, {
    given: Promise.resolve(ports),
    generations: workflowGenerations({
      ...settings,
      registrations: [],
      table: [],
    }),
  });
}

await test("CLV-277 the daemon adapters connect the GitHub worker to the host documents, reports and statuses", () =>
  withFiles(journalFiles(), async (root) => {
    const { documents, reports, ports } = hostPorts();
    const built = builtAdapters(root, ports);
    try {
      await built.github.scan();
      assert.deepEqual(
        reports.toSorted((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
        scannedReports(),
      );
      assert.deepEqual(
        await built.github.deliver(
          githubIntent({
            operationId: "operation-new",
            payload: "sha256:missing",
          }),
          new AbortController().signal,
        ),
        { kind: "failed", reason: "payload-not-available" },
      );
      assert.deepEqual(documents, ["sha256:missing"]);
    } finally {
      await Promise.all([
        built.worker.close(),
        built.github.close(),
        built.commands.close(),
      ]);
    }
  }));
