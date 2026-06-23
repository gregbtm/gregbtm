/**
 * PCPartPicker catalog source via the pre-scraped GitHub Pages dataset.
 * Data: https://jonathanvusich.github.io/pcpartpicker-scraper/{region}/{slug}
 * Returns full component specs + GBP prices for 22 part categories.
 */

const BASE_URL = 'https://jonathanvusich.github.io/pcpartpicker-scraper';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const PART_SLUGS = [
  'cpu', 'cpu-cooler', 'motherboard', 'memory', 'internal-hard-drive',
  'video-card', 'power-supply', 'case', 'case-fan', 'fan-controller',
  'thermal-paste', 'optical-drive', 'sound-card', 'wired-network-card',
  'wireless-network-card', 'monitor', 'external-hard-drive', 'headphones',
  'keyboard', 'mouse', 'speakers', 'ups-system',
] as const;

export type PartSlug = typeof PART_SLUGS[number];

export type PPRegion = 'uk' | 'us' | 'de' | 'fr' | 'ca' | 'au' | 'be' | 'es' | 'ie' | 'it' | 'nz' | 'se';

export const CATEGORY_TO_SLUG: Partial<Record<string, PartSlug>> = {
  cpu: 'cpu',
  cooling: 'cpu-cooler',
  motherboard: 'motherboard',
  ram: 'memory',
  storage: 'internal-hard-drive',
  gpu: 'video-card',
  psu: 'power-supply',
  case: 'case',
  monitor: 'monitor',
};

export interface PPComponent {
  brand: string;
  model: string;
  name: string;
  price: number | null;
  currency: string;
  slug: PartSlug;
  specs: Record<string, string | number | null>;
}

// ── Spec parsers ───────────────────────────────────────────────────────────

function parseBytes(obj: unknown): string | null {
  const total = (obj as { total?: number } | null)?.total;
  if (!total) return null;
  const gb = total / 1e9;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  if (gb < 1) return `${Math.round(total / 1e6)} MB`;
  return `${Math.round(gb)} GB`;
}

function parseCycles(obj: unknown): string | null {
  const cycles = (obj as { cycles?: number } | null)?.cycles;
  if (!cycles) return null;
  return `${(cycles / 1e9).toFixed(2)} GHz`;
}

function parseRPM(obj: unknown): string | null {
  const r = obj as { min?: number; max?: number; default?: number } | null;
  if (!r) return null;
  if (r.min != null && r.max != null && r.min !== r.max) return `${r.min}–${r.max} RPM`;
  const val = r.default ?? r.max ?? r.min;
  return val != null ? `${val} RPM` : null;
}

function parseNoise(obj: unknown): string | null {
  const r = obj as { min?: number; max?: number; default?: number } | null;
  if (!r) return null;
  const val = r.default ?? r.max ?? r.min;
  return val != null ? `${val} dB` : null;
}

