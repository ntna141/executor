import { Effect } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { dbProviderLayer, ExecutorApp, textFailureStrategy } from "@executor-js/api/server";

import { loadConfig, type CloudflareEnv } from "./config";
import { makeCloudflarePlugins } from "./plugins";
import { createD1ExecutorDb } from "./db/d1";
import { cloudflareIdentityLayer } from "./auth/identity";
import {
  CloudflareCodeExecutorProvider,
  makeCloudflareHostConfig,
  makeCloudflarePluginsProvider,
  preloadSparkToolCatalog,
} from "./execution";
import { ErrorCaptureLive } from "./observability";
import { cloudflareAccountMiddleware } from "./account/account-provider";
import { makeCloudflareApprovalHandler } from "./mcp";
import { makeCloudflareMcpAgentHandler } from "./mcp/agent-handler";
import { preloadQuickJs } from "./quickjs";

// ===========================================================================
// The Cloudflare host, as ONE `ExecutorApp.make` call: the 4th app alongside
// cloud / self-host / local, differing only by the injected Layers.
//
// The whole scenario in 60 seconds: the configured host verifier supplies the
// identity, D1 is the SQLite store (same FumaDB assembly as self-host), QuickJS
// is the in-process code substrate, and there is no billing. `diff` against
// host-selfhost/src/app.ts is three injected Layers: identity, db, plugins/config.
//
// Built per isolate (async) so the D1 schema bring-up happens once at first
// fetch; `env` arrives with that fetch (a Worker has no module-scope bindings),
// so the providers close over it instead of reading process.env.
// ===========================================================================

export const makeCloudflareApp = async (env: CloudflareEnv) => {
  const config = loadConfig(env);

  // Load the Workers-compatible (WASM-inlined) QuickJS variant before any
  // executor is built, the default variant cannot fetch its .wasm on Workers.
  // Spark's tool document is loaded the same way: the static Spark integration
  // is built from it and the plugin seam cannot await.
  await Promise.all([preloadQuickJs(), preloadSparkToolCatalog(config)]);
  const plugins = makeCloudflarePlugins(config.secretKey, {
    sparkTools: { origin: config.sparkToolsOrigin, definitions: [] },
  });

  // Open and idempotently bring up the D1 schema once. This is the long-lived
  // handle the per-request scoped executor reads through the DbProvider seam.
  const dbHandle = await createD1ExecutorDb(env.DB, env.BLOBS);
  const identityLayer = cloudflareIdentityLayer(config);
  const mcpAgentHandler = makeCloudflareMcpAgentHandler(config);
  const approvalHandler = makeCloudflareApprovalHandler(config, env);

  const { appLayer, toWebHandler } = ExecutorApp.make({
    plugins,
    providers: {
      identity: identityLayer,
      db: dbProviderLayer(Effect.succeed(dbHandle)),
      engine: { codeExecutor: CloudflareCodeExecutorProvider },
      plugins: {
        provider: makeCloudflarePluginsProvider(config),
        config: makeCloudflareHostConfig(config),
      },
      errorCapture: ErrorCaptureLive,
      // The account API (`/api/account/*`) backs the shared multiplayer shell's
      // auth context; `me` reflects the verified principal. Members/keys are
      // host-managed, so the rest of the surface is stubbed.
      account: cloudflareAccountMiddleware(config),
    },
    extensions: {
      routes: [
        // Browser approval of paused MCP executions: the console resume page
        // reads paused detail (GET) and records the decision (POST .../resume),
        // Identity-gated, routed to the owning session's Durable Object.
        HttpRouter.add("*", "/api/mcp-sessions/*", HttpEffect.fromWebHandler(approvalHandler)),
      ],
    },
    config: { mountPrefix: "/api", failure: textFailureStrategy },
    boot: identityLayer,
  });

  return { appLayer, toWebHandler, mcpAgentHandler };
};
