import { Effect, Layer } from "effect";

import {
  authenticated,
  McpAuthProvider,
  unauthorized,
  type McpDiscoveryRoute,
} from "@executor-js/host-mcp";

import { makeIdentityVerifier } from "../auth/identity";
import { makeSparkMcpCapabilityVerifier } from "../auth/spark-mcp-capability";
import type { CloudflareConfig } from "../config";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PROTECTED_RESOURCE_METADATA_PATH = `${PROTECTED_RESOURCE_METADATA_PATH}/mcp`;
const TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/:toolkitSlug`;

const toolkitSlugFromPath = (pathname: string): string | undefined => {
  const mcpPrefix = "/mcp/toolkits/";
  if (pathname.startsWith(mcpPrefix)) {
    const slug = pathname.slice(mcpPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  const metadataPrefix = `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/`;
  if (pathname.startsWith(metadataPrefix)) {
    const slug = pathname.slice(metadataPrefix.length).split("/", 1)[0];
    return slug ? decodeURIComponent(slug) : undefined;
  }
  return undefined;
};

const toolkitPath = (slug: string): string => `/mcp/toolkits/${encodeURIComponent(slug)}`;

const resourcePathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug ? toolkitPath(slug) : "/mcp";
};

const metadataPathForRequest = (request: Request): string => {
  const slug = toolkitSlugFromPath(new URL(request.url).pathname);
  return slug
    ? `${MCP_PROTECTED_RESOURCE_METADATA_PATH}/toolkits/${encodeURIComponent(slug)}`
    : MCP_PROTECTED_RESOURCE_METADATA_PATH;
};

const protectedResourceMetadataResponse = (request: Request): Response => {
  const url = new URL(request.url);
  return new Response(
    JSON.stringify({
      resource: new URL(resourcePathForRequest(request), url.origin).toString(),
      authorization_servers: [],
    }),
    { headers: { "content-type": "application/json" } },
  );
};

// ---------------------------------------------------------------------------
// Cloudflare McpAuthProvider — the `/mcp` gate, with the same identity as the
// API gate. Spark's WorkAgent can also present a persistent, conversation-bound
// capability so the Agents SDK can restore its MCP connection after hibernation.
//
// There is no MCP OAuth exchange here. The caller presents a JWT or a Spark MCP
// capability that the host already trusts. Protected-resource metadata exists
// for clients that probe for it, but it advertises no authorization server.
// ---------------------------------------------------------------------------

export const cloudflareMcpAuth = (config: CloudflareConfig): Layer.Layer<McpAuthProvider> => {
  const { verify: verifyIdentity } = makeIdentityVerifier(config);
  const { verify: verifySparkCapability } = makeSparkMcpCapabilityVerifier(config);
  const discoveryRoutes: ReadonlyArray<McpDiscoveryRoute> = [
    {
      path: PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: MCP_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
    {
      path: TOOLKIT_PROTECTED_RESOURCE_METADATA_PATH,
      handler: (request) => Effect.succeed(protectedResourceMetadataResponse(request)),
    },
  ];
  return Layer.succeed(McpAuthProvider)({
    discoveryRoutes,
    resourceMetadataUrl: (request) =>
      new URL(metadataPathForRequest(request), new URL(request.url).origin).toString(),
    authenticate: (request) =>
      verifySparkCapability(request).pipe(
        Effect.flatMap((principal) =>
          principal ? Effect.succeed(principal) : verifyIdentity(request),
        ),
        Effect.map((principal) => (principal ? authenticated(principal) : unauthorized())),
      ),
  });
};
