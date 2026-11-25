FROM oven/bun:alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS build
WORKDIR /build
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web && bun --bun run build
RUN bun build apps/server/src/main.ts --target=bun --outfile=/build/server/main.js

FROM oven/bun:alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b
COPY --from=build /build/apps/web/dist/ /app/web/dist/
COPY --from=build /build/server/main.js /app/server/main.js
ENTRYPOINT ["bun", "/app/server/main.js"]
