import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { invokeSlackTool } from "./client";
import { SLACK_USER_OAUTH_SCOPES } from "./plugin";
import { SLACK_TOOL_DEFS } from "./tools";

const recordingLayer = (requests: Request[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        requests.push(web);
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }),
    ),
  );

describe("Slack plugin", () => {
  it("exposes the 38 Codex Slack tool names once", () => {
    const names = SLACK_TOOL_DEFS.map((tool) => String(tool.name));
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    expect(names).toContain("slack_search_public");
    expect(names).toContain("slack_search_public_and_private");
    expect(names).toContain("slack_send_message");
  });

  it("marks private search and mutations for approval", () => {
    const byName = new Map(SLACK_TOOL_DEFS.map((tool) => [String(tool.name), tool]));
    expect(byName.get("slack_search_public")?.annotations?.requiresApproval).not.toBe(true);
    expect(byName.get("slack_search_public_and_private")?.annotations?.requiresApproval).toBe(true);
    expect(byName.get("slack_send_message")?.annotations?.requiresApproval).toBe(true);
    expect(byName.get("slack_delete_message")?.annotations?.requiresApproval).toBe(true);
  });

  it("uses the resolved Executor OAuth token for Slack requests", async () => {
    const requests: Request[] = [];
    await Effect.runPromise(
      invokeSlackTool(
        "slack_add_reaction",
        { channel_id: "C123", emoji: "wave", message_ts: "123.456" },
        "xoxp-executor-token",
        recordingLayer(requests),
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://slack.com/api/reactions.add");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer xoxp-executor-token");
    await expect(requests[0]?.clone().json()).resolves.toEqual({
      channel: "C123",
      name: "wave",
      timestamp: "123.456",
    });
  });

  it("maps one public search tool call to one Slack search request", async () => {
    const requests: Request[] = [];
    await Effect.runPromise(
      invokeSlackTool(
        "slack_search_public",
        {
          filters: "from:alice",
          keywords: [],
          limit: 1,
          sort: "timestamp",
          sort_dir: "desc",
        },
        "xoxp-executor-token",
        recordingLayer(requests),
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    const url = new URL(requests[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/api/search.all");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      count: "1",
      highlight: "false",
      query: "from:alice",
      sort: "timestamp",
      sort_dir: "desc",
    });
  });

  it("declares the scopes needed by the copied read and write surface", () => {
    expect(SLACK_USER_OAUTH_SCOPES).toEqual(
      expect.arrayContaining([
        "canvases:read",
        "canvases:write",
        "files:read",
        "files:write",
        "lists:read",
        "lists:write",
        "search:read",
        "users.profile:write",
      ]),
    );
  });
});
