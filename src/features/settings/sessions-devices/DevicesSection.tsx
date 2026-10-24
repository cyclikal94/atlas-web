import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { type DeviceRow, useSession } from "../../../session";
import { formatAgo } from "../relative-time";
import { LoadFailed } from "./LoadFailed";
import { RetireOtherDialog } from "./RetireOtherDialog";
import { useLoad, useOnline } from "./useLoad";
import { WipeConfirmDialog } from "./WipeConfirmDialog";

/**
 * "Devices that sync" (WF-SETTINGS-02). Labels come from real fields only (design gaps G-2 and G-3): `device_id` is an opaque
 * client-chosen string and the contract exposes no capacity, so a row says "This device" or "Another device", how many
 * sessions it holds and when it last synced. A device with no sign-ins is still listed and retirable.
 */
export const DEVICES_HEADING = "Devices that sync";
export const DEVICES_EXPLANATION =
  "Separate from the sign-ins above: a device can hold synced content and a place for syncing with no active session at all — its login may simply have expired.";
export const OFFLINE_REASON = "Retiring a device needs a connection.";

export const deviceTitle = (row: DeviceRow): string =>
  row.current ? "This device" : "Another device";
export const deviceMeta = (row: DeviceRow, now: Date): string =>
  [
    `${row.active_sessions} active ${row.active_sessions === 1 ? "session" : "sessions"}`,
    row.last_synced_at
      ? `Last synced ${formatAgo(row.last_synced_at, now)}`
      : "Never synced",
  ].join(" · ");

export function DevicesSection() {
  const session = useSession();
  const online = useOnline();
  const [load, reload] = useLoad(() => session.operations.readDevices());
  const [retiring, setRetiring] = useState<DeviceRow | null>(null);
  const now = new Date();

  return (
    <section
      aria-labelledby="devices-heading"
      className="flex max-w-[700px] flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2 id="devices-heading" className="text-[15px] font-medium text-ink-1">
          {DEVICES_HEADING}
        </h2>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {DEVICES_EXPLANATION}
        </p>
      </div>
      {load.status === "loading" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          Loading your devices…
        </p>
      ) : load.status === "error" ? (
        <LoadFailed what="your devices" error={load.error} onRetry={reload} />
      ) : (
        <List className="flex flex-col gap-2">
          {load.value.devices.map((row) => (
            <li
              key={row.id}
              data-device-row={row.current ? "current" : "other"}
              className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px] text-ink-1">
                    {deviceTitle(row)}
                    {row.current ? (
                      <span className="ml-2 text-[12px] text-ink-2">
                        Current device
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[12.5px] text-ink-2">
                    {deviceMeta(row, now)}
                  </span>
                </div>
                {online ? (
                  <Button
                    aria-label={
                      row.current
                        ? "Retire this device"
                        : "Retire this other device"
                    }
                    data-return-focus={row.current ? "device-this" : undefined}
                    onClick={() => setRetiring(row)}
                  >
                    Retire…
                  </Button>
                ) : (
                  <Button
                    disabled
                    reason={OFFLINE_REASON}
                    aria-label={
                      row.current
                        ? "Retire this device"
                        : "Retire this other device"
                    }
                  >
                    Retire…
                  </Button>
                )}
              </div>
            </li>
          ))}
        </List>
      )}
      {retiring?.current ? (
        <WipeConfirmDialog
          kind="retire"
          device={retiring}
          onClose={() => setRetiring(null)}
        />
      ) : retiring ? (
        <RetireOtherDialog
          device={retiring}
          onDone={reload}
          onClose={() => setRetiring(null)}
        />
      ) : null}
    </section>
  );
}
