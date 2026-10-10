import { emptyOverlay, foldEffect, type Overlay } from "../model/overlay";
import type { ResourceId } from "../model/types";
import { type Reader, range } from "../store/port";

/**
 * The overlays of a PAGE of resources, read in WINDOWS (R14).
 *
 * `readResourceList` used to read every pending effect of the account, however many, and group them. What it reads now is only the
 * effects of the resources it is about to show, a window of `window` rows at a time, each folded into that resource's small state
 * (`foldEffect`) and dropped, so what is in hand at once is the window plus one state per displayed resource, whatever the size of the
 * queue and however many changes lie over one resource. Nothing is capped and no change is skipped: every effect of every shown
 * resource is read once, and a resource's state is exactly what the sequential merge would have produced.
 *
 * The lookup is by the `resource_id` index, which returns entries in key order and then primary-key order. A window of `anyOf` is
 * therefore the first `window` entries of the ids still unread: every resource before the last one in it is COMPLETE, and the last
 * may have more. Those are walked by offset (the whole read is ONE transaction, so nothing moves under an offset), and the lookup
 * then goes on with the ids after it. Each round reads a full window or ends the lookup, so it terminates in at most
 * (effects / window) + (resources) reads.
 */
export async function readOverlays(
  reader: Reader,
  ids: readonly ResourceId[],
  window: number,
): Promise<Map<ResourceId, Overlay>> {
  const overlays = new Map<ResourceId, Overlay>();
  for (const id of ids) overlays.set(id, emptyOverlay());
  let remaining = [...overlays.keys()].sort();
  while (remaining.length > 0) {
    const rows = await reader.anyOf(
      "pending_effects",
      "resource_id",
      remaining,
      window,
    );
    for (const effect of rows)
      foldEffect(overlays.get(effect.resource_id) as Overlay, effect);
    // A window that is not full ends the lookup: nothing of what remains is left unread.
    const last = rows[rows.length - 1];
    if (rows.length < window || last === undefined) break;
    // The resource the window ended in may have more: its next entries, a window at a time.
    const open = last.resource_id;
    let seen = rows.filter((effect) => effect.resource_id === open).length;
    for (;;) {
      const more = await reader.byIndex(
        "pending_effects",
        "resource_id",
        range.only(open),
        window,
        seen,
      );
      for (const effect of more)
        foldEffect(overlays.get(open) as Overlay, effect);
      seen += more.length;
      if (more.length < window) break;
    }
    remaining = remaining.filter((id) => id > open);
  }
  return overlays;
}
