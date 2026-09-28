import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { invokeSlackTool, slackToolFailure } from "./client";
import { SLACK_USER_OAUTH_SCOPES } from "./plugin";
import { SLACK_TOOL_DEFS } from "./tools";

type SlackReply = (request: Request) => unknown;

/** Records every Slack request and answers each API method from `replies`. */
const recordingLayer = (
  requests: Request[],
  replies: Record<string, SlackReply> = {},
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
        requests.push(web);
        const method = new URL(web.url).pathname.replace("/api/", "");
        const reply = replies[method];
        return HttpClientResponse.fromWeb(
          request,
          Response.json(reply ? reply(web) : { ok: true }),
        );
      }),
    ),
  );

const runTool = (name: string, args: unknown, replies: Record<string, SlackReply> = {}) => {
  const requests: Request[] = [];
  const result = Effect.runPromise(
    invokeSlackTool(name, args, "xoxp-executor-token", recordingLayer(requests, replies)).pipe(
      Effect.catch((error) => Effect.succeed(slackToolFailure(error, "user"))),
    ),
  );
  return { requests, result };
};

const usersById: Record<string, string> = { U0ALICE: "alice", U0BOB: "bob" };

const usersInfo: SlackReply = (request) => {
  const id = new URL(request.url).searchParams.get("user") ?? "";
  return { ok: true, user: { id, name: usersById[id] } };
};

