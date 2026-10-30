// Canonical copy contract: do not edit copies; change this file in beyondtrust-axi,
// then re-copy it byte-for-byte with the shared vectors and recorded SHA-256 hashes.
export type DiagnosticRedactor = { text(value: string): string };
type ShapeEntry = { path: string; type: string; count?: number; expected?: string };
type IssueEntry = { path: string; received: string; expected: string; code?: string; pathTruncated?: boolean };
const issueCodes = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"]);
const types = new Set(["string", "number", "boolean", "object", "array", "null", "undefined", "bigint", "symbol", "function", "date", "int", "unknown", "never", "void"]);

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function keySegment(key: string, redactor: DiagnosticRedactor): string {
  const identifier = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key);
  const guid = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:[-_][0-9a-f]{4}){3}[-_][0-9a-f]{12})$/i.test(key);
  return `[${JSON.stringify(identifier && !guid ? redactor.text(key) : "<key>")}]`;
}

// Emit structure only, never the response body or validation-library errors.
export class ResponseDiagnostics {
  private details: Record<string, unknown> = {};
  private readonly shapeByPath = new Map<string, ShapeEntry>();
  private data: unknown;

  constructor(private readonly redactor: DiagnosticRedactor, private readonly errorCodes: readonly string[] = ["API_RESPONSE_INVALID", "AUTH_RESPONSE_INVALID"]) {}

  record(status: number, headers: Headers, data: unknown): void {
    this.data = data;
    // Parameters can contain arbitrary server text; report only the bounded media type.
    const mediaType = headers.get("content-type")?.split(";", 1)[0]?.trim();
    const contentType = mediaType && mediaType.length <= 128 && /^[a-z0-9!#$&^_.+\-]+\/[a-z0-9!#$&^_.+\-]+$/i.test(mediaType)
      ? this.redactor.text(mediaType) : null;
    this.details = { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, contentType, ...this.shape(data) };
  }

  validationFailed(issues: readonly { path: readonly PropertyKey[]; expected?: unknown; code?: unknown }[]): void {
    const issuePaths: string[] = [];
    const annotations: IssueEntry[] = [];
    let truncated = false;
    let characters = 0;
    for (const issue of issues) {
      let path = "$";
      for (const [depth, key] of issue.path.entries()) {
        if (depth >= 4) { truncated = true; break; }
        path += typeof key === "number" && Number.isSafeInteger(key) && key >= 0 ? "[*]" : keySegment(String(key), this.redactor);
      }
      if (issuePaths.length >= 64 || path.length > 256 || characters + path.length > 4096) { truncated = true; break; }
      characters += path.length;
      issuePaths.push(path);
      let received = this.data;
      for (const key of issue.path) {
        received = received !== null && typeof received === "object" && Object.hasOwn(received, key)
          ? (received as Record<PropertyKey, unknown>)[key] : undefined;
      }
      const expected = typeof issue.expected === "string" && types.has(issue.expected) ? issue.expected : "unknown";
      annotations.push({ path, received: valueType(received), expected, ...(typeof issue.code === "string" && issueCodes.has(issue.code) ? { code: issue.code } : {}), ...(truncated ? { pathTruncated: true } : {}) });
      // Validator messages and arbitrary expected strings can contain response values.
      // Annotate only types from the contract vocabulary, on the recorded received shape.
      if (!truncated && typeof issue.expected === "string" && types.has(issue.expected)) {
        const entry = this.shapeByPath.get(JSON.stringify(issue.path));
        if (entry) entry.expected = issue.expected;
      }
      if (truncated) break;
    }
    this.details = { ...this.details, issues: annotations, issuePaths, issuePathsTruncated: truncated };
  }

  private shape(data: unknown): Record<string, unknown> {
    this.shapeByPath.clear();
    const shape: ShapeEntry[] = [];
    let truncated = false;
    let characters = 0;
    const visit = (value: unknown, path: string, keys: readonly (string | number)[]): void => {
      if (shape.length >= 64 || path.length > 256 || characters + path.length > 4096) { truncated = true; return; }
      characters += path.length;
      const type = valueType(value);
      const entry = { path, type, ...(Array.isArray(value) ? { count: value.length } : {}) };
      shape.push(entry);
      this.shapeByPath.set(JSON.stringify(keys), entry);
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        if (value.length === 0) return;
        if (keys.length >= 4) { truncated = true; return; }
        visit(value[0], path + "[*]", [...keys, 0]);
        return;
      }
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (keys.length >= 4 || shape.length >= 64) { truncated = true; break; }
        const segment = keySegment(key, this.redactor);
        visit((value as Record<string, unknown>)[key], path + segment, [...keys, key]);
        if (truncated) break;
      }
    };
    visit(data, "$", []);
    return { shape, shapeTruncated: truncated };
  }

  forError(error: unknown): Record<string, unknown> {
    return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && this.errorCodes.includes(error.code) ? this.details : {};
  }
}
