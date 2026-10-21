// Usage: the ChatGPT account limits behind the pool (chatgpt.com → Usage page)
// plus what the calling API key has spent on the gateway. Served three ways:
// the console, GET /v1/usage, and a short note the model reads when the user
// asks about their usage from any client (ZadLoop, OpenCode, …).
import type { ApiKeyRecord, Store, TokenRecord } from './store.js';
import type { UsageSnapshot, UsageWindow } from './chatgpt/client.js';

export interface WindowReport {
  used_percent: number;
  remaining_percent: number;
  window_seconds: number;
  resets_at: string | null;
  resets_in_seconds: number | null;
}

export interface AccountUsage {
  id: string;
  label: string;
  status: string;
  email?: string;
  plan?: string;
  allowed: boolean;
  limit_reached: boolean;
  five_hour: WindowReport | null;
  weekly: WindowReport | null;
  credits: UsageSnapshot['credits'] | null;
  models: UsageSnapshot['models'] | null;
  fetched_at: string | null;
  error?: string;
}

export interface KeyUsage {
  name: string;
  requests_5h: number;
  requests_24h: number;
  requests_total: number;
  rpm_limit: number;
  rpd_limit: number;
  remaining_today: number;
}

export interface UsageReport {
  object: 'usage';
  generated_at: string;
  accounts: AccountUsage[];
  key?: KeyUsage;
  note: string;
}

const NOTE =
  "Account limits are the ones chatgpt.com shows under Settings → Usage. Work-mode models (names ending in -wm) spend them; the chat lane (gpt-6, gpt-5-6 and other non -wm models) is not counted against them on this plan.";

export const maskEmail = (e?: string) => (e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : undefined);

function windowReport(w: UsageWindow | undefined, nowMs: number): WindowReport | null {
  if (!w) return null;
  const resetMs = w.resetAt ? w.resetAt * 1000 : 0;
  return {
    used_percent: w.usedPercent,
    remaining_percent: Math.max(0, 100 - w.usedPercent),
    window_seconds: w.windowSeconds,
    resets_at: resetMs ? new Date(resetMs).toISOString() : null,
    resets_in_seconds: resetMs ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null,
  };
}

export function accountUsage(t: TokenRecord, nowMs = Date.now()): AccountUsage {
  const u = t.usage;
  return {
    id: t.id,
    label: t.label,
    status: t.status,
    email: maskEmail(t.email),
    plan: u?.plan ?? t.plan,
    allowed: u ? u.allowed : true,
    limit_reached: u ? u.limitReached : false,
    five_hour: windowReport(u?.primary, nowMs),
    weekly: windowReport(u?.secondary, nowMs),
    credits: u?.credits ?? null,
    models: u?.models ?? null,
    fetched_at: u?.fetchedAt ?? null,
    ...(t.usageError ? { error: t.usageError } : {}),
  };
}

export function keyUsage(store: Store, key: ApiKeyRecord, nowMs = Date.now()): KeyUsage {
  let h5 = 0;
  let h24 = 0;
  for (const r of store.requests) {
    if (r.keyId !== key.id) continue;
    const age = nowMs - Date.parse(r.ts);
    if (age < 24 * 3600_000) h24++;
    if (age < 5 * 3600_000) h5++;
  }
  return {
    name: key.name,
    requests_5h: h5,
    requests_24h: h24,
    requests_total: key.totalRequests,
    rpm_limit: key.rpm,
    rpd_limit: key.rpd,
    remaining_today: Math.max(0, key.rpd - h24),
  };
}

export function usageReport(store: Store, key?: ApiKeyRecord, nowMs = Date.now()): UsageReport {
  return {
    object: 'usage',
    generated_at: new Date(nowMs).toISOString(),
    accounts: store.tokens.map((t) => accountUsage(t, nowMs)),
    ...(key ? { key: keyUsage(store, key, nowMs) } : {}),
    note: NOTE,
  };
}

/** "3d 4h", "4h 59m", "12m" */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

const utcStamp = (iso: string) => {
  const d = new Date(iso);
  return `${d.toUTCString().slice(0, 3)} ${d.toISOString().slice(11, 16)} UTC`;
};

function windowLine(name: string, w: WindowReport | null): string {
  if (!w) return `${name}: not reported`;
  const reset = w.resets_at && w.resets_in_seconds != null ? `, resets in ${humanDuration(w.resets_in_seconds)} (${utcStamp(w.resets_at)})` : '';
  return `${name} ${w.used_percent}% used, ${w.remaining_percent}% left${reset}`;
}

