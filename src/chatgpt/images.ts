// Image inputs: an OpenAI `image_url` part (data: URL or http(s) URL) becomes a
// ChatGPT file upload and an image asset pointer inside a multimodal message.
//
// Upload flow, as chatgpt.com's own client does it:
//   POST /backend-api/files            → { file_id, upload_url }
//   PUT  upload_url (Azure blob SAS)   ← the bytes
//   POST /backend-api/files/{id}/uploaded
// The message then carries { content_type: "image_asset_pointer",
// asset_pointer: "file-service://file_id", size_bytes, width, height }.
import crypto from 'node:crypto';
import { UpstreamError } from './client.js';

const BASE = 'https://chatgpt.com';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface ImageAsset {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
}

export interface UploadCreds {
  accessToken: string;
  deviceId: string;
  ua: string;
  accountId?: string;
}

/** One upload per (account, bytes) per process — a retry on the same session must not re-upload. */
const cache = new Map<string, ImageAsset>();

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Sniff the format from magic bytes; the declared type in a data URL is often wrong. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Pixel size from the header — the backend wants width/height on the asset pointer. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } {
  try {
    if (mime === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/webp' && buf.length >= 30) {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return { width: 0, height: 0 };
}

/** Resolve an image_url value (data: URL or remote URL) to bytes. */
export async function loadImage(url: string, signal?: AbortSignal): Promise<{ buf: Buffer; mime: string; name: string }> {
  let buf: Buffer;
  let declared = '';
  let name = 'image';
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s);
    if (!m) throw new UpstreamError(400, 'bad_image', 'image_url is not a valid data URL');
    declared = m[1] ?? '';
    buf = m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
  } else if (/^https?:\/\//i.test(url)) {
    const r = await fetch(url, { signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!r.ok) throw new UpstreamError(400, 'bad_image', `could not fetch image_url (${r.status})`);
    buf = Buffer.from(await r.arrayBuffer());
    declared = (r.headers.get('content-type') ?? '').split(';')[0].trim();
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
  } else {
    throw new UpstreamError(400, 'bad_image', 'image_url must be a data: URL or an http(s) URL');
  }
  if (buf.length === 0) throw new UpstreamError(400, 'bad_image', 'image_url is empty');
  if (buf.length > MAX_IMAGE_BYTES) throw new UpstreamError(413, 'bad_image', `image is ${Math.round(buf.length / 1048576)} MB; the limit is 20 MB`);
  const mime = sniffMime(buf) ?? (declared.startsWith('image/') ? declared : '');
  if (!mime) throw new UpstreamError(400, 'bad_image', 'image_url does not hold a PNG, JPEG, GIF or WebP image');
  if (!/\.[a-z0-9]{3,4}$/i.test(name)) name = `${name}.${MIME_EXT[mime] ?? 'bin'}`;
  return { buf, mime, name };
}

function headers(creds: UploadCreds): Record<string, string> {
  return {
    'user-agent': creds.ua,
    accept: '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${creds.accessToken}`,
    'oai-device-id': creds.deviceId,
    'oai-language': 'en-US',
    origin: BASE,
    referer: `${BASE}/`,
    ...(creds.accountId ? { 'chatgpt-account-id': creds.accountId } : {}),
  };
}

/** Upload one image to the account's file service and return its asset facts. */
export async function uploadImage(creds: UploadCreds, img: { buf: Buffer; mime: string; name: string }, signal?: AbortSignal): Promise<ImageAsset> {
  const key = `${creds.accountId ?? creds.deviceId}:${crypto.createHash('sha256').update(img.buf).digest('hex')}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { width, height } = imageSize(img.buf, img.mime);
  const sig = signal ?? AbortSignal.timeout(60_000);

  const created = await fetch(`${BASE}/backend-api/files`, {
    method: 'POST',
    headers: headers(creds),
    signal: sig,
    body: JSON.stringify({ file_name: img.name, file_size: img.buf.length, use_case: 'multimodal', reset_rate_limits: false }),
  });
  if (created.status === 401) throw new UpstreamError(401, 'session_expired', 'files -> 401');
  if (created.status === 403) throw new UpstreamError(403, 'forbidden', 'files -> 403');
  if (!created.ok) throw new UpstreamError(created.status === 429 ? 429 : 502, 'upload_failed', `files -> ${created.status} ${(await created.text().catch(() => '')).slice(0, 200)}`);
  const meta = (await created.json().catch(() => null)) as { file_id?: string; upload_url?: string; status?: string } | null;
  if (!meta?.file_id || !meta.upload_url) throw new UpstreamError(502, 'upload_failed', `files -> no upload_url (${JSON.stringify(meta).slice(0, 200)})`);

  const put = await fetch(meta.upload_url, {
    method: 'PUT',
    signal: sig,
    headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2020-04-08', 'content-type': img.mime, 'content-length': String(img.buf.length) },
    body: new Uint8Array(img.buf),
  });
  if (!put.ok) throw new UpstreamError(502, 'upload_failed', `blob PUT -> ${put.status}`);

  const done = await fetch(`${BASE}/backend-api/files/${meta.file_id}/uploaded`, { method: 'POST', headers: headers(creds), signal: sig, body: '{}' });
  if (!done.ok) throw new UpstreamError(502, 'upload_failed', `files/uploaded -> ${done.status}`);

  const asset: ImageAsset = { fileId: meta.file_id, name: img.name, mime: img.mime, size: img.buf.length, width, height };
  cache.set(key, asset);
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return asset;
}

/** The part a multimodal message carries for an uploaded image. */
export function assetPart(a: ImageAsset) {
  return { content_type: 'image_asset_pointer', asset_pointer: `file-service://${a.fileId}`, size_bytes: a.size, width: a.width, height: a.height };
}

/** The attachment record chatgpt.com puts in message.metadata for an uploaded image. */
export function attachmentMeta(a: ImageAsset) {
  return { id: a.fileId, size: a.size, name: a.name, mime_type: a.mime, width: a.width, height: a.height };
}
