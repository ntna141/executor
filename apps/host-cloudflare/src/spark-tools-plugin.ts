import { Data, Effect, Option, Schema } from "effect";

import {
  definePlugin,
  ElicitationId,
  tool,
  UrlElicitation,
  type Elicit,
  type StaticToolSchema,
} from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// Spark tools as a STATIC integration.
//
// Spark's own tools (notes, todos, contacts, calendar, email, maps, artifacts)
// are the same for every user and need no credential: the acting user is
// identified by the JWT the fork signs on every call (spark-tools.ts). With one
// Executor tenant per Spark user, storing them as a per-tenant OpenAPI
// integration would mean a copy of the spec and a connection row in every
// tenant, seeded before the agent can start. A static integration is the
// shape Executor uses for its own built-in tools: contributed by a plugin,
// present in every tenant, no rows, no connection, no seeding.
//
// The tool list is Spark's OpenAPI document (`/executor/openapi.json`), loaded
// once per isolate before the plugin list is built — the plugin seam is
// synchronous, so the catalog has to be in memory by then. Every operation is
// `POST /executor/tools/<name>` with a JSON body, so a tool is (name,
// description, body schema) and its handler is that request.
// ---------------------------------------------------------------------------

export const SPARK_INTEGRATION_ID = "spark";
export const SPARK_OPENAPI_PATH = "/executor/openapi.json";
export const SPARK_TOOL_PATH_PREFIX = "/executor/tools/";

export interface SparkToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export class SparkToolError extends Data.TaggedError("SparkToolError")<{
  readonly tool: string;
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

class SparkToolCatalogError extends Data.TaggedError("SparkToolCatalogError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJsonValue = Schema.decodeUnknownOption(JsonValue);
const ErrorBody = Schema.Struct({ error: Schema.String });
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

/** A Spark tool result that asks the user to visit a URL (the authorization
 *  flow). The handler raises it as a URL elicitation: the execution pauses,
 *  Spark shows the card on the phone, and the callback resumes it. */
const UrlRequestBody = Schema.Struct({
  kind: Schema.Literal("url"),
  message: Schema.String,
  url: Schema.String,
});
const decodeUrlRequest = Schema.decodeUnknownOption(UrlRequestBody);

// ---------------------------------------------------------------------------
// OpenAPI document -> tool definitions
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestBodySchema = (operation: Readonly<Record<string, unknown>>) => {
  const body = operation.requestBody;
  if (!isRecord(body) || !isRecord(body.content)) return null;
  const json = body.content["application/json"];
  return isRecord(json) && isRecord(json.schema) ? json.schema : null;
};

/** Reads Spark's document into tool definitions. Operations that are not the
 *  `POST /executor/tools/<name>` shape are skipped rather than guessed at. */
export const sparkToolDefinitionsFromOpenApi = (
  document: unknown,
): readonly SparkToolDefinition[] => {
  if (!isRecord(document) || !isRecord(document.paths)) return [];
  const definitions: SparkToolDefinition[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith(SPARK_TOOL_PATH_PREFIX) || !isRecord(item)) continue;
    const operation = item.post;
    if (!isRecord(operation)) continue;
    const name = path.slice(SPARK_TOOL_PATH_PREFIX.length);
    if (name.length === 0 || name.includes("/")) continue;
    if (typeof operation.operationId === "string" && operation.operationId !== name) continue;
    const description =
      typeof operation.description === "string"
        ? operation.description
        : typeof operation.summary === "string"
          ? operation.summary
          : name;
    definitions.push({
      name,
      description,
      inputSchema: requestBodySchema(operation) ?? { type: "object", additionalProperties: true },
    });
  }
  return definitions;
};

// ---------------------------------------------------------------------------
// Per-isolate catalog. Loaded before the plugin list is built (app boot and
// the MCP session DO, next to `preloadQuickJs`); a failed load is not cached
// so the next boot path retries instead of pinning an empty catalog.
// ---------------------------------------------------------------------------

export interface SparkToolCatalogSource {
  readonly origin: string;
  readonly fetch: (input: string) => Promise<Response>;
}

let loaded: readonly SparkToolDefinition[] | null = null;
let loading: Promise<readonly SparkToolDefinition[]> | null = null;

const fetchCatalog = (
  source: SparkToolCatalogSource,
): Effect.Effect<readonly SparkToolDefinition[], SparkToolCatalogError> =>
  Effect.tryPromise({
    try: () => source.fetch(`${source.origin}${SPARK_OPENAPI_PATH}`),
    catch: (cause) => new SparkToolCatalogError({ message: "request failed", cause }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) => new SparkToolCatalogError({ message: "document is not JSON", cause }),
          })
        : Effect.fail(
            new SparkToolCatalogError({ message: `document returned ${response.status}` }),
          ),
    ),
    Effect.map(sparkToolDefinitionsFromOpenApi),
  );

