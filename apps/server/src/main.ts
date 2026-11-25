// Toolchain placeholder: replace with the authoritative game server.
// Bun.serve takes its port from $PORT (default 3000).
const server = Bun.serve({
  fetch: () => new Response("ok\n"),
});

console.log(`listening on ${server.url}`);
