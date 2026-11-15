import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.ACME_SERVER_URL ?? 'http://127.0.0.1:8787';
// `npm run dev` serves the app on a tunnel origin; Vite answers only hosts it is told about.
const publicHost = process.env.ACME_PUBLIC_URL ? new URL(process.env.ACME_PUBLIC_URL).hostname : null;

// In development the web app and the API share one origin through this proxy, as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: publicHost === null ? [] : [publicHost],
    proxy: { '/api': server, '/mcp': server, '/webhooks': server },
  },
});
