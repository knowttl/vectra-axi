import http from "node:http";
import https from "node:https";
import { expect, it } from "vitest";

it.each([
  ["HTTP", () => http.request("http://fixture.invalid")],
  ["HTTPS", () => https.request("https://fixture.invalid")],
  ["fetch", () => fetch("https://fixture.invalid")],
])("denies %s before an external connection", (_name, request) => {
  expect(request).toThrow("External network is denied in tests");
});
