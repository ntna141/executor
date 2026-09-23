import { ToolName, type ToolAnnotations, type ToolDef } from "@executor-js/sdk";

type JsonSchema = Readonly<Record<string, unknown>>;

const string: JsonSchema = { type: "string" };
const number: JsonSchema = { type: "number" };
const integer: JsonSchema = { type: "integer" };
const boolean: JsonSchema = { type: "boolean" };
const unknown: JsonSchema = {};
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const record: JsonSchema = { type: "object", additionalProperties: true };
const enumeration = (...values: readonly string[]): JsonSchema => ({
  type: "string",
  enum: values,
});
const object = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const approval = (description: string): ToolAnnotations => ({
  requiresApproval: true,
  approvalDescription: description,
});

const def = (
  name: string,
  description: string,
  inputSchema: JsonSchema,
  annotations?: ToolAnnotations,
): ToolDef => ({
  name: ToolName.make(name),
  description,
  inputSchema,
  ...(annotations ? { annotations } : {}),
});

const columnType = enumeration(
  "text",
  "rich_text",
  "number",
  "currency",
  "rating",
  "select",
  "multi_select",
  "date",
  "user",
  "checkbox",
  "email",
  "phone",
  "channel",
  "attachment",
);

const updateColumnType = enumeration(
  "text",
  "rich_text",
  "message",
  "link",
  "number",
  "date",
  "user",
  "attachment",
  "checkbox",
  "email",
  "phone",
  "channel",
  "rating",
  "created_by",
  "last_edited_by",
  "created_time",
  "last_edited_time",
  "vote",
  "assignee",
  "due_date",
  "completed",
  "select",
  "multi_select",
);

const searchProperties = {
  after: string,
  before: string,
  content_types: string,
  context_channel_id: string,
  cursor: string,
  filters: string,
  include_bots: boolean,
  include_context: boolean,
  keywords: array(string),
  limit: integer,
  max_context_length: integer,
  natural_language_query: string,
  only_my_channels: boolean,
  query: string,
  response_format: string,
  sort: string,
  sort_dir: string,
} satisfies Readonly<Record<string, JsonSchema>>;

