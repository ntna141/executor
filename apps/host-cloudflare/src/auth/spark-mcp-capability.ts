import { base64url } from "jose";
import { Effect } from "effect";

import type { Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

export const SPARK_MCP_AUTH_VERSION = "v1";
export const SPARK_MCP_USER_ID_HEADER = "x-spark-user-id";
export const SPARK_MCP_CONVERSATION_ID_HEADER = "x-spark-conversation-id";
export const SPARK_MCP_KEY_ID_HEADER = "x-spark-key-id";

const BEARER_PREFIX = "Bearer ";
const MINIMUM_SECRET_LENGTH = 32;

export const sparkMcpCapabilitySignatureInput = (userId: string, conversationId: string): string =>
  `spark-executor-mcp\n${SPARK_MCP_AUTH_VERSION}\n${userId}\n${conversationId}`;

const sparkPrincipal = (userId: string, config: CloudflareConfig): Principal => ({
  kind: "member",
  accountId: userId,
  organizationId: config.organizationId,
  organizationName: config.organizationName,
  organizationSlug: config.organizationSlug,
  email: "",
  name: null,
  avatarUrl: null,
  roles: ["member"],
  // A conversation capability acts for one user and never administers the
  // workspace catalog.
  orgRoleModel: "organization",
  orgRole: "member",
});

export const makeSparkMcpCapabilityVerifier = (config: CloudflareConfig) => {
  const encoder = new TextEncoder();
  const secret = config.sparkToExecutorJwtSecret;
  const key =
    secret.length >= MINIMUM_SECRET_LENGTH
      ? crypto.subtle.importKey(
          "raw",
          encoder.encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        )
      : null;

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      const authorization = request.headers.get("authorization");
      const userId = request.headers.get(SPARK_MCP_USER_ID_HEADER)?.trim();
      const conversationId = request.headers.get(SPARK_MCP_CONVERSATION_ID_HEADER)?.trim();
      const keyId = request.headers.get(SPARK_MCP_KEY_ID_HEADER);
      if (
        !key ||
        !authorization?.startsWith(BEARER_PREFIX) ||
        !userId ||
        !conversationId ||
        keyId !== SPARK_MCP_AUTH_VERSION
      ) {
        return null;
      }

      const signature = authorization.slice(BEARER_PREFIX.length).trim();
      if (!signature) return null;

      const isValid = yield* Effect.tryPromise(async () => {
        const decoded = base64url.decode(signature);
        const signatureBytes = new Uint8Array(decoded.byteLength);
        signatureBytes.set(decoded);
        return crypto.subtle.verify(
          "HMAC",
          await key,
          signatureBytes,
          encoder.encode(sparkMcpCapabilitySignatureInput(userId, conversationId)),
        );
      }).pipe(Effect.orElseSucceed(() => false));

      return isValid ? sparkPrincipal(userId, config) : null;
    });

  return { verify };
};
