/**
 * Appliance health verdict for the `/api/status` probe (Vibe Appliance manifest
 * `health:` field). Kept dependency-free so the invariant below is unit-testable
 * in isolation, without booting the DB/Redis/render graph.
 */

/**
 * A single dependency probe result. `informational: true` marks a check that is
 * surfaced to operators but MUST NOT gate the appliance health verdict.
 */
export type StatusCheck = { ok: boolean; informational?: boolean; [k: string]: unknown };

/**
 * Compute the appliance `/api/status` verdict from the dependency checks.
 *
 * Only the app's OWN bundled dependencies — postgres, redis, render, queues —
 * decide the verdict. Checks flagged `informational` are excluded. In practice
 * that is IRIS reachability: the IRS IRIS A2A endpoint is an external third-party
 * service that is (a) unreachable by default — a firm enrolls for its TCC months
 * after install (Pub 5718 onboarding critical path), so nothing is wired up yet —
 * and (b) frequently unreachable from a LAN/Tailscale-only appliance with
 * restricted egress, on top of the IRS's own maintenance windows. Gating appliance
 * health on it made the console report a perfectly healthy app as permanently down
 * (503) and made the migration-on-upgrade smoke test fail. Reachability is still
 * reported under `checks.iris` for operators — it just no longer flips the verdict.
 */
export function computeApplianceHealth(checks: Record<string, StatusCheck>): boolean {
  return Object.values(checks).every((c) => c.informational === true || c.ok);
}
