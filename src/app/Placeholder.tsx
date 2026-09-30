import { PageHeading } from "../components/ui/page-heading";

/** A destination whose feature slice has not shipped. Neutral: it renders no account data. */
export function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex max-w-[620px] flex-col gap-3">
      <PageHeading>{title}</PageHeading>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        This area arrives in a later release.
      </p>
    </div>
  );
}
