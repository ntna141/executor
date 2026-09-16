import { Effect, Layer } from "effect";

import {
  AccountProvider,
  accountProviderMiddlewareLayer,
  type AccountHeaders,
} from "@executor-js/api/server";
import { AccountError, AccountUnauthorized } from "@executor-js/api";

import { makeIdentityVerifier } from "../auth/identity";
import type { CloudflareConfig } from "../config";

// ---------------------------------------------------------------------------
// Cloudflare AccountProvider — backs the shared `/account/*` surface the
// multiplayer shell reads. `me` reflects the same principal that the API and
// MCP gates resolve from the configured identity verifier.
//
// Host-managed: members, roles, and API keys live outside Executor. The shell
// hides the API-keys footer and
// shows no members page, so those methods are never reached from the UI; they
// return empty (reads) or a clear "managed by the host" error (writes)
// to satisfy the provider shape.
// ---------------------------------------------------------------------------

const NOT_IN_APP = "Managed by the host identity system, not in the app.";

export const cloudflareAccountProvider = (
  config: CloudflareConfig,
): Layer.Layer<AccountProvider> => {
  const { verify } = makeIdentityVerifier(config);

  // The provider gets raw headers; rebuild a minimal Request so `verify` can
  // read the configured bearer header (and honor the dev-auth bypass).
  const principalFrom = (headers: AccountHeaders) =>
    verify(new Request("https://internal.local/", { headers: new Headers(headers) }));

  const forbiddenWrite = Effect.fail(new AccountError({ message: NOT_IN_APP }));

  return Layer.succeed(AccountProvider)({
    me: (headers) =>
      principalFrom(headers).pipe(
        Effect.flatMap((principal) =>
          principal
            ? Effect.succeed({
                user: {
                  id: principal.accountId,
                  email: principal.email,
                  name: principal.name,
                  avatarUrl: principal.avatarUrl,
                },
                organization: {
                  id: principal.organizationId,
                  name: principal.organizationName,
                  slug: principal.organizationSlug ?? config.organizationSlug,
                },
              })
            : Effect.fail(new AccountUnauthorized()),
        ),
      ),
    listApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createApiKey: () => forbiddenWrite,
    revokeApiKey: () => forbiddenWrite,
    // Org-owned keys are a WorkOS concept; host-managed instances have no
    // credential store of their own to mint one from.
    listOrgApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createOrgApiKey: () => forbiddenWrite,
    revokeOrgApiKey: () => forbiddenWrite,
    listMembers: () => Effect.succeed({ members: [] }),
    listRoles: () => Effect.succeed({ roles: [] }),
    inviteMember: () => forbiddenWrite,
    removeMember: () => forbiddenWrite,
    updateMemberRole: () => forbiddenWrite,
    updateOrgName: () => forbiddenWrite,
  });
};

/** The per-request `AccountProvider` middleware (mounted under `/api`). */
export const cloudflareAccountMiddleware = (config: CloudflareConfig) =>
  accountProviderMiddlewareLayer(cloudflareAccountProvider(config));
