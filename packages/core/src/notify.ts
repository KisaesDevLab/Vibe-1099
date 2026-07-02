/**
 * Notification helper — persist an in-app notification (async job completions,
 * alerts). userId null = visible to all staff in the firm.
 */
import { notifications, type Db } from '@vibe1099/db';

export interface NotifyInput {
  firmId: string;
  userId?: string | null;
  kind: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  link?: string;
  entityType?: string | null;
  entityId?: string | null;
}

export async function notify(db: Db, n: NotifyInput): Promise<void> {
  await db.insert(notifications).values({
    firmId: n.firmId,
    userId: n.userId ?? null,
    kind: n.kind,
    severity: n.severity ?? 'info',
    title: n.title,
    body: n.body ?? '',
    link: n.link ?? '',
    entityType: n.entityType ?? null,
    entityId: n.entityId ?? null,
  });
}
