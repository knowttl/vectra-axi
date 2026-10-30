import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ResponseDiagnostics } from "../src/response-diagnostics.js";
import vectors from "./fixtures/response-diagnostics-vectors.json" with { type: "json" };
import hashes from "./fixtures/response-diagnostics-sha256.json" with { type: "json" };

test.each(vectors)("shared diagnostics vector: $name", (vector) => {
  const redactor = { text: (text: string) => (vector.secrets ?? []).reduce((text, secret) => text.replaceAll(secret, "***redacted***"), text) };
  const diagnostics = new ResponseDiagnostics(redactor);
  diagnostics.record(vector.status, new Headers(vector.contentType ? { "content-type": vector.contentType } : {}), vector.data);
  if (vector.issues) diagnostics.validationFailed(vector.issues);
  expect(diagnostics.forError({ code: "API_RESPONSE_INVALID" })).toEqual(vector.expected);
  expect(diagnostics.forError({ code: "AUTH_RESPONSE_INVALID" })).toEqual(vector.expected);
  expect(diagnostics.forError({ code: "TRANSPORT_ERROR" })).toEqual({});
});

test("matches expected types against the newly recorded response", () => {
  const diagnostics = new ResponseDiagnostics({ text: (text) => text });
  diagnostics.record(200, new Headers(), { field: 123 });
  diagnostics.validationFailed([{ path: ["field"], expected: "string" }]);
  diagnostics.record(202, new Headers(), { field: false });
  diagnostics.validationFailed([{ path: ["field"], expected: "number" }]);
  expect(diagnostics.forError({ code: "API_RESPONSE_INVALID" })).toEqual({
    status: 202, contentType: null,
    shape: [{ path: "$", type: "object" }, { path: '$["field"]', type: "boolean", expected: "number" }],
    shapeTruncated: false, issues: [{ path: '$["field"]', received: "boolean", expected: "number" }],
    issuePaths: ['$["field"]'], issuePathsTruncated: false,
  });
});

test.each([
  { name: "entry count", path: ["field"], displayed: '$["field"]', count: 64 },
  { name: "path characters", path: ["a".repeat(40), "b".repeat(40)], displayed: `$["${"a".repeat(40)}"]["${"b".repeat(40)}"]`, count: 46 },
])("bounds issue annotations by $name", ({ path, displayed, count }) => {
  const diagnostics = new ResponseDiagnostics({ text: (text) => text });
  diagnostics.record(200, new Headers(), {});
  diagnostics.validationFailed(Array.from({ length: 65 }, () => ({ path, expected: "string" })));
  expect(diagnostics.forError({ code: "API_RESPONSE_INVALID" })).toMatchObject({
    issues: Array(count).fill({ path: displayed, received: "undefined", expected: "string" }),
    issuePathsTruncated: true,
  });
});

// These bytes are the distribution interface consumed by copies and language ports.
test.each(Object.entries(hashes))("canonical copy SHA-256: %s", (path, hash) => {
  const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
});
