/**
 * Map over `items` with at most `limit` calls in flight.
 *
 * `Promise.all` over a mapped array starts every call at once. For anything that opens a socket
 * that is a file-descriptor leak waiting for a big enough input: one run handed the GitHub blob
 * API twelve thousand simultaneous uploads and took the process down with `EMFILE`, after every
 * request had already 500'd.
 *
 * Results keep the order of `items`. The first rejection is thrown once the calls already in
 * flight have settled, so a failure never leaves work running behind it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let failure: unknown;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw failure;
  return results;
}
