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
import { searchAllPrebuiltRetailers, ALL_PREBUILT_RETAILER_IDS } from './sources/prebuilt-retailers.js';
import { getAmazonPriceHistory } from './sources/camelcamelcamel.js';
import { importPCPartPickerList } from './sources/pcpartpicker.js';
import { keepaSearch, keepaGetByAsin, keepaGetMultiple } from './sources/keepa.js';
import { awinSearch, awinGetMerchants, awinFeedSearch } from './sources/awin.js';
import { paapiSearch, paapiGetItems } from './sources/amazon-paapi.js';
import { ebayBrowseSearch, ebayBrowseGetItem, type EbayCondition } from './sources/ebay-browse.js';
import { notifyAll, sendDiscord, sendSlack } from './notifications.js';
import { findBenchmark, findCpuBenchmark, findGpuBenchmark, CPU_BENCHMARKS, GPU_BENCHMARKS } from './data/benchmarks.js';
import { checkCompatibility } from './services/compatibility.js';
import { calculateDealScore, getDealScoresForAll } from './services/deal-scorer.js';
import { buildVsBuy, budgetBuilder, upgradeAdvisor, type UseCase } from './services/build-advisor.js';
import { findComponentReviews } from './sources/youtube-reviews.js';
import { searchBuildapc, getUkDeals, getBuildRecommendations } from './sources/reddit.js';
import { searchHukd, getHukdHotDeals, searchHukdForComponent } from './sources/hotukdeals.js';
import { bingSearchPrices, bingFindRetailers } from './sources/bing-shopping.js';
import { validatePrices, getPriceValidationReport } from './services/price-validator.js';
import { scrapeWithBrowser, SUPPORTED_PLAYWRIGHT_RETAILERS, type BrowserScrapeResult } from './sources/playwright-scraper.js';
import { searchPCPartPickerCatalog, fetchPartData, PART_SLUGS, slugForCategory, formatPPComponent, type PartSlug, type PPRegion } from './sources/pcpartpicker-api.js';
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

const ALL_RETAILER_ENUM = [
  'scan', 'overclockers', 'ebuyer', 'ccl', 'box', 'novatech', 'aria', 'awdit',
  'corsair', 'nzxt', 'coolermaster', 'lianli', 'fractal', 'thermaltake',
] as const;

const ALL_PREBUILT_ENUM = [
  'currys', 'argos', 'johnlewis', 'ao', 'very',
  'ebuyer', 'scan', 'overclockers', 'box', 'novatech',
  'ccl', 'chillblast', 'dell', 'hp', 'amazon',
  'pallicomp', 'costco', 'cyberpower', 'pcspecialist', 'lenovo',
  'bedrock',
] as const;

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

const SearchPrebuiltSchema = z.object({
  query: z.string().min(1),
  retailers: z.array(z.enum(ALL_PREBUILT_ENUM)).optional(),
});

const TrackPrebuiltSchema = z.object({
  name: z.string().min(1),
  search_query: z.string().min(1),
  category: z.enum(['gaming', 'workstation', 'office', 'home', 'mini', 'aio', 'other']).default('gaming'),
  brand: z.string().optional(),
  cpu: z.string().optional(),
  gpu: z.string().optional(),
  ram: z.string().optional(),
  storage: z.string().optional(),
  os: z.string().optional(),
  form_factor: z.string().optional(),
  alert_price: z.number().positive().optional(),
  notes: z.string().optional(),
  fetch_now: z.boolean().default(true),
});

const PrebuiltIdSchema = z.object({ id: z.number().int().positive() });

const RefreshPrebuiltSchema = z.object({
  id: z.number().int().positive(),
  retailers: z.array(z.enum(ALL_PREBUILT_ENUM)).optional(),
});

const PrebuiltHistorySchema = z.object({
  id: z.number().int().positive(),
  days: z.number().int().min(1).max(365).default(30),
});

const ComparePrebuiltsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(2).max(5),
});

const SetPrebuiltAlertSchema = z.object({
  id: z.number().int().positive(),
  alert_price: z.number().positive().nullable(),
});

const BenchmarkLookupSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['cpu', 'gpu', 'auto']).default('auto'),
});

const BenchmarkCompareSchema = z.object({
  component_a: z.string().min(1),
  component_b: z.string().min(1),
  type: z.enum(['cpu', 'gpu', 'auto']).default('auto'),
});

const BenchmarkPerPoundSchema = z.object({
  budget_max: z.number().positive(),
  budget_min: z.number().positive().default(0),
  type: z.enum(['cpu', 'gpu']),
  top_n: z.number().int().min(1).max(20).default(10),
});

const CompatibilitySchema = z.object({
  cpu: z.string().optional(),
  motherboard: z.string().optional(),
  ram: z.string().optional(),
  gpu: z.string().optional(),
  psu: z.string().optional(),
  case: z.string().optional(),
  cooler: z.string().optional(),
  storage: z.string().optional(),
});

const DealScoreSchema = z.object({
  component_id: z.number().int().positive().optional(),
});

const BuildVsBuySchema = z.object({
  cpu: z.string().optional(),
  gpu: z.string().optional(),
  ram_gb: z.number().int().positive().optional(),
  storage_gb: z.number().int().positive().optional(),
});

const BudgetBuilderSchema = z.object({
  budget: z.number().positive(),
  use_case: z.enum(['gaming_1080p', 'gaming_1440p', 'gaming_4k', 'workstation', 'streaming', 'general']).default('gaming_1440p'),
});

const UpgradeAdvisorSchema = z.object({
  current_cpu: z.string().min(1),
  current_gpu: z.string().min(1),
  budget: z.number().positive(),
  use_case: z.enum(['gaming_1080p', 'gaming_1440p', 'gaming_4k', 'workstation', 'streaming', 'general']).default('gaming_1440p'),
});

const FindReviewsSchema = z.object({
  component: z.string().min(1),
  max_results: z.number().int().min(1).max(15).default(8),
  trusted_only: z.boolean().default(false),
});

const RedditSearchSchema = z.object({
  query: z.string().min(1),
  sort_by: z.enum(['relevance', 'top', 'new']).default('relevance'),
  max_results: z.number().int().min(1).max(25).default(10),
});

const RedditBuildRecsSchema = z.object({
  budget: z.number().positive(),
  use_case: z.string().default('gaming'),
});

const HukdSearchSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(50).default(20),
});

const HukdHotDealsSchema = z.object({
  category: z.enum(['computing', 'all']).default('computing'),
  max_results: z.number().int().min(1).max(50).default(20),
});

const BingSearchSchema = z.object({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(20).default(10),
  uk_retailers_only: z.boolean().default(true),
});

const BingFindRetailersSchema = z.object({
  query: z.string().min(1),
});

const ValidatePricesSchema = z.object({
  component_id: z.number().int().positive(),
});

const PriceConfidenceSchema = z.object({
  component_id: z.number().int().positive(),
});

const BrowserScrapeSchema = z.object({
  query: z.string().min(1),
  retailers: z.array(z.enum(['currys', 'ao', 'johnlewis', 'very'])).optional(),
  save_to_component_id: z.number().int().positive().optional(),
});

const PPCatalogSchema = z.object({
  query: z.string().min(1),
  part_type: z.enum(PART_SLUGS),
  region: z.string().default('uk'),
  priced_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(100).default(25),
});

const PPBrowseSchema = z.object({
  part_type: z.enum(PART_SLUGS),
  region: z.string().default('uk'),
  priced_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(20),
});

// ── Helpers ────────────────────────────────────────────────────────────────

const KeepaSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(20).default(5),
});

const KeepaAsinSchema = z.object({ asin: z.string().min(1) });

const AwinSearchSchema = z.object({
  query:      z.string(),
  maxResults: z.number().int().min(1).max(100).default(20),
});

const AwinFeedSchema = z.object({
  merchantId: z.string().min(1),
  query:      z.string(),
  maxResults: z.number().int().min(1).max(100).default(20),
});

const PaapiSearchSchema = z.object({
  query:       z.string(),
  searchIndex: z.string().default('Electronics'),
  maxResults:  z.number().int().min(1).max(10).default(10),
});

const PaapiGetItemsSchema = z.object({
  asins: z.array(z.string()).min(1).max(10),
});

const EbayBrowseSearchSchema = z.object({
  query:      z.string().min(1),
  condition:  z.enum(['any', 'new', 'used', 'refurbished']).default('any'),
  maxResults: z.number().int().min(1).max(200).default(20),
});

