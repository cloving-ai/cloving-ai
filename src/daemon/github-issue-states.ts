import { field, repositoryPath, type Operation } from "./github-operation.ts";

function numbersOf(payload: Operation["payload"]): readonly number[] {
  const { numbers } = payload;
  if (
    Object.keys(payload).join(",") !== "numbers" ||
    !Array.isArray(numbers) ||
    numbers.length < 1 ||
    numbers.length > 50 ||
    numbers.some(
      (number: unknown) =>
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1,
    )
  )
    throw new Error("invalid-github-input");
  return numbers.map((number: number) => number);
}

function missing(error: unknown): null {
  const detail = field(error, "detail");
  if (typeof detail === "string" && /\bHTTP (?:404|410)\b/.test(detail))
    return null;
  throw error;
}

async function stateOf(
  operation: Operation,
  number: number,
): Promise<"open" | "closed" | "missing"> {
  const response = await operation.calls
    .gh(["api", `${repositoryPath}/issues/${String(number)}`])
    .catch(missing);
  if (response === null) return "missing";
  const issue: unknown = JSON.parse(response);
  if (field(issue, "pull_request") !== undefined) return "missing";
  const state = field(issue, "state");
  if (state !== "open" && state !== "closed")
    throw new Error("github-call-failed");
  return state;
}

export async function issueStates(operation: Operation) {
  const numbers = numbersOf(operation.payload);
  const states = [];
  for (const number of numbers)
    states.push({ number, state: await stateOf(operation, number) });
  return states;
}
