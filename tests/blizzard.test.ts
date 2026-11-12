import { expect, test } from "bun:test";
import { BlizzardClient } from "../src/blizzard.ts";
import { HttpClient } from "../src/http.ts";
import { configSchema } from "../src/model.ts";
import { refreshRoster } from "../src/roster.ts";

test("uses Forever realmless paths, profile namespace, OAuth header auth and one cached token", async () => {
  const urls: string[] = [];
  let oauth = 0;
  const http = new HttpClient(async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/token")) {
      oauth++;
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toStartWith(
        "Basic ",
      );
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    expect(url).toContain("namespace=profile-forever-us");
    expect(url).not.toContain("access_token");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    if (url.includes("/guild/"))
      return Response.json({
        members: [
          {
            character: {
              name: "Example",
              surname: "Priest",
              slug: "example-priest",
              level: 17,
            },
            rank: 2,
          },
        ],
      });
    if (url.includes("/professions?"))
      return Response.json({
        character: { slug: "example-priest" },
        primaries: [
          {
            profession: { name: "Alchemy" },
            tiers: [
              {
                tier: { name: "Classic" },
                skill_points: 72,
                max_skill_points: 150,
              },
              {
                tier: { name: "Other tier" },
                skill_points: 0,
                max_skill_points: 75,
              },
            ],
          },
        ],
        secondaries: [
          {
            profession: { name: "First Aid" },
            skill_points: 30,
            max_skill_points: 75,
          },
        ],
      });
    if (url.includes("/specializations?"))
      return Response.json({
        specialization_groups: [
          {
            is_active: false,
            specializations: [
              { specialization: { name: "Holy" }, spent_points: 10 },
            ],
          },
          {
            is_active: true,
            specializations: [
              {
                specialization: { name: "Shadow" },
                specialization_name: "Shadow Magic",
                spent_points: 5,
              },
              { specialization: { name: "Discipline" }, spent_points: 2 },
            ],
          },
        ],
      });
    return Response.json({
      name: "Example",
      surname: "Priest",
      level: 17,
      ruleset: { name: "Roleplay" },
      character_class: { name: "Priest" },
    });
  });
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test-id", clientSecret: "test-secret" },
    http,
  );
  const [guild, profile, professions, talents] = await Promise.all([
    client.guild("example-guild"),
    client.profile("example-priest"),
    client.professions("example-priest"),
    client.talents("example-priest"),
  ]);
  expect(oauth).toBe(1);
  expect(
    urls.some((u) => u.includes("/data/wow/guild/example-guild/roster?")),
  ).toBe(true);
  expect(guild[0]?.guildRank).toBe(2);
  expect(profile.name).toBe("Example Priest");
  expect(professions.primary.map((p) => p.skill)).toEqual([72, 0]);
  expect(professions.secondary[0]?.name).toBe("First Aid");
  expect(talents.talents).toEqual([
    { tree: "Shadow Magic", points: 5 },
    { tree: "Discipline", points: 2 },
  ]);
});

test("unknown response shapes fail; known empty profession/talent responses stay empty", async () => {
  let response: unknown = {};
  const http = new HttpClient(async (input) =>
    String(input).endsWith("/token")
      ? Response.json({ access_token: "test-token", expires_in: 3600 })
      : Response.json(response),
  );
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test-id", clientSecret: "test-secret" },
    http,
  );
  await expect(client.professions("example-priest")).rejects.toThrow(
    "unsupported shape",
  );
  await expect(client.talents("example-priest")).rejects.toThrow(
    "unsupported shape",
  );
  response = { character: { slug: "example-priest" } };
  expect(await client.professions("example-priest")).toEqual({
    primary: [],
    secondary: [],
  });
  response = { specialization_groups: [{ is_active: true }] };
  expect(await client.talents("example-priest")).toEqual({ talents: [] });
  response = {
    specialization_groups: [{ is_active: true }, { is_active: true }],
  };
  expect(await client.talents("example-priest")).toEqual({ talents: [] });
});

test("OAuth network, JSON and token-schema failures abort enrichment instead of producing a partial snapshot", async () => {
  for (const failure of ["network", "json", "schema"]) {
    const urls: string[] = [];
    const http = new HttpClient(
      async (input) => {
        urls.push(String(input));
        if (failure === "network") throw new Error("private-network-detail");
        return failure === "json"
          ? new Response("private-invalid-json")
          : Response.json({ private_response: "unsupported-token-shape" });
      },
      async () => {},
    );
    const client = new BlizzardClient(
      { region: "us", locale: "en_US" },
      { clientId: "test-id", clientSecret: "test-secret" },
      http,
    );
    const result = refreshRoster(
      configSchema.parse({
        version: 1,
        region: "us",
        characters: [{ slug: "example-priest", name: "Example Priest" }],
      }),
      {},
      client,
    );
    await expect(result).rejects.toThrow("OAuth authentication failed");
    await expect(result).rejects.not.toThrow("private");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url === "https://oauth.battle.net/token")).toBe(
      true,
    );
  }
});

