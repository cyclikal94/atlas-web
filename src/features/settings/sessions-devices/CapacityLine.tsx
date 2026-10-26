import {
  SESSIONS_FULL,
  SESSIONS_UNAVAILABLE,
  SYNC_FULL,
  SYNC_UNAVAILABLE,
  sessionsLimited,
  sessionsUnlimited,
  syncLimited,
  syncUnlimited,
} from "./label-copy";
import { type CapacityReading, decodeCapacity } from "./labels";

/** D-8d-11: the line for one reading. The devices line is `sync_capacity` alone, never the number of listed devices. */
export function capacityText(
  kind: "sessions" | "devices",
  reading: CapacityReading,
): string {
  const sessions = kind === "sessions";
  switch (reading.kind) {
    case "unavailable":
      return sessions ? SESSIONS_UNAVAILABLE : SYNC_UNAVAILABLE;
    case "unlimited":
      return sessions
        ? sessionsUnlimited(reading.used)
        : syncUnlimited(reading.used);
    case "limited": {
      const line = sessions
        ? sessionsLimited(reading.used, reading.limit)
        : syncLimited(reading.used, reading.limit);
      if (reading.remaining > 0) return line;
      return `${line} ${sessions ? SESSIONS_FULL : SYNC_FULL}`;
    }
  }
}

/**
 * One section's capacity, drawn only from that section's READY answer (the caller renders it only then): nothing is shown while
 * loading, after an error, or from an earlier answer, so a reading is never presented as current when it is not. It is an observation,
 * not a reservation, and the words never promise a place.
 */
export function CapacityLine({
  kind,
  raw,
}: {
  kind: "sessions" | "devices";
  /** The answer's member as received; `undefined` when the answer had none (an older server). */
  raw: unknown;
}) {
  return (
    <p
      data-capacity={kind}
      className="text-xs leading-relaxed text-muted-foreground"
    >
      {capacityText(kind, decodeCapacity(raw))}
    </p>
  );
}
