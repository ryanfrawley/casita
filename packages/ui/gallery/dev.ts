// The gallery: every token and component in both themes, for reviewing the port against the
// design system. `bun run ui:gallery`.

import index from "./index.html";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 5174),
  development: true,
  routes: { "/*": index },
});
console.log(`gallery: ${server.url}`);
