/**
 * App-wide "assigned preparer" filter. A payer can carry the staff user
 * responsible for it; choosing a preparer in the top bar narrows every
 * payer-keyed view (dashboard, pickers, queues, transmissions…) to that
 * preparer's payers. The choice is sticky per browser.
 *
 * Unpaginated lists filter client-side with `matches(payerId)`; server-paginated
 * lists pass `query` (`&preparerId=…`) so totals stay honest.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';

export interface StaffMember { id: string; name: string; active: boolean }

interface PreparerCtx {
  staff: StaffMember[];
  /** '' = everyone, 'none' = unassigned payers, else a staff user id. */
  filter: string;
  setFilter: (v: string) => void;
  /** Does this payer pass the current filter? */
  matches: (payerId: string | null | undefined) => boolean;
  /** Preparer assigned to a payer (undefined = unassigned). */
  preparerOf: (payerId: string) => StaffMember | undefined;
  /** '&preparerId=…' for server-filtered endpoints ('' when no filter). */
  query: string;
  /** Re-fetch staff + assignments (after assigning on the Payers screen). */
  reload: () => void;
}

const STORAGE_KEY = 'v1099.preparerFilter';

const Ctx = createContext<PreparerCtx>({
  staff: [], filter: '', setFilter: () => {}, matches: () => true, preparerOf: () => undefined, query: '', reload: () => {},
});

export const usePreparerFilter = () => useContext(Ctx);

export function PreparerProvider({ children }: { children: ReactNode }) {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [filter, setFilterState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  });

  const setFilter = useCallback((v: string) => {
    setFilterState(v);
    try { if (v) localStorage.setItem(STORAGE_KEY, v); else localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  }, []);

  const reload = useCallback(() => {
    api.get<{ staff: StaffMember[]; assignments: Record<string, string> }>('/api/payers/preparers')
      .then((r) => {
        setStaff(r.staff);
        setAssignments(r.assignments);
        // a remembered preparer who no longer exists must not leave the app silently empty
        setFilterState((f) => (f && f !== 'none' && !r.staff.some((s) => s.id === f) ? '' : f));
      })
      .catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const value = useMemo<PreparerCtx>(() => ({
    staff,
    filter,
    setFilter,
    matches: (payerId) => (!filter ? true : !payerId ? false : filter === 'none' ? !assignments[payerId] : assignments[payerId] === filter),
    preparerOf: (payerId) => staff.find((s) => s.id === assignments[payerId]),
    query: filter ? `&preparerId=${filter}` : '',
    reload,
  }), [staff, assignments, filter, setFilter, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Top-bar selector. Highlighted while active so a narrowed app is never a surprise. */
export function PreparerFilterSelect({ meId }: { meId?: string }) {
  const { staff, filter, setFilter } = usePreparerFilter();
  const options = staff.filter((s) => s.active || s.id === filter);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, margin: 0 }} title="Show only the payers assigned to this preparer, across the app">
      <span className="muted">Preparer</span>
      <select
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: 'auto', padding: '2px 6px', fontSize: 12, ...(filter ? { borderColor: 'var(--accent)', background: '#eef2ff', fontWeight: 600 } : {}) }}
      >
        <option value="">All payers</option>
        {options.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === meId ? ' (me)' : ''}</option>)}
        <option value="none">Unassigned</option>
      </select>
    </label>
  );
}
