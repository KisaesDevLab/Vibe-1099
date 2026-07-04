/**
 * Front-end feature flags.
 *
 * MO_FILING_ENABLED — Missouri direct filing (Pub 1220). Hidden for now: state
 * filing is being handled through a third-party provider (Tax1099 / TaxBandits).
 * Flip to `true` to bring back the Missouri nav item, screen, deadline, and the
 * correction MO-impact notice. The backend /api/mo/* endpoints are untouched.
 */
export const MO_FILING_ENABLED = false;
