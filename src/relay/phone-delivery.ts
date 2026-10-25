import { Actor, type EffectSuccessPayload } from "solid-objects";
import { deliveryBackoffMilliseconds } from "../delivery-backoff.ts";
import { outboxIdentity, PhoneOutbox } from "./phone-outbox.ts";

export type PostedEnvelope = {
  readonly envelopeId: string;
  readonly kind: string;
  readonly ciphertext: string;
  readonly expiresAt: string;
  readonly push: string;
  readonly collapseId: string | null;
};

export type DeliveryTopic = "decision" | "closed";

export type DeviceDelivery = {
  readonly deviceId: string;
  readonly topic: DeliveryTopic;
  readonly state: "pending" | "sent" | "failed" | "cancelled";
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly lastFailure: string | null;
  readonly envelopes: readonly PostedEnvelope[];
};

export type DeviceEnvelopes = {
  readonly deviceId: string;
  readonly envelopes: readonly PostedEnvelope[];
};

export type PostOutcome = {
  readonly at: number;
  readonly failure: string | null;
};

export const postEnvelopesEffect = "phone_post_envelopes";

export const deviceRemoved = "device-removed";

const attemptLimit = deliveryBackoffMilliseconds.length;

const retentionMilliseconds = 7 * 86_400_000;

function same(
  item: DeviceDelivery,
  key: { readonly deviceId: string; readonly topic: DeliveryTopic },
): boolean {
  return item.deviceId === key.deviceId && item.topic === key.topic;
}

function replaced(
  deliveries: readonly DeviceDelivery[],
  delivery: DeviceDelivery,
): DeviceDelivery[] {
  return deliveries.map((item) => (same(item, delivery) ? delivery : item));
}

function ended(delivery: DeviceDelivery): boolean {
  if (delivery.state === "sent" || delivery.state === "cancelled") return true;
  return (
    delivery.state === "failed" &&
    (delivery.attempts >= attemptLimit ||
      delivery.lastFailure === deviceRemoved)
  );
}

function started(
  topic: DeliveryTopic,
  device: DeviceEnvelopes,
): DeviceDelivery {
  return {
    ...device,
    topic,
    state: "pending",
    attempts: 1,
    lastAttemptAt: null,
    lastFailure: null,
  };
}

function settled(
  delivery: DeviceDelivery,
  result: PostOutcome,
): DeviceDelivery {
  if (result.failure === null)
    return {
      ...delivery,
      state: "sent",
      lastAttemptAt: result.at,
      lastFailure: null,
      envelopes: [],
    };
  return {
    ...delivery,
    state: "failed",
    lastAttemptAt: result.at,
    lastFailure: result.failure,
  };
}

function afterClose(
  delivery: DeviceDelivery,
  closedAt: number | null,
): DeviceDelivery {
  const stopped =
    delivery.topic === "decision" &&
    delivery.state === "failed" &&
    closedAt !== null;
  return stopped ? { ...delivery, state: "cancelled" } : delivery;
}

export class PhoneDelivery extends Actor {
  static override readonly actorType = "PhoneDelivery";

  deliveries: DeviceDelivery[] = [];

  closedAt: number | null = null;

  promptDigest: string | null = null;

  offer(device: DeviceEnvelopes & { readonly promptDigest: string }): boolean {
    const known = this.deliveries.some((item) =>
      same(item, { deviceId: device.deviceId, topic: "decision" }),
    );
    if (known || this.closedAt !== null) return false;
    const delivery = started("decision", {
      deviceId: device.deviceId,
      envelopes: device.envelopes,
    });
    this.promptDigest ??= device.promptDigest;
    this.deliveries = [...this.deliveries, delivery];
    this.emit(postEnvelopesEffect, {
      arguments: {
        deviceId: delivery.deviceId,
        envelopes: delivery.envelopes,
        topic: delivery.topic,
      },
      onSuccess: "posted",
    });
    return true;
  }

  close({
    devices,
    at,
  }: {
    readonly devices: readonly DeviceEnvelopes[];
    readonly at: number;
  }): boolean {
    if (this.closedAt !== null) return false;
    this.closedAt = at;
    const closing = devices.map((device) => started("closed", device));
    this.deliveries = [
      ...this.deliveries.map((item): DeviceDelivery =>
        item.state === "failed" ? { ...item, state: "cancelled" } : item,
      ),
      ...closing,
    ];
    for (const device of devices)
      this.emit(postEnvelopesEffect, {
        arguments: { ...device, topic: "closed" },
        onSuccess: "posted",
      });
    if (closing.length === 0)
      this.schedule({ at: new Date(at + retentionMilliseconds) }).retire();
    return true;
  }

  posted({
    arguments: request,
    result,
  }: EffectSuccessPayload<
    { deviceId: string; topic: DeliveryTopic },
    PostOutcome
  >): void {
    const delivery = this.deliveries.find(
      (item) => same(item, request) && item.state === "pending",
    );
    if (delivery === undefined) return;
    const updated = afterClose(settled(delivery, result), this.closedAt);
    this.deliveries = replaced(this.deliveries, updated);
    if (!ended(updated)) {
      const wait = deliveryBackoffMilliseconds[updated.attempts] ?? 0;
      this.schedule({
        at: new Date(result.at + wait),
        key: `${updated.topic}:${updated.deviceId}`,
      }).retry({ deviceId: updated.deviceId, topic: updated.topic });
      return;
    }
    const closing = this.deliveries.filter((item) => item.topic === "closed");
    if (updated.topic === "closed" && closing.every(ended))
      this.schedule({
        at: new Date(result.at + retentionMilliseconds),
      }).retire();
  }

  retry(key: {
    readonly deviceId: string;
    readonly topic: DeliveryTopic;
  }): void {
    const delivery = this.deliveries.find(
      (item) => same(item, key) && item.state === "failed",
    );
    if (delivery === undefined || ended(delivery)) return;
    this.deliveries = replaced(this.deliveries, {
      ...delivery,
      state: "pending",
      attempts: delivery.attempts + 1,
    });
    this.emit(postEnvelopesEffect, {
      arguments: {
        deviceId: delivery.deviceId,
        topic: delivery.topic,
        envelopes: delivery.envelopes,
      },
      onSuccess: "posted",
    });
  }

  retire(): void {
    this.sendTo(PhoneOutbox.ref(outboxIdentity)).retire({
      decisionId: this.actorId,
    });
  }
}
