import { Actor } from "solid-objects";

export type PhoneDevice = {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly agreementPublicKey: string;
  readonly answerPublicKey: string;
  readonly approvalPublicKey: string;
  readonly pairedAt: string;
  readonly state: "checking" | "connected";
  readonly removedAt: string | null;
};

export class PhoneDevices extends Actor {
  static override readonly actorType = "PhoneDevices";

  devices: PhoneDevice[] = [];

  add({ device }: { readonly device: PhoneDevice }): PhoneDevice {
    const removed = this.devices.some(
      (item) => item.deviceId === device.deviceId && item.removedAt !== null,
    );
    if (removed)
      this.reject("pairing_device_revoked", {
        message: "This phone was removed. Connect it again as a new phone.",
      });
    this.devices = [
      ...this.devices.filter((item) => item.deviceId !== device.deviceId),
      device,
    ];
    return device;
  }

  connect({ deviceId }: { readonly deviceId: string }): boolean {
    const found = this.devices.some(
      (item) => item.deviceId === deviceId && item.removedAt === null,
    );
    this.devices = this.devices.map((item) =>
      item.deviceId === deviceId && item.removedAt === null
        ? { ...item, state: "connected" }
        : item,
    );
    return found;
  }

  remove({
    deviceId,
    removedAt,
  }: {
    readonly deviceId: string;
    readonly removedAt: string;
  }): boolean {
    const found = this.devices.some(
      (item) => item.deviceId === deviceId && item.removedAt === null,
    );
    this.devices = this.devices.map((item) =>
      item.deviceId === deviceId && item.removedAt === null
        ? { ...item, removedAt }
        : item,
    );
    return found;
  }

  removeAll({ removedAt }: { readonly removedAt: string }): number {
    const count = this.devices.filter((item) => item.removedAt === null).length;
    this.devices = this.devices.map((item) =>
      item.removedAt === null ? { ...item, removedAt } : item,
    );
    return count;
  }
}
