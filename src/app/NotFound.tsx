import { Link } from "@tanstack/react-router";
import { PageHeading } from "../components/ui/page-heading";

export function NotFound() {
  return (
    <div className="flex max-w-[620px] flex-col gap-3">
      <PageHeading>Page not found</PageHeading>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        Nothing lives at this address.
      </p>
      <Link
        to="/today"
        className="w-fit text-[14px] text-action-ink underline underline-offset-2"
      >
        Go to Today
      </Link>
    </div>
  );
}
