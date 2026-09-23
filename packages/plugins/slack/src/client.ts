import { Data, Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const SLACK_API = "https://slack.com/api/";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Args = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

export class SlackApiError extends Data.TaggedError("SlackApiError")<{
  readonly method: string;
  readonly code: string;
  readonly status?: number;
}> {
  override get message(): string {
    return `Slack ${this.method} failed: ${this.code}`;
  }
}

const asObject = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const stringValue = (args: Args, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const numberValue = (args: Args, key: string): number | undefined => {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const booleanValue = (args: Args, key: string): boolean | undefined =>
  typeof args[key] === "boolean" ? args[key] : undefined;

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const compact = (input: Args): Args =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  );

const slackCall = Effect.fn("Slack.call")(function* (method: string, body: Args, token: string) {
  const client = yield* HttpClient.HttpClient;
  const values = compact(body);
  const request = (
    method === "search.all"
      ? HttpClientRequest.get(
          `${SLACK_API}${method}?${new URLSearchParams(
            Object.entries(values).map(([key, value]) => [key, String(value)]),
          )}`,
        )
      : HttpClientRequest.post(`${SLACK_API}${method}`).pipe(
          HttpClientRequest.setHeader("Content-Type", "application/json; charset=utf-8"),
          HttpClientRequest.bodyJsonUnsafe(values),
        )
  ).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
  );
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError(() => new SlackApiError({ method, code: "transport_error" })));
  const payload = asObject(
    yield* response.json.pipe(
      Effect.mapError(
        () => new SlackApiError({ method, code: "invalid_json", status: response.status }),
      ),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new SlackApiError({
      method,
      code: response.status === 429 ? "rate_limited" : `http_${response.status}`,
      status: response.status,
    });
  }
  if (payload.ok !== true) {
    return yield* new SlackApiError({
      method,
      code: typeof payload.error === "string" ? payload.error : "unknown_error",
      status: response.status,
    });
  }
  return payload;
});

const richText = (value: unknown): readonly JsonObject[] => [
  {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text: String(value ?? "") }],
      },
    ],
  },
];

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "column";

