// All data is fetched client-side via Socket.IO and REST API after hydration.
// Disable SSR so the static adapter generates plain HTML shells.
export const ssr = false;
export const prerender = true;
