import { PageHeading } from "../components/ui/page-heading";
import { CacheGate } from "../features/sync/CacheGate";
import { NoticeList } from "../features/sync/NoticeBanners";

/**
 * FIXTURE ONLY. A page with one view that reads from the cache, wrapped in the CacheGate, and the notices above it, driven by the
 * data double's `?state=` (`gate`, `gate-floor`, `floor-a`, `floor-b`, ...). The shell, navigation and drafts are NOT gated: they
 * are not drawn here because they are not cache-sourced.
 */
export function GateGallery() {
  return (
    <main className="flex max-w-[760px] flex-col gap-4 p-6">
      <PageHeading>Gate</PageHeading>
      <NoticeList />
      <CacheGate>
        <section
          aria-labelledby="cached-heading"
          className="rounded-lg border border-border bg-card p-3.5"
        >
          <h2
            id="cached-heading"
            className="text-sm font-medium text-foreground"
          >
            Tasks
          </h2>
          <p className="text-sm text-muted-foreground">
            Water plants · Take bins out
          </p>
        </section>
      </CacheGate>
    </main>
  );
}
