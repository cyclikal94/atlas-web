import { Dialog } from "../../../components/ui/dialog";
import { useSession } from "../../../session";
import { LoadFailed } from "../sessions-devices/LoadFailed";
import { useLoad } from "../sessions-devices/useLoad";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { LinkedIdentities } from "./LinkedIdentities";
import { signingInExtras } from "./slots";

/**
 * WF-SETTINGS-03, "Signing in": the password and the linked single-sign-on identities of the account. Both actions that end
 * a session do so everywhere, including here, and each says so before it is pressed. The dialog reads `GET /me` fresh on
 * every open; a `closed` or `auth_state` answer means the tree is going and nothing about the account is drawn.
 */
function SigningInBody() {
  const session = useSession();
  const [account, reload] = useLoad(() => session.operations.readAccount());
  const [sessions] = useLoad(() => session.operations.listSessions());
  if (account.status === "loading")
    return (
      <p aria-busy="true" className="text-[13px] text-ink-2">
        Loading how you sign in…
      </p>
    );
  if (account.status === "error")
    return account.error.cause === "closed" ||
      account.error.cause === "auth_state" ? null : (
      <LoadFailed
        what="how you sign in"
        error={account.error}
        onRetry={reload}
      />
    );
  const startedAt =
    sessions.status === "ready"
      ? (sessions.value.sessions.find((row) => row.current)?.created_at ?? null)
      : null;
  return (
    <div className="flex flex-col gap-6">
      <ChangePasswordForm hasPassword={account.value.has_password} />
      <LinkedIdentities
        account={account.value}
        currentSessionStartedAt={startedAt}
      />
      {signingInExtras.map((extra) => (
        <div key={extra.id}>{extra.render()}</div>
      ))}
    </div>
  );
}

export function SigningInDialog({
  open,
  onClose,
  onCloseAutoFocus,
}: {
  open: boolean;
  onClose(): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      title="Signing in"
    >
      <SigningInBody />
    </Dialog>
  );
}
