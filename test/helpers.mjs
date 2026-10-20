// Shared helpers for the regression suite (runs against dist/, so build first).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtures = path.join(here, 'fixtures');

/** Load a recorded backend stream as a web ReadableStream plus the ids of the messages we sent. */
export function fixtureStream(name, chunkSize = 777) {
  const raw = fs.readFileSync(path.join(fixtures, `${name}.sse`));
  const meta = JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), 'utf8'));
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= raw.length) { controller.close(); return; }
      controller.enqueue(new Uint8Array(raw.subarray(offset, Math.min(raw.length, offset + chunkSize))));
      offset += chunkSize;
    },
  });
  return { body, inputIds: new Set(meta.inputIds), meta };
}

/** Drain a parser into {text, reasoning, finish, slug, kinds}. */
export async function collect(events) {
  const out = { text: '', reasoning: '', finish: '', slug: '', kinds: [] };
  for await (const ev of events) {
    if (ev.delta) out.text += ev.delta;
    if (ev.reasoning) out.reasoning += ev.reasoning;
    if (ev.finish) out.finish = ev.finish;
    if (ev.modelSlug) out.slug = ev.modelSlug;
    if (ev.kinds) out.kinds = ev.kinds;
  }
  return out;
}
