import { jwtVerify } from "jose";
import { describe, expect, it } from "@effect/vitest";

import { makeSparkToolsFetch } from "./spark-tools";
import { makeCloudflarePlugins } from "./plugins";

const secret = "spark-tools-test-secret-012345678901";
const origin = "https://spark.example.com";

describe("makeSparkToolsFetch", () => {
  it("adds Spark as a first-party OpenAPI preset", () => {
    const [openapi] = makeCloudflarePlugins("x".repeat(32), {
      sparkToolsOrigin: origin,
    });

    expect(openapi.integrationPresets).toContainEqual(
      expect.objectContaining({
        id: "spark-tools",
        url: `${origin}/executor/openapi.json`,
        defaultSlug: "spark",
      }),
    );
  });

  it("routes Spark tool requests through the binding with a user JWT", async () => {
    let forwarded: Request | undefined;
    const fetch = makeSparkToolsFetch({
      origin,
      secret,
      accountId: "user-1",
      organizationId: "spark",
      binding: {
        fetch: async (request) => {
          forwarded = new Request(request);
          return Response.json({ ok: true });
        },
      },
      publicFetch: async () => new Response("unexpected", { status: 500 }),
    });

    const response = await fetch(`${origin}/executor/tools/searchNotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe(`${origin}/executor/tools/searchNotes`);
    const authorization = forwarded?.headers.get("authorization");
    expect(authorization).toMatch(/^Bearer /);
    if (!authorization) return;
    const { payload } = await jwtVerify(
      authorization.slice("Bearer ".length),
      new TextEncoder().encode(secret),
      { algorithms: ["HS256"], issuer: "executor", audience: "spark-tools" },
    );
    expect(payload).toMatchObject({ sub: "user-1", org: "spark" });
  });

  it("leaves unrelated API requests on the public fetch path", async () => {
    let publicUrl = "";
    const fetch = makeSparkToolsFetch({
      origin,
      secret,
      accountId: "user-1",
      organizationId: "spark",
      publicFetch: async (request) => {
        publicUrl = new Request(request).url;
        return new Response(null, { status: 204 });
      },
    });

    const response = await fetch("https://api.example.com/items");

    expect(response.status).toBe(204);
    expect(publicUrl).toBe("https://api.example.com/items");
  });
});
