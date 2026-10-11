import type { StoreReceipt } from "../broker/actor/authority.ts";
import { documentDigest } from "../broker/decision-restore.ts";
import type { Command, Gateway } from "./gateway.ts";

interface Identified {
  readonly runId: string;
  readonly commandId: string;
}

interface Revised extends Identified {
  readonly expectedRevision: number;
}

export interface GateOpening extends Revised {
  readonly gateId: string;
  readonly kind: "question" | "approval";
  readonly prompt: string;
  readonly subject: string;
  readonly expiresAt?: string;
}

export interface WaitRegistration extends Identified {
  readonly gateId: string;
}

export interface ObservationReport extends Identified {
  readonly condition: string;
  readonly reason: string;
  readonly evidence?: string;
  readonly retryAt?: string;
  readonly operationId?: string;
  readonly attempt?: number;
  readonly limit?: number;
}

export interface WorkerPort {
  readonly submit: (
    command: Command,
    documents?: readonly string[],
  ) => Promise<StoreReceipt>;
  readonly started: (run: Revised) => Promise<StoreReceipt>;
  readonly openGate: (opening: GateOpening) => Promise<StoreReceipt>;
  readonly registerWait: (wait: WaitRegistration) => Promise<StoreReceipt>;
  readonly observe: (report: ObservationReport) => Promise<StoreReceipt>;
  readonly completed: (run: Revised) => Promise<StoreReceipt>;
  readonly failed: (run: Revised) => Promise<StoreReceipt>;
}

function reference(text: unknown): string | null {
  return typeof text === "string" ? documentDigest(text) : null;
}

export function workerPort(gateway: Gateway): WorkerPort {
  const submit = (
    command: Command,
    documents?: readonly string[],
  ): Promise<StoreReceipt> =>
    gateway.execute({
      principal: "worker",
      command,
      ...(documents === undefined ? {} : { documents }),
    });
  return {
    submit,
    started: (run) => submit({ kind: "mark-started", ...run }),
    openGate: (opening) => {
      const { kind, prompt, ...rest } = opening;
      return submit(
        {
          kind: "open-gate",
          ...rest,
          gateKind: kind,
          prompt: reference(prompt),
        },
        [prompt],
      );
    },
    registerWait: (wait) => submit({ kind: "register-wait", ...wait }),
    observe: (report) => submit({ kind: "report-observation", ...report }),
    completed: (run) => submit({ kind: "complete-run", ...run }),
    failed: (run) => submit({ kind: "fail-run", ...run }),
  };
}