/** Plain-text summary: what the model reads, and what `GET /v1/usage?format=text` returns. */
export function usageText(r: UsageReport): string {
  const lines = [`ShadowGate live usage, checked ${r.generated_at.slice(11, 16)} UTC on ${r.generated_at.slice(0, 10)}:`];
  if (!r.accounts.length) lines.push('- No ChatGPT accounts are in the pool.');
  for (const a of r.accounts) {
    const who = `${a.label}${a.plan ? ` (${a.plan} plan)` : ''}${a.status !== 'healthy' ? `, status ${a.status}` : ''}`;
    if (!a.fetched_at) {
      lines.push(`- ${who}: usage not available yet${a.error ? ` (${a.error})` : ''}.`);
      continue;
    }
    const parts = [windowLine('5-hour limit', a.five_hour), windowLine('weekly limit', a.weekly)];
    if (a.limit_reached || !a.allowed) parts.push('LIMIT REACHED — work-mode models are blocked until the reset');
    const c = a.credits;
    if (c) parts.push(c.unlimited ? 'credits: unlimited' : c.hasCredits ? `credits: ${c.balance ?? 'yes'}` : 'credits: none');
    const models = Object.entries(a.models ?? {}).map(([slug, m]) => `${slug} ${m.available ? 'available' : `unavailable${m.availableAt ? ` until ${new Date(m.availableAt * 1000).toISOString().slice(0, 16)}Z` : ''}`}`);
    if (models.length) parts.push(models.join(', '));
    const age = Math.round((Date.parse(r.generated_at) - Date.parse(a.fetched_at)) / 60000);
    lines.push(`- ${who}: ${parts.join('; ')}.${age >= 2 ? ` (snapshot ${age} min old)` : ''}`);
  }
  if (r.key) {
    const k = r.key;
    lines.push(`- This API key "${k.name}": ${k.requests_5h} requests in the last 5 hours, ${k.requests_24h} in the last 24 hours (gateway limit ${k.rpd_limit}/day, ${k.remaining_today} left; ${k.rpm_limit}/minute), ${k.requests_total} in total.`);
  }
  lines.push(`- ${r.note}`);
  return lines.join('\n');
}

/** Wording of the note appended to the user's message (stripped again from continuation keys). */
export function usageNote(text: string): string {
  return `\n\n[ShadowGate usage: the gateway attached this live data because the user asked about usage or limits. Use these numbers when you report usage, and never say you cannot see it. If the user asked for usage after a task, finish the task first, then report usage at the end.\n${text}]`;
}

const ASK_USAGE: RegExp[] = [
  /\b(my|our|the|account|plan|current|chatgpt|codex|shadowgate|gateway|weekly|daily|hourly|5[- ]?h(?:our)?|five[- ]hour|remaining|left)\s+(usage|quota|limits?|rate[- ]?limits?|credits?)\b(?!\s+(?:of|in|for|example|examples|pattern|text|string)\b)/i,
  /\b(usage|quota|limits?|credits?)\s+(left|remaining|status|reset|resets|so far|now)\b/i,
  /\b(how much|how many|what'?s|what is|show|check|tell me|give me|see)\b[^.?!\n]{0,40}\b(usage|quota|limits?|credits?)\b(?!\s+(?:of|in|for|example|examples|pattern|text|string)\b)/i,
  /\bhave i (used|spent|reached|hit)\b/i,
  /\b(reach|reached|hit)\s+(my|the)\s+(limit|cap|quota)\b/i,
  /\bwhen (does|do|will) (my|the) (limit|limits|usage|quota)s? reset\b/i,
  /(استخدامي|الاستخدام|استهلاكي|الاستهلاك|الليميت|ليميت|الكوتا|الرصيد|الحد المسموح|الباقي من)/,
];

/** True when the conversation's latest real user message (not a tool result) asks about usage. */
export function lastUserAsksAboutUsage(messages: Array<{ role: string; content?: unknown }>): boolean {
  const textOf = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text ?? '')).join('\n') : '';
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'user') i--;
  if (i < 0) return false;
  // harnesses often split one turn into several user messages (the typed text, then reminders)
  const turn: string[] = [];
  for (; i >= 0 && messages[i].role === 'user'; i--) turn.unshift(textOf(messages[i].content));
  return asksAboutUsage(turn.join('\n'));
}

/** True when a user message asks about their usage or limits. */
export function asksAboutUsage(text: string): boolean {
  const body = text.replace(/\n\n\[(?:Harness reminder|Output format|ShadowGate usage):[\s\S]*$/, '');
  // harnesses wrap the typed text in long context blocks: look at both ends of a long turn
  const t = body.length > 50000 ? body.slice(0, 25000) + '\n' + body.slice(-25000) : body;
  return ASK_USAGE.some((re) => re.test(t));
}
