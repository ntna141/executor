import {
  AuthTemplateSlug,
  Context,
  definePlugin,
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  IntegrationAlreadyExistsError,
  IntegrationSlug,
  InternalError,
  OrgWriteDeniedError,
  type PluginCtx,
  Schema,
} from "@executor-js/sdk/core";
import { capture } from "@executor-js/api";

import { checkSlackAuth, invokeSlackTool, SlackApiError } from "./client";
import { SLACK_TOOL_DEFS } from "./tools";

export const SLACK_USER_OAUTH_SCOPES = [
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:join",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "lists:read",
  "lists:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "reminders:read",
  "reminders:write",
  "search:read",
  "stars:read",
  "team:read",
  "usergroups:read",
  "users.profile:read",
  "users.profile:write",
  "users:read",
  "users:read.email",
] as const;

const SLACK = IntegrationSlug.make("slack");
const OAUTH = AuthTemplateSlug.make("oauth2");

const AddSlackResult = Schema.Struct({ slug: Schema.String });
const IntegrationAlreadyExists = IntegrationAlreadyExistsError.annotate({ httpApiStatus: 409 });

const SlackApi = HttpApiGroup.make("slack").add(
  HttpApiEndpoint.post("addIntegration", "/slack/integrations", {
    success: AddSlackResult,
    error: [InternalError, IntegrationAlreadyExists, OrgWriteDeniedError],
  }),
);

const SlackApiBundle = HttpApi.make("slack-api").add(SlackApi);

const makeSlackExtension = (ctx: PluginCtx<Record<string, never>>) => ({
  seed: () =>
    ctx.core.integrations
      .register({
        slug: SLACK,
        name: "Slack",
        description: "Search, read, and manage Slack conversations and workspace content.",
        config: { scopes: SLACK_USER_OAUTH_SCOPES },
        canRemove: false,
        canRefresh: true,
      })
      .pipe(Effect.as({ slug: String(SLACK) })),
});

type SlackExtension = ReturnType<typeof makeSlackExtension>;

export class SlackExtensionService extends Context.Service<SlackExtensionService, SlackExtension>()(
  "SlackExtensionService",
) {}

const SlackHandlers = HttpApiBuilder.group(SlackApiBundle, "slack", (handlers) =>
  handlers.handle("addIntegration", () =>
    capture(
      Effect.gen(function* () {
        const slack = yield* SlackExtensionService;
        return yield* slack.seed();
      }),
    ),
  ),
);

export const slackPlugin = definePlugin(() => ({
  id: "slack" as const,
  storage: () => ({}) as Record<string, never>,

  integrationPresets: [
    {
      id: "slack",
      name: "Slack",
      summary: "Search, read, and manage Slack conversations and workspace content.",
      url: "https://slack.com",
      featured: true,
      defaultSlug: "slack",
    },
  ],

  extension: makeSlackExtension,

  routes: () => SlackApi,
  handlers: () => SlackHandlers,
  extensionService: SlackExtensionService,

  describeAuthMethods: () => [
    {
      id: String(OAUTH),
      label: "Slack OAuth",
      kind: "oauth" as const,
      template: String(OAUTH),
      oauth: {
        authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.user.access",
        scopes: SLACK_USER_OAUTH_SCOPES,
      },
    },
  ],

  describeIntegrationDisplay: () => ({ url: "https://slack.com", family: "slack" }),

  resolveTools: () => Effect.succeed({ tools: SLACK_TOOL_DEFS }),

  invokeTool: ({ ctx, toolRow, credential, args }) => {
    if (credential.value === null) {
      return Effect.fail(
        new SlackApiError({ method: String(toolRow.name), code: "missing_access_token" }),
      );
    }
    return invokeSlackTool(String(toolRow.name), args, credential.value, ctx.httpClientLayer);
  },

  listHealthCheckCandidates: () =>
    Effect.succeed([
      {
        operation: "auth.test",
        method: "post",
        requiredArgCount: 0,
        destructive: false,
        summary: "Verify the Slack token and identify its workspace and user.",
      },
    ]),

  checkHealth: ({ ctx, credential }) => {
    if (credential.value === null) {
      return Effect.succeed({
        status: "expired" as const,
        checkedAt: Date.now(),
        detail: "Missing access token",
      });
    }
    return checkSlackAuth(credential.value, ctx.httpClientLayer).pipe(
      Effect.map((result) => ({
        status: "healthy" as const,
        checkedAt: Date.now(),
        identity: [result.user, result.team]
          .filter((value): value is string => typeof value === "string")
          .join(" @ "),
      })),
      Effect.catch((error) =>
        Effect.succeed({
          status: ["invalid_auth", "token_expired", "token_revoked", "account_inactive"].includes(
            error.code,
          )
            ? ("expired" as const)
            : ("degraded" as const),
          checkedAt: Date.now(),
          detail: error.code,
        }),
      ),
    );
  },
}));

export default slackPlugin;
