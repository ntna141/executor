const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isLegacySlackQueryToken = (value: unknown): boolean =>
  isRecord(value) && value.in === "query" && value.name === "token";

/**
 * Slack's archived Web API specification exposes the OAuth credential as a
 * required `token` query parameter. Current Slack requests authenticate with
 * the Bearer header rendered by Executor, so that legacy parameter must not be
 * part of the model-facing operation input.
 */
export const normalizeSlackSpec = (document: unknown): unknown => {
  if (!isRecord(document) || !isRecord(document.paths)) return document;

  for (const pathItem of Object.values(document.paths)) {
    if (!isRecord(pathItem)) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation) || !Array.isArray(operation.parameters)) continue;
      operation.parameters = operation.parameters.filter(
        (parameter) => !isLegacySlackQueryToken(parameter),
      );
    }
  }

  return document;
};