test("profile metrics are numeric, last login converts epoch milliseconds, and missing values remain unknown", async () => {
  let response: unknown = {
    name: "Example",
    surname: "Priest",
    equipped_item_level: 12,
    average_item_level: 15,
    achievement_points: 0,
    experience: 127,
    last_login_timestamp: 1_794_052_800_000,
  };
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test-id", clientSecret: "test-secret" },
    new HttpClient(async (url) =>
      Response.json(
        String(url).endsWith("/token")
          ? { access_token: "test-token", expires_in: 3600 }
          : response,
      ),
    ),
  );
  const profile = await client.profile("example-priest");
  expect(profile).toMatchObject({
    equippedItemLevel: 12,
    averageItemLevel: 15,
    achievementPoints: 0,
    experience: 127,
  });
  expect(profile.lastLoginAt).toBe(new Date(1_794_052_800_000).toISOString());
  response = { name: "Example", last_login_timestamp: 0 };
  const empty = await client.profile("example-priest");
  expect(empty.lastLoginAt).toBeUndefined();
  expect(empty.experience).toBeUndefined();
  expect(Object.hasOwn(empty, "experience")).toBe(true);
  response = { name: "Example", last_login_timestamp: -1 };
  await expect(client.profile("example-priest")).rejects.toThrow(
    "unsupported shape",
  );
});

test("professions preserve known recipe IDs/names per tier and distinguish omitted from empty knowledge", async () => {
  let recipe: unknown = {
    id: 42,
    name: "Invented Tonic",
    key: { href: "https://untrusted.invalid/never-follow" },
  };
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test-id", clientSecret: "test-secret" },
    new HttpClient(async (url) =>
      Response.json(
        String(url).endsWith("/token")
          ? { access_token: "test-token", expires_in: 3600 }
          : {
              character: { slug: "example-priest" },
              primaries: [
                {
                  profession: { name: "Alchemy" },
                  tiers: [
                    {
                      tier: { name: "First" },
                      skill_points: 0,
                      max_skill_points: 75,
                      known_recipes: [recipe],
                    },
                    {
                      tier: { name: "Second" },
                      skill_points: 1,
                      max_skill_points: 75,
                      known_recipes: [],
                    },
                    {
                      tier: { name: "Third" },
                      skill_points: 2,
                      max_skill_points: 75,
                    },
                  ],
                },
              ],
            },
      ),
    ),
  );
  const result = await client.professions("example-priest");
  expect(result.primary.map((p) => p.recipes)).toEqual([
    [{ id: 42, name: "Invented Tonic" }],
    [],
    undefined,
  ]);
  expect(JSON.stringify(result)).not.toContain("untrusted");
  recipe = { id: -1, name: "Invalid" };
  await expect(client.professions("example-priest")).rejects.toThrow(
    "unsupported shape",
  );
});

test("guild class references resolve through the Forever class index even when character APIs return 404", async () => {
  for (const classIndexFails of [false, true]) {
    const urls: string[] = [];
    const client = new BlizzardClient(
      { region: "us", locale: "en_US" },
      { clientId: "test-id", clientSecret: "test-secret" },
      new HttpClient(async (input) => {
        const url = new URL(input);
        urls.push(url.toString());
        if (url.pathname.endsWith("/token"))
          return Response.json({
            access_token: "test-token",
            expires_in: 3600,
          });
        if (url.pathname === "/data/wow/playable-class/index") {
          expect(url.searchParams.get("namespace")).toBe("static-forever-us");
          return classIndexFails
            ? new Response(null, { status: 404 })
            : Response.json({ classes: [{ id: 101, name: "Invented Class" }] });
        }
        expect(url.searchParams.get("namespace")).toBe("profile-forever-us");
        if (url.pathname.endsWith("/roster"))
          return Response.json({
            members: [
              {
                rank: 2,
                character: {
                  id: 10101,
                  name: "Example",
                  surname: "Member",
                  slug: "example-member",
                  level: 12,
                  playable_class: {
                    id: 101,
                    key: { href: "https://untrusted.invalid/never-follow" },
                  },
                },
              },
              {
                rank: 2,
                character: {
                  id: 10102,
                  name: "Another",
                  surname: "Member",
                  slug: "another-member",
                  level: 5,
                  playable_class: { id: 102 },
                },
              },
            ],
          });
        return new Response(null, { status: 404 });
      }),
    );
    const result = await refreshRoster(
      configSchema.parse({ version: 1, region: "us", guild: "example-guild" }),
      {},
      client,
    );
    const row = result.rows.find((r) => r.character.slug === "example-member");
    expect(row?.character.class).toBe(classIndexFails ? "" : "Invented Class");
    expect(row?.profileStatus).toBe("unavailable");
    expect(row?.profileFetchedAt).toBeNull();
    expect(
      result.rows.find((r) => r.character.slug === "another-member")?.character
        .class,
    ).toBe("");
    expect(
      urls.filter((u) => u.includes("/playable-class/index")),
    ).toHaveLength(1);
    expect(urls.some((u) => u.includes("untrusted.invalid"))).toBe(false);
  }
});

