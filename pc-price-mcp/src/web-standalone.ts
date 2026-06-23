#!/usr/bin/env node
/**
 * Standalone web dashboard server — no MCP stdio transport.
 * Use this to run the dashboard as a persistent NAS service:
 *
 *   node dist/web-standalone.js
 *
 * Starts the background scheduler (if configured) and the web UI on WEB_PORT.
 */
import { startScheduler } from './scheduler.js';
import { startWebServer } from './web.js';

startScheduler();

const port = parseInt(process.env.WEB_PORT ?? '3000');
startWebServer(port);
