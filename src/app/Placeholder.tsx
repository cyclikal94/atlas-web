import { Sparkles } from "lucide-react";
import { EmptyState } from "../components/ui/empty-state";
import { PageHeading } from "../components/ui/page-heading";

/** A destination whose feature slice has not shipped. Neutral: it renders no account data. */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="atlas-enter flex max-w-[620px] flex-col gap-6">
      <PageHeading>{title}</PageHeading>
      <EmptyState icon={Sparkles}>
        This area arrives in a later release.
      </EmptyState>
    </div>
  );
}
