/**
 * Express HTTP server — web dashboard for the UK PC Price MCP.
 * Binds to 0.0.0.0 so it's accessible on the local network (NAS use).
 * Serves static files from ../public and REST API at /api/*.
 */
import express, { Request, Response, NextFunction } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import { searchWithRetry } from './sources/pricesapi.js';
import { searchAllUkRetailers, ALL_RETAILER_IDS } from './sources/uk-retailers.js';
import { getSchedulerStatus, restartScheduler, stopScheduler } from './scheduler.js';
import { notifyAll } from './notifications.js';
import {
  exportPriceHistoryCsv, exportPriceHistoryJson,
  exportBuildCsv, exportBuildJson, exportTrackedComponentsCsv,
} from './export.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Wrap async route handlers — Express 5 propagates thrown errors automatically,
// but this keeps the pattern explicit and compatible with Express 4 too.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Express 5 types params as string | string[] — normalise to string.
function param(p: string | string[]): string {
  return Array.isArray(p) ? p[0] : p;
}

export function startWebServer(port: number): void {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // ── Components ───────────────────────────────────────────────────────────

  app.get('/api/components', h(async (_req, res) => {
    const components = db.getTrackedComponents();
    const result = components.map(c => {
      const latest = db.getLatestPricePerRetailer(c.id);
      const best = latest[0] ?? null;
      return {
        ...c,
        best_price: best?.price ?? null,
        best_retailer: best?.retailer ?? null,
        best_in_stock: best?.in_stock ?? null,
        best_currency: best?.currency ?? 'GBP',
        best_url: best?.url ?? null,
      };
    });
    res.json(result);
  }));

  app.post('/api/components', h(async (req, res) => {
    const { name, search_query, category = 'other', alert_price, notes } = req.body;
    if (!name || !search_query) {
      res.status(400).json({ error: 'name and search_query are required' });
      return;
    }
    const component = db.addTrackedComponent(name, category, search_query,
      alert_price ? Number(alert_price) : undefined, notes);
    res.json(component);
  }));

  app.delete('/api/components/:id', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    const removed = db.removeTrackedComponent(id);
    res.json({ removed });
  }));

  app.patch('/api/components/:id/alert', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    const { alert_price } = req.body;
    db.updateAlertPrice(id, alert_price != null ? Number(alert_price) : null);
    res.json({ ok: true });
  }));

  app.post('/api/components/:id/refresh', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    const component = db.getTrackedComponentById(id);
    if (!component) { res.status(404).json({ error: 'Component not found' }); return; }

    const country = (req.body?.country as string) ?? db.getConfig('default_country') ?? 'gb';
    const { products } = await searchWithRetry(component.search_query, country, 3, 15);
    const snapshots: db.PriceSnapshot[] = [];

    for (const p of products) {
      for (const o of p.offers) {
        if (o.price > 0) {
          snapshots.push({
            source: 'pricesapi', price: o.price, currency: o.currency,
            retailer: o.merchant, url: o.url || null, inStock: o.inStock,
          });
        }
      }
    }
    if (snapshots.length > 0) {
      db.savePriceSnapshots(id, snapshots);
      db.markLastChecked(id);
    }

    const latest = db.getLatestPricePerRetailer(id);
    res.json({ saved: snapshots.length, products: products.length, latest });
  }));

  app.get('/api/components/:id/history', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    const days = parseInt(req.query.days as string) || 30;
    const history = db.getPriceHistory(id, days);
    const trend = db.getDailyPriceTrend(id, days);
    res.json({ history, trend });
  }));

  app.get('/api/components/:id/stats', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    res.json(db.getPriceStats(id));
  }));

  app.get('/api/components/:id/latest', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    res.json(db.getLatestPricePerRetailer(id));
  }));

  // ── Search ───────────────────────────────────────────────────────────────

  app.get('/api/search/retailers', h(async (req, res) => {
    const query = req.query.q as string;
    if (!query) { res.status(400).json({ error: 'q is required' }); return; }
    const rawRetailers = req.query.retailers as string;
    const retailers = rawRetailers ? rawRetailers.split(',') : [...ALL_RETAILER_IDS];
    const results = await searchAllUkRetailers(query, retailers as Parameters<typeof searchAllUkRetailers>[1]);
    res.json(results);
  }));

  app.get('/api/search/api', h(async (req, res) => {
    const query = req.query.q as string;
    if (!query) { res.status(400).json({ error: 'q is required' }); return; }
    const country = (req.query.country as string) ?? 'gb';
    const result = await searchWithRetry(query, country, 5, 10);
    res.json(result);
  }));

  // ── Builds ───────────────────────────────────────────────────────────────

  app.get('/api/builds', h(async (_req, res) => {
    const builds = db.getBuilds();
    const result = builds.map(b => {
      const summary = db.getBuildSummary(b.id);
      return {
        ...b,
        item_count: summary?.items.length ?? 0,
        total_cost: summary?.totalCost ?? 0,
        missing_prices: summary?.missingPrices ?? 0,
      };
    });
    res.json(result);
  }));

  app.post('/api/builds', h(async (req, res) => {
    const { name, description } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    res.json(db.createBuild(name, description));
  }));

  app.get('/api/builds/:id', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    const summary = db.getBuildSummary(id);
    if (!summary) { res.status(404).json({ error: 'Build not found' }); return; }
    // Convert Map to plain object for JSON serialisation
    const bestPrices: Record<number, unknown> = {};
    for (const [cid, p] of summary.bestPrices) bestPrices[cid] = p;
    res.json({ ...summary, bestPrices });
  }));

  app.delete('/api/builds/:id', h(async (req, res) => {
    const id = parseInt(param(req.params.id));
    db.deleteBuild(id);
    res.json({ ok: true });
  }));

  app.post('/api/builds/:id/items', h(async (req, res) => {
    const buildId = parseInt(param(req.params.id));
    const { component_id, quantity = 1, notes } = req.body;
    if (!component_id) { res.status(400).json({ error: 'component_id is required' }); return; }
    db.addBuildItem(buildId, parseInt(component_id), parseInt(quantity), notes);
    res.json({ ok: true });
  }));

  app.delete('/api/builds/:buildId/items/:componentId', h(async (req, res) => {
    db.removeBuildItem(parseInt(param(req.params.buildId)), parseInt(param(req.params.componentId)));
    res.json({ ok: true });
  }));

  // ── Scheduler ─────────────────────────────────────────────────────────────

  app.get('/api/scheduler', h(async (_req, res) => {
    res.json(getSchedulerStatus());
  }));

  app.post('/api/scheduler', h(async (req, res) => {
    const mins = parseInt(req.body.interval_minutes);
    if (isNaN(mins) || mins === 0) {
      db.deleteConfig('auto_refresh_interval_minutes');
      stopScheduler();
      res.json({ ok: true, active: false });
    } else if (mins < 1) {
      res.status(400).json({ error: 'Minimum interval is 1 minute' });
    } else {
      db.setConfig('auto_refresh_interval_minutes', String(mins));
      restartScheduler();
      res.json({ ok: true, active: true, intervalMinutes: mins });
    }
  }));

  // ── Config ────────────────────────────────────────────────────────────────

  app.get('/api/config', h(async (_req, res) => {
    const config = db.getAllConfig();
    // Mask webhook URLs — return only a presence indicator
    const safe: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(config)) {
      safe[k] = k.includes('webhook_url') ? Boolean(v) : v;
    }
    res.json(safe);
  }));

  app.post('/api/config', h(async (req, res) => {
    const { key, value } = req.body;
    if (!key) { res.status(400).json({ error: 'key is required' }); return; }
    if (value === null || value === '' || value === undefined) {
      db.deleteConfig(key);
    } else {
      db.setConfig(key, String(value));
    }
    if (key === 'auto_refresh_interval_minutes') restartScheduler();
    res.json({ ok: true });
  }));

  // ── Notifications ─────────────────────────────────────────────────────────

  app.post('/api/notifications/test', h(async (_req, res) => {
    const result = await notifyAll({
      type: 'test',
      componentName: 'Test Component',
      message: 'Test notification from UK PC Price MCP web dashboard.',
    });
    res.json(result);
  }));

  // ── Price intelligence ────────────────────────────────────────────────────

  app.get('/api/alerts', h(async (_req, res) => {
    res.json(db.getComponentsBelowAlertPrice());
  }));

  app.get('/api/price-drops', h(async (req, res) => {
    const minPct = parseFloat(req.query.min_percent as string) || 2;
    res.json(db.getRecentPriceDrops(minPct));
  }));

  app.get('/api/stock-changes', h(async (req, res) => {
    const hours = parseInt(req.query.hours as string) || 24;
    res.json(db.getRecentStockChanges(hours));
  }));

  // ── Waitlist ──────────────────────────────────────────────────────────────

  app.get('/api/waitlist', h(async (_req, res) => {
    res.json(db.getWaitlist());
  }));

  app.post('/api/waitlist', h(async (req, res) => {
    const { component_id, retailer, max_price } = req.body;
    if (!component_id) { res.status(400).json({ error: 'component_id is required' }); return; }
    const item = db.addToWaitlist(parseInt(component_id), retailer, max_price);
    res.json(item);
  }));

  app.delete('/api/waitlist/:componentId', h(async (req, res) => {
    db.removeFromWaitlist(parseInt(param(req.params.componentId)));
    res.json({ ok: true });
  }));

  // ── Export ────────────────────────────────────────────────────────────────

  app.get('/api/export', h(async (req, res) => {
    const { type, format = 'csv', id, days = '90' } = req.query as Record<string, string>;
    const numId = id ? parseInt(id) : undefined;
    const numDays = parseInt(days) || 90;

    let filePath: string;
    if (type === 'price_history') {
      if (!numId) { res.status(400).json({ error: 'id required for price_history' }); return; }
      filePath = format === 'json' ? exportPriceHistoryJson(numId, numDays) : exportPriceHistoryCsv(numId, numDays);
    } else if (type === 'build') {
      if (!numId) { res.status(400).json({ error: 'id required for build' }); return; }
      filePath = format === 'json' ? exportBuildJson(numId) : exportBuildCsv(numId);
    } else {
      filePath = exportTrackedComponentsCsv();
    }

    res.download(filePath);
  }));

  // ── Error handler ─────────────────────────────────────────────────────────

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[web error]', err.message);
    res.status(500).json({ error: err.message });
  });

  app.listen(port, '0.0.0.0', () => {
    console.error(`[web] Dashboard → http://0.0.0.0:${port}`);
  });
}
