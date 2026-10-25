export interface PhoneLink {
  readonly daemonId: string;
  readonly origin: string;
  readonly token: string;
  readonly registeredAt: string;
}

export function parsePhoneLink(
  text: string | undefined,
): PhoneLink | undefined {
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  const filled = (name: string): string | undefined => {
    const field: unknown = Reflect.get(value, name);
    return typeof field === "string" && field !== "" ? field : undefined;
  };
  const daemonId = filled("daemonId");
  const origin = filled("origin");
  const token = filled("token");
  const registeredAt = filled("registeredAt");
  if (
    daemonId === undefined ||
    origin === undefined ||
    token === undefined ||
    registeredAt === undefined
  )
    return undefined;
  return { daemonId, origin, token, registeredAt };
}
