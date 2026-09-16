import { SignJWT } from "jose";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import type { CloudflareConfig } from "../config";
import { makeTrustedJwtVerifier } from "./trusted-jwt";

const secret = "trusted-jwt-test-secret-0123456789";
const key = new TextEncoder().encode(secret);

const config: CloudflareConfig = {
  authMode: "trusted-jwt",
  accessTeamDomain: "",
  accessAud: "",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  sparkToExecutorJwtSecret: secret,
  trustedJwtIssuer: "spark",
  trustedJwtAudience: "spark-executor",
  trustedJwtOrganizationClaim: "org",
  sparkToolsOrigin: "",
  executorToSparkJwtSecret: "",
  adminEmails: [],
  organizationId: "spark",
  organizationName: "Spark",
  organizationSlug: "spark",
  secretKey: "x".repeat(32),
  allowLocalNetwork: false,
  webBaseUrl: "https://executor.example.com",
  enableDevAuth: false,
};

const token = (overrides: Readonly<Record<string, unknown>> = {}) =>
  new SignJWT({ org: "org-1", ...overrides })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-1")
    .setIssuer("spark")
    .setAudience("spark-executor")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

const requestWith = (value: string) =>
  new Request("https://executor.internal/mcp", {
    headers: { authorization: `Bearer ${value}` },
  });

describe("makeTrustedJwtVerifier", () => {
  it.effect("maps signed Spark identity claims to an Executor principal", () =>
    Effect.gen(function* () {
      const signedToken = yield* Effect.promise(() => token());
      const principal = yield* makeTrustedJwtVerifier(config).verify(requestWith(signedToken));

      expect(principal).toMatchObject({
        accountId: "user-1",
        organizationId: "org-1",
        roles: ["member"],
      });
    }),
  );

  it.effect("rejects a token for another audience", () =>
    Effect.gen(function* () {
      const wrongAudience = yield* Effect.promise(() =>
        new SignJWT({ org: "org-1" })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject("user-1")
          .setIssuer("spark")
          .setAudience("another-service")
          .setExpirationTime("5m")
          .sign(key),
      );

      const principal = yield* makeTrustedJwtVerifier(config).verify(requestWith(wrongAudience));

      expect(principal).toBeNull();
    }),
  );

  it.effect("uses the configured organization when the token has no organization claim", () =>
    Effect.gen(function* () {
      const signedToken = yield* Effect.promise(() => token({ org: undefined }));
      const principal = yield* makeTrustedJwtVerifier(config).verify(requestWith(signedToken));

      expect(principal).toMatchObject({
        accountId: "user-1",
        organizationId: "spark",
      });
    }),
  );
});
