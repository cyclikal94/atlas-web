import { Button } from "../../components/ui/button";
import { appUpdates, updateReady, useAppUpdate } from "./store";

/** PROPOSED copy (WEB-14a D-P9, design gap G-6 style: no accepted wireframe has it). */
export const UPDATE_READY_TEXT = "A new version of Atlas is ready.";
export const UPDATE_READY_ACTION = "Reload to update";

/**
 * The update action offered where the server's API version has paused Atlas (the API compatibility screen and the `compat_paused`
 * banner): a mismatch is lifted by a client build whose range includes the server's version (delivery-slices case 3). Shown only while a
 * newer version can be loaded; the reload is the person's choice, and unfinished forms are saved first (the coordinator's `accept`).
 * A `missing` version is not lifted by an update, and this says nothing about it.
 */
export function UpdateReady() {
  const state = useAppUpdate();
  if (!updateReady(state)) return null;
  return (
    <div data-update-ready="" className="flex flex-wrap items-center gap-2">
      <p className="text-[14px] leading-[1.6] text-ink-1">
        {UPDATE_READY_TEXT}
      </p>
      <Button variant="primary" onClick={() => appUpdates.actions()?.accept()}>
        {UPDATE_READY_ACTION}
      </Button>
    </div>
  );
}

export default UpdateReady;
