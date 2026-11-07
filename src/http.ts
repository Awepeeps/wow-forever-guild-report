export type Fetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export class ApiError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
  ) {
    super(`${service} request failed (HTTP ${status}).`);
    this.name = "ApiError";
  }
}
export class SafeError extends Error {}

export class HttpClient {
  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      Bun.sleep(ms),
  ) {}

  async json(
    service: string,
    url: string | URL,
    init: RequestInit = {},
    retry = true,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        if (!retry || attempt === 3)
          throw new SafeError(
            `${service} network request failed or timed out.`,
          );
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new SafeError(`${service} returned invalid JSON.`);
        }
      }
      if (
        retry &&
        (response.status === 429 || response.status >= 500) &&
        attempt < 3
      ) {
        const header = response.headers.get("retry-after");
        const seconds = header === null ? Number.NaN : Number(header);
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : header
            ? Date.parse(header) - Date.now()
            : 0;
        // Do not retry before a long server cooldown. Let the caller schedule a later run.
        if (delay > 30_000) throw new ApiError(service, response.status);
        await response.body?.cancel();
        await this.sleep(Math.max(500 * 2 ** attempt, delay || 0));
        continue;
      }
      await response.body?.cancel();
      throw new ApiError(service, response.status);
    }
    throw new SafeError(`${service} retry budget exhausted.`);
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length && failure === undefined) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) continue;
        try {
          results[index] = await fn(item);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure !== undefined) throw failure;
  return results;
}
