import type { Captured, ProfileState } from "../model/types";
import { guardedPlan, readPlan } from "./builders";

/**
 * W12 `writeProfile` and W13 `recordDeviceVerification` (plan 5.8). Both are RESPONSE-DERIVED (the result of `GET /me`, the
 * current-device row of the sessions list), so both carry the full guard set (G1 G2 INC CLS EPO): a late answer of a former
 * account, epoch or incarnation can never change the current one's record.
 *
 * NEITHER CREATES THE DATABASE. They run only through an `AccountService`, which exists only for a database that was opened, and
 * the profile source opens with `create: false`: a database that does not exist is not created by a profile write (F-P1, MU-44).
 */

/** The verified display name, for the epoch it was verified in. Only the `username` is kept: never an id, never a label of a device. */
export const writeProfile = guardedPlan<
  { captured: Captured; username: string; now: number },
  null,
  { written: true }
>({
  name: "data.writeProfile",
  meta: { writer: "W12", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => ({
    sync: {
      ...sync,
      profile: {
        username: input.username,
        verified_epoch: input.captured.epoch,
        verified_at: input.now,
      },
    },
    result: { written: true },
  }),
});

/**
 * The device mirror (D:1913-1964): `device_id`, `device_verified: true` and `device_verified_for: { account_id, epoch }` in ONE
 * guarded transaction. A failed or stale attempt writes nothing, and a correction never touches `cursor`, `phase` or `cache_status`.
 */
export const recordDeviceVerification = guardedPlan<
  { captured: Captured; deviceId: string },
  null,
  { written: true }
>({
  name: "data.recordDeviceVerification",
  meta: { writer: "W13", guards: ["INC", "CLS", "EPO"], quota: "cache" },
  scope: [],
  durability: "default",
  read: async () => null,
  decide: ({ sync, input }) => ({
    sync: {
      ...sync,
      device_id: input.deviceId,
      device_verified: true,
      device_verified_for: {
        account_id: input.captured.account,
        epoch: input.captured.epoch,
      },
    },
    result: { written: true },
  }),
});

/** The persisted verified profile, for a page that starts offline (it is shown only for the epoch it was verified in). */
export const readProfile = readPlan<
  { incarnationId: string },
  null,
  ProfileState | null
>({
  name: "data.readProfile",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => sync?.profile ?? null,
});
