import { Link } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { buttonVariants } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { PageHeading } from "../components/ui/page-heading";

export function NotFound() {
  return (
    <div className="atlas-enter flex max-w-[620px] flex-col gap-6">
      <PageHeading>Page not found</PageHeading>
      <EmptyState
        icon={Compass}
        action={
          <Link to="/today" className={buttonVariants({ variant: "default" })}>
            Go to Today
          </Link>
        }
      >
        Nothing lives at this address.
      </EmptyState>
    </div>
  );
}
