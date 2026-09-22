import { IntegrationSlug, type FirstPartyOAuthClientConfig } from "@executor-js/sdk";

// ---------------------------------------------------------------------------
// Host-operated OAuth apps. With one tenant per Spark user there is no shared
// catalog an operator could register an app into, so the apps users connect
// through are declared here from Wrangler secrets — the same mechanism
// upstream cloud uses (apps/cloud/src/engine/first-party-oauth-clients.ts).
// They exist in every tenant with no stored row, and rotating a secret is an
// env change. A user's own dynamic registrations still live in their tenant.
// ---------------------------------------------------------------------------

export interface FirstPartyOAuthClientEnv {
  readonly FIRST_PARTY_SLACK_CLIENT_ID?: string;
  readonly FIRST_PARTY_SLACK_CLIENT_SECRET?: string;
}

export const SLACK_USER_OAUTH_SCOPES = [
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read",
  "users:read",
  "users:read.email",
] as const;

const client = (
  clientId: string | undefined,
  clientSecret: string | undefined,
  config: Omit<FirstPartyOAuthClientConfig, "clientId" | "clientSecret">,
): readonly FirstPartyOAuthClientConfig[] => {
  const id = clientId?.trim();
  const secret = clientSecret?.trim();
  return id && secret ? [{ ...config, clientId: id, clientSecret: secret }] : [];
};

export const firstPartyOAuthClientsFromEnv = (
  env: FirstPartyOAuthClientEnv,
): readonly FirstPartyOAuthClientConfig[] => [
  // Slack's hosted MCP server is limited to Marketplace-listed apps, so Spark
  // connects Slack through the Web API instead: the user-token authorize
  // endpoint mints a user token for whichever workspace the user picks, and the
  // `slack` integration is an OpenAPI description of the Web API.
  ...client(env.FIRST_PARTY_SLACK_CLIENT_ID, env.FIRST_PARTY_SLACK_CLIENT_SECRET, {
    name: "slack",
    authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.user.access",
    integrations: [IntegrationSlug.make("slack")],
    allowedScopes: SLACK_USER_OAUTH_SCOPES,
  }),
];
