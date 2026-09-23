import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  googleCatalog,
  googleDiscoveryAdapter,
} from "@executor-js/plugin-openapi/providers/google";
import {
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { encryptedSecretsPlugin } from "@executor-js/plugin-encrypted-secrets";
import { slackPlugin } from "@executor-js/plugin-slack";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";

import { sparkToolsPlugin, type SparkToolsPluginOptions } from "./spark-tools-plugin";

// ---------------------------------------------------------------------------
// The Cloudflare host's plugin list — the same protocol/provider plugins as
// self-host (no WorkOS Vault). Built as a factory because the encrypted-secrets
// master key arrives via `env` at request time (no process.env on a Worker), so
// the plugin set is constructed per app-build with the resolved key. The tuple
// SHAPE (which drives the API + table set) is independent of the key value.
//
// `dangerouslyAllowStdioMCP` is false: a multi-user instance must not let a user
// spawn arbitrary stdio MCP processes.
//
// Spark's own tools are a STATIC integration (spark-tools-plugin.ts): present
// in every tenant with no rows, bound to the acting user through the signed
// fetch the provider passes in. The plugin is always in the tuple so the API
// and table shape never depend on whether an identity was available.
// ---------------------------------------------------------------------------

export const makeCloudflarePlugins = (
  secretKey: string,
  options: {
    readonly activeToolkitSlug?: string;
    readonly allowLocalNetwork?: boolean;
    readonly sparkTools?: SparkToolsPluginOptions;
  } = {},
) =>
  [
    openApiHttpPlugin({
      presets: [...googleCatalog, ...microsoftCatalog],
      specFormats: [googleDiscoveryAdapter, microsoftGraphAdapter],
    }),
    mcpHttpPlugin({ dangerouslyAllowStdioMCP: false }),
    graphqlHttpPlugin(),
    slackPlugin(),
    toolkitsPlugin({ activeToolkitSlug: options.activeToolkitSlug }),
    encryptedSecretsPlugin({ key: secretKey }),
    sparkToolsPlugin(options.sparkTools),
  ] as const;

export type CloudflarePlugins = ReturnType<typeof makeCloudflarePlugins>;