const EbayBrowseGetItemSchema = z.object({
  itemId: z.string().min(1),
});

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
    // Run Modified Z-score validation before persisting — marks outliers in DB
    const validated = validatePrices(snapshots);
    db.savePriceSnapshots(component.id, validated);
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

  // ── Pre-built PC systems ──────────────────────────────────────────────────
  {
    name: 'search_prebuilt_pcs',
    description:
      'Search for pre-built desktop PC systems across up to 15 major UK retailers: ' +
      'Currys, Argos, John Lewis, AO.com, Very, Ebuyer, Scan, Overclockers, Box, Novatech, CCL, Chillblast, Dell UK, HP UK, Amazon UK. ' +
      'Extracts specs (CPU, GPU, RAM, storage, OS) from product names automatically. ' +
      'Results are NOT saved — use track_prebuilt_pc to persist and monitor.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term, e.g. "gaming desktop RTX 4070" or "Intel i5 desktop PC"' },
        retailers: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_PREBUILT_ENUM] },
          description: 'Which retailers to search (default: all 15)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'track_prebuilt_pc',
    description: 'Add a pre-built PC system to the watchlist for ongoing price monitoring. Optionally provide specs for easier identification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "Scan Spectrum RTX 4070 Gaming PC"' },
        search_query: { type: 'string', description: 'Query string used for price lookups' },
        category: { type: 'string', enum: ['gaming', 'workstation', 'office', 'home', 'mini', 'aio', 'other'], default: 'gaming' },
        brand: { type: 'string' }, cpu: { type: 'string' }, gpu: { type: 'string' },
        ram: { type: 'string' }, storage: { type: 'string' }, os: { type: 'string' },
        form_factor: { type: 'string', description: 'Tower, Mini PC, All-in-One, etc.' },
        alert_price: { type: 'number', description: 'Alert threshold in GBP' },
        notes: { type: 'string' },
        fetch_now: { type: 'boolean', default: true, description: 'Fetch current prices immediately' },
      },
      required: ['name', 'search_query'],
    },
  },
  {
    name: 'list_tracked_prebuilts',
    description: 'List all tracked pre-built PC systems with their best current price.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'refresh_prebuilt_prices',
    description: 'Refresh prices for a tracked pre-built PC system across all 15 retailers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Prebuilt system ID from list_tracked_prebuilts' },
        retailers: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_PREBUILT_ENUM] },
          description: 'Which retailers to query (default: all 15)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_prebuilt_price_history',
    description: 'Get price history and daily trend for a tracked pre-built PC system.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        days: { type: 'number', default: 30 },
      },
      required: ['id'],
    },
  },
  {
    name: 'compare_prebuilt_systems',
    description: 'Compare 2–5 tracked pre-built PC systems side by side — specs, best price, retailers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Prebuilt system IDs to compare (2–5)' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'set_prebuilt_alert',
    description: 'Set or remove a price alert for a tracked pre-built PC system.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number' },
        alert_price: { type: ['number', 'null'], description: 'GBP threshold, or null to remove' },
      },
      required: ['id', 'alert_price'],
    },
  },
  {
    name: 'remove_tracked_prebuilt',
    description: 'Remove a pre-built PC system from the watchlist and delete all stored price history.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },

  // ── Keepa ─────────────────────────────────────────────────────────────────
  {
    name: 'keepa_search',
    description: 'Search Amazon UK via the Keepa API. Returns current prices, all-time low/high, 30/90/180-day averages, and full price history for each product. Requires KEEPA_API_KEY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:  { type: 'string', description: 'Search term (e.g. "RTX 4080", "Ryzen 5 7600X")' },
        limit:  { type: 'number', description: 'Max results (default 5, max 20)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'keepa_get_product',
    description: 'Get full Amazon UK product details and price history by ASIN via Keepa. Includes all-time low/high, 30/90/180-day averages, and up to 365 days of price history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asin: { type: 'string', description: 'Amazon ASIN (e.g. B09P3VZV9C)' },
      },
      required: ['asin'],
    },
  },
  {
    name: 'keepa_get_used_prices',
    description: 'Get used/second-hand price history for an Amazon UK product via Keepa.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asin: { type: 'string' },
      },
      required: ['asin'],
    },
  },

  // ── AWIN ──────────────────────────────────────────────────────────────────
  {
    name: 'awin_search',
    description: 'Search UK retailer products via AWIN (Affiliate Window). Covers Scan, Overclockers, Ebuyer, CCL, Currys, Amazon UK, Novatech and 300+ other UK merchants. Requires AWIN_PUBLISHER_ID and AWIN_API_KEY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:      { type: 'string', description: 'Product search query' },
        maxResults: { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'awin_merchants',
    description: 'List all UK merchants you are joined to in AWIN. Use this to find merchant IDs for awin_feed_search.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'awin_feed_search',
    description: 'Search a specific AWIN merchant\'s product feed by keyword. Useful for retailers that don\'t appear in the main ProductServe search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        merchantId: { type: 'string', description: 'AWIN merchant/programme ID (from awin_merchants)' },
        query:      { type: 'string', description: 'Product search query' },
        maxResults: { type: 'number', default: 20 },
      },
      required: ['merchantId', 'query'],
    },
  },

  // ── Amazon PAAPI ──────────────────────────────────────────────────────────
  {
    name: 'amazon_search',
    description: 'Search Amazon UK via the official Product Advertising API v5. Returns live prices, Prime eligibility, stock status, and product images. Requires AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, and AMAZON_ASSOCIATE_TAG.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:       { type: 'string', description: 'Search keywords' },
        searchIndex: { type: 'string', description: 'Amazon category (default: Electronics)', default: 'Electronics' },
        maxResults:  { type: 'number', description: 'Max results (1–10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'amazon_get_items',
    description: 'Get Amazon UK product details for specific ASINs via PAAPI. Returns live price, stock, and product info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asins: { type: 'array', items: { type: 'string' }, description: 'List of ASINs (max 10)' },
      },
      required: ['asins'],
    },
  },

  // ── eBay Browse API ───────────────────────────────────────────────────────
  {
    name: 'ebay_search',
    description:
      'Search live eBay UK listings via the official Browse API. Returns new, used, and refurbished PC components ' +
      'with price, seller rating, free-shipping flag, and direct listing links. ' +
      'Condition filter: "new" | "used" | "refurbished" | "any" (default). ' +
      'Requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET — free at developer.ebay.com.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:      { type: 'string', description: 'Search term, e.g. "RTX 4080" or "Ryzen 7 7800X3D"' },
        condition:  { type: 'string', enum: ['any', 'new', 'used', 'refurbished'], default: 'any' },
        maxResults: { type: 'number', description: 'Max listings to return (default 20, max 200)', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'ebay_get_item',
    description: 'Get full details for a specific eBay listing by item ID. Returns description, seller info, shipping, returns policy, and all images.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        itemId: { type: 'string', description: 'eBay item ID (the number from the listing URL)' },
      },
      required: ['itemId'],
    },
  },

  // ── Intelligence tools ─────────────────────────────────────────────────
  {
    name: 'benchmark_lookup',
    description:
      'Look up PassMark benchmark score, TDP, architecture, and tier for a CPU or GPU. ' +
      'Enables performance comparisons and value analysis. Data is from the bundled benchmark database (updated quarterly).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component name, e.g. "RTX 4070 Super" or "Ryzen 5 7600X"' },
        type: { type: 'string', enum: ['cpu', 'gpu', 'auto'], default: 'auto' },
      },
      required: ['query'],
    },
  },
  {
    name: 'benchmark_compare',
    description:
      'Compare two CPUs or GPUs head-to-head using PassMark scores. ' +
      'Returns performance delta, tier difference, and upgrade justification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component_a: { type: 'string', description: 'First component name' },
        component_b: { type: 'string', description: 'Second component name' },
        type: { type: 'string', enum: ['cpu', 'gpu', 'auto'], default: 'auto' },
      },
      required: ['component_a', 'component_b'],
    },
  },
  {
    name: 'benchmark_per_pound',
    description:
      'Find the best-value CPUs or GPUs in a given price range, ranked by PassMark score per pound. ' +
      'Uses benchmark database only — does not check live prices.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget_max: { type: 'number', description: 'Maximum price in GBP' },
        budget_min: { type: 'number', description: 'Minimum price in GBP (default 0)', default: 0 },
        type: { type: 'string', enum: ['cpu', 'gpu'] },
        top_n: { type: 'number', default: 10 },
      },
      required: ['budget_max', 'type'],
    },
  },
  {
    name: 'check_compatibility',
    description:
      'Check a set of PC components for compatibility issues: CPU ↔ motherboard socket, ' +
      'DDR4/DDR5 memory standard, PSU wattage sufficiency, and case form factor. ' +
      'No API key needed — uses static compatibility rules.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cpu:         { type: 'string', description: 'CPU name or model, e.g. "Ryzen 5 7600X"' },
        motherboard: { type: 'string', description: 'Motherboard name, e.g. "ASUS ROG Strix B650E-F"' },
        ram:         { type: 'string', description: 'RAM kit, e.g. "Corsair Vengeance 32GB DDR5-6000"' },
        gpu:         { type: 'string', description: 'GPU, e.g. "RTX 4070 Super"' },
        psu:         { type: 'string', description: 'PSU, e.g. "Corsair RM850x 850W"' },
        case:        { type: 'string', description: 'Case, e.g. "Fractal Meshify 2 Compact ATX"' },
        cooler:      { type: 'string', description: 'CPU cooler (optional)' },
        storage:     { type: 'string', description: 'Storage (optional)' },
      },
    },
  },
  {
    name: 'get_deal_score',
    description:
      'Calculate a deal score (0–100) for a tracked component based on its price history. ' +
      '100 = at all-time low, 0 = at all-time high. ' +
      'If no component_id given, returns scores for all tracked components sorted best-deal-first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component_id: { type: 'number', description: 'Optional — specific component to score. Omit to score all.' },
      },
    },
  },
  {
    name: 'build_vs_buy',
    description:
      'Compare building a PC from components versus buying a pre-built system. ' +
      'Looks up your tracked components and pre-built systems for pricing. ' +
      'Returns: build total, cheapest matching pre-built, savings estimate, and verdict.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cpu:        { type: 'string', description: 'Target CPU model, e.g. "Ryzen 5 7600X"' },
        gpu:        { type: 'string', description: 'Target GPU model, e.g. "RTX 4070 Super"' },
        ram_gb:     { type: 'number', description: 'Target RAM in GB (e.g. 32)' },
        storage_gb: { type: 'number', description: 'Target SSD in GB (e.g. 1000)' },
      },
    },
  },
  {
    name: 'budget_builder',
    description:
      'Design an optimal PC build for a given budget and use case. ' +
      'Returns a component allocation breakdown with suggested products and search queries ' +
      'at each budget tier. Use cases: gaming_1080p, gaming_1440p, gaming_4k, workstation, streaming, general.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget:   { type: 'number', description: 'Total budget in GBP' },
        use_case: {
          type: 'string',
          enum: ['gaming_1080p', 'gaming_1440p', 'gaming_4k', 'workstation', 'streaming', 'general'],
          default: 'gaming_1440p',
        },
      },
      required: ['budget'],
    },
  },
  {
    name: 'upgrade_advisor',
    description:
      'Recommend the best component upgrades for an existing PC given current specs and a budget. ' +
      'Identifies the bottleneck (CPU vs GPU), ranks candidates by performance gain per £, ' +
      'and flags whether a new platform (socket) is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        current_cpu: { type: 'string', description: 'Your current CPU, e.g. "Ryzen 5 3600"' },
        current_gpu: { type: 'string', description: 'Your current GPU, e.g. "RTX 2070"' },
        budget:      { type: 'number', description: 'Upgrade budget in GBP' },
        use_case:    {
          type: 'string',
          enum: ['gaming_1080p', 'gaming_1440p', 'gaming_4k', 'workstation', 'streaming', 'general'],
          default: 'gaming_1440p',
        },
      },
      required: ['current_cpu', 'current_gpu', 'budget'],
    },
  },
  {
    name: 'find_reviews',
    description:
      'Find YouTube review videos for a PC component. Results are sorted with trusted hardware ' +
      'channels first (Gamers Nexus, Hardware Unboxed, Linus Tech Tips, Digital Foundry, etc.). ' +
      'Requires YOUTUBE_API_KEY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component:    { type: 'string', description: 'Component name, e.g. "RTX 4070 Super"' },
        max_results:  { type: 'number', default: 8 },
        trusted_only: { type: 'boolean', default: false, description: 'Only return videos from known trusted channels' },
      },
      required: ['component'],
    },
  },
  {
    name: 'reddit_recommendations',
    description:
      'Search r/buildapc on Reddit for community recommendations and build advice. ' +
      'Great for real-world opinions on compatibility, value, and alternatives. ' +
      'Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query:       { type: 'string', description: 'Search query, e.g. "RTX 4070 vs RX 7800 XT"' },
        sort_by:     { type: 'string', enum: ['relevance', 'top', 'new'], default: 'relevance' },
        max_results: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'reddit_uk_deals',
    description:
      'Get the latest UK-tagged deals from r/buildapcsales. Filters for posts mentioning UK retailers ' +
      '(Scan, Overclockers, Ebuyer, Amazon UK, CCL, etc.). ' +
      'Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        max_results: { type: 'number', default: 15 },
      },
    },
  },
  {
    name: 'reddit_build_advice',
    description:
      'Search r/buildapc for community-recommended builds within a budget and use case. ' +
      'Returns relevant posts sorted by Reddit score (upvotes). ' +
      'Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget:   { type: 'number', description: 'Budget in GBP' },
        use_case: { type: 'string', default: 'gaming', description: 'Use case, e.g. "gaming", "workstation", "streaming"' },
      },
      required: ['budget'],
    },
  },

  // ── HotUKDeals ─────────────────────────────────────────────────────────
  {
    name: 'hotukdeals_search',
    description:
      'Search HotUKDeals (UK\'s largest deal community) for PC component deals. ' +
      'Surfaces flash sales, voucher codes, and time-limited offers that don\'t appear on retailer APIs. ' +
      'No API key required. Results include price, merchant, and deal description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component or keyword, e.g. "RTX 4070" or "Fractal case"' },
        max_results: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'hotukdeals_hot',
    description:
      'Get the latest hot deals from HotUKDeals computing category. ' +
      'Shows trending deals ordered by recency. No API key required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['computing', 'all'], default: 'computing' },
        max_results: { type: 'number', default: 20 },
      },
    },
  },

  // ── Bing Shopping ──────────────────────────────────────────────────────
  {
    name: 'bing_search_prices',
    description:
      'Search Bing for UK retailer prices — catches shops not covered by PricesAPI, AWIN, or the direct scrapers. ' +
      'Extracts prices from search snippets. Requires BING_API_KEY (Azure Cognitive Services → Bing Search v7). ' +
      'Free tier: 1,000 calls/month.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component to search, e.g. "Ryzen 5 7600X"' },
        max_results: { type: 'number', default: 10 },
        uk_retailers_only: {
          type: 'boolean',
          default: true,
          description: 'Limit to known UK retailers (Scan, Overclockers, Ebuyer, etc.). False = broader UK search.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'bing_find_retailers',
    description:
      'Broader Bing search to discover any UK retailer selling a component — not limited to the known retailer list. ' +
      'Only returns results where a price was found in the snippet. Requires BING_API_KEY.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component name, e.g. "be quiet Pure Rock 2 cooler"' },
      },
      required: ['query'],
    },
  },

  // ── Price validation & ensemble scoring ────────────────────────────────
  {
    name: 'validate_prices',
    description:
      'Run Modified Z-score outlier detection on the latest prices for a tracked component. ' +
      'Flags prices that are statistical outliers (e.g. data errors, bundle prices, VAT mistakes) using ' +
      'Median Absolute Deviation — more robust than standard Z-score because a single outlier cannot inflate the variance. ' +
      'Outlier records are excluded from deal scores, all-time-low stats, and comparisons.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component_id: { type: 'number', description: 'Component ID from list_tracked_components' },
      },
      required: ['component_id'],
    },
  },
  {
    name: 'price_confidence_report',
    description:
      'Get an ensemble validation report for a tracked component — consensus price (median of non-outlier sources), ' +
      'per-source confidence scores (0–1), and how far each retailer deviates from the consensus. ' +
      'Useful for identifying which sources are most trustworthy for a given component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component_id: { type: 'number', description: 'Component ID from list_tracked_components' },
      },
      required: ['component_id'],
    },
  },
  {
    name: 'scrape_with_browser',
    description:
      'Use a headless Chromium browser (via Playwright) to scrape JS-rendered pages on Currys, AO, John Lewis, and Very — ' +
      'retailers that block or serve incomplete data to plain HTTP fetch requests. ' +
      'Playwright must be enabled at build time (ENABLE_PLAYWRIGHT=true) or PLAYWRIGHT_CHROMIUM_PATH must point to a Chromium binary. ' +
      'Results can be optionally saved to a tracked component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Component or product to search for' },
        retailers: {
          type: 'array',
          items: { type: 'string', enum: ['currys', 'ao', 'johnlewis', 'very'] },
          description: 'Which retailers to scrape (default: all four)',
        },
        save_to_component_id: {
          type: 'number',
          description: 'Optional — save scraped prices to this tracked component ID',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'pcpartpicker_search_catalog',
    description:
      'Search the PCPartPicker UK component catalog (pre-scraped, updated regularly) for a specific part type. ' +
      'Returns components matching your query with full technical specs (VRAM, core count, socket, form factor, etc.) ' +
      'and current GBP prices. 22 part types supported: cpu, video-card, motherboard, memory, internal-hard-drive, ' +
      'power-supply, case, cpu-cooler, case-fan, monitor, and more.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term, e.g. "RTX 4080" or "Ryzen 7 7800X3D"' },
        part_type: {
          type: 'string',
          enum: [...PART_SLUGS],
          description: 'PCPartPicker category slug',
        },
        region: { type: 'string', default: 'uk', description: 'Region code (uk, us, de, fr, ca, au…)' },
        priced_only: { type: 'boolean', default: true, description: 'Exclude items with no listed price' },
        limit: { type: 'number', default: 25, description: 'Max results (1–100)' },
      },
      required: ['query', 'part_type'],
    },
  },
  {
    name: 'pcpartpicker_browse_catalog',
    description:
      'Browse the cheapest (or all) components of a given type from the PCPartPicker UK catalog. ' +
      'Useful for discovering available options without a specific search query — e.g. list all PSUs, all ITX cases, or cheapest SSDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        part_type: {
          type: 'string',
          enum: [...PART_SLUGS],
          description: 'PCPartPicker category slug',
        },
        region: { type: 'string', default: 'uk', description: 'Region code (uk, us, de, fr, ca, au…)' },
        priced_only: { type: 'boolean', default: true, description: 'Exclude items with no listed price' },
        limit: { type: 'number', default: 20, description: 'Max results (1–50)' },
      },
      required: ['part_type'],
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

      // ── search_prebuilt_pcs ───────────────────────────────────────────────
      case 'search_prebuilt_pcs': {
        const { query, retailers } = SearchPrebuiltSchema.parse(args);
        const retailerList = retailers ?? [...ALL_PREBUILT_RETAILER_IDS];
        const results = await searchAllPrebuiltRetailers(query, retailerList);
        const lines = [`## Pre-Built PC Search: "${query}"\n`];
        lines.push(`Searched ${retailerList.length} retailer(s) · ${new Date().toLocaleString('en-GB')}\n`);

        for (const r of results) {
          if (r.error && r.results.length === 0) {
            lines.push(`### ${r.retailer} — ⚠️ ${r.error}`);
            continue;
          }
          lines.push(`### ${r.retailer} (${r.results.length} result(s)) · ${r.durationMs}ms`);
          for (const p of r.results) {
            const priceStr = p.price != null ? fmt(p.price, p.currency) : 'Price N/A';
            const stockStr = p.inStock ? '✅ In Stock' : '❌ Out of Stock';
            lines.push(`- **${p.name}** — **${priceStr}** · ${stockStr}`);
            const specs = [p.cpu, p.gpu, p.ram, p.storage, p.os, p.formFactor].filter(Boolean).join(' · ');
            if (specs) lines.push(`  *${specs}*`);
            if (p.url) lines.push(`  ${p.url}`);
          }
          lines.push('');
        }

        const allResults = results.flatMap(r => r.results.map(p => ({ ...p, _retailer: r.retailer })));
        const best = allResults.filter(p => p.price != null).sort((a, b) => a.price! - b.price!)[0];
        if (best) lines.push(`\n**Best price found: ${fmt(best.price!, best.currency)} at ${best._retailer}**`);

        return ok(lines.join('\n'));
      }

      // ── track_prebuilt_pc ─────────────────────────────────────────────────
      case 'track_prebuilt_pc': {
        const { name: sysName, search_query, category, brand, cpu, gpu, ram, storage, os, form_factor, alert_price, notes, fetch_now } = TrackPrebuiltSchema.parse(args);
        const system = db.addPrebuiltSystem(sysName, category, search_query, {
          brand, cpu, gpu, ram, storage, os, formFactor: form_factor,
          alertPrice: alert_price, notes,
        });

        const lines = [
          `✅ Now tracking **"${system.name}"** (ID: **${system.id}**)\n`,
          `Category: ${system.category}${system.cpu ? ` · CPU: ${system.cpu}` : ''}${system.gpu ? ` · GPU: ${system.gpu}` : ''}`,
        ];

        if (fetch_now) {
          lines.push('\n⏳ Fetching current prices across 15 retailers…');
          const results = await searchAllPrebuiltRetailers(search_query);
          const snapshots: db.PrebuiltPriceSnapshot[] = [];
          for (const r of results) {
            for (const p of r.results) {
              if (p.price && p.price > 0) {
                snapshots.push({ source: r.retailer, price: p.price, currency: p.currency, retailer: r.retailer, url: p.url, inStock: p.inStock });
              }
            }
          }
          if (snapshots.length > 0) {
            db.savePrebuiltPriceSnapshots(system.id, snapshots);
            db.markPrebuiltLastChecked(system.id);
            const best = snapshots.sort((a, b) => a.price - b.price)[0];
            lines.push(`✅ Saved ${snapshots.length} price records. Best: **${fmt(best.price, best.currency)} at ${best.retailer}**`);
          } else {
            lines.push('⚠️ No prices found yet — try `refresh_prebuilt_prices` later.');
          }
        }

        if (alert_price) lines.push(`\n🔔 Alert set at ${fmtRaw(alert_price)}`);
        return ok(lines.join('\n'));
      }

      // ── list_tracked_prebuilts ────────────────────────────────────────────
      case 'list_tracked_prebuilts': {
        const systems = db.getPrebuiltSystems();
        if (systems.length === 0) {
          return ok('No pre-built PC systems tracked yet.\nUse `search_prebuilt_pcs` to find systems, then `track_prebuilt_pc` to monitor them.');
        }

        const lines = [`## Tracked Pre-Built PCs (${systems.length})\n`];
        lines.push('| ID | Name | Category | Best Price | Retailer | Alert | Checked |');
        lines.push('|----|------|----------|------------|----------|-------|---------|');

        for (const s of systems) {
          const latest = db.getLatestPrebuiltPricePerRetailer(s.id);
          const best = latest[0];
          const priceStr = best ? fmt(best.price, best.currency) : '—';
          const retailerStr = best?.retailer ?? '—';
          const alertStr = s.alert_price ? fmtRaw(s.alert_price) : '—';
          const checkedStr = s.last_checked ? new Date(s.last_checked + 'Z').toLocaleDateString('en-GB') : 'Never';
          lines.push(`| ${s.id} | ${s.name} | ${s.category} | **${priceStr}** | ${retailerStr} | ${alertStr} | ${checkedStr} |`);
        }

        return ok(lines.join('\n'));
      }

      // ── refresh_prebuilt_prices ───────────────────────────────────────────
      case 'refresh_prebuilt_prices': {
        const { id, retailers } = RefreshPrebuiltSchema.parse(args);
        const system = db.getPrebuiltSystemById(id) ?? notFound('prebuilt system', id);
        const retailerList = retailers ?? [...ALL_PREBUILT_RETAILER_IDS];
        const results = await searchAllPrebuiltRetailers(system.search_query, retailerList);
        const snapshots: db.PrebuiltPriceSnapshot[] = [];

        for (const r of results) {
          for (const p of r.results) {
            if (p.price && p.price > 0) {
              snapshots.push({ source: r.retailer, price: p.price, currency: p.currency, retailer: r.retailer, url: p.url, inStock: p.inStock });
            }
          }
        }

        if (snapshots.length > 0) {
          db.savePrebuiltPriceSnapshots(id, snapshots);
          db.markPrebuiltLastChecked(id);
        }

        const latest = db.getLatestPrebuiltPricePerRetailer(id);
        const best = latest[0];
        const lines = [
          `## Prices refreshed — **"${system.name}"**\n`,
          `Queried ${retailerList.length} retailer(s) · Saved ${snapshots.length} price records\n`,
        ];

        if (best) {
          const alertNote = system.alert_price && best.price <= system.alert_price ? ' 🔔 **BELOW ALERT PRICE!**' : '';
          lines.push(`**Best: ${fmt(best.price, best.currency)} at ${best.retailer}**${alertNote}`);
        }

        if (latest.length > 1) {
          lines.push('\n| Retailer | Price | In Stock |');
          lines.push('|----------|-------|----------|');
          for (const p of latest.slice(0, 10)) {
            lines.push(`| ${p.retailer} | ${fmt(p.price, p.currency)} | ${p.in_stock ? '✅' : '❌'} |`);
          }
        }

        return ok(lines.join('\n'));
      }

      // ── get_prebuilt_price_history ────────────────────────────────────────
      case 'get_prebuilt_price_history': {
        const { id, days } = PrebuiltHistorySchema.parse(args);
        const system = db.getPrebuiltSystemById(id) ?? notFound('prebuilt system', id);
        const stats = db.getPrebuiltPriceStats(id);
        const trend = db.getPrebuiltDailyPriceTrend(id, days);

        const lines = [`## Price History — **"${system.name}"** (${days}d)\n`];
        if (stats.all_time_low != null) {
          lines.push(`All-time low: **${fmt(stats.all_time_low, stats.currency)}** · High: ${fmt(stats.all_time_high!, stats.currency)}`);
          lines.push(`30-day avg: ${stats.avg_30d != null ? fmt(stats.avg_30d, stats.currency) : '—'} · Current best: ${stats.current_best != null ? fmt(stats.current_best, stats.currency) : '—'}`);
          lines.push(`Total price records: ${stats.total_records}\n`);
        } else {
          lines.push('No price data yet — run `refresh_prebuilt_prices` first.\n');
        }

        if (trend.length > 0) {
          lines.push('| Date | Min | Avg | Max |');
          lines.push('|------|-----|-----|-----|');
          for (const t of trend.slice(-14)) {
            lines.push(`| ${t.date} | ${fmt(t.min_price, stats.currency)} | ${fmt(t.avg_price, stats.currency)} | ${fmt(t.max_price, stats.currency)} |`);
          }
        }

        return ok(lines.join('\n'));
      }

      // ── compare_prebuilt_systems ──────────────────────────────────────────
      case 'compare_prebuilt_systems': {
        const { ids } = ComparePrebuiltsSchema.parse(args);
        const systems = ids.map(id => db.getPrebuiltSystemById(id) ?? notFound('prebuilt system', id));
        const lines = [`## Pre-Built PC Comparison (${systems.length} systems)\n`];

        const specFields: Array<{ key: keyof db.PrebuiltSystem; label: string }> = [
          { key: 'category', label: 'Category' },
          { key: 'brand', label: 'Brand' },
          { key: 'cpu', label: 'CPU' },
          { key: 'gpu', label: 'GPU' },
          { key: 'ram', label: 'RAM' },
          { key: 'storage', label: 'Storage' },
          { key: 'os', label: 'OS' },
          { key: 'form_factor', label: 'Form Factor' },
        ];

        lines.push(`| Spec | ${systems.map(s => s.name).join(' | ')} |`);
        lines.push(`|------|${systems.map(() => '------').join('|')}|`);

        for (const { key, label } of specFields) {
          const vals = systems.map(s => String(s[key] ?? '—'));
          if (vals.some(v => v !== '—')) {
            lines.push(`| ${label} | ${vals.join(' | ')} |`);
          }
        }

        lines.push('\n**Current Best Prices:**\n');
        lines.push(`| System | Best Price | Retailer | In Stock |`);
        lines.push(`|--------|------------|----------|----------|`);

        for (const s of systems) {
          const latest = db.getLatestPrebuiltPricePerRetailer(s.id);
          const best = latest[0];
          const priceStr = best ? fmt(best.price, best.currency) : '—';
          const retailerStr = best?.retailer ?? '—';
          const stockStr = best ? (best.in_stock ? '✅' : '❌') : '—';
          lines.push(`| [${s.id}] ${s.name} | **${priceStr}** | ${retailerStr} | ${stockStr} |`);
        }

        return ok(lines.join('\n'));
      }

      // ── set_prebuilt_alert ────────────────────────────────────────────────
      case 'set_prebuilt_alert': {
        const { id, alert_price } = SetPrebuiltAlertSchema.parse(args);
        const system = db.getPrebuiltSystemById(id) ?? notFound('prebuilt system', id);
        db.updatePrebuiltAlertPrice(id, alert_price);
        return ok(
          alert_price != null
            ? `🔔 Alert set at **${fmtRaw(alert_price)}** for **"${system.name}"**.\nYou'll be notified when the price drops below this threshold.`
            : `🔕 Alert removed for **"${system.name}"**.`,
        );
      }

      // ── remove_tracked_prebuilt ───────────────────────────────────────────
      case 'remove_tracked_prebuilt': {
        const { id } = PrebuiltIdSchema.parse(args);
        const system = db.getPrebuiltSystemById(id) ?? notFound('prebuilt system', id);
        db.removePrebuiltSystem(id);
        return ok(`🗑️ **"${system.name}"** removed from prebuilt watchlist.\nAll price history for this system has been deleted.`);
      }

      // ── Keepa ──────────────────────────────────────────────────────────────

      case 'keepa_search': {
        const { query, limit } = KeepaSearchSchema.parse(args);
        const result = await keepaSearch(query, limit);
        if (result.error) return ok(`Keepa error: ${result.error}`);
        if (result.products.length === 0) return ok(`No Amazon UK results found for "${query}" via Keepa.`);
        const lines = [`## Keepa: "${query}" — Amazon UK (${result.products.length} results)\n`];
        for (const p of result.products) {
          lines.push(`### ${p.title}`);
          lines.push(`ASIN: \`${p.asin}\` | ${p.brand ? `Brand: ${p.brand} | ` : ''}${p.inStock ? 'In Stock' : 'Out of Stock'}`);
          lines.push(`**Current:** ${p.currentPrice != null ? fmtRaw(p.currentPrice) : 'N/A'} | **All-time low:** ${p.allTimeLow != null ? fmtRaw(p.allTimeLow) : 'N/A'} | **ATH:** ${p.allTimeHigh != null ? fmtRaw(p.allTimeHigh) : 'N/A'}`);
          lines.push(`Avg 30d: ${p.avg30d != null ? fmtRaw(p.avg30d) : 'N/A'} | Avg 90d: ${p.avg90d != null ? fmtRaw(p.avg90d) : 'N/A'} | Avg 180d: ${p.avg180d != null ? fmtRaw(p.avg180d) : 'N/A'}`);
          if (p.priceHistory.length > 0) {
            const recent = p.priceHistory.slice(-5);
            lines.push(`Recent prices: ${recent.map(h => `${h.date} → ${fmtRaw(h.price)}`).join(', ')}`);
          }
          lines.push(`[View on Amazon](${p.url})\n`);
        }
        if (result.tokensLeft != null) lines.push(`\n*Keepa tokens remaining: ${result.tokensLeft}*`);
        return ok(lines.join('\n'));
      }

      case 'keepa_get_product': {
        const { asin } = KeepaAsinSchema.parse(args);
        const p = await keepaGetByAsin(asin);
        if (!p) return ok(`No product found for ASIN ${asin} on Amazon UK via Keepa.`);
        const lines = [`## ${p.title}`, `ASIN: \`${p.asin}\`${p.brand ? ` | Brand: ${p.brand}` : ''} | ${p.inStock ? 'In Stock' : 'Out of Stock'}`];
        lines.push(`\n**Prices**`);
        lines.push(`Current: ${p.currentPrice != null ? fmtRaw(p.currentPrice) : 'N/A'} | All-time low: ${p.allTimeLow != null ? fmtRaw(p.allTimeLow) : 'N/A'} | All-time high: ${p.allTimeHigh != null ? fmtRaw(p.allTimeHigh) : 'N/A'}`);
        lines.push(`30d avg: ${p.avg30d != null ? fmtRaw(p.avg30d) : 'N/A'} | 90d avg: ${p.avg90d != null ? fmtRaw(p.avg90d) : 'N/A'} | 180d avg: ${p.avg180d != null ? fmtRaw(p.avg180d) : 'N/A'}`);
        lines.push(`\n**Price history (last 30 entries)**`);
        for (const h of p.priceHistory.slice(-30)) lines.push(`${h.date}: ${fmtRaw(h.price)}`);
        lines.push(`\n[View on Amazon](${p.url})`);
        return ok(lines.join('\n'));
      }

      case 'keepa_get_used_prices': {
        const { asin } = KeepaAsinSchema.parse(args);
        const { keepaGetUsedPrices } = await import('./sources/keepa.js');
        const history = await keepaGetUsedPrices(asin);
        if (history.length === 0) return ok(`No used price history for ASIN ${asin}.`);
        const lines = [`## Used price history for \`${asin}\` (last 365 days)\n`];
        for (const h of history) lines.push(`${h.date}: ${fmtRaw(h.price)}`);
        return ok(lines.join('\n'));
      }

      // ── AWIN ───────────────────────────────────────────────────────────────

      case 'awin_search': {
        const { query, maxResults } = AwinSearchSchema.parse(args);
        const result = await awinSearch(query, maxResults);
        if (result.error) return ok(`AWIN error: ${result.error}`);
        if (result.products.length === 0) return ok(`No AWIN results for "${query}". Check AWIN credentials or try a different query.`);
        const lines = [`## AWIN: "${query}" — ${result.products.length} results across UK retailers\n`];
        for (const p of result.products) {
          lines.push(`**${p.name}** — ${p.merchant}`);
          lines.push(`${p.price != null ? fmtRaw(p.price) : 'Price N/A'}${p.rrp ? ` (RRP ${fmtRaw(p.rrp)})` : ''} | ${p.inStock ? 'In Stock' : 'Out of Stock'}`);
          if (p.brand) lines.push(`Brand: ${p.brand}`);
          if (p.ean)   lines.push(`EAN: ${p.ean}`);
          if (p.url)   lines.push(`[View product](${p.url})`);
          lines.push('');
        }
        return ok(lines.join('\n'));
      }

      case 'awin_merchants': {
        const merchants = await awinGetMerchants();
        if (merchants.length === 0) return ok('No joined UK merchants found. Join programmes at awin.com/gb/publishers.');
        const lines = [`## AWIN Joined UK Merchants (${merchants.length})\n`];
        for (const m of merchants) lines.push(`**${m.name}** — ID: \`${m.id}\`${m.url ? ` — ${m.url}` : ''}`);
        return ok(lines.join('\n'));
      }

      case 'awin_feed_search': {
        const { merchantId, query, maxResults } = AwinFeedSchema.parse(args);
        const result = await awinFeedSearch(merchantId, query, maxResults);
        if (result.error) return ok(`AWIN feed error: ${result.error}`);
        if (result.products.length === 0) return ok(`No results for "${query}" in merchant ${merchantId}.`);
        const lines = [`## AWIN Feed: "${query}" — ${result.products[0]?.merchant ?? merchantId} (${result.products.length} results)\n`];
        for (const p of result.products) {
          lines.push(`**${p.name}** | ${p.price != null ? fmtRaw(p.price) : 'N/A'} | ${p.inStock ? 'In Stock' : 'Out of Stock'}`);
          if (p.ean) lines.push(`EAN: ${p.ean}`);
          if (p.url) lines.push(`[View](${p.url})`);
          lines.push('');
        }
        return ok(lines.join('\n'));
      }

      // ── Amazon PAAPI ────────────────────────────────────────────────────────

      case 'amazon_search': {
        const { query, searchIndex, maxResults } = PaapiSearchSchema.parse(args);
        const result = await paapiSearch(query, searchIndex, maxResults);
        if (result.error) return ok(`Amazon PAAPI error: ${result.error}`);
        if (result.products.length === 0) return ok(`No Amazon UK results for "${query}".`);
        const lines = [`## Amazon UK: "${query}" — ${result.products.length} results${result.totalResults ? ` of ${result.totalResults}` : ''}\n`];
        for (const p of result.products) {
          lines.push(`### ${p.title}`);
          lines.push(`ASIN: \`${p.asin}\`${p.brand ? ` | Brand: ${p.brand}` : ''} | ${p.inStock ? 'In Stock' : 'Out of Stock'}${p.isPrime ? ' | Prime' : ''}`);
          lines.push(`**Price:** ${p.price != null ? fmtRaw(p.price, p.currency) : 'N/A'}${p.lowestNewPrice != null && p.lowestNewPrice !== p.price ? ` | Lowest new: ${fmtRaw(p.lowestNewPrice, p.currency)}` : ''}`);
          if (p.features.length > 0) lines.push(`- ${p.features.join('\n- ')}`);
          lines.push(`[View on Amazon](${p.url})\n`);
        }
        return ok(lines.join('\n'));
      }

      case 'amazon_get_items': {
        const { asins } = PaapiGetItemsSchema.parse(args);
        const result = await paapiGetItems(asins);
        if (result.error) return ok(`Amazon PAAPI error: ${result.error}`);
        if (result.products.length === 0) return ok('No products found for the given ASINs.');
        const lines = [`## Amazon UK — ${result.products.length} items\n`];
        for (const p of result.products) {
          lines.push(`### ${p.title}`);
          lines.push(`ASIN: \`${p.asin}\`${p.brand ? ` | ${p.brand}` : ''} | ${p.inStock ? 'In Stock' : 'Out of Stock'}${p.isPrime ? ' | Prime' : ''}`);
          lines.push(`**Price:** ${p.price != null ? fmtRaw(p.price, p.currency) : 'N/A'}`);
          lines.push(`[View on Amazon](${p.url})\n`);
        }
        return ok(lines.join('\n'));
      }

      // ── eBay Browse API ────────────────────────────────────────────────────

      case 'ebay_search': {
        const { query, condition, maxResults } = EbayBrowseSearchSchema.parse(args);
        const result = await ebayBrowseSearch(query, condition as EbayCondition, maxResults);
        if (result.error) return ok(`eBay error: ${result.error}`);
        if (result.listings.length === 0) return ok(`No eBay UK listings found for "${query}"${condition !== 'any' ? ` (condition: ${condition})` : ''}.`);

        const totalStr = result.total != null ? ` of ~${result.total.toLocaleString()}` : '';
        const lines = [
          `## eBay UK: "${query}"${condition !== 'any' ? ` — ${condition}` : ''} (${result.listings.length}${totalStr} listings)\n`,
          '| Title | Price | Condition | Shipping | Seller | |',
          '|-------|-------|-----------|----------|--------|---|',
        ];

        for (const l of result.listings) {
          const priceStr  = l.price != null ? fmtRaw(l.price, l.currency) : 'See listing';
          const shipStr   = l.freeShipping ? '**Free**' : '—';
          const sellerStr = l.feedbackPct != null ? `${l.seller} (${l.feedbackPct.toFixed(0)}%)` : l.seller;
          const condShort = l.condition.replace('Seller refurbished', 'Refurb').replace('Manufacturer refurbished', 'Mfr refurb');
          lines.push(`| ${l.title.slice(0, 60)}${l.title.length > 60 ? '…' : ''} | **${priceStr}** | ${condShort} | ${shipStr} | ${sellerStr} | [View](${l.url}) |`);
        }

        lines.push(`\n*Scraped: ${new Date(result.scrapedAt).toLocaleString('en-GB')} · ${result.durationMs}ms*`);
        lines.push('> eBay prices include private seller listings. Always check seller feedback before buying.');
        return ok(lines.join('\n'));
      }

      case 'ebay_get_item': {
        const { itemId } = EbayBrowseGetItemSchema.parse(args);
        const item = await ebayBrowseGetItem(itemId);
        if (!item) return ok(`eBay item ${itemId} not found or no longer available.`);

        const price    = (item.price as Record<string, unknown> | null);
        const seller   = (item.seller as Record<string, unknown> | null);
        const shipping = ((item.shippingOptions as Record<string, unknown>[] | null) ?? [])[0];
        const returns  = (item.returnTerms as Record<string, unknown> | null);

        const lines = [
          `## ${String(item.title ?? 'eBay Listing')}`,
          `**Item ID:** ${itemId}`,
          price?.value != null ? `**Price:** ${fmtRaw(parseFloat(String(price.value)), String(price.currency ?? 'GBP'))}` : '',
          `**Condition:** ${String(item.condition ?? 'Unknown')}`,
          `**Status:** ${item.itemEndDate ? `Ends ${new Date(String(item.itemEndDate)).toLocaleString('en-GB')}` : 'Fixed price'}`,
          seller ? `**Seller:** ${String(seller.username ?? '?')}${seller.feedbackPercentage != null ? ` (${seller.feedbackPercentage}% positive)` : ''}` : '',
          shipping ? `**Shipping:** ${String(shipping.shippingCostType ?? '')} — ${String((shipping.shippingCost as Record<string, unknown> | null)?.value ?? '')} ${String((shipping.shippingCost as Record<string, unknown> | null)?.currency ?? '')}` : '',
          returns ? `**Returns:** ${String(returns.returnsAccepted ? 'Accepted' : 'Not accepted')}${returns.returnPeriod ? ` — ${String(returns.returnPeriod)}` : ''}` : '',
          item.description ? `\n**Description:**\n${String(item.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)}` : '',
          `\n[View on eBay](${String(item.itemWebUrl ?? `https://www.ebay.co.uk/itm/${itemId}`)})`,
        ];

        return ok(lines.filter(Boolean).join('\n'));
      }

      // ── hotukdeals_search ─────────────────────────────────────────────────
      case 'hotukdeals_search': {
        const { query, max_results } = HukdSearchSchema.parse(args);
        const result = await searchHukd(query, max_results);
        if (result.error) return ok(`HotUKDeals search failed: ${result.error}`);
        if (!result.deals.length) return ok(`No HotUKDeals found for "${query}".`);
        const lines = [
          `## HotUKDeals — "${query}" (${result.deals.length} deals)`,
          '',
          ...result.deals.map((d, i) => {
            const priceLine = d.price != null ? ` — ${fmt(d.price)}` : '';
            const merchantLine = d.merchant ? ` @ ${d.merchant}` : '';
            return [
              `### ${i + 1}. ${d.title}`,
              `${priceLine || merchantLine ? `**${d.price != null ? fmt(d.price) : ''}${merchantLine}**` : ''}`,
              d.description ? `> ${d.description.slice(0, 200)}` : '',
              `📅 ${d.publishedAt.split('T')[0]}${d.category ? ` | [${d.category}]` : ''}`,
              `[View Deal](${d.url})`,
            ].filter(Boolean).join('\n');
          }),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── hotukdeals_hot ────────────────────────────────────────────────────
      case 'hotukdeals_hot': {
        const { category, max_results } = HukdHotDealsSchema.parse(args);
        const result = await getHukdHotDeals(category, max_results);
        if (result.error) return ok(`HotUKDeals fetch failed: ${result.error}`);
        if (!result.deals.length) return ok('No hot deals found right now.');
        const lines = [
          `## HotUKDeals — Hot ${category === 'all' ? 'All' : 'Computing'} Deals`,
          '',
          ...result.deals.map((d, i) => {
            return [
              `### ${i + 1}. ${d.title}`,
              d.price != null ? `**${fmt(d.price)}**${d.merchant ? ` @ ${d.merchant}` : ''}` : (d.merchant ? `@ ${d.merchant}` : ''),
              d.description ? `> ${d.description.slice(0, 150)}` : '',
              `📅 ${d.publishedAt.split('T')[0]}  [View Deal](${d.url})`,
            ].filter(Boolean).join('\n');
          }),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── bing_search_prices ────────────────────────────────────────────────
      case 'bing_search_prices': {
        const { query, max_results, uk_retailers_only } = BingSearchSchema.parse(args);
        const result = await bingSearchPrices(query, max_results, uk_retailers_only);
        if (result.error) return ok(`Bing price search failed: ${result.error}`);
        if (!result.results.length) return ok(`No Bing price results found for "${query}".`);
        const withPrice = result.results.filter(r => r.price !== null);
        const noPrice   = result.results.filter(r => r.price === null);
        const lines = [
          `## Bing Price Search — ${query}`,
          `*${result.results.length} results — ${withPrice.length} with prices extracted*`,
          '',
          withPrice.length > 0 ? '### Results with prices' : '',
          ...withPrice.map((r, i) =>
            `**${i + 1}. ${fmt(r.price!)}** — [${r.siteName}](${r.url})\n> ${r.snippet.slice(0, 180)}`,
          ),
          noPrice.length > 0 ? '\n### Additional results (no price in snippet)' : '',
          ...noPrice.map((r, i) =>
            `${i + 1}. [${r.name.slice(0, 80)}](${r.url}) — ${r.siteName}`,
          ),
        ];
        return ok(lines.filter(Boolean).join('\n\n'));
      }

      // ── bing_find_retailers ───────────────────────────────────────────────
      case 'bing_find_retailers': {
        const { query } = BingFindRetailersSchema.parse(args);
        const result = await bingFindRetailers(query);
        if (result.error) return ok(`Bing retailer search failed: ${result.error}`);
        if (!result.results.length) return ok(`No UK retailers with prices found for "${query}" via Bing.`);
        const lines = [
          `## Bing — UK Retailers for "${query}"`,
          `*${result.results.length} retailers found with prices in snippets*`,
          '',
          '| # | Retailer | Price | In Stock |',
          '|---|---|---|---|',
          ...result.results.map((r, i) =>
            `| ${i + 1} | [${r.siteName}](${r.url}) | ${r.price != null ? fmt(r.price) : '—'} | ${r.inStock === true ? 'Yes' : r.inStock === false ? 'No' : '?'} |`,
          ),
          '',
          '*Prices extracted from Bing snippets — verify on retailer site before purchasing.*',
        ];
        return ok(lines.join('\n'));
      }

      // ── benchmark_lookup ──────────────────────────────────────────────────
      case 'benchmark_lookup': {
        const { query, type } = BenchmarkLookupSchema.parse(args);
        const result = findBenchmark(query, type);
        if (!result) {
          return ok(`No benchmark data found for "${query}". Try a more specific name like "RTX 4070 Super" or "Ryzen 5 7600X".`);
        }
        const isCpu = 'socket' in result;
        const lines = [
          `## ${result.name}`,
          `**Type:** ${isCpu ? 'CPU' : 'GPU'}`,
          `**Tier:** ${result.tier}`,
          `**Brand:** ${result.brand}`,
          isCpu ? `**Socket:** ${(result as any).socket}` : `**Architecture:** ${(result as any).architecture}`,
          isCpu ? `**Cores/Threads:** ${(result as any).cores}C / ${(result as any).threads}T` : `**VRAM:** ${(result as any).vram}GB ${(result as any).memType}`,
          `**TDP:** ${result.tdp}W`,
          '',
          `**PassMark Score:** ${result.score.toLocaleString()} ${isCpu ? '(multi-thread)' : '(G3D Mark)'}`,
          isCpu ? `**Single-thread:** ${(result as any).singleScore.toLocaleString()}` : '',
        ];
        return ok(lines.filter(Boolean).join('\n'));
      }

      // ── benchmark_compare ─────────────────────────────────────────────────
      case 'benchmark_compare': {
        const { component_a, component_b, type } = BenchmarkCompareSchema.parse(args);
        const a = findBenchmark(component_a, type);
        const b = findBenchmark(component_b, type);
        if (!a) return ok(`Could not find benchmark data for "${component_a}".`);
        if (!b) return ok(`Could not find benchmark data for "${component_b}".`);
        const winner = a.score >= b.score ? a : b;
        const loser  = a.score >= b.score ? b : a;
        const diffPct = Math.round((winner.score - loser.score) / loser.score * 100);
        const lines = [
          `## Benchmark Comparison`,
          '',
          `| | ${a.name} | ${b.name} |`,
          `|---|---|---|`,
          `| PassMark | ${a.score.toLocaleString()} | ${b.score.toLocaleString()} |`,
          `| TDP | ${a.tdp}W | ${b.tdp}W |`,
          'socket' in a ? `| Socket | ${(a as any).socket} | ${(b as any).socket} |` : `| VRAM | ${(a as any).vram}GB | ${(b as any).vram}GB |`,
          `| Tier | ${a.tier} | ${b.tier} |`,
          '',
          `**Winner:** ${winner.name} is **${diffPct}% faster** (${winner.score.toLocaleString()} vs ${loser.score.toLocaleString()})`,
          diffPct < 10 ? '\n> The performance difference is under 10% — likely imperceptible in real-world use.' : '',
          diffPct > 30 ? `\n> A ${diffPct}% gap is significant — the ${winner.name} is a meaningful step up.` : '',
        ];
        return ok(lines.filter(Boolean).join('\n'));
      }

      // ── benchmark_per_pound ───────────────────────────────────────────────
      case 'benchmark_per_pound': {
        const { budget_max, budget_min, type, top_n } = BenchmarkPerPoundSchema.parse(args);
        const data = type === 'gpu' ? GPU_BENCHMARKS : CPU_BENCHMARKS;
        const TIER_PRICES: Record<string, number> = {
          budget: 80,  entry: 130, mid: 220, 'mid-high': 340, high: 520, ultra: 850,
        };
        const filtered = data
          .map(c => {
            const estPrice = TIER_PRICES[c.tier] ?? 300;
            return { ...c, estPrice, scorePerPound: Math.round(c.score / estPrice) };
          })
          .filter(c => c.estPrice >= budget_min && c.estPrice <= budget_max)
          .sort((a, b) => b.scorePerPound - a.scorePerPound)
          .slice(0, top_n);

        if (!filtered.length) return ok(`No ${type.toUpperCase()} data found in the £${budget_min}–£${budget_max} range.`);

        const header = `## Best Value ${type.toUpperCase()}s — £${budget_min}–£${budget_max}`;
        const table = [
          `| # | Name | PassMark | Est. Price | Score/£ | Tier |`,
          `|---|---|---|---|---|---|`,
          ...filtered.map((c, i) =>
            `| ${i + 1} | ${c.name} | ${c.score.toLocaleString()} | ~£${c.estPrice} | ${c.scorePerPound} | ${c.tier} |`,
          ),
        ];
        return ok([header, '', ...table, '', '*Prices are tier-based estimates. Use search_components for live pricing.*'].join('\n'));
      }

      // ── check_compatibility ───────────────────────────────────────────────
      case 'check_compatibility': {
        const { cpu, motherboard, ram, gpu, psu, case: pcCase, cooler, storage } = CompatibilitySchema.parse(args);
        const result = checkCompatibility({ cpu, motherboard, ram, gpu, psu, case: pcCase, cooler, storage });
        const lines = [
          `## Compatibility Check`,
          `**Result:** ${result.isCompatible ? '✓ Compatible' : '✗ Issues Found'}`,
          `**Summary:** ${result.summary}`,
          result.estimatedPsuWatts ? `**Estimated power draw:** ~${result.estimatedPsuWatts}W` : '',
        ];
        if (result.issues.length > 0) {
          lines.push('', '### Errors (must fix)');
          for (const iss of result.issues) {
            lines.push(`- **${iss.type}:** ${iss.message}`);
          }
        }
        if (result.warnings.length > 0) {
          lines.push('', '### Warnings (review recommended)');
          for (const w of result.warnings) {
            lines.push(`- **${w.type}:** ${w.message}`);
          }
        }
        return ok(lines.filter(l => l !== undefined).join('\n'));
      }

      // ── get_deal_score ────────────────────────────────────────────────────
      case 'get_deal_score': {
        const { component_id } = DealScoreSchema.parse(args);
        if (component_id) {
          const d = calculateDealScore(component_id);
          if (d.score === null) return ok(`Insufficient price history for component ${component_id}. Run refresh_prices to gather more data.`);
          const lines = [
            `## Deal Score: ${d.componentName}`,
            `**Score:** ${d.score}/100 — ${d.label}`,
            `**Current best price:** ${d.currentBestPrice != null ? fmt(d.currentBestPrice) : 'Unknown'}`,
            `**All-time low:** ${d.allTimeLow != null ? fmt(d.allTimeLow) : 'Unknown'}`,
            `**30-day average:** ${d.avg30d != null ? fmt(d.avg30d) : 'Unknown'}`,
            d.vsAvg30dPercent != null ? `**vs 30-day avg:** ${d.vsAvg30dPercent > 0 ? `-${d.vsAvg30dPercent}%` : `+${Math.abs(d.vsAvg30dPercent)}%`}` : '',
            `**Data points:** ${d.dataPoints}`,
            '',
            `**Recommendation:** ${d.recommendation}`,
          ];
          return ok(lines.filter(Boolean).join('\n'));
        }
        const scores = getDealScoresForAll();
        if (!scores.length) return ok('No components have enough price history yet. Track some components and run refresh_prices first.');
        const lines = [
          '## Deal Scores — All Tracked Components',
          '',
          '| # | Component | Score | Label | Current Price | vs ATL |',
          '|---|---|---|---|---|---|',
          ...scores.map((d, i) =>
            `| ${i + 1} | ${d.componentName} | ${d.score}/100 | ${d.label} | ${d.currentBestPrice != null ? fmt(d.currentBestPrice) : '—'} | +${d.vsAllTimeLowPercent ?? '?'}% |`,
          ),
        ];
        return ok(lines.join('\n'));
      }

      // ── build_vs_buy ──────────────────────────────────────────────────────
      case 'build_vs_buy': {
        const { cpu, gpu, ram_gb, storage_gb } = BuildVsBuySchema.parse(args);
        const result = buildVsBuy({ cpu, gpu, ramGb: ram_gb, storageGb: storage_gb });
        const lines = [
          '## Build vs Buy Analysis',
          '',
          result.buildComponents.length > 0 ? '### Build components' : '',
          ...result.buildComponents.map(c =>
            `- **${c.category.toUpperCase()}** ${c.name}: ${c.price != null ? fmt(c.price) : 'price unknown'} ${c.retailer ? `(${c.retailer})` : ''}`,
          ),
          result.buildCost != null ? `\n**Total build cost: ${fmt(result.buildCost)}**` : '',
          '',
          result.cheapestPrebuilt
            ? `### Cheapest matching pre-built\n- **${result.cheapestPrebuilt.name}** — ${fmt(result.cheapestPrebuilt.price)} (${result.cheapestPrebuilt.retailer})${result.cheapestPrebuilt.url ? `\n  [View listing](${result.cheapestPrebuilt.url})` : ''}`
            : '### Pre-built comparison\nNo matching pre-built systems tracked.',
          '',
          `**Verdict:** ${result.verdict === 'build' ? '🔧 Build — cheaper and more flexible' : result.verdict === 'buy' ? '🛒 Buy — pre-built is better value' : result.verdict === 'similar' ? '⚖️ Similar cost — choose based on preference' : '⚠️ Insufficient data'}`,
          result.savingsIfBuild != null ? `**Savings by building:** £${Math.abs(result.savingsIfBuild)}${result.savingsIfBuild < 0 ? ' (pre-built is cheaper)' : ''}` : '',
          '',
          ...result.notes.map(n => `> ${n}`),
        ];
        return ok(lines.filter(l => l !== undefined).join('\n'));
      }

      // ── budget_builder ────────────────────────────────────────────────────
      case 'budget_builder': {
        const { budget, use_case } = BudgetBuilderSchema.parse(args);
        const result = budgetBuilder(budget, use_case as UseCase);
        const lines = [
          `## Budget Builder — ${result.useCaseLabel} — £${budget.toLocaleString()}`,
          '',
          '| Component | Budget | % | Suggestion | Tier |',
          '|---|---|---|---|---|',
          ...result.allocations.map(a =>
            `| ${a.label} | £${a.budgetPounds} | ${a.allocationPercent}% | ${a.suggestion} | ${a.tier} |`,
          ),
          '',
          `**Total allocated:** £${result.totalAllocated.toLocaleString()} of £${budget.toLocaleString()}`,
          '',
          '### Notes',
          ...result.notes.map(n => `- ${n}`),
          '',
          '### Next steps',
          ...result.allocations.map(a =>
            `- **${a.label}:** search for "${a.searchQuery}"`,
          ),
        ];
        return ok(lines.join('\n'));
      }

      // ── upgrade_advisor ───────────────────────────────────────────────────
      case 'upgrade_advisor': {
        const { current_cpu, current_gpu, budget, use_case } = UpgradeAdvisorSchema.parse(args);
        const result = upgradeAdvisor({ currentCpu: current_cpu, currentGpu: current_gpu, budget, useCase: use_case as UseCase });
        const lines = [
          `## Upgrade Advisor`,
          `**Current setup:** ${result.currentCpu} + ${result.currentGpu}`,
          `**Budget:** £${budget.toLocaleString()} | **Use case:** ${result.useCase}`,
          '',
          `**Bottleneck:** ${result.bottleneck.toUpperCase()}`,
          `> ${result.bottleneckReason}`,
          '',
        ];
        if (result.recommendations.length === 0) {
          lines.push('No upgrades found within this budget that provide significant gains.');
        } else {
          lines.push('### Recommended upgrades (best value first)');
          for (const [i, rec] of result.recommendations.entries()) {
            lines.push(
              `\n#### ${i + 1}. ${rec.component.toUpperCase()}: ${rec.suggestion}`,
              `**Reason:** ${rec.reason}`,
              rec.gainPercent != null ? `**Performance gain:** +${rec.gainPercent}%` : '',
              `**Estimated cost:** ~£${rec.estimatedCostPounds}`,
              rec.valueScore != null ? `**Value score:** ${rec.valueScore} pts/£100 spent` : '',
              `**Search for:** "${rec.searchQuery}"`,
            );
          }
        }
        if (result.notes.length > 0) {
          lines.push('', '### Notes', ...result.notes.map(n => `- ${n}`));
        }
        return ok(lines.filter(Boolean).join('\n'));
      }

      // ── find_reviews ──────────────────────────────────────────────────────
      case 'find_reviews': {
        const { component, max_results, trusted_only } = FindReviewsSchema.parse(args);
        const result = await findComponentReviews(component, max_results, trusted_only);
        if (result.error) return ok(`Review search failed: ${result.error}`);
        if (!result.videos.length) return ok(`No YouTube reviews found for "${component}".`);
        const lines = [
          `## YouTube Reviews — ${component}`,
          `*${result.videos.length} videos found. Trusted channels shown first.*`,
          '',
          ...result.videos.map((v, i) => [
            `### ${i + 1}. ${v.title}`,
            `**Channel:** ${v.channelName}${v.isTrustedChannel ? ' ✓' : ''} | **Published:** ${v.publishedAt.split('T')[0]}${v.viewCount ? ` | **Views:** ${parseInt(v.viewCount).toLocaleString()}` : ''}`,
            `[Watch on YouTube](${v.url})`,
          ].join('\n')),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── reddit_recommendations ────────────────────────────────────────────
      case 'reddit_recommendations': {
        const { query, sort_by, max_results } = RedditSearchSchema.parse(args);
        const result = await searchBuildapc(query, sort_by, max_results);
        if (result.error) return ok(`Reddit search failed: ${result.error}`);
        if (!result.posts.length) return ok(`No r/buildapc posts found for "${query}".`);
        const lines = [
          `## r/buildapc — "${query}"`,
          `*${result.posts.length} posts, sorted by ${sort_by}*`,
          '',
          ...result.posts.map((p, i) =>
            `### ${i + 1}. ${p.title}\n` +
            `↑ ${p.score.toLocaleString()} | 💬 ${p.numComments} comments | ${p.createdDate}` +
            (p.flair ? ` | [${p.flair}]` : '') +
            `\n[Read on Reddit](${p.permalink})` +
            (p.selftext ? `\n> ${p.selftext.replace(/\n/g, ' ').slice(0, 200)}…` : ''),
          ),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── reddit_uk_deals ───────────────────────────────────────────────────
      case 'reddit_uk_deals': {
        const { max_results } = z.object({ max_results: z.number().int().default(15) }).parse(args);
        const result = await getUkDeals(max_results);
        if (result.error) return ok(`Reddit deals fetch failed: ${result.error}`);
        if (!result.posts.length) return ok('No UK deals found on r/buildapcsales this week.');
        const lines = [
          `## r/buildapcsales — UK Deals (Past 7 Days)`,
          `*${result.posts.length} UK-tagged deals*`,
          '',
          ...result.posts.map((p, i) =>
            `### ${i + 1}. ${p.title}\n` +
            `↑ ${p.score.toLocaleString()} | 💬 ${p.numComments} | ${p.createdDate}` +
            (p.flair ? ` | [${p.flair}]` : '') +
            `\n[Reddit thread](${p.permalink})` +
            (p.url !== p.permalink ? `  |  [Deal link](${p.url})` : ''),
          ),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── reddit_build_advice ───────────────────────────────────────────────
      case 'reddit_build_advice': {
        const { budget, use_case } = RedditBuildRecsSchema.parse(args);
        const result = await getBuildRecommendations(budget, use_case);
        if (result.error) return ok(`Reddit search failed: ${result.error}`);
        if (!result.posts.length) return ok(`No relevant r/buildapc posts found for £${budget} ${use_case} build.`);
        const lines = [
          `## r/buildapc — Community Advice for £${budget.toLocaleString()} ${use_case} Build`,
          `*${result.posts.length} relevant posts*`,
          '',
          ...result.posts.map((p, i) =>
            `### ${i + 1}. ${p.title}\n` +
            `↑ ${p.score.toLocaleString()} | 💬 ${p.numComments} | ${p.createdDate}\n` +
            `[Read on Reddit](${p.permalink})` +
            (p.selftext ? `\n> ${p.selftext.replace(/\n/g, ' ').slice(0, 300)}…` : ''),
          ),
        ];
        return ok(lines.join('\n\n'));
      }

      // ── validate_prices ───────────────────────────────────────────────────
      case 'validate_prices': {
        const { component_id } = ValidatePricesSchema.parse(args);
        const component = db.getTrackedComponentById(component_id) ?? notFound('tracked component', component_id);
        // Get all latest prices (including any already-marked outliers) for analysis
        const records = db.getLatestPricePerRetailer(component_id, false);
        if (records.length === 0) {
          return ok(`No price data for **"${component.name}"**. Run \`refresh_prices\` to fetch current prices.`);
        }
        const snapshots: db.PriceSnapshot[] = records.map(r => ({
          source: r.source, price: r.price, currency: r.currency,
          retailer: r.retailer, url: r.url, inStock: r.in_stock === 1,
        }));
        const validated = validatePrices(snapshots);
        const outliers = validated.filter(v => v.isOutlier);
        const valid = validated.filter(v => !v.isOutlier);

        const lines = [
          `## Price Validation — **${component.name}**`,
          `*Modified Z-score (MAD-based) · threshold |Z| > 3.5*\n`,
          `**${valid.length} valid** prices · **${outliers.length} outlier${outliers.length !== 1 ? 's' : ''}** detected out of ${validated.length} sources\n`,
          '| Retailer | Price | Z-score | Status |',
          '|---|---|---|---|',
          ...validated
            .sort((a, b) => a.price - b.price)
            .map(v =>
              `| ${v.retailer} | ${fmtRaw(v.price)} | ${v.zScore.toFixed(2)} | ${v.isOutlier ? '⚠️ Outlier' : '✅ Valid'} |`,
            ),
        ];

        if (outliers.length > 0) {
          lines.push('\n> Outlier prices are excluded from deal scores, stats, and comparisons.');
          lines.push('> They may represent bundles, VAT errors, or data feed mistakes.');
        } else {
          lines.push('\n> All prices are within the normal range — no outliers detected.');
        }

        const prices = valid.map(v => v.price);
        if (prices.length > 0) {
          const sorted = [...prices].sort((a, b) => a - b);
          const med = sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];
          lines.push(`\n**Consensus price (median of valid):** ${fmtRaw(med)}`);
        }

        return ok(lines.join('\n'));
      }

      // ── price_confidence_report ───────────────────────────────────────────
      case 'price_confidence_report': {
        const { component_id } = PriceConfidenceSchema.parse(args);
        const component = db.getTrackedComponentById(component_id) ?? notFound('tracked component', component_id);
        const records = db.getLatestPricePerRetailer(component_id, false);
        if (records.length === 0) {
          return ok(`No price data for **"${component.name}"**. Run \`refresh_prices\` first.`);
        }
        const snapshots: db.PriceSnapshot[] = records.map(r => ({
          source: r.source, price: r.price, currency: r.currency,
          retailer: r.retailer, url: r.url, inStock: r.in_stock === 1,
        }));
        const report = getPriceValidationReport(snapshots);

        const lines = [
          `## Price Confidence Report — **${component.name}**`,
          '',
          `**Consensus price:** ${report.consensusPrice != null ? fmtRaw(report.consensusPrice) : 'N/A'} *(median of ${report.validCount} non-outlier sources)*`,
          `**Raw median:** ${report.medianAllPrice != null ? fmtRaw(report.medianAllPrice) : 'N/A'} *(all ${report.totalCount} sources)*`,
          `**Outliers excluded:** ${report.outlierCount}`,
          '',
          '| Retailer | Price | Confidence | Status |',
          '|---|---|---|---|',
          ...report.sourceSummary
            .sort((a, b) => b.confidence - a.confidence)
            .map(s => {
              const confBar = '█'.repeat(Math.round(s.confidence * 5)) + '░'.repeat(5 - Math.round(s.confidence * 5));
              return `| ${s.retailer} | ${fmtRaw(s.price)} | ${confBar} ${(s.confidence * 100).toFixed(0)}% | ${s.isOutlier ? '⚠️ Outlier' : '✅ Valid'} |`;
            }),
          '',
          '> Confidence = how close the price is to the consensus median.',
          '> 100% = exactly at consensus, 0% = 50%+ deviation from consensus.',
        ];

        return ok(lines.join('\n'));
      }

      // ── scrape_with_browser ───────────────────────────────────────────────
      case 'scrape_with_browser': {
        const { query, retailers, save_to_component_id } = BrowserScrapeSchema.parse(args);
        const targetRetailers = retailers ?? [...SUPPORTED_PLAYWRIGHT_RETAILERS];

        const results: BrowserScrapeResult[] = await scrapeWithBrowser(query, targetRetailers);

        const lines = [
          `## Browser Scrape — "${query}"`,
          `*Playwright/Chromium · ${targetRetailers.join(', ')}*\n`,
        ];

        let totalSaved = 0;
        const allSnaps: db.PriceSnapshot[] = [];

        for (const r of results) {
          if (r.error && r.results.length === 0) {
            lines.push(`### ${r.retailer} — ⚠️ ${r.error} *(${r.durationMs}ms)*`);
            continue;
          }
          lines.push(`### ${r.retailer} — ${r.results.length} result(s) *(${r.durationMs}ms)*`);
          for (const p of r.results) {
            lines.push(`- **${fmtRaw(p.price, p.currency)}** · ${p.inStock ? '✅ In Stock' : '❌ Out of Stock'}${p.url ? `\n  ${p.url}` : ''}`);
            allSnaps.push(p);
          }
          lines.push('');
        }

        if (save_to_component_id != null && allSnaps.length > 0) {
          const component = db.getTrackedComponentById(save_to_component_id);
          if (!component) {
            lines.push(`\n⚠️ Component ID ${save_to_component_id} not found — prices not saved.`);
          } else {
            const validated = validatePrices(allSnaps);
            db.savePriceSnapshots(save_to_component_id, validated);
            db.markLastChecked(save_to_component_id);
            totalSaved = allSnaps.length;
            lines.push(`\n✅ Saved ${totalSaved} price record(s) to **"${component.name}"** (ID: ${save_to_component_id})`);
          }
        } else if (allSnaps.length > 0) {
          const best = allSnaps.filter(s => s.price > 0).sort((a, b) => a.price - b.price)[0];
          if (best) {
            lines.push(`\n**Best price found: ${fmtRaw(best.price, best.currency)} at ${best.retailer}**`);
          }
          lines.push(`\nUse \`save_to_component_id\` to persist these prices to a tracked component.`);
        }

        return ok(lines.join('\n'));
      }

      // ── pcpartpicker_search_catalog ──────────────────────────────────────
      case 'pcpartpicker_search_catalog': {
        const { query, part_type, region, priced_only, limit } = PPCatalogSchema.parse(args);
        const results = await searchPCPartPickerCatalog(
          query, part_type as PartSlug, region as PPRegion, priced_only, limit,
        );
        if (results.length === 0) {
          return ok(`No PCPartPicker ${part_type} components matched "${query}"${priced_only ? ' with a listed price' : ''}.`);
        }
        const lines = [
          `## PCPartPicker Catalog: "${query}" (${part_type}, ${region.toUpperCase()})`,
          `*${results.length} result(s) · prices from pcpartpicker-scraper dataset*\n`,
        ];
        for (const [i, c] of results.entries()) {
          lines.push(formatPPComponent(c, i));
          lines.push('');
        }
        return ok(lines.join('\n'));
      }

      // ── pcpartpicker_browse_catalog ──────────────────────────────────────
      case 'pcpartpicker_browse_catalog': {
        const { part_type, region, priced_only, limit } = PPBrowseSchema.parse(args);
        const all = await fetchPartData(part_type as PartSlug, region as PPRegion);
        let results = priced_only ? all.filter((c) => c.price !== null) : all;
        results = results
          .sort((a, b) => {
            if (a.price && b.price) return a.price - b.price;
            if (a.price) return -1;
            if (b.price) return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, limit);
        if (results.length === 0) {
          return ok(`No ${part_type} components found in the PCPartPicker ${region.toUpperCase()} catalog${priced_only ? ' with a listed price' : ''}.`);
        }
        const totalPriced = all.filter((c) => c.price !== null).length;
        const lines = [
          `## PCPartPicker Catalog: ${part_type} (${region.toUpperCase()})`,
          `*Showing ${results.length} of ${totalPriced} priced items · sorted by price*\n`,
        ];
        for (const [i, c] of results.entries()) {
          lines.push(formatPPComponent(c, i));
          lines.push('');
        }
        return ok(lines.join('\n'));
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