function buildSpecs(raw: Record<string, unknown>, slug: PartSlug): Record<string, string | number | null> {
  const s: Record<string, string | number | null> = {};

  if (slug === 'cpu') {
    s.cores = (raw.cores as number) ?? null;
    s.base_clock = parseCycles(raw.base_clock);
    s.boost_clock = parseCycles(raw.boost_clock);
    s.tdp = raw.tdp != null ? `${raw.tdp}W` : null;
    s.integrated_graphics = (raw.integrated_graphics as string) ?? null;
    s.multithreading = raw.multithreading != null ? (raw.multithreading ? 'Yes' : 'No') : null;
  } else if (slug === 'video-card') {
    s.chipset = (raw.chipset as string) ?? null;
    s.vram = parseBytes(raw.vram);
    s.core_clock = parseCycles(raw.core_clock);
    s.boost_clock = parseCycles(raw.boost_clock);
    s.length = raw.length != null ? `${raw.length}mm` : null;
    s.color = (raw.color as string) ?? null;
  } else if (slug === 'motherboard') {
    s.socket = (raw.socket as string) ?? null;
    s.form_factor = (raw.form_factor as string) ?? null;
    s.max_ram = parseBytes(raw.max_ram);
    s.ram_slots = (raw.ram_slots as number) ?? null;
    s.color = (raw.color as string) ?? null;
  } else if (slug === 'memory') {
    s.module_type = (raw.module_type as string) ?? null;
    s.speed = raw.speed != null ? `${raw.speed} MHz` : null;
    const modCount = (raw.number_of_modules as number) ?? 1;
    const modSize = parseBytes(raw.module_size);
    s.modules = modSize ? `${modCount}× ${modSize}` : null;
    s.cas = raw.cas_timing != null ? `CL${raw.cas_timing}` : null;
    s.error_correction = (raw.error_correction as string) ?? null;
  } else if (slug === 'internal-hard-drive') {
    s.capacity = parseBytes(raw.capacity);
    s.type = (raw.storage_type as string) ?? null;
    s.form_factor = (raw.form_factor as string) ?? null;
    s.interface = (raw.interface as string) ?? null;
    s.rpm = raw.platter_rpm != null ? `${raw.platter_rpm} RPM` : null;
    s.cache = parseBytes(raw.cache_amount);
  } else if (slug === 'power-supply') {
    s.form_factor = (raw.form_factor as string) ?? null;
    s.wattage = raw.wattage != null ? `${raw.wattage}W` : null;
    s.efficiency = (raw.efficiency_rating as string) ?? null;
    s.modular = (raw.modular as string) ?? null;
    s.color = (raw.color as string) ?? null;
  } else if (slug === 'case') {
    s.form_factor = (raw.form_factor as string) ?? null;
    s.color = (raw.color as string) ?? null;
    s.psu_wattage = raw.psu_wattage != null ? `${raw.psu_wattage}W` : null;
    s.side_panel = (raw.side_panel as string) ?? null;
    s.internal_bays = (raw.internal_bays as number) ?? null;
  } else if (slug === 'cpu-cooler') {
    s.fan_rpm = parseRPM(raw.fan_rpm);
    s.noise = parseNoise(raw.decibels);
    s.radiator_size = raw.radiator_size != null ? `${raw.radiator_size}mm` : null;
    s.color = (raw.color as string) ?? null;
  } else if (slug === 'case-fan') {
    s.size = raw.size != null ? `${raw.size}mm` : null;
    s.rpm = parseRPM(raw.rpm);
    s.airflow = (raw.airflow as string) ?? null;
    s.noise = parseNoise(raw.decibels);
    s.pwm = raw.pwm != null ? (raw.pwm ? 'Yes' : 'No') : null;
  } else if (slug === 'monitor') {
    const res = raw.resolution as { width?: number; height?: number } | null;
    s.resolution = res?.width && res?.height ? `${res.width}×${res.height}` : null;
    s.size = raw.size != null ? `${raw.size}"` : null;
    s.refresh_rate = raw.refresh_rate != null ? `${raw.refresh_rate}Hz` : null;
    s.response_time = raw.response_time != null ? `${raw.response_time}ms` : null;
    s.panel_type = (raw.panel_type as string) ?? null;
  } else if (slug === 'sound-card') {
    s.channels = (raw.channels as string | number) ?? null;
    s.bitrate = raw.bitrate != null ? `${raw.bitrate}-bit` : null;
    s.snr = raw.snr != null ? `${raw.snr}dB` : null;
    s.interface = (raw.interface as string) ?? null;
  } else if (slug === 'wireless-network-card' || slug === 'wired-network-card') {
    s.interface = (raw.interface as string) ?? null;
    s.protocols = (raw.supported_protocols as string) ?? null;
  } else if (slug === 'ups-system') {
    s.watt_capacity = raw.watt_capacity != null ? `${raw.watt_capacity}W` : null;
    s.va_capacity = raw.va_capacity != null ? `${raw.va_capacity}VA` : null;
  }

  // Remove null values
  for (const key of Object.keys(s)) {
    if (s[key] === null) delete s[key];
  }

  return s;
}

function parseRecord(raw: Record<string, unknown>, slug: PartSlug): PPComponent {
  const brand = String(raw.brand ?? '');
  const model = String(raw.model ?? '');
  const priceArr = raw.price as [string, string] | null;
  const rawPrice = priceArr ? parseFloat(priceArr[0]) : null;
  const price = rawPrice != null && rawPrice > 0 ? rawPrice : null;
  const currency = priceArr?.[1] ?? 'GBP';
  return {
    brand, model,
    name: `${brand} ${model}`.trim(),
    price,
    currency,
    slug,
    specs: buildSpecs(raw, slug),
  };
}

// ── Cache + fetch ───────────────────────────────────────────────────────────

const _cache = new Map<string, { data: PPComponent[]; fetchedAt: number }>();

export async function fetchPartData(slug: PartSlug, region: PPRegion = 'uk'): Promise<PPComponent[]> {
  const key = `${region}/${slug}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  const url = `${BASE_URL}/${region}/${slug}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`PCPartPicker catalog returned HTTP ${res.status} for ${key}`);

  const raw: Record<string, unknown>[] = await res.json();
  const data = raw.map((r) => parseRecord(r, slug));
  _cache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchPCPartPickerCatalog(
  query: string,
  slug: PartSlug,
  region: PPRegion = 'uk',
  pricedOnly = true,
  limit = 25,
): Promise<PPComponent[]> {
  const parts = await fetchPartData(slug, region);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const matches = parts.filter((p) => {
    if (pricedOnly && p.price === null) return false;
    const haystack = [p.name, ...Object.values(p.specs).map(String)].join(' ').toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });

  matches.sort((a, b) => {
    if (a.price && b.price) return a.price - b.price;
    if (a.price) return -1;
    if (b.price) return 1;
    return a.name.localeCompare(b.name);
  });

  return matches.slice(0, limit);
}

export function slugForCategory(category: string): PartSlug | null {
  return CATEGORY_TO_SLUG[category.toLowerCase()] ?? null;
}

export function formatPPComponent(c: PPComponent, idx?: number): string {
  const prefix = idx != null ? `### ${idx + 1}. ` : '### ';
  const price = c.price != null ? `£${c.price.toFixed(2)}` : 'No price';
  const specLines = Object.entries(c.specs).map(([k, v]) => `  - **${k}**: ${v}`).join('\n');
  return `${prefix}${c.name}\n**Price**: ${price}\n${specLines}`;
}
