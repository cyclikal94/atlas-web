import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { useSharingDefaults } from "../../../data";
import * as base from "../copy";
import { useSharingEnv } from "../env";
import { Banner } from "../parts";
import { householdPath, invitationsPath } from "../route";
import { useHouseholdsEnv } from "./env";
import {
  type HouseholdsMemory,
  type Read,
  readHouseholds,
  readInvitations,
  readSignup,
  type Unresolved,
  useHouseholdsMemory,
  walkSent,
} from "./memory";
import {
  type Ctx,
  refusal,
  reloadAll,
  retry,
  retryRefusal,
  unresolvedOf,
} from "./operations";

/** The route paths of the household screens (D-12b-1); the two public ones are the route module's. */
export { householdPath, invitationsPath };
export const signupPath = (id: string): string => `${householdPath(id)}/signup`;
export const renamePath = (id: string): string => `${householdPath(id)}/rename`;
export const NEW_PATH = "/sharing/new";

/**
 * Everything a household screen needs, for the identity displayed NOW: its page memory (re-rendered on every change), the operation
 * context, and the env. Each render records the live connection and compatibility in the memory, so a continuation that finishes after
 * a remount checks them as they are now (DA-H1).
 */
export function useHouseholds() {
  const env = useSharingEnv();
  const { api } = useHouseholdsEnv();
  const defaults = useSharingDefaults();
  const announcer = useAnnouncer();
  const navigate = useNavigate();
  const memory = useHouseholdsMemory(env.identity);
  memory.live = {
    identity: env.identity,
    online: env.online,
    writable: env.writable,
    now: env.now,
  };
  const ctx: Ctx = {
    memory,
    api,
    accountId: env.accountId,
    defaults,
    announce: (text) => announcer.announce(text),
    newId: env.newId,
    go: (path) => void navigate({ to: path } as never),
  };
  return { env, api, memory, ctx, defaults };
}

export type ReadKind = "households" | "invitations" | "sent" | "signup";
const READERS: Readonly<
  Record<ReadKind, (memory: HouseholdsMemory, api: Ctx["api"]) => Promise<void>>
> = {
  households: readHouseholds,
  invitations: readInvitations,
  sent: walkSent,
  signup: readSignup,
};

/**
 * The reads a screen owns: asked once when it mounts (unless one of the kind is already on its way) and once on each reconnection. Never
 * again by itself: a remount is the only way a screen asks twice (a `403` remounts it once), so no answer can make it read in a loop.
 */
export function useAsk(ctx: Ctx, online: boolean, kinds: readonly ReadKind[]) {
  const { memory, api } = ctx;
  const asked = useRef<string | null>(null);
  const key = kinds.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked per mount and per reconnection; `kinds` is fixed per caller
  useEffect(() => {
    if (!online) {
      asked.current = null;
      return;
    }
    if (asked.current === `${memory.identity}|${key}`) return;
    asked.current = `${memory.identity}|${key}`;
    for (const kind of kinds)
      if (memory[kind].status !== "loading") void READERS[kind](memory, api);
  }, [online, memory, key]);
}

/** Why nothing can be sent now (offline, the server's version, an operation running, an unresolved attempt), or null. */
export const blockedReason = (memory: HouseholdsMemory): string | null =>
  refusal(memory, false);

/**
 * The unresolved attempt (R8), with its own Try again and Reload. Shown on the page and in every household dialog: nothing new is sent
 * until it is resolved, so wherever the person is, this is what they can do. `onRetried` hears the attempt a Try again pressed HERE
 * completed (made, not refused): the dialog it was pressed in finishes as its first try would have (review 1 F-R1-2).
 */
export function UnresolvedBanner({
  ctx,
  onRetried,
}: {
  ctx: Ctx;
  onRetried?: (completed: Unresolved) => void;
}) {
  const { memory } = ctx;
  const unresolved = unresolvedOf(memory);
  if (unresolved === null) return null;
  const retryBlocked = retryRefusal(memory);
  return (
    <div data-households-unresolved="">
      <Banner
        message={
          unresolved.sent && !unresolved.heldBack
            ? base.UNCERTAIN
            : base.NOT_SENT
        }
        action={
          <span className="flex flex-wrap gap-2">
            {retryBlocked !== null ? (
              <Button disabled reason={retryBlocked}>
                {base.TRY_AGAIN}
              </Button>
            ) : (
              <Button
                onClick={() =>
                  void retry(ctx).then((completed) => {
                    if (completed !== null) onRetried?.(completed);
                  })
                }
              >
                {base.TRY_AGAIN}
              </Button>
            )}
            <Button
              variant="ghost"
              // Shows the lists again; the unconfirmed change stays to be tried again (R8).
              onClick={() => reloadAll(ctx)}
            >
              {base.RELOAD}
            </Button>
          </span>
        }
      />
    </div>
  );
}

/**
 * Whether `read` FAILED with nothing landed on this page (WF-SHARING-01's Er state, review 1 F-R1-1): a screen that needs it shows the
 * failure with its own Try again (`ReadFailed`), never "Loading…". Offline the screen says it needs a connection instead (the read is
 * asked again on reconnection: `useAsk`); a read that once landed keeps showing that answer with its time.
 */
export const failedUnread = (read: Read<unknown>, online: boolean): boolean =>
  online && read.status === "failed" && read.last === null;

/**
 * A failed read (`failedUnread`): what could not be read, its copyable request id, and a Try again that asks it again (the same reader
 * the screen's mount asked: `READERS`). A Try again while one is already on its way is not offered twice: the read is then `loading`
 * and the screen shows its loading line.
 */
export function ReadFailed({
  ctx,
  kind,
  message,
}: {
  ctx: Ctx;
  kind: ReadKind;
  message: string;
}) {
  const failure = ctx.memory[kind].failure;
  return (
    <div data-households-read-failed={kind}>
      <Banner
        message={message}
        requestId={
          failure !== null && "requestId" in failure
            ? failure.requestId
            : undefined
        }
        action={
          <Button onClick={() => void READERS[kind](ctx.memory, ctx.api)}>
            {base.TRY_AGAIN}
          </Button>
        }
      />
    </div>
  );
}

/** The last problem of `surface`, with its copyable request id. */
export function ProblemBanner({
  memory,
  surface,
}: {
  memory: HouseholdsMemory;
  surface: string;
}) {
  const problem = memory.problems.get(surface);
  if (problem === undefined) return null;
  return (
    <div data-households-problem={surface}>
      <Banner message={problem.message} requestId={problem.requestId} />
    </div>
  );
}

/** A small, stated reason line (the role or rule that makes an action unavailable). */
export function Note({ children }: { children: string }) {
  return (
    <p className="text-xs leading-[1.55] text-muted-foreground">{children}</p>
  );
}
