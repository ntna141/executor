import { jwtVerify, type JWTPayload } from "jose";
import { Effect } from "effect";

import type { Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

const BEARER_PREFIX = "Bearer ";

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Every Spark user is their own Executor tenant: the token's subject is both
 * the acting account and the organization id, so a user's catalog, added MCP
 * servers, OAuth clients, and connections are partitioned from every other
 * user's. There is no workspace to administer, so the role model is `none`
 * and the user may write anything inside their own tenant.
 *
 * Spark also signs `org` as the user id. It carries no extra information, but
 * a token whose `org` names anything else is a signer bug that would silently
 * land the user in a shared tenant, so it is refused rather than reconciled.
 */
export const principalFromTrustedJwtClaims = (
  claims: JWTPayload,
  config: CloudflareConfig,
): Principal | null => {
  const accountId = optionalString(claims.sub);
  if (!accountId || typeof claims.exp !== "number") return null;
  const org = optionalString(claims.org);
  if (org !== null && org !== accountId) return null;

  return {
    kind: "member",
    accountId,
    organizationId: accountId,
    organizationName: optionalString(claims.name) ?? accountId,
    organizationSlug: config.organizationSlug,
    email: optionalString(claims.email) ?? "",
    name: optionalString(claims.name),
    avatarUrl: null,
    roles: ["admin"],
    orgRoleModel: "none",
  };
};

export const makeTrustedJwtVerifier = (config: CloudflareConfig) => {
  const key = new TextEncoder().encode(config.sparkToExecutorJwtSecret);

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith(BEARER_PREFIX)) return null;
      const token = authorization.slice(BEARER_PREFIX.length).trim();
      if (!token) return null;

      const verified = yield* Effect.tryPromise(() =>
        jwtVerify(token, key, {
          algorithms: ["HS256"],
          issuer: config.trustedJwtIssuer,
          audience: config.trustedJwtAudience,
        }),
      ).pipe(Effect.orElseSucceed(() => null));
      return verified ? principalFromTrustedJwtClaims(verified.payload, config) : null;
    });

  return { verify };
};