const thumbnails = Object.fromEntries(
  [64, 80, 160, 360, 480, 720].map((size) => [
    `thumb_${size}`,
    `https://files.example/board_${size}.png`,
  ]),
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

  it("returns search matches as compact messages carrying the IDs thread reads take", async () => {
    const { result } = runTool(
      "slack_search_public_and_private",
      { keywords: ["board"] },
      {
        "search.all": () => ({
          ok: true,
          messages: {
            total: 42,
            matches: [
              {
                iid: "0f8c3a52-search-hit",
                team: "T0TEAM",
                score: 0,
                db_message: {},
                type: "message",
                user: "U0BOB",
                username: "bob",
                ts: "1790000100.000200",
                text: "Board rev B is in",
                permalink:
                  "https://example.slack.com/archives/C0HW/p1790000100000200?thread_ts=1790000000.000100",
                channel: {
                  id: "C0HW",
                  name: "hardware",
                  is_channel: true,
                  is_im: false,
                  is_private: true,
                  pending_shared: [],
                },
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      { type: "rich_text_section", elements: [{ type: "text", text: "Board" }] },
                    ],
                  },
                ],
                files: [
                  {
                    id: "F0PHOTO",
                    title: "board.png",
                    name: "board.png",
                    filetype: "png",
                    mimetype: "image/png",
                    url_private: "https://files.example/board.png",
                    ...thumbnails,
                  },
                ],
              },
              {
                type: "message",
                user: null,
                username: "linear",
                ts: "1790000200.000300",
                text: "",
                permalink: "https://example.slack.com/archives/C0PRODUCT/p1790000200000300",
                channel: { id: "C0PRODUCT", name: "product", is_im: false },
                attachments: [
                  {
                    id: 1,
                    color: "5e6ad2",
                    fallback: "ENG-7 Ship rev B",
                    blocks: [
                      { type: "section", text: { type: "mrkdwn", text: "*ENG-7* Ship rev B" } },
                      {
                        type: "context",
                        elements: [{ type: "mrkdwn", text: "Assigned to alice" }],
                      },
                      {
                        type: "actions",
                        elements: [{ type: "button", text: { type: "plain_text", text: "View" } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      },
    );

    await expect(result).resolves.toEqual({
      messages: [
        {
          channel_id: "C0HW",
          channel_name: "hardware",
          ts: "1790000100.000200",
          thread_ts: "1790000000.000100",
          user_id: "U0BOB",
          user_name: "bob",
          text: "Board rev B is in",
          files: [{ id: "F0PHOTO", name: "board.png", type: "png" }],
          permalink:
            "https://example.slack.com/archives/C0HW/p1790000100000200?thread_ts=1790000000.000100",
        },
        {
          channel_id: "C0PRODUCT",
          channel_name: "product",
          ts: "1790000200.000300",
          user_name: "linear",
          text: "",
          attachments: [{ text: "*ENG-7* Ship rev B\nAssigned to alice" }],
          permalink: "https://example.slack.com/archives/C0PRODUCT/p1790000200000300",
        },
      ],
      total: 42,
    });
  });

  it("cuts long search text to a marked snippet that a thread read returns in full", async () => {
    const longText = `Rev B plan: ${"step ".repeat(300)}`;
    const linearBody = `ENG-9 ${"detail ".repeat(200)}`;
    const message = {
      type: "message",
      user: "U0ALICE",
      username: "alice",
      ts: "1790000400.000500",
      text: longText,
      channel: { id: "C0HW", name: "hardware" },
      attachments: [{ fallback: "ENG-9", text: linearBody }],
    };
    const search = await runTool(
      "slack_search_public",
      { keywords: ["rev"] },
      { "search.all": () => ({ ok: true, messages: { total: 1, matches: [message] } }) },
    ).result;
    expect(search).toMatchObject({
      messages: [
        {
          text: `${longText.slice(0, 500)}…`,
          attachments: [{ text: `${linearBody.slice(0, 500)}…` }],
          truncated: true,
        },
      ],
    });

    const thread = await runTool(
      "slack_read_thread",
      { channel_id: "C0HW", message_ts: "1790000400.000500" },
      { "conversations.replies": () => ({ ok: true, has_more: false, messages: [message] }) },
    ).result;
    expect(thread).toMatchObject({
      messages: [{ text: longText, attachments: [{ text: linearBody }] }],
    });
    expect(thread).not.toHaveProperty("messages.0.truncated");
  });

  it("reads the whole thread a reply's permalink points into, naming each author", async () => {
    const { requests, result } = runTool(
      "slack_read_thread",
      {
        permalink:
          "https://example.slack.com/archives/C0HW/p1790000100000200?thread_ts=1790000000.000100",
      },
      {
        "conversations.replies": () => ({
          ok: true,
          has_more: false,
          messages: [
            {
              type: "message",
              user: "U0ALICE",
              ts: "1790000000.000100",
              thread_ts: "1790000000.000100",
              reply_count: 1,
              text: "When does rev B land?",
            },
            {
              type: "message",
              user: "U0BOB",
              ts: "1790000100.000200",
              thread_ts: "1790000000.000100",
              text: "Board rev B is in",
            },
          ],
        }),
        "users.info": usersInfo,
      },
    );

    await expect(result).resolves.toEqual({
      channel_id: "C0HW",
      thread_ts: "1790000000.000100",
      has_more: false,
      messages: [
        {
          channel_id: "C0HW",
          ts: "1790000000.000100",
          thread_ts: "1790000000.000100",
          reply_count: 1,
          user_id: "U0ALICE",
          user_name: "alice",
          text: "When does rev B land?",
        },
        {
          channel_id: "C0HW",
          ts: "1790000100.000200",
          thread_ts: "1790000000.000100",
          user_id: "U0BOB",
          user_name: "bob",
          text: "Board rev B is in",
        },
      ],
    });
    const replies = new URL(requests[0]?.url ?? "");
    expect(requests[0]?.method).toBe("GET");
    expect(replies.pathname).toBe("/api/conversations.replies");
    expect(Object.fromEntries(replies.searchParams)).toEqual({
      channel: "C0HW",
      ts: "1790000000.000100",
      limit: "100",
    });
  });

  it("reads channel history with author names and the cursor for the next page", async () => {
    const { result } = runTool(
      "slack_read_channel",
      { channel_id: "C0HW", limit: 2 },
      {
        "conversations.history": () => ({
          ok: true,
          has_more: true,
          response_metadata: { next_cursor: "bmV4dA==" },
          messages: [
            { type: "message", user: "U0ALICE", ts: "1790000300.000400", text: "Ship it" },
          ],
        }),
        "users.info": usersInfo,
      },
    );

    await expect(result).resolves.toEqual({
      channel_id: "C0HW",
      has_more: true,
      next_cursor: "bmV4dA==",
      messages: [
        {
          channel_id: "C0HW",
          ts: "1790000300.000400",
          user_id: "U0ALICE",
          user_name: "alice",
          text: "Ship it",
        },
      ],
    });
  });

  it("returns user search results without Slack's profile payload", async () => {
    const { result } = runTool(
      "slack_search_users",
      { query: "alice" },
      {
        "users.list": () => ({
          ok: true,
          members: [
            {
              id: "U0ALICE",
              name: "alice",
              real_name: "Alice Example",
              is_bot: false,
              tz: "America/Los_Angeles",
              profile: {
                display_name: "alice",
                title: "Hardware lead",
                email: "alice@example.com",
                image_512: "https://avatars.example/alice_512.png",
              },
            },
            { id: "U0BOB", name: "bob", real_name: "Bob Example", profile: {} },
          ],
        }),
      },
    );

    await expect(result).resolves.toEqual({
      users: [
        {
          id: "U0ALICE",
          name: "alice",
          real_name: "Alice Example",
          display_name: "alice",
          title: "Hardware lead",
          email: "alice@example.com",
          is_bot: false,
        },
      ],
    });
  });

  it("returns Slack's reason when Slack rejects a call", async () => {
    const { result } = runTool(
      "slack_read_thread",
      { channel_id: "C0HW", message_ts: "1790000000.000100" },
      {
        "conversations.replies": () => ({
          ok: false,
          error: "invalid_arguments",
          response_metadata: { messages: ["[ERROR] invalid value for `ts`"] },
        }),
      },
    );

    const failure = await result;
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: "invalid_arguments",
        details: { method: "conversations.replies", messages: ["[ERROR] invalid value for `ts`"] },
      },
    });
    expect(failure).toHaveProperty(
      "error.message",
      expect.stringContaining("[ERROR] invalid value for `ts`"),
    );
  });

  it("fails a thread read that names no message without calling Slack", async () => {
    const { requests, result } = runTool("slack_read_thread", { channel_id: "C0HW" });

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(requests).toHaveLength(0);
  });

  it("asks for a reconnect only when Slack rejects the token", async () => {
    const revoked = await runTool(
      "slack_search_users",
      { query: "alice" },
      { "users.list": () => ({ ok: false, error: "token_revoked" }) },
    ).result;
    expect(revoked).toMatchObject({
      ok: false,
      error: {
        code: "connection_rejected",
        status: 401,
        details: { category: "authentication", integration: { id: "slack", scope: "user" } },
      },
    });

    const narrow = await runTool(
      "slack_read_user_profile",
      {},
      {
        "users.profile.get": () => ({
          ok: false,
          error: "missing_scope",
          needed: "users.profile:read",
          provided: "search:read",
        }),
      },
    ).result;
    expect(narrow).toMatchObject({
      ok: false,
      error: {
        code: "missing_scope",
        details: { method: "users.profile.get", needed: "users.profile:read" },
      },
    });
    expect(narrow).not.toHaveProperty("error.details.category");
    expect(narrow).toHaveProperty("error.message", expect.stringContaining("users.profile:read"));
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
