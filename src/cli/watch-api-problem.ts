import { STATUS_CODES } from "node:http";

export interface ApiReply {
  readonly status: number;
  readonly type: string;
  readonly body: string;
  readonly allow?: string;
}

export interface ApiProblem {
  readonly code: string;
  readonly detail: string;
}

export function problem(status: number, detail: ApiProblem): ApiReply {
  return {
    status,
    type: "application/problem+json",
    body: JSON.stringify({
      type: "about:blank",
      title: STATUS_CODES[status],
      status,
      detail: detail.detail,
      code: detail.code,
    }),
  };
}

export const serviceUnavailable = problem(503, {
  code: "service-unavailable",
  detail: "The Cloving service does not answer.",
});
