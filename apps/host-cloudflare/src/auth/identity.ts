import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";
import { makeAccessVerifier } from "./cloudflare-access";
import { makeTrustedJwtVerifier } from "./trusted-jwt";

export const makeIdentityVerifier = (config: CloudflareConfig) =>
  !config.enableDevAuth && config.authMode === "trusted-jwt"
    ? makeTrustedJwtVerifier(config)
    : makeAccessVerifier(config);

export const cloudflareIdentityLayer = (
  config: CloudflareConfig,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeIdentityVerifier(config);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) =>
            principal ? Effect.succeed(principal) : Effect.fail(new Unauthorized()),
          ),
        ),
    }),
  );
};
