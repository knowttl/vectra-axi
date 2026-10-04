import "./network-guard.js";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import https, { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

const first = { id: 1, detection_type: "synthetic-type", state: "active", threat: null, certainty: 80 };
const second = { ...first, id: 2, threat: 72 };
const host7 = { id: 7, name: "synthetic-host-7", state: "active", threat: 90, certainty: 80 };
const account7 = { id: 7, name: "synthetic-account-7", state: "active", threat: 10, certainty: 20 };
const openAssignment = { id: 11, host_id: 7, account_id: null, date_resolved: null };
const resolvedAssignment = { id: 12, host_id: null, account_id: 7, date_resolved: "2026-09-30T12:00:00Z" };
const outcome1 = { id: 1, title: "Benign True Positive", category: "benign_true_positive", builtin: true };
const user3 = { id: 3, username: "soc-analyst" };
const hostGroup8 = { id: 8, name: "synthetic-host-group", type: "host" };
const member7 = { id: 7, name: "synthetic-host-7" };
const rule7 = { id: 7, enabled: true, triage_category: "synthetic-triage" };
const next = "https://fixture.invalid/api/v2.5/detections?state=active&threat_gte=70&min_id=2";
const responses = new Map<string, { status: number; body: unknown }>([
  ["https://fixture.invalid/api/v2.5/detections?ordering=-id",
    { status: 200, body: { results: [second, first], count: 2 } }],
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
  ["https://fixture.invalid/api/v2.5/hosts/7", { status: 200, body: host7 }],
  ["https://fixture.invalid/api/v2.5/accounts/7", { status: 200, body: account7 }],
  ["https://fixture.invalid/api/v2.5/hosts?t_score_gte=70",
    { status: 200, body: { results: [host7], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/detections/42/notes",
    { status: 200, body: [{ id: 1, note: "synthetic detail ".repeat(100) }, { id: 2, note: "short synthetic note" }] }],
  ["https://fixture.invalid/api/v2.5/tagging/host/7", { status: 200, body: { tags: ["synthetic-tag"] } }],
  ["https://fixture.invalid/api/v2.5/accounts/7/notes", { status: 200, body: [] }],
  // READ-04: unresolved and resolved assignments stay distinct rows; the
  // resolution taxonomy and users are separate resources on their own routes.
  ["https://fixture.invalid/api/v2.5/assignments?resolved=false&page_size=100",
    { status: 200, body: { results: [openAssignment], count: 2,
      next: "https://fixture.invalid/api/v2.5/assignments?resolved=false&page=2" } }],
  ["https://fixture.invalid/api/v2.5/assignments?resolved=false&page=2",
    { status: 200, body: { results: [resolvedAssignment], count: 2, next: null } }],
  ["https://fixture.invalid/api/v2.5/assignments?resolved=true&page_size=100", { status: 403, body: {} }],
  ["https://fixture.invalid/api/v2.5/assignment_outcomes?page_size=100",
    { status: 200, body: { results: [outcome1], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/assignment_outcomes/1", { status: 200, body: outcome1 }],
  ["https://fixture.invalid/api/v2.5/users?page_size=100",
    { status: 200, body: { results: [user3], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/users/3", { status: 200, body: user3 }],
  ["https://fixture.invalid/api/v2.5/users?username=nobody&page_size=100",
    { status: 200, body: { results: [], count: 0 } }],
  // READ-06: audits arrive as one date-windowed list, never a paged
  // collection; both ISO dates are required and applied inclusively.
  ["https://fixture.invalid/api/v2.5/audits?start=2026-10-01&end=2026-10-02",
    { status: 200, body: [
      { user: "synthetic-admin", role: "Super Admin", vectra_timestamp: "2026-10-01T12:00:00Z",
        result: "success", message: "synthetic audit one" },
      { user: "synthetic-api-client", role: "Read Only", vectra_timestamp: "2026-10-02T08:30:00Z",
        result: "failure", message: "synthetic audit two" },
    ] }],
  ["https://fixture.invalid/api/v2.5/audits?start=2026-10-03&end=2026-10-03",
    { status: 200, body: [] }],
  ["https://fixture.invalid/api/v2.5/audits?start=2026-10-04&end=2026-10-04",
    { status: 403, body: {} }],
  // READ-05: group kinds pass through verbatim, membership comes from the
  // paged member route scoped to one group, and triage rules carry no
  // benign verdict.
  ["https://fixture.invalid/api/v2.5/groups",
    { status: 200, body: { results: [hostGroup8], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/groups/8/members?page_size=100",
    { status: 200, body: { results: [member7], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/rules/7", { status: 200, body: rule7 }],
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
