/**
 * The neutral entry: everything the production build shows until WEB-08 supplies sign-in. It shows nothing about
 * any account. The line below is provisional and is replaced by WEB-08b.
 */
export function NeutralEntry() {
  return (
    <main className="mx-auto flex max-w-[620px] flex-col gap-3 px-5 py-16">
      <h1 className="text-[30px] font-semibold tracking-[-0.025em] text-ink-1">
        Atlas
      </h1>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        Sign-in isn't available in this build yet.
      </p>
    </main>
  );
}