test("recipe details use original IDs on the static Forever route, validate quantities and strip external references", async () => {
  let response: unknown = {
    id: 42,
    name: "Invented Tonic",
    crafted_item: {
      id: 7001,
      name: "Invented Tonic",
      key: { href: "https://untrusted.invalid/never-follow" },
    },
    crafted_quantity: { minimum: 1, maximum: 3 },
    reagents: [{ reagent: { id: 7002, name: "Invented Herb" }, quantity: 2 }],
  };
  const urls: string[] = [];
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test", clientSecret: "test" },
    new HttpClient(async (input) => {
      const url = new URL(input);
      urls.push(url.toString());
      if (url.pathname.endsWith("/token"))
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      expect(url.pathname).toBe("/data/wow/recipe/42");
      expect(url.searchParams.get("namespace")).toBe("static-forever-us");
      return Response.json(response);
    }),
  );
  expect(await client.recipe(42)).toEqual({
    id: 42,
    name: "Invented Tonic",
    output: { id: 7001, name: "Invented Tonic" },
    quantity: { min: 1, max: 3 },
    reagents: [{ item: { id: 7002, name: "Invented Herb" }, quantity: 2 }],
  });
  response = {
    id: 42,
    name: "Invented Tonic",
    crafted_quantity: { value: 1 },
    reagents: [],
  };
  expect((await client.recipe(42)).quantity).toEqual({ min: 1, max: 1 });
  response = { id: 42, name: "Invented Tonic" };
  expect((await client.recipe(42)).reagents).toBeUndefined();
  response = { id: 43, name: "Different Recipe" };
  await expect(client.recipe(42)).rejects.toThrow("identity");
  response = {
    id: 42,
    name: "Invented Tonic",
    reagents: [{ reagent: { id: 7002, name: "Invented Herb" }, quantity: -1 }],
  };
  await expect(client.recipe(42)).rejects.toThrow("unsupported shape");
  response = {
    id: 42,
    name: "Invented Tonic",
    crafted_quantity: { minimum: 4, maximum: 1 },
  };
  await expect(client.recipe(42)).rejects.toThrow("unsupported shape");
  const count = urls.length;
  await expect(client.recipe(-1)).rejects.toThrow("unsupported shape");
  expect(urls).toHaveLength(count);
  expect(urls.some((url) => url.includes("untrusted.invalid"))).toBe(false);
});

test("vendor sell prices come from the static Forever item route and validate identity and shape", async () => {
  let response: unknown = { id: 7001, name: "Invented Tonic", sell_price: 29 };
  const client = new BlizzardClient(
    { region: "us", locale: "en_US" },
    { clientId: "test", clientSecret: "test" },
    new HttpClient(async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/token"))
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      expect(url.pathname).toBe("/data/wow/item/7001");
      expect(url.searchParams.get("namespace")).toBe("static-forever-us");
      return Response.json(response);
    }),
  );
  expect(await client.itemVendor(7001)).toEqual({ id: 7001, sellCopper: 29 });
  response = { id: 7001, sell_price: 0 };
  expect(await client.itemVendor(7001)).toEqual({ id: 7001, sellCopper: 0 });
  // Missing sell_price is unknown, not zero.
  response = { id: 7001 };
  expect(await client.itemVendor(7001)).toEqual({ id: 7001 });
  response = { id: 7002, sell_price: 29 };
  await expect(client.itemVendor(7001)).rejects.toThrow("identity");
  response = { id: 7001, sell_price: -5 };
  await expect(client.itemVendor(7001)).rejects.toThrow("unsupported shape");
});
