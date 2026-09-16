import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  loadedSparkTools,
  preloadSparkTools,
  resetSparkToolCatalog,
  SparkToolError,
  sparkToolDefinitionsFromOpenApi,
  sparkToolsPlugin,
} from "./spark-tools-plugin";

const origin = "https://spark.example.com";
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const document = {
  openapi: "3.1.0",
  paths: {
    "/executor/tools/create_note": {
      post: {
        operationId: "create_note",
        description: "Create a note for the user.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { title: { type: "string" } } },
            },
          },
        },
      },
    },
    "/executor/tools/list_todos": {
      post: { operationId: "list_todos", summary: "List todos" },
    },
    "/executor/other": { post: { operationId: "other" } },
    "/executor/tools/mismatch": { post: { operationId: "renamed" } },
  },
};

describe("sparkToolDefinitionsFromOpenApi", () => {
  it("reads every POST /executor/tools/<name> operation and its body schema", () => {
    expect(sparkToolDefinitionsFromOpenApi(document)).toEqual([
      {
        name: "create_note",
        description: "Create a note for the user.",
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
      },
      {
        name: "list_todos",
        description: "List todos",
        inputSchema: { type: "object", additionalProperties: true },
      },
    ]);
    expect(sparkToolDefinitionsFromOpenApi(null)).toEqual([]);
  });
});

describe("preloadSparkTools", () => {
  afterEach(() => resetSparkToolCatalog());

  it("loads the catalog once and keeps it for the isolate", async () => {
    let fetches = 0;
    const source = {
      origin,
      fetch: async (input: string) => {
        fetches += 1;
        expect(input).toBe(`${origin}/executor/openapi.json`);
        return Response.json(document);
      },
    };

    expect(loadedSparkTools()).toEqual([]);
    await preloadSparkTools(source);
    await preloadSparkTools(source);

    expect(fetches).toBe(1);
    expect(loadedSparkTools().map((tool) => tool.name)).toEqual(["create_note", "list_todos"]);
  });

  it("does not pin an empty catalog after a failed load", async () => {
    let attempts = 0;
    const source = {
      origin,
      fetch: async () => {
        attempts += 1;
        return attempts === 1 ? new Response("down", { status: 503 }) : Response.json(document);
      },
    };

    expect(await preloadSparkTools(source)).toEqual([]);
    expect(loadedSparkTools()).toEqual([]);
    await preloadSparkTools(source);
    expect(loadedSparkTools()).toHaveLength(2);
  });
});

describe("sparkToolsPlugin", () => {
  const definitions = sparkToolDefinitionsFromOpenApi(document);

  const handlerFor = (name: string, fetch: typeof globalThis.fetch) => {
    const plugin = sparkToolsPlugin({ origin, definitions, fetch });
    const [integration] = plugin.staticIntegrations?.({}) ?? [];
    const tool = integration?.tools.find((candidate) => candidate.name === name);
    expect(tool).toBeDefined();
    return tool!;
  };

  it.effect("posts the arguments to Spark's tool route and returns the JSON result", () =>
    Effect.gen(function* () {
      let seen: { url: string; init?: RequestInit } | undefined;
      const tool = handlerFor("create_note", async (input, init) => {
        seen = { url: String(input), init };
        return Response.json({ id: "note-1" });
      });

      const result = yield* tool.handler({
        args: { title: "Hello" },
        ctx: {} as never,
        elicit: (() => Effect.void) as never,
      });

      expect(result).toEqual({ id: "note-1" });
      expect(seen?.url).toBe(`${origin}/executor/tools/create_note`);
      expect(seen?.init?.method).toBe("POST");
      expect(parseJson(String(seen?.init?.body))).toEqual({ title: "Hello" });
      expect(tool.inputSchema?.["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual(
        {
          type: "object",
          properties: { title: { type: "string" } },
        },
      );
    }),
  );

  it.effect("raises a url result as a URL elicitation and reports the outcome", () =>
    Effect.gen(function* () {
      const tool = handlerFor("create_note", async () =>
        Response.json({
          kind: "url",
          message: "Authorize linear",
          url: "https://linear.test/authorize",
        }),
      );
      const raised: unknown[] = [];
      const elicit = (request: unknown) => {
        raised.push(request);
        return Effect.succeed({ action: "accept" as const, content: {} });
      };

      const result = yield* tool.handler({ args: {}, ctx: {} as never, elicit: elicit as never });

      expect(result).toEqual({ completed: true, message: "Authorize linear" });
      expect(raised).toEqual([
        expect.objectContaining({
          _tag: "UrlElicitation",
          message: "Authorize linear",
          url: "https://linear.test/authorize",
        }),
      ]);
    }),
  );

  it.effect("fails with Spark's error message on a non-2xx answer", () =>
    Effect.gen(function* () {
      const tool = handlerFor("list_todos", async () =>
        Response.json({ error: "invalid tool input" }, { status: 400 }),
      );

      const failure = yield* Effect.flip(
        tool.handler({ args: {}, ctx: {} as never, elicit: (() => Effect.void) as never }),
      );

      expect(failure).toBeInstanceOf(SparkToolError);
      expect(failure).toMatchObject({
        tool: "list_todos",
        status: 400,
        message: "invalid tool input",
      });
    }),
  );
});
