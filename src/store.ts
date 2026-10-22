// Encrypted-at-rest JSON store with atomic, debounced writes.
// Chosen deliberately over SQLite: zero native dependencies (no supply-chain
// or build risk on any platform), and write volume here is low (personal
// gateway) with request logs kept as a capped ring.
import fs from 'node:fs';
import path from 'node:path';

export type TokenStatus = 'unverified' | 'healthy' | 'cooling' | 'expired';

export interface TokenRecord {
  id: string;
  label: string;
  sessionHash: string; // sha256(session token) for dedupe, not secret
  encSession: string; // AES-256-GCM(session token)
  encAccess: string; // AES-256-GCM(access token)
  deviceId: string;
  ua: string;
  email?: string;
  name?: string;
  plan?: string;
  accountId?: string;
  status: TokenStatus;
  coolUntil?: number;
  /** model slug → epoch ms until which this account's usage cap for that model applies */
  modelCaps?: Record<string, number>;
  /** consecutive "unusual activity" refusals; drives the adaptive rest and resets on success */
  throttleStrikes?: number;
  failCount: number;
  lastRefresh?: string;
  lastVerified?: string;
  /** when the per-model configs (thinking efforts) were last read */
  modelConfigsAt?: string;
  /** model catalog reported by chatgpt.com for this account (refreshed on verify) */
  models?: Array<{ slug: string; title: string; reasoning: string; efforts: string[]; maxTokens?: number; workMode?: boolean }>;
  defaultModel?: string;
  /** last usage-limit snapshot from chatgpt.com (5-hour + weekly windows, credits) */
  usage?: import('./chatgpt/client.js').UsageSnapshot;
  usageError?: string;
  lastUsed?: string;
  lastError?: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  hash: string; // sha256(full key)
  prefix: string; // sg-xxxxxxx
  enabled: boolean;
  rpm: number;
  rpd: number;
  totalRequests: number;
  totalChars: number;
  createdAt: string;
  lastUsed?: string;
}

export interface RequestLog {
  ts: string; // ISO
  keyId: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  charsIn: number;
  charsOut: number;
  error?: string;
  /** what the gateway did on the way: compacted, nudged, tool calls, failover … */
  notes?: string;
}

export interface Settings {
  adminUser: string;
  adminHash: string; // bcrypt
  mustChangePw: boolean;
  sessionVersion: number;
  totpSecret: string | null;
  ipSalt: string;
  brandName: string;
  /** record /v1 exchanges as read-only conversations in the console chat */
  recordApi?: boolean;
  /**
   * Conversation continuation: send only new messages into the backend conversation
   * a request is continuing. "temp" = only models that continue inside temporary chats;
   * "all" = also work-mode models, whose conversations must be saved to the account's
   * history while active (hidden again when idle); "off" = always resend everything.
   */
  continuation?: 'off' | 'temp' | 'all';
}

export interface AuditEntry {
  ts: string;
  action: string;
  detail: string;
  ipHash: string;
}

export interface StoreData {
  settings: Settings;
  tokens: TokenRecord[];
  keys: ApiKeyRecord[];
  requests: RequestLog[];
  audit: AuditEntry[];
}

const MAX_REQUESTS = 5000;
const MAX_AUDIT = 1000;
const DEBOUNCE_MS = 300;

export class Store {
  private data: StoreData;
  private file: string;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string, freshSettings: () => Settings) {
    this.file = path.join(dataDir, 'store.json');
    this.data = this.load(freshSettings);
  }

  private load(freshSettings: () => Settings): StoreData {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as StoreData;
      if (parsed.settings && Array.isArray(parsed.tokens) && Array.isArray(parsed.keys)) {
        parsed.requests = Array.isArray(parsed.requests) ? parsed.requests : [];
        parsed.audit = Array.isArray(parsed.audit) ? parsed.audit : [];
        return parsed;
      }
      console.warn('[shadowgate] store.json has an unexpected shape — starting fresh (old file kept as store.json.bak)');
      fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[shadowgate] store.json unreadable — starting fresh:', (err as Error).message);
        try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch { /* ignore */ }
      }
    }
    return { settings: freshSettings(), tokens: [], keys: [], requests: [], audit: [] };
  }

  get settings(): Settings {
    return this.data.settings;
  }

  get tokens(): TokenRecord[] {
    return this.data.tokens;
  }

  get keys(): ApiKeyRecord[] {
    return this.data.keys;
  }

  get requests(): RequestLog[] {
    return this.data.requests;
  }

  get audit(): AuditEntry[] {
    return this.data.audit;
  }

  logAudit(entry: AuditEntry): void {
    this.data.audit.push(entry);
    if (this.data.audit.length > MAX_AUDIT) {
      this.data.audit.splice(0, this.data.audit.length - MAX_AUDIT);
    }
    this.flush();
  }

  logRequest(entry: RequestLog): void {
    this.data.requests.push(entry);
    if (this.data.requests.length > MAX_REQUESTS) {
      this.data.requests.splice(0, this.data.requests.length - MAX_REQUESTS);
    }
    this.flush();
  }

  /**
   * Mark the store dirty and persist shortly (debounced). Call after ANY
   * mutation of settings / tokens / keys. Many mutations within the window
   * collapse into one atomic write.
   */
  flush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  /** Persist immediately (atomic tmp + rename). Used on shutdown. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    const json = JSON.stringify(this.data);
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error('[shadowgate] store flush failed (atomic):', err);
      try {
        fs.writeFileSync(this.file, json, { mode: 0o600 });
        this.dirty = false;
      } catch (err2) {
        console.error('[shadowgate] store flush failed (direct):', err2);
      }
    }
  }
}