export const preloadSparkTools = (
  source: SparkToolCatalogSource,
): Promise<readonly SparkToolDefinition[]> => {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = Effect.runPromise(
      fetchCatalog(source).pipe(
        Effect.tap((definitions) =>
          Effect.sync(() => {
            loaded = definitions;
          }),
        ),
        Effect.catchTag("SparkToolCatalogError", (error) =>
          Effect.logError(
            "Spark tools document could not be loaded; Spark tools are unavailable",
            error,
          ).pipe(Effect.as([] as readonly SparkToolDefinition[])),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            loading = null;
          }),
        ),
      ),
    );
  }
  return loading;
};

/** The catalog as of the last successful preload; empty until then. */
export const loadedSparkTools = (): readonly SparkToolDefinition[] => loaded ?? [];

/** Test seam. */
export const resetSparkToolCatalog = (): void => {
  loaded = null;
  loading = null;
};

// ---------------------------------------------------------------------------
// JSON schema as a Standard Schema. Validation is delegated to Spark, which
// answers 400 with issues; the schema here only describes the input to agents.
// ---------------------------------------------------------------------------

const jsonSchemaStandard = (schema: Readonly<Record<string, unknown>>): StaticToolSchema => ({
  "~standard": {
    version: 1,
    vendor: "spark",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({ ...schema }),
      output: () => ({ ...schema }),
    },
  },
});

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export interface SparkToolsPluginOptions {
  readonly origin: string;
  readonly definitions: readonly SparkToolDefinition[];
  /** Fetch bound to the acting user (spark-tools.ts). Absent for callers with
   *  no identity, which then see no Spark tools. */
  readonly fetch?: typeof globalThis.fetch;
}

const callSparkTool = (
  options: SparkToolsPluginOptions,
  fetch: typeof globalThis.fetch,
  name: string,
  args: unknown,
): Effect.Effect<unknown, SparkToolError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${options.origin}${SPARK_TOOL_PATH_PREFIX}${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(isRecord(args) ? args : {}),
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    },
    catch: (cause) =>
      new SparkToolError({ tool: name, status: 0, message: "request failed", cause }),
  }).pipe(
    Effect.flatMap(({ status, ok, text }) => {
      // Spark answers JSON; a non-JSON body is kept verbatim so the failure
      // still carries what came back.
      const body = Option.getOrElse(decodeJsonValue(text), () => text);
      if (ok) return Effect.succeed(body);
      const message = Option.match(decodeErrorBody(body), {
        onNone: () => `Spark tool ${name} failed with ${status}`,
        onSome: ({ error }) => error,
      });
      return Effect.fail(new SparkToolError({ tool: name, status, message }));
    }),
  );

/** Result of a Spark tool that paused for the user: after the accept, the
 *  tool reports what the user did rather than the URL again. */
const raiseUrlRequest = (elicit: Elicit, result: unknown): Effect.Effect<unknown> =>
  Option.match(decodeUrlRequest(result), {
    onNone: () => Effect.succeed(result),
    onSome: (request) =>
      elicit(
        UrlElicitation.make({
          message: request.message,
          url: request.url,
          elicitationId: ElicitationId.make(crypto.randomUUID()),
        }),
      ).pipe(
        Effect.map(() => ({ completed: true, message: request.message })),
        Effect.catchTag("ElicitationDeclinedError", () =>
          Effect.succeed({ completed: false, message: request.message }),
        ),
      ),
  });

export const sparkToolsPlugin = definePlugin(
  (
    options: SparkToolsPluginOptions = {
      origin: "",
      definitions: [],
    },
  ) => ({
    id: "spark-tools" as const,
    packageName: "@executor-js/host-cloudflare/spark-tools",
    storage: () => ({}),
    extension: () => ({}),

    staticIntegrations: () => {
      const fetch = options.fetch;
      if (!fetch || !options.origin || options.definitions.length === 0) return [];
      return [
        {
          id: SPARK_INTEGRATION_ID,
          kind: "spark",
          name: "Spark",
          url: options.origin,
          canRemove: false,
          canRefresh: false,
          canEdit: false,
          tools: options.definitions.map((definition) =>
            tool({
              name: definition.name,
              description: definition.description,
              inputSchema: jsonSchemaStandard(definition.inputSchema),
              execute: (args, { elicit }) =>
                callSparkTool(options, fetch, definition.name, args).pipe(
                  Effect.flatMap((result) => raiseUrlRequest(elicit, result)),
                ),
            }),
          ),
        },
      ];
    },
  }),
);
