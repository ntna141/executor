import { SignJWT } from "jose";
import { Data } from "effect";

const EXECUTOR_TOOL_ISSUER = "executor";
const EXECUTOR_TOOL_AUDIENCE = "spark-tools";
const MINIMUM_SECRET_LENGTH = 32;

class SparkToolsConfigurationError extends Data.TaggedError("SparkToolsConfigurationError")<{
  readonly message: string;
}> {}

interface SparkToolsBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface SparkToolsFetchOptions {
  readonly binding?: SparkToolsBinding;
  readonly origin: string;
  readonly secret: string;
  readonly accountId: string;
  readonly organizationId: string;
  readonly allowLocalNetwork?: boolean;
  readonly publicFetch?: typeof globalThis.fetch;
}

const isSparkRequest = (request: Request, origin: string): boolean => {
  if (!origin) return false;
  const url = new URL(request.url);
  return (
    url.origin === origin &&
    (url.pathname === "/executor/openapi.json" || url.pathname.startsWith("/executor/tools/"))
  );
};

const executorToolToken = async (options: SparkToolsFetchOptions): Promise<string> => {
  if (options.secret.length < MINIMUM_SECRET_LENGTH) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- Fetch adapter boundary must reject a misconfigured host before sending a request.
    throw new SparkToolsConfigurationError({
      message: "EXECUTOR_TO_SPARK_JWT_SECRET must contain at least 32 characters",
    });
  }
  return new SignJWT({ org: options.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(options.accountId)
    .setIssuer(EXECUTOR_TOOL_ISSUER)
    .setAudience(EXECUTOR_TOOL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(new TextEncoder().encode(options.secret));
};

export const makeSparkToolsFetch = (options: SparkToolsFetchOptions): typeof globalThis.fetch => {
  const publicFetch = options.publicFetch ?? globalThis.fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    if (!isSparkRequest(request, options.origin)) return publicFetch(request);
    if (!options.binding) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- Fetch adapter boundary must reject instead of leaking an internal call onto public HTTP.
      throw new SparkToolsConfigurationError({
        message: "SPARK_TOOLS service binding is not configured",
      });
    }

    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${await executorToolToken(options)}`);
    return options.binding.fetch(new Request(request, { headers }));
  };
};
