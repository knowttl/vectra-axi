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
const rule7 = { id: 7, enabled: true, triage_category: "synthetic-triage",
  description: "Synthetic automation", detection: "synthetic-detection", is_whitelist: false,
  source_conditions: { OR: [] }, additional_conditions: null };
const ruxDetection1 = { id: 1, detection_type: "synthetic-type", state: "active", threat: 71, certainty: 80 };
const ruxEntity7 = { id: 7, name: "synthetic-host-7", type: "host", urgency_score: 76, importance: 3 };
const ruxGroup8 = { id: 8, name: "synthetic-cloud-group", type: "account" };
const ruxAccountMember = { uid: "synthetic-account@fixture.invalid" };
const ruxRule7 = { id: 7, enabled: true, triage_category: "synthetic-triage",
  description: "Synthetic automation", detection: "synthetic-detection", is_whitelist: false,
  source_conditions: null, additional_conditions: null };
const ruxHealthEvent1 = { id: 101, health_check_name: "cpu", status: "OK",
  event_timestamp: "2026-10-01T12:00:00Z" };
const ruxHealthEvent2 = { id: 102, health_check_name: "disk", status: "WARNING",
  event_timestamp: "2026-10-01T12:05:00Z" };
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
  // READ-07: health snapshots are single versioned bodies with cached/fresh
  // semantics from the request flags; the event feed is one checkpoint batch
  // per read with its returned checkpoint, never a computed next ID.
  ["https://fixture.invalid/api/v2.5/health",
    { status: 200, body: { network: { status: "ok" }, system: { status: "ok" },
      updated_at: "2026-10-01T12:00:00Z" } }],
  ["https://fixture.invalid/api/v2.5/health?cache=false",
    { status: 200, body: { network: { status: "ok" }, system: { status: "ok" } } }],
  ["https://fixture.invalid/api/v2.5/health/cpu",
    { status: 200, body: { cpu: { status: "ok", load: 12 } } }],
  ["https://fixture.invalid/api/v2.5/health?vlans=false",
    { status: 200, body: { network: { status: "ok" }, system: { status: "ok" },
      updated_at: "2026-10-01T12:00:00Z" } }],
  ["https://fixture.invalid/api/v2.5/events/health",
    { status: 200, body: { next_checkpoint: "chk-2", remaining_count: 0, events: [
      { id: 101, health_check_name: "cpu", status: "ok", event_timestamp: "2026-10-01T12:00:00Z" },
      { id: 102, health_check_name: "disk", status: "warning", event_timestamp: "2026-10-01T12:05:00Z" },
    ] } }],
  ["https://fixture.invalid/api/v2.5/events/health?from=chk-2",
    { status: 200, body: { next_checkpoint: "chk-3", remaining_count: 0, events: [] } }],
  ["https://fixture.invalid/api/v2.5/events/health?from=chk-9",
    { status: 403, body: {} }],
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
  ["https://fixture.invalid/api/v2.5/groups?page_size=100",
    { status: 200, body: { results: [hostGroup8], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/groups/8/members?page_size=100",
    { status: 200, body: { results: [member7], count: 1 } }],
  ["https://fixture.invalid/api/v2.5/rules/7", { status: 200, body: rule7 }],
  // PACK-01: doctor checks each profile with one bounded detection read.
  // The bare list URL returns a first page with a continuation that a
  // one-row window keeps as evidence without following; the denied origin
  // exercises the synthetic access-failure journey.
  ["https://fixture.invalid/api/v2.5/detections",
    { status: 200, body: { results: [first], count: 2, next } }],
  ["https://denied.invalid/api/v2.5/detections", { status: 403, body: {} }],
  // READ-08: lockdown status arrives as one unpaged list per kind through
  // its own status route; there is no execution leaf to fixture.
  ["https://fixture.invalid/api/v2.5/lockdown/host",
    { status: 200, body: [{ host_id: 7, lock_date: "2026-09-30T12:00:00Z",
      locked_by: "synthetic-admin", unlock_date: null }] }],
  ["https://fixture.invalid/api/v2.5/lockdown/account", { status: 200, body: [] }],
  ["https://denied.invalid/api/v2.5/lockdown/host", { status: 403, body: {} }],
  // RUX-01: the packaged cloud doctor check performs the named unversioned
  // exchange only; the returned refresh token is accepted and never spent.
  ["https://fixture.invalid/oauth2/token",
    { status: 200, body: { access_token: "packaged-rux-token", token_type: "Bearer", expires_in: 3600,
      refresh_token: "packaged-rux-refresh" } }],
  // RUX-02: the packaged cloud read journey lists detections and entities
  // through the documented v3.4 routes with Bearer resource use. Cloud IDs
  // stay scoped to the cloud profile; urgency/importance never fold into
  // threat/certainty.
  ["https://fixture.invalid/api/v3.4/detections/?state=active&page_size=100",
    { status: 200, body: { results: [ruxDetection1], count: 1 } }],
  ["https://fixture.invalid/api/v3.4/detections/1/",
    { status: 200, body: { ...ruxDetection1, description: "synthetic cloud detail" } }],
  ["https://fixture.invalid/api/v3.4/entities/?type=host&page_size=100",
    { status: 200, body: { results: [ruxEntity7], count: 1 } }],
  // RUX-05: the packaged cloud group journey lists groups, shows one
  // group, pages account-kind members with their native uid identity, and
  // lists and shows a triage rule through the documented v3.4 routes.
  // Cloud IDs stay scoped to the cloud profile; rule output carries no
  // benign verdict.
  ["https://fixture.invalid/api/v3.4/groups/?include_members=false&page_size=100",
    { status: 200, body: { results: [ruxGroup8], count: 1 } }],
  ["https://fixture.invalid/api/v3.4/groups/8/?include_members=false",
    { status: 200, body: { ...ruxGroup8, member_count: 1 } }],
  ["https://fixture.invalid/api/v3.4/groups/8/members/?page_size=100",
    { status: 200, body: { results: [ruxAccountMember], count: 1 } }],
  ["https://fixture.invalid/api/v3.4/rules/?page_size=100",
    { status: 200, body: { results: [ruxRule7], count: 1 } }],
  ["https://fixture.invalid/api/v3.4/rules/7/",
    { status: 200, body: ruxRule7 }],
  // RUX-04 (part a): the packaged cloud journey reads notes through the
  // plural tvui_types segment and tags through the singular table segment.
  ["https://fixture.invalid/api/v3.4/detections/1/notes/",
    { status: 200, body: [{ id: 1, note: "synthetic cloud note" }] }],
  ["https://fixture.invalid/api/v3.4/tagging/host/7/",
    { status: 200, body: { status: "success", tag_id: 9, tags: ["synthetic-cloud-tag"] } }],
  // RUX-06: the packaged cloud health and lockdown journey reads a
  // snapshot, one check, one integer-checkpoint event batch and per-kind
  // lockdown status through the documented v3.4 routes with Bearer
  // resource use. Cloud IDs stay scoped to the cloud profile.
  ["https://fixture.invalid/api/v3.4/health/",
    { status: 200, body: { network: { status: "ok" }, updated_at: "2026-10-01T12:00:00Z" } }],
  ["https://fixture.invalid/api/v3.4/health/cpu/",
    { status: 200, body: { cpu: { status: "ok", load: 12 } } }],
  // RUX-06b: the packaged cloud journey reads one connector check with its
  // recorded filter flags and one fixed-route ping with no query.
  ["https://fixture.invalid/api/v3.4/health/edr/?edr_type=synthetic-edr",
    { status: 200, body: { edr: { status: "ok" } } }],
  ["https://fixture.invalid/api/v3.4/health/network_brain/ping/",
    { status: 200, body: { ping: { status: "ok" } } }],
  ["https://fixture.invalid/api/v3.4/events/health/",
    { status: 200, body: { next_checkpoint: 102, remaining_count: 0,
      events: [ruxHealthEvent1, ruxHealthEvent2] } }],
  ["https://fixture.invalid/api/v3.4/events/health/?from=102",
    { status: 200, body: { next_checkpoint: 102, remaining_count: 0, events: [] } }],
  ["https://fixture.invalid/api/v3.4/lockdown/?type=host",
    { status: 200, body: [{ entity_id: 7, type: "host", locked_by: "synthetic-admin",
      lock_event_timestamp: "2026-09-30T12:00:00Z", unlock_event_timestamp: null }] }],
  ["https://fixture.invalid/api/v3.4/lockdown/?type=account", { status: 200, body: [] }],
]);

