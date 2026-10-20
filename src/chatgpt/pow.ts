// Proof-of-work solver for OpenAI's sentinel challenges.
// Faithful port of the reference implementation (sha3-512 loop over a
// fingerprint config array), tuned for Node's crypto.
import { createHash, randomUUID } from 'node:crypto';

const CORES = [8, 12, 16, 24];
const SCREENS = [3000, 4000, 6000];

// Exact magic string used by the browser fingerprint (note the U+2212 minus).
const WEBKIT_STR =
  'webkitGetUserMedia\u2212function webkitGetUserMedia() { [native code] }';

const FALLBACK_BUILD_ID = 'prod-a696433ddfe0489db6696cae8c5778c2128f26e8';

let userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
let cachedBuildId = FALLBACK_BUILD_ID;
let cachedScripts: string[] = [];
let cachedCore = CORES[Math.floor(Math.random() * CORES.length)];
let cachedHardware = SCREENS[Math.floor(Math.random() * SCREENS.length)];
const cachedSid = randomUUID();
const startTime = Date.now();
// microsecond-flavoured start (ms + fraction), like Go's UnixMicro()/1e3
const startMs = startTime + (startTime % 997) / 1000;

let buildIdFetched = false;

/** Point the fingerprint at the real browser identity we are impersonating. */
export function setPoWUserAgent(ua: string): void {
  if (ua) userAgent = ua;
}

/** Grab the current chatgpt.com build id + script names for the fingerprint. */
export async function warmBuildId(): Promise<void> {
  if (buildIdFetched) return;
  buildIdFetched = true;
  try {
    const r = await fetch('https://chatgpt.com/?oai-dm=1', {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': userAgent, accept: 'text/html' },
    });
    if (!r.ok) return;
    const html = await r.text();
    const build = html.match(/data-build="([^"]+)"/)?.[1];
    if (build) cachedBuildId = build;
    cachedScripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  } catch {
    /* keep fallbacks */
  }
}

/** "Mon Jan 2 2006 15:04:05" rendered in Asia/Shanghai, browser-style suffix. */
function parseTime(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')} ${get('hour')}:${get('minute')}:${get('second')} GMT+0800 (\u4e2d\u56fd\u6807\u51c6\u65f6\u95f4)`;
}

function fingerprintConfig(): unknown[] {
  const elapsedMs = Date.now() - startTime;
  const timeNum = elapsedMs + Math.random(); // ns-precision-ish ms float
  const script = cachedScripts.length
    ? cachedScripts[Math.floor(Math.random() * cachedScripts.length)]
    : null;
  return [
    cachedHardware, // 0 screen width
    parseTime(), // 1
    4294705152, // 2
    0, // 3 nonce (set per iteration)
    userAgent, // 4
    script, // 5
    cachedBuildId, // 6
    'en-US', // 7
    'en-US', // 8
    0, // 9 elapsed ms (set per iteration)
    WEBKIT_STR, // 10
    'location', // 11
    'ontransitionend', // 12
    timeNum, // 13
    cachedSid, // 14
    '', // 15
    cachedCore, // 16
    startMs, // 17
  ];
}

/** Brute-force the sha3-512 answer for a (seed, difficulty) pair. */
export function generateAnswer(seed: string, diff: string): string {
  const timeStart = Date.now();
  const config = fingerprintConfig();
  const diffLen = diff.length;
  for (let i = 0; i < 500_000; i++) {
    config[3] = i;
    config[9] = Math.round(Date.now() - timeStart);
    const base = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
    const hash = createHash('sha3-512').update(seed + base, 'utf8').digest('hex');
    if (hash.slice(0, diffLen) <= diff) return base;
  }
  return (
    'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' +
    Buffer.from(`"${seed}"`, 'utf8').toString('base64')
  );
}

let cachedRequirementsProof = '';

/** The "p" value sent to /sentinel/chat-requirements. */
export function requirementsProof(): string {
  if (!cachedRequirementsProof) {
    cachedRequirementsProof =
      'gAAAAAC' + generateAnswer(String(Math.random()), '0');
  }
  return cachedRequirementsProof;
}

/** The per-conversation proof header. */
export function conversationProof(seed: string, difficulty: string): string {
  return 'gAAAAAB' + generateAnswer(seed, difficulty);
}
