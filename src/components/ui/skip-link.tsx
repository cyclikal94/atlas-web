/** The first focusable element. Hidden until focused; activation moves focus to <main id="main">. */
export function SkipLink() {
  return (
    // biome-ignore lint/a11y/useValidAnchor: a skip link is an in-page anchor; the handler only moves focus, so the URL fragment (which carries the OIDC grant) is never changed
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2.5 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("main")?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
