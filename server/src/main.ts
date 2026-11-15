import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { loadConfig } from './config';
import { createContext } from './context-factory';
import { connectDatabase } from './db/client';

const config = loadConfig();
const database = connectDatabase(config.databaseUrl);
const app = createApp(createContext(config, database.db));

// In production the server also serves the built web app, so everything shares one origin.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (config.production && existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Acme Pay server listening on http://${info.address}:${info.port} (app at ${config.publicUrl})`);
});

function shutdown(): void {
  server.close(() => {
    void database.close().then(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
