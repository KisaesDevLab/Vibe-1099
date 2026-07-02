/**
 * Request context types — the three trust zones (staff / client / recipient).
 */
import type { UserRole } from '@vibe1099/shared';

export interface StaffSession {
  userId: string;
  firmId: string;
  role: UserRole;
  email: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ClientScope {
  inviteId: string;
  firmId: string;
  payerId: string;
  taxYear: number;
  formTypes: string[];
}

export interface RecipientScope {
  deliveryId: string;
  formRecordId: string;
  recipientId: string;
  firmId: string;
  challengePassed: boolean;
}

declare global {
  namespace Express {
    interface Request {
      staff?: StaffSession;
      sessionId?: string;
      clientScope?: ClientScope;
      recipientScope?: RecipientScope;
      requestId?: string;
    }
  }
}

export {};
