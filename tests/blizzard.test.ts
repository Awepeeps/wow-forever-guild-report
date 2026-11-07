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
