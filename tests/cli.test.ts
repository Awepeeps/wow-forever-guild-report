import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { snapshotSchema } from "../src/model.ts";
import { snapshot } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");
async function run(
  directory: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    [
      join(root, "node_modules/.bin/varlock"),
      "run",
      "--",
      process.execPath,
      join(root, "src/cli.ts"),
      ...args,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        BLIZZARD_CLIENT_ID: "",
        BLIZZARD_CLIENT_SECRET: "",
        GOOGLE_ACCESS_TOKEN: "",
        GOOGLE_SERVICE_ACCOUNT_FILE: "",
        GOOGLE_SPREADSHEET_ID: "",
        DISCORD_MAP_FILE: "",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("real Varlock CLI exports a private workbook and fails refresh before touching outputs when credentials are missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-cli-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const config = join(root, "examples/roster.json");
    const out = join(directory, "output");
    const result = await run(directory, [
      "export",
      "--config",
      config,
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    const path = join(out, "snapshot.json");
    const before = await readFile(path, "utf8");
    expect(snapshotSchema.safeParse(JSON.parse(before)).success).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(out, "roster.xlsx"))).size).toBeGreaterThan(1_000);
    const failed = await run(directory, [
      "refresh",
      "--config",
      config,
      "--out",
      out,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("BLIZZARD_CLIENT_ID");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("offline export defaults to a separate directory and refuses replacing an API snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-export-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const livePath = join(directory, "output/roster/snapshot.json");
    const live = JSON.stringify({
      ...snapshot,
      rows: snapshot.rows.map((row) => ({ ...row, profileStatus: "ok" })),
    });
    await Bun.write(livePath, live);
    const args = ["export", "--config", join(root, "examples/roster.json")];
    expect((await run(directory, args)).code).toBe(0);
    expect(await readFile(livePath, "utf8")).toBe(live);
    expect(
      await Bun.file(join(directory, "output/export/roster.xlsx")).exists(),
    ).toBe(true);
    const refused = await run(directory, [...args, "--out", "output/roster"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("cannot replace an API refresh snapshot");
    expect(await readFile(livePath, "utf8")).toBe(live);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a missing configured Discord map fails before writing exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-map-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const result = await run(
      directory,
      ["export", "--config", join(root, "examples/roster.json")],
      { DISCORD_MAP_FILE: ".local/missing-map.json" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Cannot read JSON input");
    expect(
      await Bun.file(join(directory, "output/export/snapshot.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("real import ignores Notes, creates sibling map, and refuses an overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-import-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const input = join(directory, "original.csv");
    await Bun.write(
      input,
      "Discord,Character Name,Ruleset,Class,Faction,Race,Level,Spec 1,Spec 2,Profession 1,Profession 2,Notes\nexample,Example Priest,,,,,17,,,Alchemy,,do-not-import-this-note\n",
    );
    const args = [
      "import",
      "--input",
      input,
      "--out",
      join(directory, ".local/roster.json"),
    ];
    expect((await run(directory, args)).code).toBe(0);
    expect(
      await readFile(join(directory, ".local/roster.json"), "utf8"),
    ).not.toContain("do-not-import-this-note");
    expect(
      JSON.parse(
        await readFile(join(directory, ".local/discord-map.json"), "utf8"),
      ),
    ).toEqual({ "us:example-priest": "example" });
    const rerun = await run(directory, args);
    expect(rerun.code).toBe(1);
    expect(rerun.stderr).toContain("already exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
