import { Button } from "../../../components/ui/button";
import * as copy from "../copy";

/**
 * A read of this device's data that failed or kept changing (WEB-10a decision 31): with an earlier complete read, what is shown is that one,
 * marked stale; without one, nothing is known. Either way, Try again reads everything again. Never "none".
 */
export function ReadNotice({
  error,
  stale,
  retry,
}: {
  error: "failed" | "unstable";
  stale: boolean;
  retry(): void;
}) {
  return (
    <div
      className="flex flex-col gap-2"
      {...(stale ? { "data-list-stale": error } : { "data-list-error": error })}
    >
      <p className="text-[12.5px] text-ink-2">
        {error === "unstable" ? copy.LOCAL_UNSTABLE : copy.LOCAL_FAILED}
        {stale ? ` ${copy.SHOWING_LAST_READ}` : ""}
      </p>
      <span>
        <Button onClick={retry}>{copy.TRY_AGAIN}</Button>
      </span>
    </div>
  );
}
