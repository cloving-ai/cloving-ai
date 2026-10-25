import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { canonicalJson } from "../phone/canonical-json.ts";

export interface DaemonKeys {
  readonly agreementPrivateKey: string;
  readonly agreementPublicKey: string;
  readonly signingPrivateKey: string;
  readonly signingPublicKey: string;
}

const fields = [
  "agreementPrivateKey",
  "agreementPublicKey",
  "signingPrivateKey",
  "signingPublicKey",
] as const;

export function publicPoint(key: KeyObject): string {
  const { x = "", y = "" } = key.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x, "base64url"),
    Buffer.from(y, "base64url"),
  ]).toString("base64url");
}

function pair(): { readonly privateKey: string; readonly publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
    publicKey: publicPoint(publicKey),
  };
}

export function newDaemonKeys(): DaemonKeys {
  const agreement = pair();
  const signing = pair();
  return {
    agreementPrivateKey: agreement.privateKey,
    agreementPublicKey: agreement.publicKey,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
  };
}

export function parseDaemonKeys(
  text: string | undefined,
): DaemonKeys | undefined {
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) return undefined;
  const complete = fields.every((name) => {
    const field: unknown = Reflect.get(value, name);
    return typeof field === "string" && field !== "";
  });
  if (!complete) return undefined;
  return {
    agreementPrivateKey: String(Reflect.get(value, "agreementPrivateKey")),
    agreementPublicKey: String(Reflect.get(value, "agreementPublicKey")),
    signingPrivateKey: String(Reflect.get(value, "signingPrivateKey")),
    signingPublicKey: String(Reflect.get(value, "signingPublicKey")),
  };
}

export function keyFingerprint(keys: DaemonKeys): Buffer {
  const text = canonicalJson({
    agreementKey: keys.agreementPublicKey,
    signingKey: keys.signingPublicKey,
  });
  return createHash("sha256").update(text).digest().subarray(0, 16);
}

export function pairingIdentity(secret: Buffer): string {
  return createHash("sha256")
    .update("cloving-pairing-id|")
    .update(secret)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function pairingLink(
  origin: string,
  values: { readonly secret: Buffer; readonly keys: DaemonKeys },
): string {
  const payload = Buffer.concat([values.secret, keyFingerprint(values.keys)]);
  return `${origin}/pair#v1.${payload.toString("base64url")}`;
}
