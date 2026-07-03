/**
 * app_settings accessor — reviewer gate, message templates, reminder schedule,
 * retention, portal availability, W-9 staleness threshold.
 */
import { eq } from 'drizzle-orm';
import { AppError, MAX_TAX_YEAR, MIN_TAX_YEAR, SUPPORTED_TAX_YEARS } from '@vibe1099/shared';
import { appSettings, getDb } from '@vibe1099/db';

const DEFAULT_FILING_YEARS = {
  years: [...SUPPORTED_TAX_YEARS],
  current: Math.max(...SUPPORTED_TAX_YEARS),
};

export const SETTING_DEFAULTS: Record<string, unknown> = {
  /** enabled filing years + the default ("current") one; admins roll this forward */
  filing_years: DEFAULT_FILING_YEARS,
  reviewer_gate_enabled: false,
  /** per-(formType, taxYear) federal threshold overrides in cents, e.g. {"NEC:2026": 200000} — registry defaults apply when unset */
  federal_thresholds: {},
  w9_stale_years: 3,
  invite_expiry_days: 30,
  recipient_token_days: 90,
  /** forms remain portal-accessible through Oct 15 of following year */
  portal_available_until: 'oct15',
  w9_reminder_days: [7, 14, 21],
  data_retention_years: 4,
  message_templates: null, // null = shipped defaults
};

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await getDb().query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  if (row) return row.value as T;
  return SETTING_DEFAULTS[key] as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** Keys holding secrets that must never appear in the generic settings dump. */
const SECRET_SETTING_KEYS = new Set(['cloudflare_tunnel_token']);

export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = await getDb().select().from(appSettings);
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (!SECRET_SETTING_KEYS.has(r.key)) out[r.key] = r.value;
  return out;
}

export interface FilingYears {
  years: number[];
  current: number;
}

/** Enabled filing years (descending) + the default current year. */
export async function getFilingYears(): Promise<FilingYears> {
  const raw = (await getSetting<FilingYears>('filing_years')) ?? DEFAULT_FILING_YEARS;
  const years = [...new Set(raw.years)].sort((a, b) => b - a);
  const current = years.includes(raw.current) ? raw.current : (years[0] ?? Math.max(...SUPPORTED_TAX_YEARS));
  return { years, current };
}

/** Roll forward: enable a new filing year and make it current. */
export async function addFilingYear(taxYear: number): Promise<FilingYears> {
  if (taxYear < MIN_TAX_YEAR || taxYear > MAX_TAX_YEAR) {
    throw AppError.validation(`Tax year must be between ${MIN_TAX_YEAR} and ${MAX_TAX_YEAR}`);
  }
  const cur = await getFilingYears();
  if (cur.years.includes(taxYear)) throw AppError.conflict(`Tax year ${taxYear} already exists`);
  const next: FilingYears = { years: [...cur.years, taxYear].sort((a, b) => b - a), current: taxYear };
  await setSetting('filing_years', next);
  return next;
}

/** Change which enabled year is the default without adding a new one. */
export async function setCurrentFilingYear(taxYear: number): Promise<FilingYears> {
  const cur = await getFilingYears();
  if (!cur.years.includes(taxYear)) throw AppError.validation(`Tax year ${taxYear} is not enabled`);
  const next: FilingYears = { years: cur.years, current: taxYear };
  await setSetting('filing_years', next);
  return next;
}

/** Admin threshold override for (formType, taxYear) in cents; undefined = use registry default. */
export async function thresholdOverride(formType: string, taxYear: number): Promise<number | undefined> {
  const map = (await getSetting<Record<string, number>>('federal_thresholds')) ?? {};
  const v = map[`${formType}:${taxYear}`];
  return typeof v === 'number' && v >= 0 ? v : undefined;
}
