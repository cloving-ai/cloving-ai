import { parseCheckTimeFactor } from "../quality/test-execution.ts";

export function testMilliseconds(milliseconds: number): number {
  return (
    milliseconds *
    parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"])
  );
}
