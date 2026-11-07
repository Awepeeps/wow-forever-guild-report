import { expect, test } from "bun:test";
import { ApiError, HttpClient, mapConcurrent } from "../src/http.ts";

test("retries rate limits with Retry-After and sends bounded timeouts without redirects", async () => {
  const waits: number[] = [];
  let count = 0;
  const client = new HttpClient(
    async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return count++ === 0
        ? new Response("slow", { status: 429, headers: { "Retry-After": "2" } })
        : Response.json({ ok: true });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(await client.json("API", "https://example.com")).toEqual({ ok: true });
  expect(waits).toEqual([2_000]);
});

test("caps retry budget and suppresses sensitive server bodies", async () => {
  let attempts = 0;
  const client = new HttpClient(
    async () => {
      attempts++;
      return new Response("sensitive-example-body", { status: 503 });
    },
    async () => {},
  );
  await expect(client.json("API", "https://example.com")).rejects.toThrow(
    "HTTP 503",
  );
  expect(attempts).toBe(4);
  try {
    await client.json("API", "https://example.com", {}, false);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect(String(e)).not.toContain("sensitive-example-body");
  }
  expect(attempts).toBe(5);
});

test("does not retry authentication errors or cooldowns over 30 seconds", async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const client = new HttpClient(async () => {
      calls++;
      return new Response("", { status, headers: { "Retry-After": "120" } });
    });
    await expect(client.json("API", "https://example.com")).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("bounds concurrent work and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(1);
    active--;
    return n * 2;
  });
  expect(peak).toBe(2);
  expect(result).toEqual([2, 4, 6, 8, 10, 12]);
});
