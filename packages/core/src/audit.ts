/**
 * Audit log helper — append-only (DB trigger enforces immutability).
 * before/after are stored as SHA-256 hashes of canonical JSON; details carry
 * a redacted summary (never TINs).
 */
import { createHash } from 'node:crypto';
import { auditLog, type Db } from '@vibe1099/db';

export interface AuditEntry {
  firmId?: string | null;
  actorType: 'staff' | 'client' | 'recipient' | 'system';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

function hashOf(value: unknown): string | null {
  if (value === undefined) return null;
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    firmId: entry.firmId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    beforeHash: hashOf(entry.before),
    afterHash: hashOf(entry.after),
    detail: entry.detail ?? null,
    ip: entry.ip ?? null,
  });
}
