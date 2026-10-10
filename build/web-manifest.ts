/**
 * The installable web app (WEB-14a; WEB-03 3.7a item 3): served as `/manifest.webmanifest` (nginx: `no-cache`, its MIME type), linked from
 * the shell by the plugin, and precached with the icons. Installability does not depend on notification permission.
 */
export const webManifest = {
  id: "/",
  name: "Atlas",
  short_name: "Atlas",
  description: "Atlas: tasks, shared work and calendars, offline too.",
  start_url: "/",
  scope: "/",
  display: "standalone" as const,
  background_color: "#08090A",
  theme_color: "#08090A",
  lang: "en-GB",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    {
      src: "/icons/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
    { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
  ],
};
