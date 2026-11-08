import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dailyRefresh } from "../scripts/daily-refresh.ts";
import { atomicWrite } from "../src/files.ts";
import { snapshot } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), "daily-refresh-"));
  directories.push(out);
  const path = join(out, "snapshot.json");
  const pending = join(out, "publication-pending.json");
  const started = Date.parse(snapshot.generatedAt) + 1000;
  await atomicWrite(path, JSON.stringify(snapshot));
  return {
    out,
    path,
    pending,
    now: () => started,
    fresh: { ...snapshot, generatedAt: new Date(started).toISOString() },
  };
}

for (const refreshCode of [0, 2] as const) {
  test(`daily refresh publishes fresh exit-${refreshCode} data once and backs up retained state privately`, async () => {
    const f = await fixture();
    const calls: string[][] = [];
    const result = await dailyRefresh({
      ...f,
      run: async (args) => {
        calls.push(args);
        if (args[0] === "refresh") {
          await atomicWrite(f.path, JSON.stringify(f.fresh));
          return refreshCode;
        }
        expect(JSON.parse(await readFile(f.pending, "utf8"))).toEqual({
          generatedAt: f.fresh.generatedAt,
        });
        expect((await stat(f.pending)).mode & 0o777).toBe(0o600);
        return 0;
      },
    });
    expect(result).toBe(refreshCode);
    expect(calls).toEqual([
      ["refresh", ".local/roster.json", f.out],
      ["sheets", f.path],
    ]);
    expect(await Bun.file(f.pending).exists()).toBe(false);
    const backups = join(f.out, "backups");
    const [name] = await readdir(backups);
    expect(name).toBeDefined();
    const backup = join(backups, name ?? "missing");
    expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(snapshot);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
  });
}

test("daily refresh never publishes after a failed or unexpected refresh exit, even with a new file", async () => {
  for (const code of [1, 3, 127]) {
    const f = await fixture();
    let calls = 0;
    await expect(
      dailyRefresh({
        ...f,
        run: async () => {
          calls++;
          await atomicWrite(f.path, JSON.stringify(f.fresh));
          return code;
        },
      }),
    ).rejects.toThrow("Daily refresh failed");
    expect(calls).toBe(1);
    expect(await Bun.file(f.pending).exists()).toBe(false);
  }
});

test("daily refresh rejects stale, future, missing, and malformed snapshots before publication", async () => {
  for (const kind of ["stale", "future", "missing", "malformed"]) {
    const f = await fixture();
    let calls = 0;
    await expect(
      dailyRefresh({
        ...f,
        run: async () => {
          calls++;
          if (kind === "future")
            await atomicWrite(
              f.path,
              JSON.stringify({
                ...f.fresh,
                generatedAt: new Date(f.now() + 1).toISOString(),
              }),
            );
          if (kind === "missing") await rm(f.path);
          if (kind === "malformed")
            await atomicWrite(f.path, '{"private":"sentinel-private-data"}');
          return 0;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await Bun.file(f.pending).exists()).toBe(false);
  }
});

test("daily refresh refuses a fresh but empty discovered guild roster", async () => {
  const f = await fixture();
  let calls = 0;
  await expect(
    dailyRefresh({
      ...f,
      run: async () => {
        calls++;
        await atomicWrite(f.path, JSON.stringify({ ...f.fresh, rows: [] }));
        return 0;
      },
    }),
  ).rejects.toThrow("empty roster");
  expect(calls).toBe(1);
});

test("a failed or interrupted Google publication blocks subsequent unattended runs", async () => {
  for (const interrupted of [false, true]) {
    const f = await fixture();
    let publishes = 0;
    await expect(
      dailyRefresh({
        ...f,
        run: async (args) => {
          if (args[0] === "refresh") {
            await atomicWrite(f.path, JSON.stringify(f.fresh));
            return 2;
          }
          publishes++;
          if (interrupted) throw new Error("Interrupted process");
          return 1;
        },
      }),
    ).rejects.toThrow();
    expect(publishes).toBe(1);
    expect(await Bun.file(f.pending).exists()).toBe(true);
    let calls = 0;
    await expect(
      dailyRefresh({
        ...f,
        run: async () => {
          calls++;
          return 0;
        },
      }),
    ).rejects.toThrow("earlier publication needs inspection");
    expect(calls).toBe(0);
  }
});

test("backup rotation retains fourteen snapshots and leaves unrelated private files alone", async () => {
  const f = await fixture();
  const backups = join(f.out, "backups");
  await mkdir(backups);
  for (let day = 1; day <= 16; day++)
    await atomicWrite(
      join(
        backups,
        `snapshot-2026-10-${String(day).padStart(2, "0")}T00-00-00-000Z.json`,
      ),
      "{}",
    );
  await atomicWrite(join(backups, "human-backup.json"), "private");
  await expect(dailyRefresh({ ...f, run: async () => 1 })).rejects.toThrow(
    "Daily refresh failed",
  );
  expect((await readdir(backups)).length).toBe(15);
  expect(await Bun.file(join(backups, "human-backup.json")).text()).toBe(
    "private",
  );
  expect(
    await Bun.file(
      join(backups, "snapshot-2026-10-01T00-00-00-000Z.json"),
    ).exists(),
  ).toBe(false);
});

test("just daily refuses a concurrent cycle before invoking the CLI", async () => {
  const f = await fixture();
  await mkdir(join(f.out, ".local"));
  const holder = Bun.spawn(
    [
      "bash",
      "-c",
      'exec 9>"$1"; flock -x 9; echo ready; read -r signal',
      "bash",
      join(f.out, ".local/daily-refresh.lock"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "ready",
    );
    reader.releaseLock();
    const blocked = Bun.spawn(
      [
        "just",
        "--justfile",
        resolve(import.meta.dir, "../justfile"),
        "--working-directory",
        f.out,
        "daily",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(await blocked.exited).toBe(75);
    expect(await new Response(blocked.stderr).text()).not.toContain("varlock");
  } finally {
    holder.stdin.write("release\n");
    holder.stdin.end();
    await holder.exited;
  }
});
