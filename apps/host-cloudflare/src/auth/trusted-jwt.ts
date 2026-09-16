import { jwtVerify, type JWTPayload } from "jose";
import { Effect } from "effect";

import type { Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

const BEARER_PREFIX = "Bearer ";

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export const principalFromTrustedJwtClaims = (
  claims: JWTPayload,
  config: CloudflareConfig,
): Principal | null => {
  const accountId = optionalString(claims.sub);
  const organizationId =
    optionalString(claims[config.trustedJwtOrganizationClaim]) ?? config.organizationId;
  if (!accountId || typeof claims.exp !== "number") return null;

  return {
    kind: "member",
    accountId,
    organizationId,
    organizationName: optionalString(claims.org_name) ?? organizationId,
    organizationSlug: optionalString(claims.org_slug) ?? config.organizationSlug,
    email: optionalString(claims.email) ?? "",
    name: optionalString(claims.name),
    avatarUrl: null,
    roles: ["member"],
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
