import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const target = process.env.CAXIO_DEV_SERVER_ORIGIN;
  return {
    plugins: [react()],
    server: { proxy: target ? { "/ws": { target, ws: true } } : undefined },
  };
});
