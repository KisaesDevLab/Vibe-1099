/**
 * app_settings accessor — reviewer gate, message templates, reminder schedule,
 * retention, portal availability, W-9 staleness threshold.
 */
import { eq } from 'drizzle-orm';
import { appSettings, getDb } from '@vibe1099/db';

export const SETTING_DEFAULTS: Record<string, unknown> = {
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

export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = await getDb().select().from(appSettings);
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Admin threshold override for (formType, taxYear) in cents; undefined = use registry default. */
export async function thresholdOverride(formType: string, taxYear: number): Promise<number | undefined> {
  const map = (await getSetting<Record<string, number>>('federal_thresholds')) ?? {};
  const v = map[`${formType}:${taxYear}`];
  return typeof v === 'number' && v >= 0 ? v : undefined;
}
