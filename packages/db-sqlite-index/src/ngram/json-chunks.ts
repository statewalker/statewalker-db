/**
 * Serialises rows into JSON array parameters for `json_each(?)`, each at most
 * `maxChars` UTF-16 code units. 500k code units stay under a Durable Object's
 * ~2 MB string limit even at 4 bytes per code point; a single row larger than
 * that still fails there with "string or blob too big".
 */
export function chunkJson(rows: unknown[], maxChars = 500_000): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    if (current.length > 0 && size + json.length + 1 > maxChars) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      size = 2;
    }
    current.push(json);
    size += json.length + 1;
  }
  if (current.length > 0) chunks.push(`[${current.join(",")}]`);
  return chunks;
}
