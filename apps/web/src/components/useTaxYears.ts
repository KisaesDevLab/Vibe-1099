/**
 * Shared filing-years hook. Fetches the admin-configured enabled years + the
 * default ("current") year once, caches module-wide, and notifies subscribers.
 * Screens render year <option>s from `years` and can default state to `current`.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

export interface FilingYears {
  years: number[];
  current: number;
}

// fallback before the fetch resolves (matches shipped SUPPORTED_TAX_YEARS)
const FALLBACK: FilingYears = { years: [2026, 2025], current: 2026 };

let cache: FilingYears | null = null;
let inflight: Promise<FilingYears> | null = null;
const subscribers = new Set<(v: FilingYears) => void>();

function load(): Promise<FilingYears> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api
      .get<FilingYears>('/api/admin/tax-years')
      .then((r) => {
        cache = { years: [...r.years].sort((a, b) => b - a), current: r.current };
        subscribers.forEach((fn) => fn(cache!));
        return cache;
      })
      .catch(() => FALLBACK);
  }
  return inflight;
}

/** Force a refresh (e.g. after an admin rollover) so every picker updates. */
export function refreshTaxYears(): void {
  cache = null;
  inflight = null;
  void load();
}

/**
 * A screen's selected tax year, seeded from the configured current year (not a
 * literal) and re-synced when an admin rolls the year. Seeding from `current`
 * means a warm-cache mount renders the right year on the first pass instead of
 * fetching 2026 first and the real year second (two requests, racing responses).
 */
export function useTaxYearState(): [number, (y: number) => void, FilingYears] {
  const fy = useTaxYears();
  const [taxYear, setTaxYear] = useState(fy.current);
  useEffect(() => {
    setTaxYear(fy.current);
  }, [fy.current]);
  return [taxYear, setTaxYear, fy];
}

export function useTaxYears(): FilingYears {
  const [value, setValue] = useState<FilingYears>(cache ?? FALLBACK);
  useEffect(() => {
    let alive = true;
    const onChange = (v: FilingYears) => alive && setValue(v);
    subscribers.add(onChange);
    void load().then((v) => alive && setValue(v));
    return () => {
      subscribers.delete(onChange);
      alive = false;
    };
  }, []);
  return value;
}
