import { sleep as sdkSleep } from "workflow";

export async function sleep(request: {
  readonly seconds: number;
}): Promise<void> {
  await sdkSleep(sleepSeconds(request) * 1000);
}

function sleepSeconds(request: unknown): number {
  if (
    typeof request !== "object" ||
    request === null ||
    Reflect.ownKeys(request).length !== 1
  )
    throw new Error("invalid-sleep-seconds");
  const field: { readonly value?: unknown; readonly enumerable?: boolean } =
    Object.getOwnPropertyDescriptor(request, "seconds") ?? {};
  const seconds = field.value;
  if (
    field.enumerable !== true ||
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 86400
  )
    throw new Error("invalid-sleep-seconds");
  return seconds;
}
