import { randomBytes } from "node:crypto";

export type SessionPrincipalKind = "bootstrap" | "matrix";

export type SessionPrincipal = {
  kind: SessionPrincipalKind;
  username: string;
};

export type Session = {
  sid: string;
  csrf: string;
  principal: SessionPrincipal;
  expiresAt: number;
};

export type SessionStoreOptions = {
  ttlMs: number;
  now?: () => number;
  generateId?: () => string;
};

export type SessionStore = {
  create(principal: SessionPrincipal): Session;
  get(sid: string | undefined): Session | null;
  revoke(sid: string): void;
  size(): number;
  gc(): void;
};

const defaultId = (): string => randomBytes(32).toString("base64url");

export const createSessionStore = (options: SessionStoreOptions): SessionStore => {
  const { ttlMs } = options;
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? defaultId;
  const sessions = new Map<string, Session>();

  const gc = (): void => {
    const t = now();
    for (const [sid, session] of sessions) {
      if (session.expiresAt <= t) {
        sessions.delete(sid);
      }
    }
  };

  return {
    create(principal: SessionPrincipal): Session {
      gc();
      const session: Session = {
        sid: generateId(),
        csrf: generateId(),
        principal,
        expiresAt: now() + ttlMs,
      };
      sessions.set(session.sid, session);
      return session;
    },
    get(sid: string | undefined): Session | null {
      if (sid === undefined || sid.length === 0) return null;
      const session = sessions.get(sid);
      if (session === undefined) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(sid);
        return null;
      }
      return session;
    },
    revoke(sid: string): void {
      sessions.delete(sid);
    },
    size(): number {
      return sessions.size;
    },
    gc,
  };
};
