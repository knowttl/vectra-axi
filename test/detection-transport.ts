import "./network-guard.js";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

const first = { id: 1, detection_type: "synthetic-type", state: "active", threat: null, certainty: 80 };
const second = { ...first, id: 2, threat: 72 };
const next = "https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70&min_id=2";
const responses = new Map<string, { status: number; body: unknown }>([
  ["https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70",
    { status: 200, body: { results: [first], count: 2, next } }],
  [next, { status: 200, body: { results: [second], count: 2, next: null } }],
  ["https://fixture.invalid/api/v2.5/detections/1",
    { status: 200, body: { ...first, description: "synthetic detail ".repeat(100) } }],
  ["https://fixture.invalid/api/v2.5/detections?state=empty",
    { status: 200, body: { results: [], count: 0 } }],
  ["https://fixture.invalid/api/v2.5/detections?state=denied", { status: 403, body: {} }],
  ["https://fixture.invalid/api/v2.5/detections?state=malformed",
    { status: 200, body: { results: [first, { ...second, threat: "high" }], count: 2 } }],
]);

https.request = ((options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
  const url = new URL(options.path!, `https://${options.hostname}`).href;
  const fixture = responses.get(url);
  const headers = options.headers as Record<string, string>;
  if (!fixture || options.method !== "GET" || headers.Authorization !== "Token packaged-detection-token") {
    throw new Error(`Unexpected synthetic request: ${options.method} ${url}`);
  }
  appendFileSync(process.env.DETECTION_TRACE!, JSON.stringify({ method: options.method, url }) + "\n");
  const response = Object.assign(new PassThrough(), { statusCode: fixture.status, headers: {} });
  const pending = Object.assign(new EventEmitter(), {
    end: () => queueMicrotask(() => {
      callback(response as unknown as IncomingMessage);
      response.end(JSON.stringify(fixture.body));
    }),
    destroy: (error?: Error): EventEmitter => {
      if (error) pending.emit("error", error);
      return pending;
    },
  });
  return pending as unknown as ClientRequest;
}) as typeof https.request;
syncBuiltinESMExports();
