import { relative } from "node:path";

export type SocketAddress =
  | { readonly kind: "address"; readonly path: string }
  | {
      readonly kind: "refused";
      readonly reason: "runtime-path-too-long";
      readonly detail: string;
    };

const maximumBytes = 103;

export function socketAddress(path: string): SocketAddress {
  const [shortest] = [path, relative(process.cwd(), path)]
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => Buffer.byteLength(left) - Buffer.byteLength(right));
  if (shortest === undefined || Buffer.byteLength(shortest) > maximumBytes)
    return {
      kind: "refused",
      reason: "runtime-path-too-long",
      detail: `The socket path ${path} is longer than ${String(maximumBytes)} bytes.`,
    };
  return { kind: "address", path: shortest };
}