export const SLACK_TOOL_DEFS: readonly ToolDef[] = [
  def(
    "slack_add_list_record",
    "Add one record to a Slack List. Use slack_read_list with schema_only first.",
    object({ list_id: string, columns: record }, ["list_id", "columns"]),
    approval("Add a record to a Slack List"),
  ),
  def(
    "slack_add_reaction",
    "Add an emoji reaction to a Slack message.",
    object({ channel_id: string, emoji: string, message_ts: string }, [
      "channel_id",
      "emoji",
      "message_ts",
    ]),
    approval("Add a reaction to a Slack message"),
  ),
  def(
    "slack_complete_file_upload",
    "Finish a Slack external file upload and optionally share the file.",
    object(
      {
        channel_id: string,
        file_id: string,
        initial_comment: string,
        thread_ts: string,
        title: string,
      },
      ["file_id"],
    ),
    approval("Complete and optionally share a Slack file upload"),
  ),
  def(
    "slack_create_canvas",
    "Create a standalone Slack Canvas containing Markdown.",
    object({ content: string, title: string }, ["content", "title"]),
    approval("Create a Slack Canvas"),
  ),
  def(
    "slack_create_conversation",
    "Create a Slack channel, direct message, or group direct message.",
    object({
      channel_name: nullable(string),
      is_private: nullable(boolean),
      team_id: nullable(string),
      user_ids: nullable(array(string)),
    }),
    approval("Create a Slack conversation"),
  ),
  def(
    "slack_create_list",
    "Create a Slack List with optional columns and description.",
    object(
      {
        columns: array(
          object({ name: string, options: record, type: columnType }, ["name", "type"]),
        ),
        description: string,
        name: string,
      },
      ["name"],
    ),
    approval("Create a Slack List"),
  ),
  def(
    "slack_create_reminder",
    "Create a Slack reminder.",
    object(
      {
        recurrence: nullable(record),
        team_id: nullable(string),
        text: string,
        time: { anyOf: [string, number] },
      },
      ["text", "time"],
    ),
    approval("Create a Slack reminder"),
  ),
  def(
    "slack_delete_message",
    "Delete a Slack message sent by the connected user. This cannot be undone.",
    object({ channel_id: string, message_id: string }, ["channel_id", "message_id"]),
    approval("Permanently delete a Slack message"),
  ),
  def(
    "slack_edit_message",
    "Edit a Slack message sent by the connected user.",
    object(
      {
        channel_id: string,
        message: object({
          blocks: nullable(unknown),
          file_ids: nullable(unknown),
          link_names: nullable(boolean),
          markdown_text: nullable(string),
          parse: nullable(enumeration("none", "full")),
          reply_broadcast: nullable(boolean),
          text: nullable(string),
          unfurled_attachments: nullable(unknown),
        }),
        message_id: string,
      },
      ["channel_id", "message", "message_id"],
    ),
    approval("Edit a Slack message"),
  ),
  def(
    "slack_get_file_upload_url",
    "Start Slack's external file-upload flow.",
    object({ alt_txt: string, content_length: integer, filename: string, snippet_type: string }, [
      "content_length",
      "filename",
    ]),
    approval("Start a Slack file upload"),
  ),
  def(
    "slack_get_reactions",
    "Get reactions for one Slack message.",
    object({ channel_id: string, message_ts: string }, ["channel_id", "message_ts"]),
  ),
  def(
    "slack_invite_to_conversation",
    "Invite users to an existing public or private Slack channel.",
    object({ conversation_id: string, user_ids: array(string) }, ["conversation_id", "user_ids"]),
    approval("Invite users to a Slack channel"),
  ),
  def(
    "slack_join_conversation",
    "Join an existing public Slack channel.",
    object({ conversation_id: string }, ["conversation_id"]),
    approval("Join a Slack channel"),
  ),
  def(
    "slack_leave_conversation",
    "Leave an existing Slack channel.",
    object({ conversation_id: string }, ["conversation_id"]),
    approval("Leave a Slack channel"),
  ),
  def(
    "slack_list_channel_members",
    "List members of a Slack channel or return its member count.",
    object(
      {
        channel_id: string,
        cursor: nullable(string),
        include_bots: nullable(boolean),
        include_deleted: nullable(boolean),
        limit: nullable(integer),
        response_format: nullable(string),
      },
      ["channel_id"],
    ),
  ),
  def(
    "slack_list_starred_items",
    "List items saved by the connected Slack user.",
    object({ cursor: nullable(string), limit: nullable(integer), team_id: nullable(string) }),
  ),
  def(
    "slack_list_user_channels",
    "List channels, direct messages, and group direct messages visible to the connected user.",
    object({
      cursor: string,
      exclude_archived: boolean,
      format: string,
      limit: integer,
      name_prefix: string,
      team_id: string,
      types: string,
    }),
  ),
  def(
    "slack_list_user_conversations",
    "List conversations visible to a Slack user.",
    object({
      cursor: nullable(string),
      exclude_archived: nullable(boolean),
      limit: nullable(integer),
      query: nullable(string),
      team_id: nullable(string),
      types: nullable({
        anyOf: [
          enumeration("public_channel", "private_channel", "mpim", "im"),
          array(enumeration("public_channel", "private_channel", "mpim", "im")),
        ],
      }),
      user_id: nullable(string),
    }),
  ),
  def(
    "slack_list_user_groups",
    "List Slack user groups.",
    object({
      include_count: nullable(boolean),
      include_disabled: nullable(boolean),
      limit: nullable(integer),
      query: nullable(string),
      team_id: nullable(string),
    }),
  ),
  def(
    "slack_list_workspaces",
    "List Slack workspaces available to the connected token.",
    object({ cursor: nullable(string), include_icon: nullable(boolean), limit: nullable(integer) }),
  ),
  def(
    "slack_read_canvas",
    "Read a Slack Canvas and return its content and metadata.",
    object({ canvas_id: string }, ["canvas_id"]),
  ),
  def(
    "slack_read_channel",
    "Read Slack channel or direct-message history, newest first.",
    object(
      {
        channel_id: string,
        cursor: string,
        latest: string,
        limit: integer,
        oldest: string,
        response_format: string,
      },
      ["channel_id"],
    ),
  ),
  def("slack_read_file", "Read a Slack file by file ID.", object({ file_id: string }, ["file_id"])),
  def(
    "slack_read_list",
    "Read Slack List schema and records by list ID or title.",
    object({
      cursor: string,
      format: string,
      limit: integer,
      list_id: string,
      list_title: string,
      schema_only: boolean,
    }),
  ),
  def(
    "slack_read_thread",
    "Read a Slack thread, including the parent and replies.",
    object(
      {
        channel_id: string,
        cursor: string,
        latest: string,
        limit: integer,
        message_ts: string,
        oldest: string,
        response_format: string,
      },
      ["channel_id", "message_ts"],
    ),
  ),
  def(
    "slack_read_user_profile",
    "Read a Slack user's profile. Defaults to the connected user.",
    object({ include_locale: boolean, response_format: string, user_id: string }),
  ),
  def(
    "slack_schedule_message",
    "Schedule a Slack message for later delivery.",
    object(
      {
        channel_id: string,
        message: string,
        post_at: integer,
        reply_broadcast: boolean,
        thread_ts: string,
      },
      ["channel_id", "message", "post_at"],
    ),
    approval("Schedule a Slack message"),
  ),
  def(
    "slack_search_channels",
    "Search Slack channels by name, topic, and purpose.",
    object({
      channel_types: string,
      cursor: string,
      include_archived: boolean,
      keywords: array(string),
      limit: integer,
      natural_language_query: string,
      query: string,
      response_format: string,
    }),
  ),
  def(
    "slack_search_emojis",
    "Search custom Slack emoji names.",
    object({ query: string }, ["query"]),
  ),
  def(
    "slack_search_public",
    "Search messages and files in public Slack channels. Put content words in keywords and Slack modifiers such as from:alice, in:general, after:2026-01-01, and before:2026-02-01 in filters. For the latest result, use sort=timestamp and sort_dir=desc. Use a known Slack username directly; call slack_search_users first only when the person is ambiguous.",
    object(searchProperties),
  ),
  def(
    "slack_search_public_and_private",
    "Search messages and files across public channels, private channels, group DMs, and DMs. Put content words in keywords and Slack modifiers such as from:alice, in:general, after:2026-01-01, and before:2026-02-01 in filters. For the latest result, use sort=timestamp and sort_dir=desc. Use a known Slack username directly; call slack_search_users first only when the person is ambiguous.",
    object({ ...searchProperties, channel_types: string }),
    approval("Search private Slack conversations"),
  ),
  def(
    "slack_search_users",
    "Search Slack users by name, email, and profile attributes. Use this only when a later tool needs a user ID or the requested person is ambiguous; Slack message search accepts from:username directly.",
    object({
      cursor: string,
      keywords: array(string),
      limit: integer,
      natural_language_query: string,
      query: string,
      response_format: string,
    }),
  ),
  def(
    "slack_send_message",
    "Send a Slack message to a channel or user.",
    object(
      {
        channel_id: string,
        draft_id: string,
        message: string,
        reply_broadcast: boolean,
        thread_ts: string,
        unfurl_app_links: boolean,
      },
      ["channel_id", "message"],
    ),
    approval("Send a Slack message"),
  ),
  def(
    "slack_send_message_draft",
    "Create an attached Slack draft without sending it.",
    object({ channel_id: string, message: string, thread_ts: string }, ["channel_id", "message"]),
    approval("Create a Slack message draft"),
  ),
  def(
    "slack_update_canvas",
    "Update all or part of a Slack Canvas.",
    object(
      {
        action: enumeration("append", "prepend", "replace"),
        canvas_id: string,
        content: string,
        section_id: string,
        sections: array(
          object(
            {
              content: string,
              edit_type: enumeration("append", "prepend", "replace", "delete"),
              section_id: string,
            },
            ["edit_type"],
          ),
        ),
      },
      ["canvas_id"],
    ),
    approval("Update a Slack Canvas"),
  ),
  def(
    "slack_update_list",
    "Update Slack List metadata and columns.",
    object(
      {
        columns_to_add: array(
          object({ name: string, options: record, type: updateColumnType }, ["name", "type"]),
        ),
        columns_to_delete: array(object({ key: string }, ["key"])),
        columns_to_update: array(
          object({ key: string, name: string, options: record, type: updateColumnType }, ["key"]),
        ),
        description: string,
        icon: string,
        list_id: string,
        name: string,
      },
      ["list_id"],
    ),
    approval("Update a Slack List"),
  ),
  def(
    "slack_update_list_record",
    "Update selected fields in one Slack List record.",
    object({ list_id: string, record_id: string, updated_columns: record }, [
      "list_id",
      "record_id",
      "updated_columns",
    ]),
    approval("Update a Slack List record"),
  ),
  def(
    "slack_update_user_profile",
    "Update the connected user's Slack profile, or another user when permitted.",
    object(
      {
        profile_patch: object({
          display_name: nullable(string),
          email: nullable(string),
          fields: nullable(record),
          first_name: nullable(string),
          last_name: nullable(string),
          phone: nullable(string),
          pronouns: nullable(string),
          real_name: nullable(string),
          start_date: nullable(string),
          status_emoji: nullable(string),
          status_expiration: nullable(number),
          status_text: nullable(string),
          title: nullable(string),
        }),
        user_id: nullable(string),
      },
      ["profile_patch"],
    ),
    approval("Update a Slack user profile"),
  ),
] as const;
