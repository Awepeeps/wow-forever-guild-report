import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema, snapshotSchema } from "../src/model.ts";
import { recipeMappingFromCsv } from "../src/recipe-mapping.ts";
import { snapshot } from "./helpers.ts";

const root = resolve(import.meta.dir, "..");
async function run(
  directory: string,
  args: string[],
  // `undefined` removes a variable so a test's .env.local supplies it instead.
  environment: Record<string, string | undefined> = {},
) {
  // The schema loads a Varlock plugin; resolve it from the repo's installed packages.
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
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
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          BLIZZARD_CLIENT_ID: "",
          BLIZZARD_CLIENT_SECRET: "",
          GOOGLE_ACCESS_TOKEN: "",
          GOOGLE_SERVICE_ACCOUNT_FILE: "",
          GOOGLE_SERVICE_ACCOUNT_JSON: "",
          GOOGLE_SPREADSHEET_ID: "",
          INFISICAL_SITE_URL: "",
          INFISICAL_PROJECT_ID: "",
          INFISICAL_CLIENT_ID: "",
          INFISICAL_CLIENT_SECRET: "",
          DISCORD_MAP_FILE: "",
          ...environment,
        }).filter(([, value]) => value !== undefined),
      ),
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

test("CLI persists the full pinned recipe map for later learned recipes and refuses replacing its map file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recipe-map-cli-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const path = join(directory, "config.json"),
      mappingPath = join(directory, "recipe-map.json"),
      out = join(directory, "output");
    const mapping = recipeMappingFromCsv(
      "ID,Spell\n42001,72001\n42002,72002\n",
      "1.60.1.70862",
    );
    await Bun.write(mappingPath, JSON.stringify(mapping));
    const config = configSchema.parse({
      version: 1,
      region: "us",
      characters: [
        {
          name: "Example Crafter",
          slug: "example-crafter",
          primary: [
            {
              name: "Alchemy",
              recipes: [{ id: 42001, name: "Invented Tonic" }],
            },
          ],
        },
      ],
    });
    await Bun.write(path, JSON.stringify(config));
    const first = await run(directory, [
      "export",
      "--config",
      path,
      "--out",
      out,
      "--recipe-map",
      mappingPath,
    ]);
    expect(first.code).toBe(0);
    expect(await readFile(join(out, "recipes.csv"), "utf8")).toContain(
      "spell=72001",
    );
    const row = config.characters[0];
    if (!row) throw new Error("fixture");
    row.primary = [
      { name: "Alchemy", recipes: [{ id: 42002, name: "Invented Tonic" }] },
    ];
    await Bun.write(path, JSON.stringify(config));
    const next = await run(directory, [
      "export",
      "--config",
      path,
      "--out",
      out,
    ]);
    expect(next.code).toBe(0);
    expect(await readFile(join(out, "recipes.csv"), "utf8")).toContain(
      "spell=72002",
    );
    const saved = snapshotSchema.parse(
      JSON.parse(await readFile(join(out, "snapshot.json"), "utf8")),
    );
    expect(saved.recipeMapping?.spells["42001"]).toBe(72001);
    expect(saved.recipeMapping?.build).toBe(mapping.build);
    const original = await readFile(mappingPath, "utf8");
    const refused = await run(directory, [
      "recipe-map",
      "--build",
      mapping.build,
      "--out",
      mappingPath,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(await readFile(mappingPath, "utf8")).toBe(original);
    await Bun.write(
      mappingPath,
      JSON.stringify({
        ...mapping,
        spells: { "42002": "https://private-input.invalid" },
      }),
    );
    const before = await readFile(join(out, "snapshot.json"), "utf8");
    const invalid = await run(directory, [
      "export",
      "--config",
      path,
      "--out",
      out,
      "--recipe-map",
      mappingPath,
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).not.toContain("private-input");
    expect(await readFile(join(out, "snapshot.json"), "utf8")).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

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

test("an unreachable Infisical source fails closed without starting the app or echoing bootstrap secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "roster-infisical-"));
  try {
    await Bun.write(
      join(directory, ".env.schema"),
      Bun.file(join(root, ".env.schema")),
    );
    const bootstrapSecret = "bootstrap-secret-must-not-print";
    await Bun.write(
      join(directory, ".env.local"),
      [
        "INFISICAL_SITE_URL=https://127.0.0.1:9",
        "INFISICAL_PROJECT_ID=00000000-0000-0000-0000-000000000000",
        "INFISICAL_CLIENT_ID=test-client-id",
        `INFISICAL_CLIENT_SECRET=${bootstrapSecret}`,
        "BLIZZARD_CLIENT_ID=infisical()",
        "BLIZZARD_CLIENT_SECRET=local-value-must-not-be-used",
        "",
      ].join("\n"),
    );
    const out = join(directory, "output");
    const result = await run(
      directory,
      ["export", "--config", join(root, "examples/roster.json"), "--out", out],
      {
        INFISICAL_SITE_URL: undefined,
        INFISICAL_PROJECT_ID: undefined,
        INFISICAL_CLIENT_ID: undefined,
        INFISICAL_CLIENT_SECRET: undefined,
        BLIZZARD_CLIENT_ID: undefined,
        BLIZZARD_CLIENT_SECRET: undefined,
      },
    );
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("BLIZZARD_CLIENT_ID");
    expect(`${result.stdout}${result.stderr}`).not.toContain(bootstrapSecret);
    expect(await Bun.file(join(out, "snapshot.json")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
