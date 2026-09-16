import { base64url } from "jose";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import type { CloudflareConfig } from "../config";
import {
  makeSparkMcpCapabilityVerifier,
  sparkMcpCapabilitySignatureInput,
  SPARK_MCP_AUTH_VERSION,
  SPARK_MCP_CONVERSATION_ID_HEADER,
  SPARK_MCP_KEY_ID_HEADER,
  SPARK_MCP_USER_ID_HEADER,
} from "./spark-mcp-capability";

const secret = "spark-mcp-capability-test-secret-0123456789";

const config: CloudflareConfig = {
  authMode: "trusted-jwt",
  accessTeamDomain: "",
  accessAud: "",
  accessNameClaim: "name",
  accessGroupsClaim: "groups",
  sparkToExecutorJwtSecret: secret,
  trustedJwtIssuer: "spark",
  trustedJwtAudience: "spark-executor",
  firstPartyOAuthClients: [],
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

const capabilityRequest = async (userId: string, conversationId: string): Promise<Request> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sparkMcpCapabilitySignatureInput(userId, conversationId)),
  );
  return new Request("https://executor.example.com/mcp", {
    headers: {
      authorization: `Bearer ${base64url.encode(new Uint8Array(signature))}`,
      [SPARK_MCP_USER_ID_HEADER]: userId,
      [SPARK_MCP_CONVERSATION_ID_HEADER]: conversationId,
      [SPARK_MCP_KEY_ID_HEADER]: SPARK_MCP_AUTH_VERSION,
    },
  });
};

describe("makeSparkMcpCapabilityVerifier", () => {
  it.effect("accepts a valid conversation capability", () =>
    Effect.gen(function* () {
      const request = yield* Effect.promise(() => capabilityRequest("user-1", "conversation-1"));
      const principal = yield* makeSparkMcpCapabilityVerifier(config).verify(request);

      expect(principal).toMatchObject({
        accountId: "user-1",
        organizationId: "user-1",
        orgRoleModel: "none",
      });
    }),
  );

  it.effect("rejects a capability copied to another conversation", () =>
    Effect.gen(function* () {
      const original = yield* Effect.promise(() => capabilityRequest("user-1", "conversation-1"));
      const headers = new Headers(original.headers);
      headers.set(SPARK_MCP_CONVERSATION_ID_HEADER, "conversation-2");
      const request = new Request(original, { headers });
      const principal = yield* makeSparkMcpCapabilityVerifier(config).verify(request);

      expect(principal).toBeNull();
    }),
  );
});
