#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as db from './db.js';
import { searchWithRetry } from './sources/pricesapi.js';
import {
  scrapeEbayGpuPrices, resolveGpuSlug, listSupportedGpus,
  scrapeEbayComponentPrices, resolveComponentSlug, listSupportedComponents,
} from './sources/pcprice.js';
import { searchAllUkRetailers, ALL_RETAILER_IDS } from './sources/uk-retailers.js';
import { getAmazonPriceHistory } from './sources/camelcamelcamel.js';
import { importPCPartPickerList } from './sources/pcpartpicker.js';
import { notifyAll, sendDiscord, sendSlack } from './notifications.js';
import {
  exportPriceHistoryCsv, exportPriceHistoryJson,
  exportBuildCsv, exportBuildJson, exportTrackedComponentsCsv,
} from './export.js';
import { startScheduler, stopScheduler, restartScheduler, getSchedulerStatus } from './scheduler.js';
import { startWebServer } from './web.js';

// ── Argument schemas ───────────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z.string().min(1),
  country: z.string().default('gb'),
  max_results: z.number().int().min(1).max(10).default(5),
  offers_per_product: z.number().int().min(1).max(20).default(10),
});

const ALL_RETAILER_ENUM = ['scan', 'overclockers', 'ebuyer', 'ccl', 'box', 'novatech', 'aria', 'awdit'] as const;

const UkRetailersSchema = z.object({
  query: z.string().min(1),
  retailers: z
    .array(z.enum(ALL_RETAILER_ENUM))
    .default([...ALL_RETAILER_IDS])
    .describe('Which retailers to query (default: all eight)'),
});

const TrackSchema = z.object({
  name: z.string().min(1),
  search_query: z.string().min(1),
  category: z
    .enum(['gpu', 'cpu', 'ram', 'motherboard', 'storage', 'psu', 'case', 'cooling', 'monitor', 'other'])
    .default('other'),
  alert_price: z.number().positive().optional(),
  notes: z.string().optional(),
  fetch_now: z.boolean().default(true),
  country: z.string().default('gb'),
});

const IdSchema = z.object({ id: z.number().int().positive() });

const SetAlertSchema = z.object({
  id: z.number().int().positive(),
  alert_price: z.number().positive().nullable(),
});

const HistorySchema = z.object({
  id: z.number().int().positive(),
  days: z.number().int().min(1).max(365).default(30),
  show_trend: z.boolean().default(false),
});

const RefreshSchema = z.object({
  id: z.number().int().positive().optional(),
  country: z.string().default('gb'),
});

const EbaySchema = z.object({
  query: z.string().min(1),
  country: z.string().default('gb'),
});

const EbayComponentSchema = z.object({
  query: z.string().min(1),
  category: z.enum(['gpu', 'cpu', 'ram', 'motherboard']).default('gpu'),
  country: z.string().default('gb'),
});

const ListSupportedSchema = z.object({
  category: z.enum(['gpu', 'cpu', 'ram', 'motherboard']).default('gpu'),
});

const PriceDropSchema = z.object({
  min_drop_percent: z.number().min(0).default(2),
});

const CreateBuildSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const AddBuildItemSchema = z.object({
  build_id: z.number().int().positive(),
  component_id: z.number().int().positive(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().optional(),
});

const RemoveBuildItemSchema = z.object({
  build_id: z.number().int().positive(),
  component_id: z.number().int().positive(),
});

const GetBuildSchema = z.object({ id: z.number().int().positive() });

const AmazonSchema = z.object({ query: z.string().min(1) });

const CompareComponentsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(2).max(5),
});

const CompareBuildsSchema = z.object({
  build_ids: z.array(z.number().int().positive()).min(2).max(4),
});

const ExportSchema = z.object({
  type: z.enum(['price_history', 'build', 'tracked_components']),
  format: z.enum(['csv', 'json']).default('csv'),
  id: z.number().int().positive().optional(),
  days: z.number().int().min(1).max(365).default(90),
});

const ImportPCPSchema = z.object({
  url: z.string().min(1),
  create_build: z.boolean().default(true),
  track_components: z.boolean().default(true),
});

const ConfigNotificationsSchema = z.object({
  discord_webhook_url: z.string().nullable().optional(),
  slack_webhook_url: z.string().nullable().optional(),
  notify_drop_percent: z.number().min(0).max(100).optional(),
});

const TestNotificationSchema = z.object({
  channel: z.enum(['discord', 'slack', 'all']).default('all'),
});

const ConfigSchedulerSchema = z.object({
  interval_minutes: z.number().int().min(0).optional(),
  notify_drop_percent: z.number().min(0).max(100).optional(),
});

const WaitlistAddSchema = z.object({
  component_id: z.number().int().positive(),
  retailer: z.string().optional(),
  max_price: z.number().positive().optional(),
});

const WaitlistRemoveSchema = z.object({ component_id: z.number().int().positive() });

const VatModeSchema = z.object({ mode: z.enum(['inc_vat', 'ex_vat']) });

const StockChangesSchema = z.object({
  hours: z.number().int().min(1).max(168).default(24),
});

// ── Helpers ────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$', JPY: '¥',
};

function fmt(amount: number, currency = 'GBP'): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const vatMode = db.getConfig('vat_mode') ?? 'inc_vat';
  const display = vatMode === 'ex_vat' ? amount / 1.2 : amount;
  return `${sym}${display.toFixed(2)}${vatMode === 'ex_vat' ? ' ex-VAT' : ''}`;
}

