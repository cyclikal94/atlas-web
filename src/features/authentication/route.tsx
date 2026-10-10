import { type AnyRoute, createRoute, Link } from "@tanstack/react-router";
import { PageHeading } from "../../components/ui/page-heading";
import { JOIN_PATH } from "./public-route";

/** [P] (design gap G-14 family): what `/join` says to someone who is already signed in on this browser. */
export const JOIN_WHILE_SIGNED_IN_HEADING = "You're signed in on this browser";
export const JOIN_WHILE_SIGNED_IN_BODY =
  "Sign out first, then open the invitation link again. Atlas keeps the link in this tab until you do.";

/**
 * `/join` inside the protected tree. A person who is signed in never registers: no registration runs while an account
 * displays, and this page says why. It shows nothing about the invitation and nothing about any account.
 */
function JoinWhileSignedIn() {
  return (
    <div className="flex max-w-[620px] flex-col gap-3">
      <PageHeading>{JOIN_WHILE_SIGNED_IN_HEADING}</PageHeading>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        {JOIN_WHILE_SIGNED_IN_BODY}
      </p>
      <Link
        to="/settings"
        className="w-fit text-[14px] text-action-ink underline underline-offset-2"
      >
        Go to Settings
      </Link>
    </div>
  );
}

export const joinRoute = (parent: AnyRoute) =>
  createRoute({
    getParentRoute: () => parent,
    path: JOIN_PATH.slice(1),
    component: JoinWhileSignedIn,
  });