const uniqueKeys = (columns: readonly JsonObject[]): readonly JsonObject[] => {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const name = typeof column.name === "string" ? column.name : `Column ${index + 1}`;
    const base = slug(name);
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base}_${suffix++}`;
    used.add(key);
    return { ...column, key, name };
  });
};

const listSchema = (value: unknown): readonly JsonObject[] => {
  const columns = Array.isArray(value) ? value.map(asObject) : [];
  const hasText = columns.some((column) => column.type === "text");
  const withPrimary =
    columns.length === 0
      ? [{ name: "Name", type: "text" }]
      : hasText
        ? columns
        : [{ name: "Task", type: "text" }, ...columns];
  const keyed = uniqueKeys(withPrimary);
  const primary = keyed.findIndex((column) => column.type === "text");
  return keyed.map((column, index) => ({
    key: column.key,
    name: column.name,
    type: column.type,
    is_primary_column: index === primary,
    ...(column.options === undefined ? {} : { options: column.options }),
  }));
};

const listMetadata = (response: JsonObject): JsonObject => {
  const list = asObject(response.list);
  const metadata = asObject(response.list_metadata);
  return Object.keys(list).length > 0 ? list : metadata;
};

const schemaColumns = (response: JsonObject): readonly JsonObject[] => {
  const metadata = listMetadata(response);
  return Array.isArray(metadata.schema) ? metadata.schema.map(asObject) : [];
};

const listColumnLookup = (
  columns: readonly JsonObject[],
  requested: string,
): JsonObject | undefined => {
  const lower = requested.toLowerCase();
  return columns.find(
    (column) =>
      column.key === requested ||
      (typeof column.name === "string" && column.name.toLowerCase() === lower),
  );
};

const valueArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [value]);

const listField = (column: JsonObject, value: unknown): JsonObject => {
  const columnId = typeof column.id === "string" ? column.id : column.column_id;
  const type = typeof column.type === "string" ? column.type : "text";
  const base = { column_id: columnId };
  // The provider returns an open string vocabulary, so a direct dispatch is clearer than tagged matching.
  // oxlint-disable-next-line executor/no-switch-statement
  switch (type) {
    case "text":
    case "rich_text":
      return { ...base, rich_text: richText(value) };
    case "number":
    case "currency":
    case "rating":
      return { ...base, number: valueArray(value).map(Number) };
    case "select":
    case "multi_select":
      return { ...base, select: valueArray(value) };
    case "date":
    case "due_date":
      return { ...base, date: valueArray(value).map(String) };
    case "user":
    case "assignee":
      return { ...base, user: valueArray(value).map(String) };
    case "checkbox":
    case "completed":
      return { ...base, checkbox: Boolean(value) };
    case "email":
    case "phone":
    case "channel":
    case "attachment":
      return { ...base, [type]: valueArray(value) };
    default:
      return { ...base, rich_text: richText(value) };
  }
};

const resolveListFields = Effect.fn("Slack.resolveListFields")(function* (
  listId: string,
  values: JsonObject,
  token: string,
) {
  const response = yield* slackCall(
    "slackLists.items.list",
    { list_id: listId, limit: 1, include_list: true },
    token,
  );
  const columns = schemaColumns(response);
  const fields: JsonObject[] = [];
  for (const [name, value] of Object.entries(values)) {
    const column = listColumnLookup(columns, name);
    if (column === undefined) {
      return yield* new SlackApiError({
        method: "slackLists.items",
        code: `column_not_found:${name}`,
      });
    }
    fields.push(listField(column, value));
  }
  return fields;
});

const downloadSlackFile = Effect.fn("Slack.downloadFile")(function* (
  file: JsonObject,
  token: string,
) {
  const url =
    typeof file.url_private_download === "string"
      ? file.url_private_download
      : typeof file.url_private === "string"
        ? file.url_private
        : undefined;
  if (url === undefined) return { file };
  const parsed = new URL(url);
  const trusted =
    parsed.protocol === "https:" &&
    (parsed.hostname === "slack.com" ||
      parsed.hostname.endsWith(".slack.com") ||
      parsed.hostname.endsWith(".slack-edge.com"));
  if (!trusted)
    return yield* new SlackApiError({ method: "files.download", code: "untrusted_download_url" });

  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
    )
    .pipe(
      Effect.mapError(
        () => new SlackApiError({ method: "files.download", code: "transport_error" }),
      ),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new SlackApiError({
      method: "files.download",
      code: `http_${response.status}`,
      status: response.status,
    });
  }
  const bytes = new Uint8Array(
    yield* response.arrayBuffer.pipe(
      Effect.mapError(() => new SlackApiError({ method: "files.download", code: "read_error" })),
    ),
  );
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return yield* new SlackApiError({ method: "files.download", code: "file_too_large" });
  }
  const mimeType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("xml")) {
    return { file, mime_type: mimeType, content: new TextDecoder().decode(bytes) };
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { file, mime_type: mimeType, base64: btoa(binary) };
});

const readFile = Effect.fn("Slack.readFile")(function* (fileId: string, token: string) {
  const response = yield* slackCall("files.info", { file: fileId }, token);
  return yield* downloadSlackFile(asObject(response.file), token);
});

const openDm = Effect.fn("Slack.openDm")(function* (channelOrUser: string, token: string) {
  if (!channelOrUser.startsWith("U")) return channelOrUser;
  const opened = yield* slackCall("conversations.open", { users: channelOrUser }, token);
  const channel = asObject(opened.channel);
  if (typeof channel.id !== "string") {
    return yield* new SlackApiError({ method: "conversations.open", code: "missing_channel_id" });
  }
  return channel.id;
});

const wordsFor = (args: Args): readonly string[] => {
  const keywords = stringArray(args.keywords);
  const query = stringValue(args, "query");
  return keywords.length > 0 ? keywords : (query?.split(/\s+/).filter(Boolean) ?? []);
};

const searchableText = (value: unknown): string => JSON.stringify(value).toLowerCase();

const matchesWords = (value: unknown, words: readonly string[]): boolean => {
  const haystack = searchableText(value);
  return words.every((raw) => {
    const negative = raw.startsWith("-");
    const word = (negative ? raw.slice(1) : raw).replace(/^"|"$/g, "").toLowerCase();
    return negative ? !haystack.includes(word) : haystack.includes(word);
  });
};

const searchUsers = Effect.fn("Slack.searchUsers")(function* (args: Args, token: string) {
  const limit = Math.min(Math.max(numberValue(args, "limit") ?? 20, 1), 20);
  const words = wordsFor(args);
  let cursor = stringValue(args, "cursor");
  const matches: JsonObject[] = [];
  for (let page = 0; page < 10 && matches.length < limit; page += 1) {
    const response = yield* slackCall("users.list", { cursor, limit: 200 }, token);
    const members = Array.isArray(response.members) ? response.members.map(asObject) : [];
    matches.push(...members.filter((member) => matchesWords(member, words)));
    cursor = stringValue(asObject(response.response_metadata), "next_cursor");
    if (cursor === undefined) break;
  }
  return { users: matches.slice(0, limit), next_cursor: cursor ?? null };
});

const searchChannels = Effect.fn("Slack.searchChannels")(function* (args: Args, token: string) {
  const limit = Math.min(Math.max(numberValue(args, "limit") ?? 20, 1), 20);
  const words = wordsFor(args);
  const response = yield* slackCall(
    "conversations.list",
    {
      cursor: stringValue(args, "cursor"),
      exclude_archived: booleanValue(args, "include_archived") === true ? false : true,
      limit: 200,
      types: stringValue(args, "channel_types") ?? "public_channel",
    },
    token,
  );
  const channels = Array.isArray(response.channels) ? response.channels.map(asObject) : [];
  return {
    channels: channels.filter((channel) => matchesWords(channel, words)).slice(0, limit),
    next_cursor: stringValue(asObject(response.response_metadata), "next_cursor") ?? null,
  };
});

const searchQuery = (args: Args): string => {
  const explicit = stringValue(args, "query");
  if (explicit !== undefined) return explicit;
  return [...stringArray(args.keywords), stringValue(args, "filters")].filter(Boolean).join(" ");
};

const messageTs = (match: JsonObject): number | undefined => {
  const ts = typeof match.ts === "string" ? Number(match.ts) : undefined;
  return ts !== undefined && Number.isFinite(ts) ? ts : undefined;
};

const messageChannelId = (match: JsonObject): string | undefined => {
  if (typeof match.channel_id === "string") return match.channel_id;
  const channel = asObject(match.channel);
  return typeof channel.id === "string" ? channel.id : undefined;
};

const searchMessages = Effect.fn("Slack.searchMessages")(function* (
  args: Args,
  token: string,
  includePrivate: boolean,
) {
  const query = searchQuery(args);
  if (query.trim().length === 0) {
    return yield* new SlackApiError({ method: "search.messages", code: "query_required" });
  }
  const limit = Math.min(Math.max(numberValue(args, "limit") ?? 20, 1), 20);
  const response = yield* slackCall(
    "search.all",
    {
      query,
      count: limit,
      highlight: false,
      sort: stringValue(args, "sort") ?? "score",
      sort_dir: stringValue(args, "sort_dir") ?? "desc",
    },
    token,
  );
  const messages = asObject(response.messages);
  const rawMatches = Array.isArray(messages.matches) ? messages.matches.map(asObject) : [];
  const after = Number(stringValue(args, "after"));
  const before = Number(stringValue(args, "before"));
  let matches = rawMatches.filter((match) => {
    const ts = messageTs(match);
    return (
      (!Number.isFinite(after) || (ts !== undefined && ts >= after)) &&
      (!Number.isFinite(before) || (ts !== undefined && ts <= before)) &&
      (booleanValue(args, "include_bots") === true || typeof match.bot_id !== "string")
    );
  });

  if (!includePrivate || booleanValue(args, "only_my_channels") === true) {
    const ids = [...new Set(matches.map(messageChannelId).filter(Predicate.isNotUndefined))];
    const infoEntries = yield* Effect.all(
      ids.map((channel) =>
        slackCall("conversations.info", { channel }, token).pipe(
          Effect.map((info) => [channel, asObject(info.channel)] as const),
          Effect.catch(() => Effect.succeed([channel, {} as JsonObject] as const)),
        ),
      ),
      { concurrency: 5 },
    );
    const info = new Map(infoEntries);
    matches = matches.filter((match) => {
      const channel = info.get(messageChannelId(match) ?? "") ?? {};
      if (
        !includePrivate &&
        (channel.is_private === true || channel.is_im === true || channel.is_mpim === true)
      )
        return false;
      if (booleanValue(args, "only_my_channels") === true && channel.is_member !== true)
        return false;
      return true;
    });
  }

  return {
    results: matches.slice(0, limit),
    paging: messages.paging ?? null,
    total: typeof messages.total === "number" ? messages.total : matches.length,
  };
});

const listUserChannels = Effect.fn("Slack.listUserChannels")(function* (args: Args, token: string) {
  const requestedLimit = Math.min(Math.max(numberValue(args, "limit") ?? 50, 1), 200);
  const prefix = stringValue(args, "name_prefix")?.toLowerCase();
  const types = stringValue(args, "types") ?? "public_channel,private_channel";
  let cursor = prefix === undefined ? stringValue(args, "cursor") : undefined;
  const channels: JsonObject[] = [];
  for (let page = 0; page < 10 && channels.length < requestedLimit; page += 1) {
    const response = yield* slackCall(
      "users.conversations",
      {
        cursor,
        exclude_archived: booleanValue(args, "exclude_archived") ?? false,
        limit: 200,
        team_id: stringValue(args, "team_id"),
        types,
      },
      token,
    );
    const pageChannels = Array.isArray(response.channels) ? response.channels.map(asObject) : [];
    channels.push(
      ...pageChannels.filter(
        (channel) =>
          prefix === undefined ||
          (typeof channel.name === "string" && channel.name.toLowerCase().startsWith(prefix)),
      ),
    );
    cursor = stringValue(asObject(response.response_metadata), "next_cursor");
    if (cursor === undefined || prefix === undefined) break;
  }
  const selected = channels.slice(0, requestedLimit);
  const format = stringValue(args, "format") ?? "full";
  return {
    channels:
      format === "ids_only"
        ? selected.map((channel) => channel.id)
        : format === "names_only"
          ? selected.map((channel) => channel.name)
          : selected,
    next_cursor: cursor ?? null,
  };
});

const listItemsAsTable = (response: JsonObject, format: string): JsonObject => {
  const metadata = listMetadata(response);
  const columns = schemaColumns(response);
  const items = Array.isArray(response.items) ? response.items.map(asObject) : [];
  const headers = [
    "Record ID",
    ...columns.map((column) => String(column.name ?? column.key ?? column.id ?? "Column")),
  ];
  const rows = items.map((item) => {
    const fields = Array.isArray(item.fields) ? item.fields.map(asObject) : [];
    const byId = new Map(
      fields.map((field) => [String(field.column_id ?? field.key ?? ""), field]),
    );
    return [
      String(item.id ?? ""),
      ...columns.map((column) => {
        const field = byId.get(String(column.id ?? column.key ?? ""));
        return String(field?.text ?? field?.value ?? "");
      }),
    ];
  });
  const escapeCell = (cell: string): string => cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const content =
    format === "csv"
      ? [headers, ...rows]
          .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
          .join("\n")
      : [
          `| ${headers.map(escapeCell).join(" | ")} |`,
          `| ${headers.map(() => "---").join(" | ")} |`,
          ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
        ].join("\n");
  return {
    list: metadata,
    content,
    next_cursor: stringValue(asObject(response.response_metadata), "next_cursor") ?? null,
  };
};

const readList = Effect.fn("Slack.readList")(function* (args: Args, token: string) {
  let listId = stringValue(args, "list_id");
  if (listId === undefined) {
    const title = stringValue(args, "list_title");
    if (title === undefined)
      return yield* new SlackApiError({
        method: "slackLists.items.list",
        code: "list_id_or_title_required",
      });
    const files = yield* slackCall("files.list", { types: "all", count: 100 }, token);
    const candidates = Array.isArray(files.files) ? files.files.map(asObject) : [];
    const match = candidates.find(
      (file) =>
        (file.filetype === "list" || file.mimetype === "application/vnd.slack-list") &&
        matchesWords(file, [title]),
    );
    if (typeof match?.id !== "string")
      return yield* new SlackApiError({ method: "slackLists.items.list", code: "list_not_found" });
    listId = match.id;
  }
  const response = yield* slackCall(
    "slackLists.items.list",
    {
      list_id: listId,
      cursor: stringValue(args, "cursor"),
      limit: Math.min(numberValue(args, "limit") ?? 100, 100),
      include_list: true,
    },
    token,
  );
  if (booleanValue(args, "schema_only") === true) {
    return { list_id: listId, schema: schemaColumns(response) };
  }
  return listItemsAsTable(response, stringValue(args, "format") ?? "markdown");
});

const canvasChanges = (args: Args): readonly JsonObject[] => {
  const sections = Array.isArray(args.sections) ? args.sections.map(asObject) : [];
  if (sections.length > 0) {
    return sections.map((section) => {
      const editType = typeof section.edit_type === "string" ? section.edit_type : "replace";
      const operation =
        editType === "append"
          ? "insert_after"
          : editType === "prepend"
            ? "insert_before"
            : editType;
      return compact({
        operation,
        section_id: section.section_id,
        document_content:
          operation === "delete"
            ? undefined
            : { type: "markdown", markdown: section.content ?? "" },
      });
    });
  }
  const action = stringValue(args, "action") ?? "replace";
  const operation =
    action === "append" ? "insert_at_end" : action === "prepend" ? "insert_at_start" : "replace";
  return [
    compact({
      operation,
      section_id: stringValue(args, "section_id"),
      document_content: { type: "markdown", markdown: stringValue(args, "content") ?? "" },
    }),
  ];
};

const invoke = Effect.fn("Slack.invokeTool")(function* (name: string, args: Args, token: string) {
  // Tool names are persisted strings, not a tagged union; this is the boundary dispatch table.
  // oxlint-disable-next-line executor/no-switch-statement
  switch (name) {
    case "slack_add_list_record": {
      const listId = String(args.list_id);
      const fields = yield* resolveListFields(listId, asObject(args.columns), token);
      return yield* slackCall(
        "slackLists.items.create",
        { list_id: listId, initial_fields: fields },
        token,
      );
    }
    case "slack_add_reaction":
      return yield* slackCall(
        "reactions.add",
        { channel: args.channel_id, name: args.emoji, timestamp: args.message_ts },
        token,
      );
    case "slack_complete_file_upload":
      return yield* slackCall(
        "files.completeUploadExternal",
        {
          files: [{ id: args.file_id, ...(args.title === undefined ? {} : { title: args.title }) }],
          channel_id: args.channel_id,
          initial_comment: args.initial_comment,
          thread_ts: args.thread_ts,
        },
        token,
      );
    case "slack_create_canvas":
      return yield* slackCall(
        "canvases.create",
        {
          title: args.title,
          document_content: { type: "markdown", markdown: args.content },
        },
        token,
      );
    case "slack_create_conversation": {
      const channelName = stringValue(args, "channel_name");
      const users = stringArray(args.user_ids);
      if (channelName === undefined)
        return yield* slackCall("conversations.open", { users: users.join(",") }, token);
      const teamId = stringValue(args, "team_id");
      const created = yield* slackCall(
        "conversations.create",
        {
          name: teamId === undefined ? slug(channelName).replace(/_/g, "-") : channelName,
          is_private: booleanValue(args, "is_private") ?? false,
          team_id: teamId,
        },
        token,
      );
      const channel = asObject(created.channel);
      if (users.length > 0 && typeof channel.id === "string") {
        yield* slackCall(
          "conversations.invite",
          { channel: channel.id, users: users.join(",") },
          token,
        );
      }
      return created;
    }
    case "slack_create_list":
      return yield* slackCall(
        "slackLists.create",
        {
          name: args.name,
          schema: listSchema(args.columns),
          ...(typeof args.description === "string"
            ? { description_blocks: richText(args.description) }
            : {}),
        },
        token,
      );
    case "slack_create_reminder":
      return yield* slackCall(
        "reminders.add",
        { text: args.text, time: args.time, team_id: args.team_id, recurrence: args.recurrence },
        token,
      );
    case "slack_delete_message":
      return yield* slackCall(
        "chat.delete",
        { channel: args.channel_id, ts: args.message_id },
        token,
      );
    case "slack_edit_message": {
      const message = asObject(args.message);
      return yield* slackCall(
        "chat.update",
        {
          channel: args.channel_id,
          ts: args.message_id,
          ...message,
          text: message.markdown_text ?? message.text,
          markdown_text: undefined,
        },
        token,
      );
    }
    case "slack_get_file_upload_url":
      return yield* slackCall(
        "files.getUploadURLExternal",
        {
          filename: args.filename,
          length: args.content_length,
          alt_txt: args.alt_txt,
          snippet_type: args.snippet_type,
        },
        token,
      );
    case "slack_get_reactions":
      return yield* slackCall(
        "reactions.get",
        { channel: args.channel_id, timestamp: args.message_ts, full: true },
        token,
      );
    case "slack_invite_to_conversation":
      return yield* slackCall(
        "conversations.invite",
        { channel: args.conversation_id, users: stringArray(args.user_ids).join(",") },
        token,
      );
    case "slack_join_conversation":
      return yield* slackCall("conversations.join", { channel: args.conversation_id }, token);
    case "slack_leave_conversation":
      return yield* slackCall("conversations.leave", { channel: args.conversation_id }, token);
    case "slack_list_channel_members": {
      const response = yield* slackCall(
        "conversations.members",
        {
          channel: args.channel_id,
          cursor: args.cursor,
          limit: Math.min(numberValue(args, "limit") ?? 30, 30),
        },
        token,
      );
      const members = stringArray(response.members);
      if (args.response_format === "count_only")
        return { channel_id: args.channel_id, num_members: members.length };
      if (args.response_format === "ids_only")
        return { members, response_metadata: response.response_metadata };
      const users = yield* Effect.all(
        members.map((user) =>
          slackCall("users.info", { user }, token).pipe(Effect.map((item) => asObject(item.user))),
        ),
        { concurrency: 8 },
      );
      return {
        members: users.filter(
          (user) =>
            (booleanValue(args, "include_bots") === true || user.is_bot !== true) &&
            (booleanValue(args, "include_deleted") === true || user.deleted !== true),
        ),
        response_metadata: response.response_metadata,
      };
    }
    case "slack_list_starred_items":
      return yield* slackCall(
        "stars.list",
        { cursor: args.cursor, limit: args.limit, team_id: args.team_id },
        token,
      );
    case "slack_list_user_channels":
      return yield* listUserChannels(args, token);
    case "slack_list_user_conversations": {
      const types = Array.isArray(args.types) ? stringArray(args.types).join(",") : args.types;
      const response = yield* slackCall(
        "users.conversations",
        {
          cursor: args.cursor,
          exclude_archived: args.exclude_archived,
          limit: args.limit,
          team_id: args.team_id,
          types,
          user: args.user_id,
        },
        token,
      );
      const query = stringValue(args, "query");
      if (query === undefined) return response;
      const channels = Array.isArray(response.channels)
        ? response.channels.filter((channel) => matchesWords(channel, [query]))
        : [];
      return { ...response, channels };
    }
    case "slack_list_user_groups": {
      const response = yield* slackCall(
        "usergroups.list",
        {
          include_count: args.include_count,
          include_disabled: args.include_disabled,
          team_id: args.team_id,
        },
        token,
      );
      const query = stringValue(args, "query");
      const limit = numberValue(args, "limit") ?? Number.POSITIVE_INFINITY;
      const groups = Array.isArray(response.usergroups)
        ? response.usergroups
            .filter((group) => query === undefined || matchesWords(group, [query]))
            .slice(0, limit)
        : [];
      return { ...response, usergroups: groups };
    }
    case "slack_list_workspaces": {
      const response = yield* slackCall("team.info", {}, token);
      return { workspaces: [response.team] };
    }
    case "slack_read_canvas":
      return yield* readFile(String(args.canvas_id), token);
    case "slack_read_channel": {
      const channel = yield* openDm(String(args.channel_id), token);
      return yield* slackCall(
        "conversations.history",
        {
          channel,
          cursor: args.cursor,
          latest: args.latest,
          limit: Math.min(numberValue(args, "limit") ?? 100, 100),
          oldest: args.oldest,
        },
        token,
      );
    }
    case "slack_read_file":
      return yield* readFile(String(args.file_id), token);
    case "slack_read_list":
      return yield* readList(args, token);
    case "slack_read_thread":
      return yield* slackCall(
        "conversations.replies",
        {
          channel: args.channel_id,
          ts: args.message_ts,
          cursor: args.cursor,
          latest: args.latest,
          limit: Math.min(numberValue(args, "limit") ?? 100, 1000),
          oldest: args.oldest,
        },
        token,
      );
    case "slack_read_user_profile":
      return yield* slackCall(
        "users.profile.get",
        { user: args.user_id, include_labels: true },
        token,
      );
    case "slack_schedule_message":
      return yield* slackCall(
        "chat.scheduleMessage",
        {
          channel: args.channel_id,
          text: args.message,
          post_at: args.post_at,
          reply_broadcast: args.reply_broadcast,
          thread_ts: args.thread_ts,
        },
        token,
      );
    case "slack_search_channels":
      return yield* searchChannels(args, token);
    case "slack_search_emojis": {
      const response = yield* slackCall("emoji.list", {}, token);
      const terms = String(args.query)
        .toLowerCase()
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean);
      const emoji = asObject(response.emoji);
      return {
        emojis: Object.entries(emoji)
          .filter(([name]) => terms.some((term) => name.toLowerCase().includes(term)))
          .slice(0, 200)
          .map(([name, url]) => ({ name, url })),
      };
    }
    case "slack_search_public":
      return yield* searchMessages(args, token, false);
    case "slack_search_public_and_private":
      return yield* searchMessages(args, token, true);
    case "slack_search_users":
      return yield* searchUsers(args, token);
    case "slack_send_message": {
      const sent = yield* slackCall(
        "chat.postMessage",
        {
          channel: args.channel_id,
          text: args.message,
          reply_broadcast: args.reply_broadcast,
          thread_ts: args.thread_ts,
          unfurl_links: args.unfurl_app_links,
        },
        token,
      );
      if (typeof args.draft_id === "string") {
        yield* slackCall("drafts.delete", { id: args.draft_id }, token).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      if (typeof sent.channel === "string" && typeof sent.ts === "string") {
        const permalink = yield* slackCall(
          "chat.getPermalink",
          { channel: sent.channel, message_ts: sent.ts },
          token,
        ).pipe(Effect.catch(() => Effect.succeed({})));
        return { ...sent, permalink: asObject(permalink).permalink ?? null };
      }
      return sent;
    }
    case "slack_send_message_draft":
      return yield* slackCall(
        "drafts.create",
        { channel_id: args.channel_id, text: args.message, thread_ts: args.thread_ts },
        token,
      );
    case "slack_update_canvas":
      return yield* slackCall(
        "canvases.edit",
        { canvas_id: args.canvas_id, changes: canvasChanges(args) },
        token,
      );
    case "slack_update_list": {
      const listId = String(args.list_id);
      const metadataUpdate = compact({
        id: listId,
        name: args.name,
        ...(typeof args.description === "string"
          ? { description_blocks: richText(args.description) }
          : {}),
      });
      let result: unknown =
        metadataUpdate.name !== undefined || metadataUpdate.description_blocks !== undefined
          ? yield* slackCall("slackLists.update", metadataUpdate, token)
          : { ok: true };
      const additions = Array.isArray(args.columns_to_add) ? args.columns_to_add.map(asObject) : [];
      const updates = Array.isArray(args.columns_to_update)
        ? args.columns_to_update.map(asObject)
        : [];
      const deletions = Array.isArray(args.columns_to_delete)
        ? args.columns_to_delete.map(asObject)
        : [];
      if (additions.length > 0 || updates.length > 0 || deletions.length > 0) {
        result = yield* slackCall(
          "slackLists.update",
          {
            id: listId,
            schema: {
              add: listSchema(additions),
              update: updates,
              delete: deletions.map((column) => column.key),
            },
          },
          token,
        );
      }
      return result;
    }
    case "slack_update_list_record": {
      const listId = String(args.list_id);
      const fields = yield* resolveListFields(listId, asObject(args.updated_columns), token);
      return yield* slackCall(
        "slackLists.items.update",
        {
          list_id: listId,
          cells: fields.map((field) => ({ ...field, row_id: args.record_id })),
        },
        token,
      );
    }
    case "slack_update_user_profile":
      return yield* slackCall(
        "users.profile.set",
        { profile: args.profile_patch, user: args.user_id },
        token,
      );
    default:
      return yield* new SlackApiError({ method: name, code: "tool_not_implemented" });
  }
});

export const invokeSlackTool = (
  name: string,
  args: unknown,
  token: string,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<unknown, SlackApiError> =>
  invoke(name, asObject(args), token).pipe(Effect.provide(httpClientLayer));

export const checkSlackAuth = (
  token: string,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
): Effect.Effect<JsonObject, SlackApiError> =>
  slackCall("auth.test", {}, token).pipe(Effect.provide(httpClientLayer));
