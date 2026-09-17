/** argon2id parameters shared by the login route, the bootstrap CLI and the Vibe Auth user adapter. */
export const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // OWASP baseline