function fmtRaw(amount: number, currency = 'GBP'): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${sym}${amount.toFixed(2)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function notFound(entity: string, id: number): never {
  throw new McpError(ErrorCode.InvalidRequest, `No ${entity} with ID ${id}`);
}

async function refreshComponent(
  component: db.TrackedComponent,
  country: string,
): Promise<{ saved: number; note: string }> {
  const { products } = await searchWithRetry(component.search_query, country, 3, 15);
  const snapshots: db.PriceSnapshot[] = [];

  for (const product of products) {
    for (const offer of product.offers) {
      if (offer.price > 0) {
        snapshots.push({
          source: 'pricesapi',
          price: offer.price,
          currency: offer.currency,
          retailer: offer.merchant,
          url: offer.url || null,
          inStock: offer.inStock,
        });
      }
    }
  }

  if (snapshots.length > 0) {
    db.savePriceSnapshots(component.id, snapshots);
    db.markLastChecked(component.id);
  }

  return {
    saved: snapshots.length,
    note: products.length === 0
      ? 'No products found for this query'
      : `${products.length} products, ${snapshots.length} offers saved`,
  };
}

// ── Tool catalogue ─────────────────────────────────────────────────────────

const TOOLS = [
  // ── Search ──────────────────────────────────────────────────────────────
  {
    name: 'search_components',
    description:
      'Search UK PC component prices across 40+ retailers via PricesAPI.io (Amazon UK, Scan, Ebuyer, etc.). ' +
      'Cold queries take 30–90s; cached queries return instantly. ' +
      'Results are NOT saved — use track_component to persist and monitor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component name, e.g. "RTX 4080 16GB"' },
        country: { type: 'string', default: 'gb' },
        max_results: { type: 'number', default: 5 },
        offers_per_product: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_uk_retailers',
    description:
      'Directly scrape up to 8 UK retailers in parallel — Scan, Overclockers, Ebuyer, CCL, Box, Novatech, Aria, AWD-IT. ' +
      'No API key required. Best-effort results (JSON-LD and structured data extracted where available). ' +
      'Faster than search_components for new-retail GB pricing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component to search for' },
        retailers: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_RETAILER_ENUM] },
          description: 'Which retailers to query (default: all eight)',
          default: [...ALL_RETAILER_IDS],
        },
      },
      required: ['query'],
    },
  },
  // ── Tracking ─────────────────────────────────────────────────────────────
  {
    name: 'track_component',
    description:
      'Add a PC component to your watchlist. Stored in local SQLite. ' +
      'Optionally fetches current prices immediately to establish a baseline. ' +
      'Set alert_price to be notified when price drops below your target.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        search_query: { type: 'string', description: 'Query string used for price lookups' },
        category: {
          type: 'string',
          enum: ['gpu', 'cpu', 'ram', 'motherboard', 'storage', 'psu', 'case', 'cooling', 'monitor', 'other'],
          default: 'other',
        },
        alert_price: { type: 'number', description: 'Alert threshold in GBP' },
        notes: { type: 'string' },
        fetch_now: { type: 'boolean', default: true },
        country: { type: 'string', default: 'gb' },
      },
      required: ['name', 'search_query'],
    },
  },
  {
    name: 'untrack_component',
    description: 'Remove a component from the watchlist and delete all stored price history.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number', description: 'Component ID from list_tracked' } },
      required: ['id'],
    },
  },
  {
    name: 'list_tracked',
    description: 'List all tracked components with their best current price and alert status.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'set_price_alert',
    description: 'Set or remove a GBP price alert threshold for a tracked component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        alert_price: { type: ['number', 'null'], description: 'GBP threshold, or null to remove' },
      },
      required: ['id', 'alert_price'],
    },
  },
  // ── Price data ────────────────────────────────────────────────────────────
  {
    name: 'get_latest_prices',
    description: 'Latest price per retailer for a tracked component, sorted cheapest first.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'get_price_history',
    description: 'Stored price history for a tracked component. Use show_trend for a daily summary table.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        days: { type: 'number', default: 30 },
        show_trend: { type: 'boolean', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_price_stats',
    description:
      'Price intelligence summary: all-time low/high, 7-day and 30-day averages, current best, and 24h change. ' +
      'Requires price history — run refresh_prices first.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'refresh_prices',
    description:
      'Fetch fresh prices from PricesAPI.io and save to database. ' +
      'Omit id to refresh all tracked components (may take several minutes for cold queries). ' +
      'Displays price change vs previous refresh.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Component ID; omit for all' },
        country: { type: 'string', default: 'gb' },
      },
    },
  },
  {
    name: 'check_price_alerts',
    description: 'Show tracked components whose current best price is at or below their alert threshold.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_price_drops',
    description:
      'Show tracked components where the best price has dropped since the previous check. ' +
      'Compares the last 24h best price against the 24–96h window.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        min_drop_percent: { type: 'number', description: 'Minimum drop % to include (default: 2)', default: 2 },
      },
    },
  },
  // ── eBay ─────────────────────────────────────────────────────────────────
  {
    name: 'get_ebay_gpu_prices',
    description:
      'eBay secondhand GPU prices from pcprice.watch. Median prices from active listings. ' +
      'For CPUs/RAM/motherboards use get_ebay_component_prices.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'GPU model, e.g. "RTX 4080" or "RX 9070 XT"' },
        country: { type: 'string', default: 'gb' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_ebay_component_prices',
    description:
      'eBay secondhand prices from pcprice.watch for any supported category: gpu, cpu, ram, or motherboard. ' +
      'Returns median price from active eBay listings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component model, e.g. "Ryzen 7 7800X3D" or "DDR5 32GB 6000"' },
        category: { type: 'string', enum: ['gpu', 'cpu', 'ram', 'motherboard'], default: 'gpu' },
        country: { type: 'string', default: 'gb' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_supported_gpus',
    description: 'List all GPU models supported by the pcprice.watch eBay scraper.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_supported_components',
    description: 'List all models supported by the pcprice.watch eBay scraper for a given category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['gpu', 'cpu', 'ram', 'motherboard'], default: 'gpu' },
      },
    },
  },
  // ── Amazon price history ──────────────────────────────────────────────────
  {
    name: 'get_amazon_price_history',
    description:
      'Fetch Amazon UK price history from CamelCamelCamel — all-time low/high, 30-day average, and price chart data. ' +
      'Great for spotting whether a current price is a genuine deal.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component to look up, e.g. "RTX 4080 Founders Edition"' },
      },
      required: ['query'],
    },
  },
  // ── Comparison ────────────────────────────────────────────────────────────
  {
    name: 'compare_components',
    description:
      'Side-by-side price comparison table for 2–5 tracked components. ' +
      'Shows current best price, retailer, stock status, all-time low, and 30-day average.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'List of 2–5 component IDs from list_tracked',
          minItems: 2,
          maxItems: 5,
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'compare_builds',
    description:
      'Compare 2–4 PC builds side by side — total cost, component count, and price breakdown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        build_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'List of 2–4 build IDs from list_builds',
          minItems: 2,
          maxItems: 4,
        },
      },
      required: ['build_ids'],
    },
  },
  // ── Export ────────────────────────────────────────────────────────────────
  {
    name: 'export_data',
    description:
      'Export price history or build data to CSV or JSON. ' +
      'Files are written to the EXPORT_DIR env-var path (defaults to cwd). ' +
      'Specify id for price_history (component ID) or build (build ID). ' +
      'tracked_components exports the full watchlist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['price_history', 'build', 'tracked_components'] },
        format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
        id: { type: 'number', description: 'Component or build ID (required for price_history and build)' },
        days: { type: 'number', default: 90, description: 'Days of history to include (price_history only)' },
      },
      required: ['type'],
    },
  },
  // ── PCPartPicker import ───────────────────────────────────────────────────
  {
    name: 'import_pcpartpicker',
    description:
      'Import a PCPartPicker UK list URL and optionally create a build + track all components. ' +
      'Note: PCPartPicker ToS prohibits automated scraping; use for personal reference only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'PCPartPicker list URL, e.g. https://uk.pcpartpicker.com/list/XXXXXX' },
        create_build: { type: 'boolean', default: true, description: 'Create a build from the list' },
        track_components: { type: 'boolean', default: true, description: 'Add each component to the watchlist' },
      },
      required: ['url'],
    },
  },
  // ── Notifications ─────────────────────────────────────────────────────────
  {
    name: 'configure_notifications',
    description:
      'Set Discord and/or Slack webhook URLs for price drop and restock alerts. ' +
      'Also configure the minimum drop percentage that triggers a notification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        discord_webhook_url: { type: ['string', 'null'], description: 'Discord webhook URL, or null to remove' },
        slack_webhook_url: { type: ['string', 'null'], description: 'Slack webhook URL, or null to remove' },
        notify_drop_percent: { type: 'number', description: 'Minimum % drop to trigger notification (default: 5)' },
      },
    },
  },
  {
    name: 'test_notification',
    description: 'Send a test notification to configured Discord and/or Slack webhooks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', enum: ['discord', 'slack', 'all'], default: 'all' },
      },
    },
  },
  // ── Scheduler ─────────────────────────────────────────────────────────────
  {
    name: 'configure_scheduler',
    description:
      'Configure the background auto-refresh scheduler. ' +
      'Set interval_minutes to enable (minimum 1); set to 0 to disable. ' +
      'The scheduler refreshes all tracked components and sends alerts automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        interval_minutes: { type: 'number', description: 'Refresh interval in minutes (0 to disable, min 1)' },
        notify_drop_percent: { type: 'number', description: 'Minimum % drop to trigger a notification' },
      },
    },
  },
  {
    name: 'get_scheduler_status',
    description: 'Show current background refresh scheduler status — active, interval, last run, next run.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // ── Waitlist ──────────────────────────────────────────────────────────────
  {
    name: 'add_to_waitlist',
    description:
      'Add a tracked component to the waitlist. ' +
      'You will be notified (via Discord/Slack) when it comes back in stock at or below max_price.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component_id: { type: 'number', description: 'Tracked component ID' },
        retailer: { type: 'string', description: 'Specific retailer to watch (omit for any retailer)' },
        max_price: { type: 'number', description: 'Only notify if restock price is at or below this GBP amount' },
      },
      required: ['component_id'],
    },
  },
  {
    name: 'remove_from_waitlist',
    description: 'Remove a component from the waitlist by its tracked component ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { component_id: { type: 'number', description: 'Tracked component ID from list_waitlist' } },
      required: ['component_id'],
    },
  },
  {
    name: 'list_waitlist',
    description: 'Show all components currently on the waitlist.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // ── VAT ──────────────────────────────────────────────────────────────────
  {
    name: 'set_vat_mode',
    description:
      'Toggle VAT display mode. inc_vat shows prices as listed (default). ' +
      'ex_vat strips UK 20% VAT from all displayed prices (useful for business purchasing).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['inc_vat', 'ex_vat'] },
      },
      required: ['mode'],
    },
  },
  // ── Stock changes ─────────────────────────────────────────────────────────
  {
    name: 'check_stock_changes',
    description:
      'Show recent stock-status changes (in stock → out of stock, or back in stock) ' +
      'detected during the last N hours of price refreshes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', default: 24, description: 'Look-back window in hours (max 168)' },
      },
    },
  },
  // ── Builds ────────────────────────────────────────────────────────────────
  {
    name: 'create_build',
    description: 'Create a named PC build to group components and track total cost.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Build name, e.g. "Gaming Rig 2025"' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_builds',
    description: 'List all saved PC builds with their component count and total cost.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_build',
    description: 'Get full build details — all components, individual prices, and total cost.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'add_to_build',
    description: 'Add a tracked component to a build. The component must already be in the watchlist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        build_id: { type: 'number' },
        component_id: { type: 'number', description: 'ID from list_tracked' },
        quantity: { type: 'number', default: 1, description: 'Number of units (e.g. 2 for dual RAM sticks)' },
        notes: { type: 'string' },
      },
      required: ['build_id', 'component_id'],
    },
  },
  {
    name: 'remove_from_build',
    description: 'Remove a component from a build (does not delete the component from tracking).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        build_id: { type: 'number' },
        component_id: { type: 'number' },
      },
      required: ['build_id', 'component_id'],
    },
  },
  {
    name: 'delete_build',
    description: 'Delete a build (does not delete the tracked components inside it).',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
];

// ── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'uk-pc-price-mcp', version: '3.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = rawArgs ?? {};

  try {
    switch (name) {

      // ── search_components ────────────────────────────────────────────────
      case 'search_components': {
        const { query, country, max_results, offers_per_product } = SearchSchema.parse(args);
        const { products, cacheSource, durationMs } = await searchWithRetry(
          query, country, max_results, offers_per_product,
        );

        if (products.length === 0) return ok(`No products found for "${query}" in ${country.toUpperCase()}.`);

        const lines = [
          `## Search: "${query}" (${country.toUpperCase()})`,
          `*${products.length} product(s) · ${cacheSource} · ${(durationMs / 1000).toFixed(1)}s*\n`,
        ];
        for (const [i, p] of products.entries()) {
          lines.push(`### ${i + 1}. ${p.name}`);
          if (p.url) lines.push(`<${p.url}>`);
          if (p.offers.length === 0) {
            lines.push('  No offers available.\n');
          } else {
            for (const o of p.offers) {
              lines.push(
                `  - **${fmt(o.price, o.currency)}** at ${o.merchant} — ${o.inStock ? '✅ In stock' : '❌ Out of stock'}`,
              );
            }
            lines.push('');
          }
        }
        return ok(lines.join('\n'));
      }

      // ── search_uk_retailers ──────────────────────────────────────────────
      case 'search_uk_retailers': {
        const { query, retailers } = UkRetailersSchema.parse(args);
        const searchResults = await searchAllUkRetailers(query, retailers);

        const lines = [`## UK Retailer Search: "${query}"\n`];

        for (const sr of searchResults) {
          lines.push(`### ${sr.retailer} *(${sr.durationMs}ms)*`);
          if (sr.error) {
            lines.push(`⚠️ ${sr.error}`);
          } else if (sr.results.length === 0) {
            lines.push('No results found.');
          } else {
            for (const r of sr.results) {
              const priceStr = r.price != null ? `**${fmt(r.price, r.currency)}**` : 'Price unknown';
              const stock = r.inStock ? '✅' : '❌';
              lines.push(`- ${stock} ${r.name} — ${priceStr}`);
              if (r.url) lines.push(`  <${r.url}>`);
              if (r.scraperNote) lines.push(`  *${r.scraperNote}*`);
            }
          }
          lines.push('');
        }

        lines.push('> *Scraped directly from retailer websites. Prices and availability may differ from their apps/checkout.*');
        return ok(lines.join('\n'));
      }

      // ── track_component ──────────────────────────────────────────────────
      case 'track_component': {
        const { name: displayName, search_query, category, alert_price, notes, fetch_now, country } =
          TrackSchema.parse(args);

        const component = db.addTrackedComponent(displayName, category, search_query, alert_price, notes);
        const lines = [
          `✅ **${displayName}** added to watchlist (ID: **${component.id}**)`,
          `Category: ${category} · Query: "${search_query}"`,
        ];
        if (alert_price != null) lines.push(`Alert threshold: ${fmtRaw(alert_price)}`);

        if (fetch_now) {
          lines.push('\n*Fetching current prices (cold query may take up to 90s)…*');
          try {
            const { saved, note } = await refreshComponent(component, country);
            lines.push(saved > 0 ? `✅ ${note}` : `⚠️ ${note}`);
          } catch (e) {
            lines.push(`⚠️ Could not fetch initial prices: ${(e as Error).message}`);
            lines.push('Run `refresh_prices` later to populate price history.');
          }
        }
        return ok(lines.join('\n'));
      }

      // ── untrack_component ────────────────────────────────────────────────
      case 'untrack_component': {
        const { id } = IdSchema.parse(args);
        const component = db.getTrackedComponentById(id) ?? notFound('tracked component', id);
        db.removeTrackedComponent(id);
        return ok(`🗑️ Removed **${component.name}** (ID: ${id}) and all its price history.`);
      }

      // ── list_tracked ─────────────────────────────────────────────────────
      case 'list_tracked': {
        const components = db.getTrackedComponents();
        if (components.length === 0) {
          return ok('No components tracked yet.\nUse `track_component` to start watching prices.');
        }

        const vatMode = db.getConfig('vat_mode') ?? 'inc_vat';
        const lines = [
          `## Tracked Components (${components.length})${vatMode === 'ex_vat' ? ' · Prices shown ex-VAT' : ''}\n`,
        ];
        for (const c of components) {
          const latest = db.getLatestPricePerRetailer(c.id);
          const best = latest[0];
          const alertLine = c.alert_price != null ? ` · Alert: ${fmtRaw(c.alert_price)}` : '';
          const checked = c.last_checked
            ? new Date(c.last_checked + 'Z').toLocaleString('en-GB')
            : 'Never';

          lines.push(`### [${c.id}] ${c.name} *(${c.category})*`);
          lines.push(`Query: "${c.search_query}"${alertLine}`);

          if (best) {
            const triggerFlag = c.alert_price != null && best.price <= c.alert_price ? ' 🔔' : '';
            lines.push(
              `Best price: **${fmt(best.price, best.currency)}** at ${best.retailer} ` +
              `${best.in_stock ? '✅' : '❌'}${triggerFlag}`,
            );
            if (latest.length > 1) lines.push(`+${latest.length - 1} more retailer(s)`);
          } else {
            lines.push('No price data yet — run `refresh_prices`.');
          }

          if (c.notes) lines.push(`Notes: ${c.notes}`);
          lines.push(`Last checked: ${checked}\n`);
        }
        return ok(lines.join('\n'));
      }

      // ── set_price_alert ──────────────────────────────────────────────────
      case 'set_price_alert': {
        const { id, alert_price } = SetAlertSchema.parse(args);
        const component = db.getTrackedComponentById(id) ?? notFound('tracked component', id);
        db.updateAlertPrice(id, alert_price);
        return ok(
          alert_price == null
            ? `🔕 Alert removed from **${component.name}**`
            : `🔔 Alert set for **${component.name}** at ${fmtRaw(alert_price)}`,
        );
      }

      // ── get_latest_prices ────────────────────────────────────────────────
      case 'get_latest_prices': {
        const { id } = IdSchema.parse(args);
        const component = db.getTrackedComponentById(id) ?? notFound('tracked component', id);
        const latest = db.getLatestPricePerRetailer(id);

        if (latest.length === 0) {
          return ok(`No price data for **${component.name}** yet.\nRun \`refresh_prices\` to fetch.`);
        }

        const lines = [
          `## Latest Prices: ${component.name}`,
          `*${latest.length} retailer(s) — sorted cheapest first*\n`,
          '| # | Retailer | Price | In Stock | Updated |',
          '|---|----------|-------|----------|---------|',
        ];

        for (const [i, r] of latest.entries()) {
          const dt = new Date(r.recorded_at + 'Z').toLocaleString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          });
          const alert = component.alert_price != null && r.price <= component.alert_price ? ' 🔔' : '';
          lines.push(
            `| ${i + 1} | ${r.retailer} | **${fmt(r.price, r.currency)}**${alert} | ` +
            `${r.in_stock ? '✅' : '❌'} | ${dt} |`,
          );
        }

        if (component.alert_price != null) {
          lines.push(`\n*Alert threshold: ${fmtRaw(component.alert_price)}*`);
        }
        return ok(lines.join('\n'));
      }

      // ── get_price_history ────────────────────────────────────────────────
      case 'get_price_history': {
        const { id, days, show_trend } = HistorySchema.parse(args);
        const component = db.getTrackedComponentById(id) ?? notFound('tracked component', id);

        if (show_trend) {
          const trend = db.getDailyPriceTrend(id, days);
          if (trend.length === 0) {
            return ok(`No price history for **${component.name}** in the last ${days} days.`);
          }
          const lines = [
            `## Price Trend: ${component.name} (last ${days} days)\n`,
            '| Date | Min | Avg | Max | Records |',
            '|------|-----|-----|-----|---------|',
          ];
          for (const row of trend) {
            lines.push(
              `| ${row.date} | ${fmt(row.min_price)} | ${fmt(row.avg_price)} | ` +
              `${fmt(row.max_price)} | ${row.record_count} |`,
            );
          }
          return ok(lines.join('\n'));
        }

        const records = db.getPriceHistory(id, days);
        if (records.length === 0) {
          return ok(`No price history for **${component.name}** in the last ${days} days.`);
        }

        const lines = [
          `## Price History: ${component.name} (last ${days} days, ${records.length} records)\n`,
          '| Date/Time | Retailer | Price | Stock | Source |',
          '|-----------|----------|-------|-------|--------|',
        ];
        for (const r of records) {
          const dt = new Date(r.recorded_at + 'Z').toLocaleString('en-GB');
          lines.push(
            `| ${dt} | ${r.retailer} | ${fmt(r.price, r.currency)} | ` +
            `${r.in_stock ? '✅' : '❌'} | ${r.source} |`,
          );
        }
        return ok(lines.join('\n'));
      }

      // ── get_price_stats ──────────────────────────────────────────────────
      case 'get_price_stats': {
        const { id } = IdSchema.parse(args);
        const component = db.getTrackedComponentById(id) ?? notFound('tracked component', id);
        const stats = db.getPriceStats(id);

        if (stats.total_records === 0) {
          return ok(
            `No price data for **${component.name}** yet.\n` +
            'Run `refresh_prices` to start collecting price history.',
          );
        }

        let changeStr = '';
        if (stats.current_best != null && stats.prev_best_24h != null) {
          const diff = stats.current_best - stats.prev_best_24h;
          const pct = (diff / stats.prev_best_24h) * 100;
          if (Math.abs(pct) >= 0.5) {
            const arrow = diff < 0 ? '📉' : '📈';
            changeStr = `${arrow} ${diff < 0 ? '-' : '+'}${fmtRaw(Math.abs(diff), stats.currency)} ` +
              `(${pct > 0 ? '+' : ''}${pct.toFixed(1)}%) vs previous check`;
          } else {
            changeStr = '↔️ Price unchanged vs previous check';
          }
        }

        const oldest = stats.oldest_record
          ? new Date(stats.oldest_record + 'Z').toLocaleDateString('en-GB')
          : 'unknown';

        const lines = [
          `## Price Statistics: ${component.name}\n`,
          `**Current best price:** ${stats.current_best != null ? fmt(stats.current_best, stats.currency) : 'No recent data (>48h)'}`,
          changeStr,
          '',
          '| Metric | Value |',
          '|--------|-------|',
          `| All-time low | ${stats.all_time_low != null ? fmt(stats.all_time_low, stats.currency) : 'N/A'} |`,
          `| All-time high | ${stats.all_time_high != null ? fmt(stats.all_time_high, stats.currency) : 'N/A'} |`,
          `| 30-day average | ${stats.avg_30d != null ? fmt(stats.avg_30d, stats.currency) : 'N/A'} |`,
          `| 7-day average | ${stats.avg_7d != null ? fmt(stats.avg_7d, stats.currency) : 'N/A'} |`,
          `| Total records | ${stats.total_records} |`,
          `| Tracking since | ${oldest} |`,
        ];

        if (component.alert_price != null) {
          lines.push(`| Alert threshold | ${fmtRaw(component.alert_price)} |`);
          if (stats.current_best != null) {
            const gap = stats.current_best - component.alert_price;
            lines.push(
              `| Distance to alert | ${gap > 0 ? `${fmtRaw(gap)} above` : `${fmtRaw(Math.abs(gap))} BELOW TARGET 🔔`} |`,
            );
          }
        }

        return ok(lines.filter(Boolean).join('\n'));
      }

      // ── refresh_prices ───────────────────────────────────────────────────
      case 'refresh_prices': {
        const { id, country } = RefreshSchema.parse(args);
        const targets = id != null
          ? [db.getTrackedComponentById(id) ?? notFound('tracked component', id)]
          : db.getTrackedComponents();

        if (targets.length === 0) {
          return ok('No tracked components to refresh. Use `track_component` to add some.');
        }

        const lines = [`## Refreshing prices for ${targets.length} component(s)…\n`];

        for (const component of targets) {
          const prevBest = db.getLatestPricePerRetailer(component.id)[0]?.price;
          lines.push(`### ${component.name}`);
          try {
            const { saved, note } = await refreshComponent(component, country);
            if (saved > 0) {
              lines.push(`✅ ${note}`);
              const newBest = db.getLatestPricePerRetailer(component.id)[0];
              if (prevBest != null && newBest) {
                const diff = newBest.price - prevBest;
                if (Math.abs(diff) > 0.01) {
                  const arrow = diff < 0 ? '📉' : '📈';
                  lines.push(
                    `${arrow} Price change: ${fmtRaw(prevBest)} → **${fmt(newBest.price, newBest.currency)}** ` +
                    `(${diff < 0 ? '' : '+'}${fmtRaw(diff, newBest.currency)})`,
                  );
                }
              }
            } else {
              lines.push(`⚠️ ${note}`);
            }
          } catch (e) {
            lines.push(`❌ Error: ${(e as Error).message}`);
          }
          lines.push('');
        }

        return ok(lines.join('\n'));
      }

      // ── check_price_alerts ───────────────────────────────────────────────
      case 'check_price_alerts': {
        const withAlerts = db.getTrackedComponents().filter(c => c.alert_price != null);
        if (withAlerts.length === 0) {
          return ok('No price alerts set.\nUse `set_price_alert` to add a GBP target to any tracked component.');
        }

        const triggered = db.getComponentsBelowAlertPrice();
        const lines = [
          '## Price Alert Check',
          `*${withAlerts.length} component(s) monitored · ${triggered.length} triggered*\n`,
        ];

        if (triggered.length === 0) {
          lines.push('No alerts triggered — all prices still above target.\n');
          lines.push('**Monitored components:**');
          for (const c of withAlerts) {
            const best = db.getLatestPricePerRetailer(c.id)[0];
            const current = best ? fmt(best.price, best.currency) : 'No data';
            const gap = best ? ` (${fmtRaw(best.price - c.alert_price!)} above target)` : '';
            lines.push(`- **${c.name}**: Target ${fmtRaw(c.alert_price!)} · Current: ${current}${gap}`);
          }
        } else {
          lines.push('### 🔔 Alerts Triggered!\n');
          for (const t of triggered) {
            lines.push(`#### ${t.component.name}`);
            lines.push(`Price: **${fmt(t.currentBestPrice, t.currency)}** at ${t.retailer}`);
            lines.push(`Target: ${fmtRaw(t.component.alert_price!)} — **${Math.abs(t.dropPercent)}% below target**`);
            if (t.url) lines.push(`<${t.url}>`);
            lines.push('');
          }
        }

        return ok(lines.join('\n'));
      }

      // ── get_price_drops ──────────────────────────────────────────────────
      case 'get_price_drops': {
        const { min_drop_percent } = PriceDropSchema.parse(args);
        const drops = db.getRecentPriceDrops(min_drop_percent);

        if (drops.length === 0) {
          return ok(
            `No price drops ≥${min_drop_percent}% detected in the last 24h.\n` +
            'Run `refresh_prices` first to get up-to-date data.',
          );
        }

        const lines = [
          `## Recent Price Drops (≥${min_drop_percent}% in last 24h)\n`,
          `*${drops.length} component(s) dropped in price*\n`,
        ];

        for (const d of drops) {
          lines.push(
            `### 📉 ${d.component.name}`,
            `${fmt(d.previousBest, d.currency)} → **${fmt(d.currentBest, d.currency)}** ` +
            `at ${d.bestRetailer} — **-${fmtRaw(d.dropAmount, d.currency)} (-${d.dropPercent.toFixed(1)}%)**`,
          );
          if (d.bestUrl) lines.push(`<${d.bestUrl}>`);
          if (d.component.alert_price != null) {
            const distToAlert = d.currentBest - d.component.alert_price;
            lines.push(
              distToAlert <= 0
                ? `🔔 **At or below alert threshold (${fmtRaw(d.component.alert_price)})**`
                : `Alert target: ${fmtRaw(d.component.alert_price)} — ${fmtRaw(distToAlert)} away`,
            );
          }
          lines.push('');
        }

        return ok(lines.join('\n'));
      }

      // ── get_ebay_gpu_prices ──────────────────────────────────────────────
      case 'get_ebay_gpu_prices': {
        const { query, country } = EbaySchema.parse(args);
        const slug = resolveGpuSlug(query);
        if (!slug) {
          return ok(
            `Could not match "${query}" to a known GPU.\n` +
            'Use `list_supported_gpus` to see all supported models.',
          );
        }

        const data = await scrapeEbayGpuPrices(slug, country);
        const lines = [
          `## eBay ${country.toUpperCase()} Prices: ${data.displayName}`,
          '*Source: pcprice.watch — eBay secondhand/resale only*\n',
        ];

        if (data.medianPrice != null) {
          lines.push(`**Median price: ${fmt(data.medianPrice, data.currency)}**`);
          if (data.activeListings > 0) lines.push(`Active listings: ${data.activeListings}`);
        } else {
          lines.push('⚠️ Could not retrieve price data.');
        }

        if (data.scraperNote) lines.push(`\n*Note: ${data.scraperNote}*`);
        lines.push(`\nSource: <${data.sourceUrl}>`);
        lines.push(`Scraped: ${new Date(data.scrapedAt).toLocaleString('en-GB')}`);
        lines.push('\n> eBay prices are **used/secondhand**. For new retail, use `search_components` or `search_uk_retailers`.');
        return ok(lines.join('\n'));
      }

      // ── get_ebay_component_prices ────────────────────────────────────────
      case 'get_ebay_component_prices': {
        const { query, category, country } = EbayComponentSchema.parse(args);
        const slug = resolveComponentSlug(category, query);
        if (!slug) {
          return ok(
            `Could not match "${query}" to a known ${category}.\n` +
            `Use \`list_supported_components\` with category="${category}" to see supported models.`,
          );
        }

        const data = await scrapeEbayComponentPrices(category, slug, country);
        const lines = [
          `## eBay ${country.toUpperCase()} Prices: ${data.displayName} *(${category})*`,
          '*Source: pcprice.watch — eBay secondhand/resale only*\n',
        ];

        if (data.medianPrice != null) {
          lines.push(`**Median price: ${fmt(data.medianPrice, data.currency)}**`);
          if (data.activeListings > 0) lines.push(`Active listings: ${data.activeListings}`);
        } else {
          lines.push('⚠️ Could not retrieve price data.');
        }

        if (data.scraperNote) lines.push(`\n*Note: ${data.scraperNote}*`);
        lines.push(`\nSource: <${data.sourceUrl}>`);
        lines.push(`Scraped: ${new Date(data.scrapedAt).toLocaleString('en-GB')}`);
        lines.push('\n> eBay prices are **used/secondhand**. For new retail, use `search_components` or `search_uk_retailers`.');
        return ok(lines.join('\n'));
      }

      // ── list_supported_gpus ──────────────────────────────────────────────
      case 'list_supported_gpus': {
        const gpus = listSupportedGpus();
        const sections: Record<string, string[]> = {};
        for (const gpu of gpus) {
          const brand = gpu.startsWith('RTX') || gpu.startsWith('GTX')
            ? 'NVIDIA GeForce' : gpu.startsWith('RX') ? 'AMD Radeon' : 'Intel Arc';
          (sections[brand] ??= []).push(gpu);
        }
        const lines = [`## Supported GPUs for eBay Lookup (${gpus.length} models)\n`];
        for (const [brand, models] of Object.entries(sections)) {
          lines.push(`### ${brand}\n${models.join(', ')}\n`);
        }
        return ok(lines.join('\n'));
      }

      // ── list_supported_components ────────────────────────────────────────
      case 'list_supported_components': {
        const { category } = ListSupportedSchema.parse(args);
        const items = listSupportedComponents(category);
        const lines = [`## Supported ${category.toUpperCase()} Models for eBay Lookup (${items.length})\n`];
        lines.push(items.join(', '));
        lines.push(`\nUse these with \`get_ebay_component_prices\` (category: "${category}").`);
        return ok(lines.join('\n'));
      }

      // ── get_amazon_price_history ─────────────────────────────────────────
      case 'get_amazon_price_history': {
        const { query } = AmazonSchema.parse(args);
        const result = await getAmazonPriceHistory(query);

        if (result.error && result.products.length === 0) {
          return ok(`No CamelCamelCamel results found for "${query}".\n${result.error}`);
        }
        if (result.products.length === 0) {
          return ok(`No CamelCamelCamel results found for "${query}".`);
        }

        const lines = [`## Amazon UK Price History: "${query}" *(via CamelCamelCamel)*\n`];

        for (const [i, r] of result.products.entries()) {
          lines.push(`### ${i + 1}. ${r.name}`);
          if (r.productUrl) lines.push(`Amazon: <${r.productUrl}>`);
          lines.push(`CamelCamelCamel: <${r.camelUrl}>\n`);

          lines.push('| Metric | Price |');
          lines.push('|--------|-------|');
          if (r.currentAmazonPrice != null)
            lines.push(`| Current Amazon price | **${fmt(r.currentAmazonPrice)}** |`);
          if (r.allTimeLow != null)
            lines.push(`| All-time low | ${fmt(r.allTimeLow)} |`);
          if (r.allTimeHigh != null)
            lines.push(`| All-time high | ${fmt(r.allTimeHigh)} |`);
          if (r.avg30d != null)
            lines.push(`| 30-day average | ${fmt(r.avg30d)} |`);

          if (r.priceHistory.length > 0) {
            const recent = r.priceHistory.slice(-10);
            lines.push('\n**Recent price history (last 10 data points):**');
            lines.push('| Date | Price |');
            lines.push('|------|-------|');
            for (const pt of recent) {
              lines.push(`| ${pt.date} | ${fmt(pt.price)} |`);
            }
          }
          if (r.scraperNote) lines.push(`\n*${r.scraperNote}*`);
          lines.push('');
        }

        lines.push('> *Amazon prices only. For all-retailer pricing, use `search_components` or `search_uk_retailers`.*');
        return ok(lines.join('\n'));
      }

      // ── compare_components ───────────────────────────────────────────────
      case 'compare_components': {
        const { ids } = CompareComponentsSchema.parse(args);
        const components = ids.map(id => db.getTrackedComponentById(id) ?? notFound('tracked component', id));

        const rows: string[][] = [];
        const headers = ['Metric', ...components.map(c => c.name)];
        const sep = headers.map((_, i) => i === 0 ? '--------' : '-------');

        const latestPerComp = components.map(c => db.getLatestPricePerRetailer(c.id));
        const statsPerComp = components.map(c => db.getPriceStats(c.id));

        rows.push(['**Current best**', ...latestPerComp.map((l, i) =>
          l[0] ? `**${fmt(l[0].price, l[0].currency)}**` : 'No data',
        )]);
        rows.push(['Retailer', ...latestPerComp.map(l => l[0]?.retailer ?? '—')]);
        rows.push(['In stock', ...latestPerComp.map(l => l[0] ? (l[0].in_stock ? '✅' : '❌') : '—')]);
        rows.push(['Alert target', ...components.map(c =>
          c.alert_price != null ? fmtRaw(c.alert_price) : '—',
        )]);
        rows.push(['All-time low', ...statsPerComp.map(s =>
          s.all_time_low != null ? fmt(s.all_time_low, s.currency) : 'N/A',
        )]);
        rows.push(['All-time high', ...statsPerComp.map(s =>
          s.all_time_high != null ? fmt(s.all_time_high, s.currency) : 'N/A',
        )]);
        rows.push(['30-day avg', ...statsPerComp.map(s =>
          s.avg_30d != null ? fmt(s.avg_30d, s.currency) : 'N/A',
        )]);
        rows.push(['7-day avg', ...statsPerComp.map(s =>
          s.avg_7d != null ? fmt(s.avg_7d, s.currency) : 'N/A',
        )]);
        rows.push(['Category', ...components.map(c => c.category)]);

        const fmtRow = (cells: string[]) => `| ${cells.join(' | ')} |`;

        const lines = [
          `## Component Comparison (${components.length} items)\n`,
          fmtRow(headers),
          fmtRow(sep),
          ...rows.map(fmtRow),
        ];

        return ok(lines.join('\n'));
      }

      // ── compare_builds ───────────────────────────────────────────────────
      case 'compare_builds': {
        const { build_ids } = CompareBuildsSchema.parse(args);
        const summaries = build_ids.map(id => {
          const s = db.getBuildSummary(id);
          if (!s) notFound('build', id);
          return s!;
        });

        const lines = [`## Build Comparison (${summaries.length} builds)\n`];

        // Summary row
        lines.push('| | ' + summaries.map(s => `**${s.build.name}**`).join(' | ') + ' |');
        lines.push('|---|' + summaries.map(() => '---').join('|') + '|');
        lines.push('| **Total cost** | ' + summaries.map(s =>
          s.totalCost > 0 ? `**${fmt(s.totalCost)}**` : 'No data',
        ).join(' | ') + ' |');
        lines.push('| Components | ' + summaries.map(s => s.items.length).join(' | ') + ' |');
        lines.push('| Missing prices | ' + summaries.map(s => s.missingPrices).join(' | ') + ' |');
        lines.push('');

        // Collect all unique component IDs across builds
        const allComponentIds = [
          ...new Set(summaries.flatMap(s => s.items.map(i => i.component_id))),
        ];
        const allComponents = allComponentIds
          .map(cid => db.getTrackedComponentById(cid))
          .filter(Boolean) as db.TrackedComponent[];

        if (allComponents.length > 0) {
          lines.push('### Price breakdown by component\n');
          lines.push('| Component | ' + summaries.map(s => s.build.name).join(' | ') + ' |');
          lines.push('|---|' + summaries.map(() => '---').join('|') + '|');

          for (const comp of allComponents) {
            const cells = summaries.map(s => {
              const item = s.items.find(i => i.component_id === comp.id);
              if (!item) return '—';
              const p = s.bestPrices.get(comp.id);
              if (!p) return `×${item.quantity} (no price)`;
              const total = p.price * item.quantity;
              return `${fmt(total, p.currency)}${item.quantity > 1 ? ` (×${item.quantity})` : ''}`;
            });
            lines.push(`| ${comp.name} | ${cells.join(' | ')} |`);
          }
        }

        return ok(lines.join('\n'));
      }

      // ── export_data ──────────────────────────────────────────────────────
      case 'export_data': {
        const { type, format, id, days } = ExportSchema.parse(args);

        let filePath: string;
        try {
          if (type === 'price_history') {
            if (id == null) throw new McpError(ErrorCode.InvalidParams, 'id is required for price_history export');
            filePath = format === 'csv'
              ? exportPriceHistoryCsv(id, days)
              : exportPriceHistoryJson(id, days);
          } else if (type === 'build') {
            if (id == null) throw new McpError(ErrorCode.InvalidParams, 'id is required for build export');
            filePath = format === 'csv' ? exportBuildCsv(id) : exportBuildJson(id);
          } else {
            if (format === 'json') {
              throw new McpError(ErrorCode.InvalidParams, 'tracked_components export only supports CSV format');
            }
            filePath = exportTrackedComponentsCsv();
          }
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw new McpError(ErrorCode.InternalError, (e as Error).message);
        }

        return ok(`✅ Exported to: \`${filePath}\``);
      }

      // ── import_pcpartpicker ──────────────────────────────────────────────
      case 'import_pcpartpicker': {
        const { url, create_build: shouldCreateBuild, track_components: shouldTrack } = ImportPCPSchema.parse(args);
        const list = await importPCPartPickerList(url);

        const lines = [
          `## PCPartPicker Import: ${list.title}`,
          `*Source: ${list.sourceUrl}*`,
          `*Scraped: ${new Date(list.scrapedAt).toLocaleString('en-GB')}*\n`,
          `> ⚠️ ${list.warning}\n`,
          `**${list.items.length} component(s) found:**\n`,
        ];

        for (const item of list.items) {
          const priceStr = item.price != null ? fmtRaw(item.price) : 'Price unknown';
          lines.push(`- **${item.name}** *(${item.category})* — ${priceStr}${item.quantity > 1 ? ` × ${item.quantity}` : ''}`);
          if (item.partUrl) lines.push(`  <${item.partUrl}>`);
        }

        if (list.totalPrice != null) {
          lines.push(`\n**PCPartPicker total: ${fmtRaw(list.totalPrice)}** *(may not match current UK retail)*`);
        }

        let buildId: number | null = null;
        if (shouldCreateBuild && list.items.length > 0) {
          const build = db.createBuild(list.title, `Imported from PCPartPicker: ${list.sourceUrl}`);
          buildId = build.id;
          lines.push(`\n✅ Build **"${build.name}"** created (ID: **${build.id}**)`);
        }

        if (shouldTrack && list.items.length > 0) {
          lines.push('\n**Adding components to watchlist…**');
          for (const item of list.items) {
            if (item.name.length < 3) continue;
            const component = db.addTrackedComponent(item.name, item.category, item.name, undefined, undefined);
            lines.push(`- ✅ [${component.id}] ${component.name}`);
            if (buildId != null) {
              db.addBuildItem(buildId, component.id, item.quantity, undefined);
            }
          }
          lines.push(`\nRun \`refresh_prices\` to fetch current UK prices for all imported components.`);
        }

        return ok(lines.join('\n'));
      }

      // ── configure_notifications ──────────────────────────────────────────
      case 'configure_notifications': {
        const { discord_webhook_url, slack_webhook_url, notify_drop_percent } = ConfigNotificationsSchema.parse(args);
        const changes: string[] = [];

        if (discord_webhook_url !== undefined) {
          if (discord_webhook_url === null) {
            db.deleteConfig('discord_webhook_url');
            changes.push('Discord webhook removed');
          } else {
            db.setConfig('discord_webhook_url', discord_webhook_url);
            changes.push(`Discord webhook set`);
          }
        }
        if (slack_webhook_url !== undefined) {
          if (slack_webhook_url === null) {
            db.deleteConfig('slack_webhook_url');
            changes.push('Slack webhook removed');
          } else {
            db.setConfig('slack_webhook_url', slack_webhook_url);
            changes.push(`Slack webhook set`);
          }
        }
        if (notify_drop_percent !== undefined) {
          db.setConfig('notify_drop_percent', String(notify_drop_percent));
          changes.push(`Notification threshold set to ${notify_drop_percent}%`);
        }

        if (changes.length === 0) {
          const discordUrl = db.getConfig('discord_webhook_url');
          const slackUrl = db.getConfig('slack_webhook_url');
          const threshold = db.getConfig('notify_drop_percent') ?? '5';
          return ok(
            `## Notification Configuration\n` +
            `- Discord: ${discordUrl ? '✅ Configured' : '❌ Not set'}\n` +
            `- Slack: ${slackUrl ? '✅ Configured' : '❌ Not set'}\n` +
            `- Drop threshold: ${threshold}%\n\n` +
            `Use \`test_notification\` to verify webhooks are working.`,
          );
        }

        return ok(`✅ Notifications updated:\n${changes.map(c => `- ${c}`).join('\n')}\n\nUse \`test_notification\` to verify.`);
      }

      // ── test_notification ────────────────────────────────────────────────
      case 'test_notification': {
        const { channel } = TestNotificationSchema.parse(args);
        const discordUrl = db.getConfig('discord_webhook_url');
        const slackUrl = db.getConfig('slack_webhook_url');

        if (!discordUrl && !slackUrl) {
          return ok(
            '⚠️ No webhooks configured.\nUse `configure_notifications` to set Discord and/or Slack webhook URLs.',
          );
        }

        const payload = {
          type: 'test' as const,
          componentName: 'Test Component',
          message: 'This is a test notification from UK PC Price MCP.',
        };

        const lines = ['## Test Notification Results\n'];

        if (channel === 'discord' || channel === 'all') {
          if (discordUrl) {
            const ok2 = await sendDiscord(discordUrl, payload);
            lines.push(`Discord: ${ok2 ? '✅ Sent successfully' : '❌ Failed — check your webhook URL'}`);
          } else {
            lines.push('Discord: ⚠️ Not configured');
          }
        }

        if (channel === 'slack' || channel === 'all') {
          if (slackUrl) {
            const ok2 = await sendSlack(slackUrl, payload);
            lines.push(`Slack: ${ok2 ? '✅ Sent successfully' : '❌ Failed — check your webhook URL'}`);
          } else {
            lines.push('Slack: ⚠️ Not configured');
          }
        }

        return ok(lines.join('\n'));
      }

      // ── configure_scheduler ──────────────────────────────────────────────
      case 'configure_scheduler': {
        const { interval_minutes, notify_drop_percent } = ConfigSchedulerSchema.parse(args);
        const changes: string[] = [];

        if (notify_drop_percent !== undefined) {
          db.setConfig('notify_drop_percent', String(notify_drop_percent));
          changes.push(`Drop notification threshold: ${notify_drop_percent}%`);
        }

        if (interval_minutes !== undefined) {
          if (interval_minutes === 0) {
            db.deleteConfig('auto_refresh_interval_minutes');
            stopScheduler();
            changes.push('Auto-refresh scheduler disabled');
          } else if (interval_minutes < 1) {
            throw new McpError(ErrorCode.InvalidParams, 'Minimum interval is 1 minute');
          } else {
            db.setConfig('auto_refresh_interval_minutes', String(interval_minutes));
            const started = restartScheduler();
            changes.push(`Auto-refresh interval set to ${interval_minutes} minute(s) — scheduler ${started ? 'started' : 'start failed'}`);
          }
        }

        if (changes.length === 0) {
          return ok('No changes made. Specify interval_minutes and/or notify_drop_percent.');
        }

        const status = getSchedulerStatus();
        const statusLine = status.active
          ? `Scheduler active — next run: ${status.nextRunAt ?? 'unknown'}`
          : 'Scheduler is stopped.';

        return ok(`✅ Scheduler updated:\n${changes.map(c => `- ${c}`).join('\n')}\n\n${statusLine}`);
      }

      // ── get_scheduler_status ─────────────────────────────────────────────
      case 'get_scheduler_status': {
        const status = getSchedulerStatus();
        const lines = [
          '## Auto-Refresh Scheduler Status\n',
          `**Active:** ${status.active ? '✅ Yes' : '❌ No'}`,
        ];

        if (status.intervalMinutes != null) {
          lines.push(`**Interval:** every ${status.intervalMinutes} minute(s)`);
        } else {
          lines.push('**Interval:** not configured — use `configure_scheduler` to enable');
        }

        lines.push(`**Currently running:** ${status.currentlyRunning ? 'Yes (refresh in progress)' : 'No'}`);
        lines.push(`**Completed runs:** ${status.runCount}`);

        if (status.lastRunAt) {
          lines.push(`**Last run:** ${new Date(status.lastRunAt).toLocaleString('en-GB')}`);
        }
        if (status.nextRunAt) {
          lines.push(`**Next run:** ${new Date(status.nextRunAt).toLocaleString('en-GB')}`);
        }

        const threshold = db.getConfig('notify_drop_percent') ?? '5';
        lines.push(`**Notification drop threshold:** ${threshold}%`);

        return ok(lines.join('\n'));
      }

      // ── add_to_waitlist ───────────────────────────────────────────────────
      case 'add_to_waitlist': {
        const { component_id, retailer, max_price } = WaitlistAddSchema.parse(args);
        const component = db.getTrackedComponentById(component_id) ?? notFound('tracked component', component_id);
        const entry = db.addToWaitlist(component_id, retailer, max_price);
        const lines = [
          `✅ **${component.name}** added to waitlist (entry ID: **${entry.id}**)`,
        ];
        if (retailer) lines.push(`Watching retailer: ${retailer}`);
        else lines.push('Watching: any retailer');
        if (max_price != null) lines.push(`Max price: ${fmtRaw(max_price)}`);
        lines.push('\nYou will be notified via Discord/Slack when this component comes back in stock.');
        lines.push('Make sure webhooks are configured with `configure_notifications`.');
        return ok(lines.join('\n'));
      }

      // ── remove_from_waitlist ──────────────────────────────────────────────
      case 'remove_from_waitlist': {
        const { component_id } = WaitlistRemoveSchema.parse(args);
        const component = db.getTrackedComponentById(component_id);
        const removed = db.removeFromWaitlist(component_id);
        if (!removed) {
          return ok(`No waitlist entry found for component ID ${component_id}.`);
        }
        return ok(`✅ **${component?.name ?? `Component ${component_id}`}** removed from waitlist.`);
      }

      // ── list_waitlist ─────────────────────────────────────────────────────
      case 'list_waitlist': {
        const entries = db.getWaitlist();
        if (entries.length === 0) {
          return ok('Waitlist is empty.\nUse `add_to_waitlist` to track out-of-stock components.');
        }

        const lines = [`## Waitlist (${entries.length} entries)\n`];
        lines.push('| Component ID | Component | Retailer | Max Price | Added |');
        lines.push('|--------------|-----------|----------|-----------|-------|');

        for (const e of entries) {
          const compName = e.component_name ?? `Component ${e.component_id}`;
          const added = new Date(e.added_at + 'Z').toLocaleDateString('en-GB');
          lines.push(
            `| ${e.component_id} | ${compName} | ${e.retailer_filter ?? 'Any'} | ` +
            `${e.max_price != null ? fmtRaw(e.max_price) : 'Any'} | ${added} |`,
          );
        }

        return ok(lines.join('\n'));
      }

      // ── set_vat_mode ──────────────────────────────────────────────────────
      case 'set_vat_mode': {
        const { mode } = VatModeSchema.parse(args);
        db.setConfig('vat_mode', mode);
        return ok(
          mode === 'ex_vat'
            ? '✅ VAT mode set to **ex-VAT** — all prices will be shown excluding 20% UK VAT.'
            : '✅ VAT mode set to **inc-VAT** — all prices will be shown as listed (including VAT).',
        );
      }

      // ── check_stock_changes ───────────────────────────────────────────────
      case 'check_stock_changes': {
        const { hours } = StockChangesSchema.parse(args);
        const changes = db.getRecentStockChanges(hours);

        if (changes.length === 0) {
          return ok(
            `No stock changes detected in the last ${hours} hour(s).\n` +
            'Run `refresh_prices` or enable the scheduler to detect stock changes.',
          );
        }

        const lines = [
          `## Stock Changes (last ${hours}h)\n`,
          `*${changes.length} change(s) detected*\n`,
          '| Component | Retailer | Change | Price | Time |',
          '|-----------|----------|--------|-------|------|',
        ];

        for (const c of changes) {
          const compName = c.component_name ?? `Component ${c.component_id}`;
          const changeStr = c.is_in_stock ? '🟢 Back in stock' : '🔴 Out of stock';
          const priceStr = c.price != null ? fmtRaw(c.price) : '—';
          const dt = new Date(c.recorded_at + 'Z').toLocaleString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          });
          lines.push(`| ${compName} | ${c.retailer} | ${changeStr} | ${priceStr} | ${dt} |`);
        }

        return ok(lines.join('\n'));
      }

      // ── create_build ─────────────────────────────────────────────────────
      case 'create_build': {
        const { name: buildName, description } = CreateBuildSchema.parse(args);
        const build = db.createBuild(buildName, description);
        return ok(
          `🖥️ Build **"${build.name}"** created (ID: **${build.id}**)\n` +
          'Use `add_to_build` to add tracked components.\n' +
          'Use `get_build` to see cost breakdown.',
        );
      }

      // ── list_builds ───────────────────────────────────────────────────────
      case 'list_builds': {
        const builds = db.getBuilds();
        if (builds.length === 0) {
          return ok('No builds yet.\nUse `create_build` to start a new PC build.');
        }

        const lines = [`## PC Builds (${builds.length})\n`];
        for (const b of builds) {
          const summary = db.getBuildSummary(b.id);
          const itemCount = summary?.items.length ?? 0;
          const totalStr =
            summary && summary.totalCost > 0 ? fmt(summary.totalCost) : 'No price data';
          const missingStr =
            summary && summary.missingPrices > 0 ? ` (${summary.missingPrices} missing prices)` : '';

          lines.push(`### [${b.id}] ${b.name}`);
          if (b.description) lines.push(b.description);
          lines.push(`${itemCount} component(s) · Total: **${totalStr}**${missingStr}`);
          lines.push(`Created: ${new Date(b.created_at + 'Z').toLocaleDateString('en-GB')}\n`);
        }
        return ok(lines.join('\n'));
      }

      // ── get_build ─────────────────────────────────────────────────────────
      case 'get_build': {
        const { id } = GetBuildSchema.parse(args);
        const summary = db.getBuildSummary(id);
        if (!summary) notFound('build', id);

        const { build, items, bestPrices, totalCost, missingPrices } = summary!;

        const lines = [
          `## 🖥️ ${build.name}`,
          build.description ? `*${build.description}*\n` : '',
          '| # | Component | Category | Qty | Best Price | Retailer | Stock |',
          '|---|-----------|----------|-----|------------|----------|-------|',
        ];

        for (const [i, item] of items.entries()) {
          const p = bestPrices.get(item.component_id);
          const priceCell = p
            ? `${fmt(p.price, p.currency)}${item.quantity > 1 ? ` × ${item.quantity} = ${fmt(p.price * item.quantity, p.currency)}` : ''}`
            : 'No data';
          const retailerCell = p?.retailer ?? '—';
          const stockCell = p ? '✅' : '—';

          lines.push(
            `| ${i + 1} | [${item.component_id}] ${item.component_name} | ${item.component_category} | ` +
            `${item.quantity} | ${priceCell} | ${retailerCell} | ${stockCell} |`,
          );
        }

        lines.push('');
        lines.push(`**Total build cost: ${fmt(totalCost)}**`);
        if (missingPrices > 0) {
          lines.push(`⚠️ ${missingPrices} component(s) have no price data — run \`refresh_prices\` to update.`);
        }
        lines.push('\n*Run `refresh_prices` to get the latest prices for all components.*');

        return ok(lines.filter(l => l !== '').join('\n'));
      }

      // ── add_to_build ──────────────────────────────────────────────────────
      case 'add_to_build': {
        const { build_id, component_id, quantity, notes } = AddBuildItemSchema.parse(args);
        const build = db.getBuildById(build_id) ?? notFound('build', build_id);
        const component = db.getTrackedComponentById(component_id) ?? notFound('tracked component', component_id);

        db.addBuildItem(build_id, component_id, quantity, notes);
        return ok(
          `✅ Added **${component.name}** (×${quantity}) to build **"${build.name}"**.\n` +
          `Use \`get_build\` with id ${build_id} to see the updated cost breakdown.`,
        );
      }

      // ── remove_from_build ─────────────────────────────────────────────────
      case 'remove_from_build': {
        const { build_id, component_id } = RemoveBuildItemSchema.parse(args);
        const build = db.getBuildById(build_id) ?? notFound('build', build_id);
        const component = db.getTrackedComponentById(component_id);

        const removed = db.removeBuildItem(build_id, component_id);
        if (!removed) {
          return ok(`Component ID ${component_id} was not in build **"${build.name}"**.`);
        }
        return ok(`🗑️ Removed **${component?.name ?? `Component ${component_id}`}** from build **"${build.name}"**.`);
      }

      // ── delete_build ──────────────────────────────────────────────────────
      case 'delete_build': {
        const { id } = GetBuildSchema.parse(args);
        const build = db.getBuildById(id) ?? notFound('build', id);
        db.deleteBuild(id);
        return ok(
          `🗑️ Build **"${build.name}"** deleted.\n` +
          'All tracked components in the build are still in your watchlist.',
        );
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Tool "${name}" failed: ${(error as Error).message}`,
    );
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

startScheduler();

const webPort = parseInt(process.env.WEB_PORT ?? '3000');
if (webPort > 0) startWebServer(webPort);

const transport = new StdioServerTransport();
await server.connect(transport);
