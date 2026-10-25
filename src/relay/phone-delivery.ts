import { Actor, type EffectSuccessPayload } from "solid-objects";
import { deliveryBackoffMilliseconds } from "../delivery-backoff.ts";

export type PostedEnvelope = {
  readonly envelopeId: string;
  readonly kind: string;
  readonly ciphertext: string;
  readonly expiresAt: string;
};

export type DeviceDelivery = {
  readonly deviceId: string;
  readonly state: "pending" | "sent" | "failed";
  readonly attempts: number;
  readonly lastAttemptAt: number | null;
  readonly lastFailure: string | null;
  readonly envelopes: readonly PostedEnvelope[];
};

export type PostOutcome = {
  readonly at: number;
  readonly failure: string | null;
};

export const postEnvelopesEffect = "phone_post_envelopes";

const attemptLimit = deliveryBackoffMilliseconds.length;

function replaced(
  deliveries: readonly DeviceDelivery[],
  delivery: DeviceDelivery,
): DeviceDelivery[] {
  return deliveries.map((item) =>
    item.deviceId === delivery.deviceId ? delivery : item,
  );
}

export class PhoneDelivery extends Actor {
  static override readonly actorType = "PhoneDelivery";

  deliveries: DeviceDelivery[] = [];

  offer({
    deviceId,
    envelopes,
  }: {
    readonly deviceId: string;
    readonly envelopes: readonly PostedEnvelope[];
  }): boolean {
    if (this.deliveries.some((item) => item.deviceId === deviceId))
      return false;
    this.deliveries = [
      ...this.deliveries,
      {
        deviceId,
        state: "pending",
        attempts: 1,
        lastAttemptAt: null,
        lastFailure: null,
        envelopes,
      },
    ];
    this.emit(postEnvelopesEffect, {
      arguments: { deviceId, envelopes },
      onSuccess: "posted",
    });
    return true;
  }

  posted({
    arguments: request,
    result,
  }: EffectSuccessPayload<{ deviceId: string }, PostOutcome>): void {
    const delivery = this.deliveries.find(
      (item) => item.deviceId === request.deviceId && item.state === "pending",
    );
    if (delivery === undefined) return;
    if (result.failure === null) {
      this.deliveries = replaced(this.deliveries, {
        ...delivery,
        state: "sent",
        lastAttemptAt: result.at,
        lastFailure: null,
        envelopes: [],
      });
      return;
    }
    this.deliveries = replaced(this.deliveries, {
      ...delivery,
      state: "failed",
      lastAttemptAt: result.at,
      lastFailure: result.failure,
    });
    if (delivery.attempts >= attemptLimit) return;
    const wait = deliveryBackoffMilliseconds[delivery.attempts] ?? 0;
    this.schedule({
      at: new Date(result.at + wait),
      key: delivery.deviceId,
    }).retry({ deviceId: delivery.deviceId });
  }

  retry({ deviceId }: { readonly deviceId: string }): void {
    const delivery = this.deliveries.find(
      (item) => item.deviceId === deviceId && item.state === "failed",
    );
    if (delivery === undefined || delivery.attempts >= attemptLimit) return;
    this.deliveries = replaced(this.deliveries, {
      ...delivery,
      state: "pending",
      attempts: delivery.attempts + 1,
    });
    this.emit(postEnvelopesEffect, {
      arguments: { deviceId, envelopes: delivery.envelopes },
      onSuccess: "posted",
    });
  }
}