// WRITE-01: the gated host tag replace sends one PATCH after its preview
// read; the accepted replace answers 200 with an empty body.
// WRITE-02: the gated detection note append sends one POST after its
// preview read; the accepted append answers 200 with an empty body.
const mutations = new Map<string, { status: number; body: unknown }>([
  ["https://fixture.invalid/api/v2.5/tagging/host/7", { status: 200, body: {} }],
  ["https://fixture.invalid/api/v2.5/detections/42/notes", { status: 200, body: {} }],
]);

https.request = ((options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
  const url = new URL(options.path!, `https://${options.hostname}`).href;
  // Mutation fixtures answer PATCH/POST writes; every other request,
  // including the form-encoded OAuth exchange POST, uses the read map.
  const mutation = options.method === "GET" ? undefined : mutations.get(url);
  const fixture = mutation ?? responses.get(url);
  const headers = options.headers as Record<string, string>;
  const ruxExchange = url === "https://fixture.invalid/oauth2/token" && options.method === "POST"
    && (headers.Authorization ?? "").startsWith("Basic ")
    && headers["Content-Type"] === "application/x-www-form-urlencoded";
  const allowedMethod = options.method === "GET" || options.method === "PATCH" || options.method === "POST";
  // RUX-02: cloud resource reads carry the exchanged Bearer token.
  const ruxResource = options.method === "GET" && headers.Authorization === "Bearer packaged-rux-token";
  if (!fixture || !(allowedMethod && headers.Authorization === "Token packaged-detection-token"
    || ruxExchange || ruxResource)) {
    throw new Error(`Unexpected synthetic request: ${options.method} ${url}`);
  }
  const response = Object.assign(new PassThrough(), { statusCode: fixture.status, headers: {} });
  let sent = "";
  const pending = Object.assign(new EventEmitter(), {
    write: (chunk: string): boolean => {
      sent += chunk;
      return true;
    },
    end: () => {
      // Mutation trace lines carry the replace/append payload; all other
      // lines keep the established shape so existing trace assertions
      // still match.
      appendFileSync(process.env.DETECTION_TRACE!, JSON.stringify({ method: options.method, url,
        ...(mutation ? { body: sent ? JSON.parse(sent) as unknown : {} } : {}) }) + "\n");
      queueMicrotask(() => {
        callback(response as unknown as IncomingMessage);
        response.end(JSON.stringify(fixture.body));
      });
    },
    destroy: (error?: Error): EventEmitter => {
      if (error) pending.emit("error", error);
      return pending;
    },
  });
  return pending as unknown as ClientRequest;
}) as typeof https.request;
syncBuiltinESMExports();
