import { Effect, Layer } from "effect";

import {
  CodeExecutorProvider,
  DbProvider,
  dbProviderLayer,
  EngineDecorator,
  EngineDecoratorNoop,
  HostConfig,
  PluginsProvider,
  type ExecutorDbHandle,
} from "@executor-js/api/server";
import { makeDynamicWorkerExecutor } from "@executor-js/runtime-dynamic-worker";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { env } from "cloudflare:workers";

import type { CloudflareConfig } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { makeSparkToolsFetch } from "./spark-tools";
import { loadedSparkTools, preloadSparkTools } from "./spark-tools-plugin";

// ---------------------------------------------------------------------------
// Cloudflare execution-stack seams — the same shape as self-host (QuickJS code
// substrate, no-op engine decorator), with the plugins + host config built from
// the per-request `env`-derived config rather than process.env.
//
// Code substrate: when the Worker declares a `worker_loaders` LOADER binding,
// use the dynamic-worker executor (cloud's substrate) — real isolates with
// `globalOutbound: null`. Without the binding, fall back to QuickJS-wasm,
// which runs in a single Worker with no extra binding.
// ---------------------------------------------------------------------------

export { makeExecutionStack } from "@executor-js/api/server";
export { EngineDecoratorNoop };

export const CloudflareCodeExecutorProvider: Layer.Layer<CodeExecutorProvider> = Layer.sync(
  CodeExecutorProvider,
  () => {
    const loader = (env as { LOADER?: WorkerLoader }).LOADER;
    return loader ? makeDynamicWorkerExecutor({ loader }) : makeQuickJsExecutor();
  },
);

const sparkToolsBinding = (): Fetcher | undefined => (env as { SPARK_TOOLS?: Fetcher }).SPARK_TOOLS;

/**
 * Loads Spark's tool document once per isolate. Must run before the plugin
 * list is built (app boot, and the MCP session DO next to `preloadQuickJs`)
 * because the plugin seam is synchronous. The document is public, so it is
 * read through the service binding when bound and the public origin otherwise.
 */
export const preloadSparkToolCatalog = (config: CloudflareConfig): Promise<unknown> => {
  if (!config.sparkToolsOrigin) return Promise.resolve([]);
  const binding = sparkToolsBinding();
  return preloadSparkTools({
    origin: config.sparkToolsOrigin,
    fetch: (input) => (binding ? binding.fetch(input) : fetch(input)),
  });
};

export const makeCloudflarePluginsProvider = (
  config: CloudflareConfig,
): Layer.Layer<PluginsProvider> =>
  Layer.succeed(PluginsProvider)({
    plugins: (context) => {
      const identity =
        context?.accountId && context.organizationId
          ? {
              accountId: context.accountId,
              organizationId: context.organizationId,
            }
          : undefined;
      return makeCloudflarePlugins(config.secretKey, {
        activeToolkitSlug:
          context?.mcpResource?.kind === "toolkit" ? context.mcpResource.slug : undefined,
        allowLocalNetwork: config.allowLocalNetwork,
        sparkTools: {
          origin: config.sparkToolsOrigin,
          definitions: loadedSparkTools(),
          fetch:
            identity && config.sparkToolsOrigin
              ? makeSparkToolsFetch({
                  binding: sparkToolsBinding(),
                  origin: config.sparkToolsOrigin,
                  secret: config.executorToSparkJwtSecret,
                  allowLocalNetwork: config.allowLocalNetwork,
                  ...identity,
                })
              : undefined,
        },
      });
    },
  });

export const makeCloudflareHostConfig = (config: CloudflareConfig): Layer.Layer<HostConfig> =>
  Layer.succeed(HostConfig)({
    allowLocalNetwork: config.allowLocalNetwork,
    webBaseUrl: config.webBaseUrl,
    oauthCallbackPath: "/api/oauth/callback",
    firstPartyOAuthClients: config.firstPartyOAuthClients,
  });

/**
 * The five execution-stack seams the shared `makeExecutionStack` reads from,
 * bundled into one Layer over the long-lived D1 handle. Mirrors self-host's
 * `SelfHostExecutionStackLayer`. The HTTP path wires these seams individually
 * through `ExecutorApp.make`; the MCP session store provides this whole Layer to
 * build a per-session engine off the envelope's request pipeline.
 */
export const makeCloudflareExecutionStackLayer = (
  config: CloudflareConfig,
  dbHandle: ExecutorDbHandle,
): Layer.Layer<
  DbProvider | PluginsProvider | HostConfig | CodeExecutorProvider | EngineDecorator
> =>
  Layer.mergeAll(
    dbProviderLayer(Effect.succeed(dbHandle)),
    makeCloudflarePluginsProvider(config),
    makeCloudflareHostConfig(config),
    CloudflareCodeExecutorProvider,
    EngineDecoratorNoop,
  );
