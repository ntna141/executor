import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";
import type { AuthenticationInput } from "./types";

const encodeJsonText = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const slackLikeSpec = encodeJsonText({
  openapi: "3.0.0",
  info: { title: "Slack Web API", version: "1.7.0" },
  servers: [{ url: "https://slack.com/api" }],
  paths: {
    "/search.messages": {
      get: {
        operationId: "search.searchMessages",
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            description: "Authentication token. Requires scope: `search:read`",
            schema: { type: "string" },
          },
          {
            name: "query",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const oauthTemplate: AuthenticationInput = {
  slug: AuthTemplateSlug.make("oauth"),
  kind: "oauth2",
  authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.user.access",
  scopes: ["search:read"],
};

const setup = (integration: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [openApiPlugin(), memoryCredentialsPlugin()] as const }),
    );
    yield* executor.openapi.addSpec({
      spec: { kind: "blob", value: slackLikeSpec },
      slug: integration,
      authenticationTemplate: [oauthTemplate],
    });
    yield* executor.connections.create({
      owner: "org",
      name: ConnectionName.make("main"),
      integration: IntegrationSlug.make(integration),
      template: AuthTemplateSlug.make("oauth"),
      value: "stored-oauth-token",
    });
    return executor;
  });

describe("Slack OpenAPI normalization", () => {
  it.effect("removes Slack's legacy query token from the tool contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* setup("slack");
        const tools = yield* executor.tools.list({
          integration: IntegrationSlug.make("slack"),
        });
        expect(tools).toHaveLength(1);
        const schema = yield* executor.tools.schema(tools[0]!.address);
        expect(schema).not.toBeNull();
        const input = schema?.inputSchema as { readonly properties?: Record<string, unknown> };
        const properties = input.properties ?? {};
        expect(properties).toHaveProperty("query");
        expect(properties).not.toHaveProperty("token");
      }),
    ),
  );

  it.effect("does not remove the same parameter from another integration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* setup("slack_clone");
        const tools = yield* executor.tools.list({
          integration: IntegrationSlug.make("slack_clone"),
        });
        expect(tools).toHaveLength(1);
        const schema = yield* executor.tools.schema(tools[0]!.address);
        expect(schema).not.toBeNull();
        const input = schema?.inputSchema as { readonly properties?: Record<string, unknown> };
        const properties = input.properties ?? {};
        expect(properties).toHaveProperty("query");
        expect(properties).toHaveProperty("token");
      }),
    ),
  );
});
