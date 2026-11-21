import type { DbEntry } from "@statewalker/db-api";

/** UTF-8 bytes of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a surrogate pair: one 4-byte character
      i++;
    } else n += 3;
  }
  return n;
}

/** About how many bytes a value takes in a message: exact for text and BLOBs, 8 for a number. */
export function valueSize(value: unknown, depth = 0): number {
  if (value === null || value === undefined || typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "string") return utf8Length(value) + 2;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength + 2;
  if (value instanceof Date) return 8;
  if (typeof value !== "object" || depth > 32) return 8;
  let n = 2;
  if (Array.isArray(value)) for (const item of value) n += valueSize(item, depth + 1);
  else
    for (const [key, item] of Object.entries(value)) {
      n += utf8Length(key) + valueSize(item, depth + 1);
    }
  return n;
}

/**
 * Cuts rows into pages of at most `maxRows` rows and about `maxBytes` bytes (by
 * {@link valueSize}); a row larger than `maxBytes` gets a page of its own. Always at least one
 * page (an empty result is one empty page).
 */
export function toPages(rows: DbEntry[], maxRows: number, maxBytes: number): DbEntry[][] {
  const pages: DbEntry[][] = [];
  let page: DbEntry[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = valueSize(row);
    if (page.length > 0 && (page.length >= maxRows || bytes + size > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(row);
    bytes += size;
  }
  pages.push(page);
  return pages;
}
