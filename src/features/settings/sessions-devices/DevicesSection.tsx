import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { type DeviceRow, useSession } from "../../../session";
import { formatAgo } from "../relative-time";
import { CapacityLine } from "./CapacityLine";
import { LoadFailed } from "./LoadFailed";
import {
  DUPLICATE_HINT,
  NAME_ACTION,
  NAME_OFFLINE_REASON,
  RENAME_ACTION,
  THIS_DEVICE_TAG,
} from "./label-copy";
import { deviceDisplay, devicePhrase, hasDuplicateTitles } from "./labels";
import { NameDeviceDialog } from "./NameDeviceDialog";
import {
  type Interaction,
  useInteractions,
  useListChanges,
  useReturnRefresh,
} from "./ownership";
import { RetireOtherDialog } from "./RetireOtherDialog";
import { useLoad, useOnline } from "./useLoad";
import { WipeConfirmDialog } from "./WipeConfirmDialog";

/**
 * "Devices that sync" (WF-SETTINGS-02). WEB-08d: a device is titled by its BE-Q25 name, else its latest sign-in's client label, else
 * WEB-08a's "This device" / "Another device". The sync capacity is the answer's `sync_capacity` (never the length of the list: a
 * device that only has sessions holds no place). Naming is offered only when the answer shows the server supports it.
 */
export const DEVICES_HEADING = "Devices that sync";
export const DEVICES_EXPLANATION =
  "Separate from the sign-ins above: a device can hold synced content and a place for syncing with no active session at all — its login may simply have expired.";
export const OFFLINE_REASON = "Retiring a device needs a connection.";

export const deviceMeta = (row: DeviceRow, now: Date): string =>
  [
    `${row.active_sessions} active ${row.active_sessions === 1 ? "session" : "sessions"}`,
    row.last_synced_at
      ? `Last synced ${formatAgo(row.last_synced_at, now)}`
      : "Never synced",
  ].join(" · ");

interface Open {
  readonly row: DeviceRow;
  readonly interaction: Interaction;
}

export function DevicesSection() {
  const session = useSession();
  const online = useOnline();
  const [load, reload, refresh] = useLoad(() =>
    session.operations.readDevices(),
  );
  // Review R1: a change made anywhere on this page for this identity (a retirement or a name here, a sign-out in the sessions list,
  // even from a screen since left) may change this list, so it is read again when one is reported.
  useListChanges(reload);
  // WEB08D-NAVIGATION-FRESHNESS-20261011: and quietly when the person comes back to this tab or window.
  useReturnRefresh(refresh);
  const interactions = useInteractions();
  const [retiring, setRetiring] = useState<Open | null>(null);
  const [naming, setNaming] = useState<Open | null>(null);
  // Review R3: each opening of a dialog is its own interaction, and a dialog closes only itself. Closing ends its interaction first,
  // so nothing it began is sent or shown afterwards; a late answer of an older dialog cannot close the one open now.
  const openRetiring = (row: DeviceRow) => {
    retiring?.interaction.end();
    setRetiring({ row, interaction: interactions.begin() });
  };
  const closeRetiring = (interaction: Interaction) => {
    interaction.end();
    setRetiring((open) => (open?.interaction === interaction ? null : open));
  };
  const openNaming = (row: DeviceRow) => {
    naming?.interaction.end();
    setNaming({ row, interaction: interactions.begin() });
  };
  const closeNaming = (interaction: Interaction) => {
    interaction.end();
    setNaming((open) => (open?.interaction === interaction ? null : open));
  };
  const now = new Date();
  // BE-Q25 servers carry `sync_capacity` in every answer; an older server has no naming endpoint, so no control is offered.
  const canName =
    load.status === "ready" && Object.hasOwn(load.value, "sync_capacity");

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
        {load.status === "ready" ? (
          <CapacityLine kind="devices" raw={load.value.sync_capacity} />
        ) : null}
      </div>
      {load.status === "loading" ? (
        <p aria-busy="true" className="text-[13px] text-ink-2">
          Loading your devices…
        </p>
      ) : load.status === "error" ? (
        <LoadFailed what="your devices" error={load.error} onRetry={reload} />
      ) : (
        <>
          {canName && hasDuplicateTitles(load.value.devices) ? (
            <p
              data-duplicate-hint=""
              className="text-[12.5px] leading-[1.6] text-ink-2"
            >
              {DUPLICATE_HINT}
            </p>
          ) : null}
          <List className="flex flex-col gap-2">
            {load.value.devices.map((row) => {
              const display = deviceDisplay(row);
              const phrase = devicePhrase(row, now);
              const retireLabel = `Retire ${phrase}`;
              const nameLabel = `${display.named ? "Rename" : "Name"} ${phrase}`;
              const nameText = display.named ? RENAME_ACTION : NAME_ACTION;
              return (
                <li
                  key={row.id}
                  data-device-row={row.current ? "current" : "other"}
                  className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[14px] text-ink-1 [overflow-wrap:anywhere]">
                        {display.named ? (
                          <bdi data-device-name="">{display.title}</bdi>
                        ) : (
                          display.title
                        )}
                        {row.current ? (
                          <span
                            data-current-tag=""
                            className="ml-2 text-[12px] text-ink-2"
                          >
                            {THIS_DEVICE_TAG}
                          </span>
                        ) : null}
                      </span>
                      {display.named && display.label ? (
                        <span
                          data-device-label=""
                          className="text-[12.5px] text-ink-2"
                        >
                          {display.label}
                        </span>
                      ) : null}
                      <span className="text-[12.5px] text-ink-2">
                        {deviceMeta(row, now)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      {canName ? (
                        online ? (
                          <Button
                            aria-label={nameLabel}
                            onClick={() => {
                              // The hook's state can lag the browser by a render.
                              if (navigator.onLine) openNaming(row);
                            }}
                          >
                            {nameText}
                          </Button>
                        ) : (
                          <Button
                            disabled
                            reason={NAME_OFFLINE_REASON}
                            aria-label={nameLabel}
                          >
                            {nameText}
                          </Button>
                        )
                      ) : null}
                      {online ? (
                        <Button
                          aria-label={retireLabel}
                          onClick={() => openRetiring(row)}
                        >
                          Retire…
                        </Button>
                      ) : (
                        <Button
                          disabled
                          reason={OFFLINE_REASON}
                          aria-label={retireLabel}
                        >
                          Retire…
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </List>
        </>
      )}
      {retiring?.row.current ? (
        <WipeConfirmDialog
          key={retiring.interaction.id}
          kind="retire"
          device={retiring.row}
          onClose={() => closeRetiring(retiring.interaction)}
        />
      ) : retiring ? (
        <RetireOtherDialog
          key={retiring.interaction.id}
          device={retiring.row}
          interaction={retiring.interaction}
          onClose={() => closeRetiring(retiring.interaction)}
        />
      ) : null}
      {naming ? (
        <NameDeviceDialog
          key={naming.interaction.id}
          device={naming.row}
          interaction={naming.interaction}
          onClose={() => closeNaming(naming.interaction)}
        />
      ) : null}
    </section>
  );
}
