import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { parse } from "jsonc-parser";

import { loadConfig } from "./config";

type ConfigEnv = Parameters<typeof loadConfig>[0];

const makeEnv = (overrides: Partial<ConfigEnv> = {}): ConfigEnv => ({
  EXECUTOR_SECRET_KEY: "test-secret-key-0123456789abcdef",
  VITE_PUBLIC_SITE_URL: "https://executor.example.com",
  ...overrides,
});

describe("loadConfig", () => {
  it("rejects missing Cloudflare Access configuration outside local development", () => {
    expect(() => loadConfig(makeEnv())).toThrowError(
      "Executor authentication is not configured. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD before serving requests.",
    );
  });

  it("rejects the repository's former team-domain placeholder", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
          ACCESS_AUD: "aud-tag",
        }),
      ),
    ).toThrowError(
      "Executor authentication is not configured. Set ACCESS_TEAM_DOMAIN before serving requests.",
    );
  });

  it("allows local development to bypass Cloudflare Access", () => {
    expect(loadConfig(makeEnv({ ENABLE_DEV_AUTH: "true" }))).toMatchObject({
      accessTeamDomain: "",
      accessAud: "",
      enableDevAuth: true,
    });
  });

  it("allows local development to bypass trusted JWT authentication", () => {
    expect(
      loadConfig(makeEnv({ AUTH_MODE: "trusted-jwt", ENABLE_DEV_AUTH: "true" })),
    ).toMatchObject({
      authMode: "trusted-jwt",
      enableDevAuth: true,
    });
  });

  it("normalises configured Access values without requiring an administrator", () => {
    expect(
      loadConfig(
        makeEnv({
          ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
          ACCESS_AUD: " aud-tag ",
        }),
      ),
    ).toMatchObject({
      accessTeamDomain: "Team.cloudflareaccess.com",
      accessAud: "aud-tag",
      adminEmails: [],
      enableDevAuth: false,
    });
  });

  it("accepts trusted JWT authentication without Cloudflare Access", () => {
    expect(
      loadConfig(
        makeEnv({
          AUTH_MODE: "trusted-jwt",
          SPARK_TO_EXECUTOR_JWT_SECRET: "t".repeat(32),
          TRUSTED_JWT_ISSUER: "https://issuer.example.com",
          TRUSTED_JWT_AUDIENCE: "executor",
        }),
      ),
    ).toMatchObject({
      authMode: "trusted-jwt",
      trustedJwtIssuer: "https://issuer.example.com",
      trustedJwtAudience: "executor",
      firstPartyOAuthClients: [],
    });
  });

  it("rejects an incomplete trusted JWT configuration", () => {
    expect(() =>
      loadConfig(
        makeEnv({
          AUTH_MODE: "trusted-jwt",
          SPARK_TO_EXECUTOR_JWT_SECRET: "short",
        }),
      ),
    ).toThrowError(
      "Executor authentication is not configured. Set SPARK_TO_EXECUTOR_JWT_SECRET and TRUSTED_JWT_ISSUER and TRUSTED_JWT_AUDIENCE before serving requests.",
    );
  });
});

describe("Cloudflare deployment configuration", () => {
  it("selects trusted Spark JWTs without storing secrets in source", () => {
    const config = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      readonly keep_vars?: boolean;
      readonly services?: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly vars?: Readonly<Record<string, unknown>>;
    };

    expect(config.keep_vars).toBe(true);
    expect(config.vars).not.toHaveProperty("ACCESS_TEAM_DOMAIN");
    expect(config.vars).not.toHaveProperty("ACCESS_AUD");
    expect(config.vars).not.toHaveProperty("ADMIN_EMAILS");
    expect(config.vars).not.toHaveProperty("SPARK_TO_EXECUTOR_JWT_SECRET");
    expect(config.vars).not.toHaveProperty("EXECUTOR_TO_SPARK_JWT_SECRET");
    expect(config.vars).toHaveProperty("AUTH_MODE", "trusted-jwt");
    expect(config.vars).toHaveProperty("TRUSTED_JWT_ISSUER", "spark");
    expect(config.vars).toHaveProperty("TRUSTED_JWT_AUDIENCE", "spark-executor");
    expect(config.vars).toHaveProperty(
      "SPARK_TOOLS_ORIGIN",
      "https://cloudflare-chat-agent.ntna102.workers.dev",
    );
    expect(config.vars).toHaveProperty("ENABLE_DEV_AUTH", "false");
    expect(config.services).toContainEqual({
      binding: "SPARK_TOOLS",
      service: "cloudflare-chat-agent",
    });
  });
});
