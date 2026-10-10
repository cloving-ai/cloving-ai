import { appendFileSync, readFileSync } from "node:fs";
import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";

export interface SentRecord {
  readonly operationId: string;
  readonly workflow: string;
  readonly receipt: string;
}

function contents(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function sentRecords(file: string): readonly SentRecord[] {
  return contents(file)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): SentRecord => {
      const value: unknown = JSON.parse(line);
      return {
        operationId: String(Reflect.get(Object(value), "operationId")),
        workflow: String(Reflect.get(Object(value), "workflow")),
        receipt: String(Reflect.get(Object(value), "receipt")),
      };
    });
}

export interface ServiceBehavior {
  readonly afterSend?: (receipt: string) => Promise<void>;
}

export function fileService(
  file: string,
  behavior: ServiceBehavior = {},
): Delivery {
  return {
    deliver: async (intent: DeliveryIntent) => {
      const receipt = `receipt-${String(sentRecords(file).length + 1)}`;
      appendFileSync(
        file,
        JSON.stringify({
          operationId: intent.operationId,
          workflow: intent.workflow,
          receipt,
        }) + "\n",
      );
      await behavior.afterSend?.(receipt);
      return { receipt };
    },
    reconcile: (intent: DeliveryIntent) => {
      const found = sentRecords(file).find(
        (record) => record.operationId === intent.operationId,
      );
      return Promise.resolve(
        found === undefined
          ? { kind: "absent" }
          : { kind: "accepted", receipt: found.receipt },
      );
    },
  };
}
