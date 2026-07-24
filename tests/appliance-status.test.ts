import { describe, expect, it } from 'vitest';
import { computeApplianceHealth, type StatusCheck } from '../apps/api/src/routes/appliance-health.js';

// Guards the Vibe Appliance `/api/status` contract (Addendum A). The appliance
// console keys `health:` on this verdict and `scripts/upgrade-smoke.sh` polls it;
// it must reflect the app's OWN bundled dependencies, not external reachability.
describe('appliance /api/status health verdict (Addendum A)', () => {
  const bundledUp = (): Record<string, StatusCheck> => ({
    postgres: { ok: true },
    redis: { ok: true },
    render: { ok: true },
    queues: { ok: true, depth: {} },
  });

  it('is healthy when every bundled dependency is up', () => {
    expect(computeApplianceHealth(bundledUp())).toBe(true);
  });

  it('stays healthy when IRIS is unreachable (pre-enrollment / restricted egress)', () => {
    // A firm enrolls for its IRIS TCC months after install (Pub 5718); until then
    // — and on a LAN/Tailscale-only appliance — the IRS endpoint is unreachable.
    // That must NOT make the appliance console see the app as down.
    const checks = { ...bundledUp(), iris: { ok: false, error: 'ETIMEDOUT', informational: true } };
    expect(computeApplianceHealth(checks)).toBe(true);
  });

  it('IRIS reachability never changes the verdict, up or down', () => {
    const irisUp = { ...bundledUp(), iris: { ok: true, status: 200, informational: true } };
    const irisDown = { ...bundledUp(), iris: { ok: false, informational: true } };
    expect(computeApplianceHealth(irisUp)).toBe(computeApplianceHealth(irisDown));
  });

  it('is unhealthy when a bundled dependency is down, even if IRIS is reachable', () => {
    const checks = {
      ...bundledUp(),
      postgres: { ok: false, error: 'ECONNREFUSED' },
      iris: { ok: true, status: 200, informational: true },
    };
    expect(computeApplianceHealth(checks)).toBe(false);
  });

  it('treats the bundled render sidecar as critical', () => {
    const checks = { ...bundledUp(), render: { ok: false } };
    expect(computeApplianceHealth(checks)).toBe(false);
  });

  it('an informational check is excluded regardless of its ok value', () => {
    // Belt-and-braces: a future informational check must behave like iris.
    const checks = { ...bundledUp(), someExternal: { ok: false, informational: true } };
    expect(computeApplianceHealth(checks)).toBe(true);
  });
});
