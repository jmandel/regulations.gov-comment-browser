// Word-pair index for quoted-phrase search on the dashboard.
//
// The word index (search/index.json + postings.bin) finds the units containing every word of a
// phrase but not whether the words are adjacent, so phrase search had to fetch and scan the full
// text of every candidate (tens of MB on a large docket). This index records, per unit, each pair
// of adjacent words with the exact characters between them ("primary source", "site-neutral"),
// so a two-word phrase is answered from the index alone and a longer phrase leaves only a few
// candidates to check against their text.
//
// Layout (under search/):
//   pairs.json       { version, shards, maxWord, maxSep, longUnits }
//   pairs/NNN.json   one shard: { keys (sorted), lens, postings }; postings is the base64 of the
//                    concatenated posting lists, encoded like postings.bin (delta + varint unit
//                    ordinals, or a bitmap when lens[i] is negative). JSON rather than binary so
//                    static hosts gzip it (most of a shard is its keys).
// A key is word + separator + word. It lives in shard fnv1a(word + separator + first character of
// the second word) % shards, so all pairs that start a phrase ("conversion factor", "conversion
// factors", ...) are in one shard. Pairs with a separator longer than maxSep or a word longer than
// maxWord are not indexed; units with a word longer than maxWord are listed in longUnits (the
// dashboard falls back to checking their text, as the word index skips such words too).
// Keep the tokenization, key and hash in step with dashboard/src/utils/fullTextSearch.ts.
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const MAX_SEP = 3;
const TARGET_SHARD_BYTES = 64 * 1024;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const SHARD_PREFIX_RE = /^[\p{L}\p{N}]+[^\p{L}\p{N}]*/u;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function writeVarint(buf: number[], n: number) {
  while (n >= 0x80) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n);
}

export class PhraseIndexBuilder {
  private postings = new Map<string, number[]>();
  private longUnits: number[] = [];
  private units = 0;
  constructor(private maxWord: number) {}

  // `text` is the unit's lowercased search text; add units in ordinal order
  add(ordinal: number, text: string) {
    this.units = ordinal + 1;
    let prev: string | null = null;
    let prevEnd = 0;
    let long = false;
    for (const m of text.matchAll(TOKEN_RE)) {
      const w = m[0];
      const start = m.index!;
      if (w.length > this.maxWord) {
        long = true;
        prev = null;
      } else {
        if (prev !== null && start - prevEnd <= MAX_SEP) {
          const key = prev + text.slice(prevEnd, start) + w;
          let p = this.postings.get(key);
          if (!p) this.postings.set(key, p = []);
          if (p[p.length - 1] !== ordinal) p.push(ordinal);
        }
        prev = w;
      }
      prevEnd = start + w.length;
    }
    if (long) this.longUnits.push(ordinal);
  }

  async write(searchDir: string): Promise<{ keys: number; shards: number; bytes: number }> {
    const units = this.units;
    const keys = [...this.postings.keys()];
    const encoded = new Map<string, { bytes: Uint8Array; len: number }>();
    let total = 0;
    for (const k of keys) {
      const list = this.postings.get(k)!;
      let e;
      if (list.length > units / 8) {
        const bm = new Uint8Array(Math.ceil(units / 8));
        for (const o of list) bm[o >> 3] |= 1 << (o & 7);
        e = { bytes: bm, len: -bm.length };
      } else {
        const buf: number[] = [];
        let prev = -1;
        for (const o of list) { writeVarint(buf, o - prev); prev = o; }
        e = { bytes: Uint8Array.from(buf), len: buf.length };
      }
      encoded.set(k, e);
      total += e.bytes.length + k.length + 8;
    }
    this.postings.clear();

    const shards = Math.max(1, Math.round(total / TARGET_SHARD_BYTES));
    const byShard: string[][] = Array.from({ length: shards }, () => []);
    for (const k of keys) {
      const prefix = k.match(SHARD_PREFIX_RE)![0];
      byShard[fnv1a(k.slice(0, prefix.length + 1)) % shards].push(k);
    }
    await mkdir(join(searchDir, "pairs"), { recursive: true });
    let bytes = 0;
    for (let s = 0; s < shards; s++) {
      const ks = byShard[s].sort();
      const postings = Buffer.concat(ks.map(k => encoded.get(k)!.bytes)).toString("base64");
      const json = JSON.stringify({ keys: ks, lens: ks.map(k => encoded.get(k)!.len), postings });
      await writeFile(join(searchDir, "pairs", `${String(s).padStart(3, "0")}.json`), json);
      bytes += json.length;
    }
    await writeFile(join(searchDir, "pairs.json"), JSON.stringify({
      version: 1, shards, maxWord: this.maxWord, maxSep: MAX_SEP, longUnits: this.longUnits,
    }));
    return { keys: keys.length, shards, bytes };
  }
}
