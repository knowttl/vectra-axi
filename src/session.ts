import { request as nodeRequest } from "node:https";
import { AxiError } from "axi-sdk-js";
import { authFailure, resolveToken, tlsOptions } from "./auth.js";
import { inventory } from "./catalogue.js";
import type { CapabilityOperation } from "./inventory/schema.js";
import { oauthCredentials, type TokenTransport } from "./oauth.js";
import type { LoadedConfig, SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

// Single HTTP seam for the session. Tests inject a fake; production uses nodeTransport.
// Responses arrive as bounded text; the session core validates JSON and policy.
export type RawTransport = (request: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  tls: ReturnType<typeof tlsOptions>;
}) => Promise<{ status: number; location?: string; bodyText: string }>;

export type SessionRequestOptions = {
  pathParams?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, string | number | boolean>>;
};

export type SessionResponse = { status: number; body: unknown };

// The only authenticated interface command handlers receive. No transport,
// fetch handle or credential material is exposed on this object.
export type Session = {
  readonly profile: Pick<SelectedProfile, "name" | "kind" | "origin" | "apiVersion">;
  request(operation: string, options?: SessionRequestOptions): Promise<SessionResponse>;
  resolveContinuation(operation: string, next: string, options?: Pick<SessionRequestOptions, "pathParams">): string;
};

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

function versionPrefix(profile: SelectedProfile): string {
  return `/api/v${profile.apiVersion}/`;
}

// One path owns operation authorization: known QUX read operations only.
// The credential-exchange route is blocked here; the session drives it internally.
function authorizeOperation(profile: SelectedProfile, operation: string): CapabilityOperation {
  const record = inventory.operations.find((candidate) => candidate.id === operation);
  if (!record || record.deployment !== profile.kind) {
    throw new AxiError(`Unknown Vectra operation: ${operation}`, "OPERATION_UNKNOWN", [
      "Use a known QUX v2.5 operation from the capability inventory; RUX operations need a cloud profile",
    ]);
  }
  if (record.effect !== "read" || record.method !== "GET") {
    throw new AxiError(`Refusing non-read Vectra operation: ${operation}`, "OPERATION_BLOCKED", [
      "The session sends reviewed read operations and the named credential exchange only",
      "Credential-export and write operations are never available through this session",
    ]);
  }
  return record;
}

function cleanParam(name: string, value: string | number): string {
  const text = String(value);
  if (!text || /[\s\x00-\x1f\x7f/]/.test(text) || text === "." || text === "..") {
    throw new AxiError(`Invalid path parameter: ${name}`, "VALIDATION_ERROR", [
      "Path parameters must be non-empty without slashes, whitespace or dot segments",
    ]);
  }
  return encodeURIComponent(text);
}

// URL construction validates the template binding, then re-checks the built
// destination before any credential is resolved or attached.
function buildOperationUrl(
  profile: SelectedProfile, record: CapabilityOperation, options?: SessionRequestOptions,
): string {
  const params = options?.pathParams ?? {};
  const path = record.path.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new AxiError(`Missing path parameter: ${name}`, "VALIDATION_ERROR", [
        `Provide ${name} for operation ${record.id}`,
      ]);
    }
    return cleanParam(name, params[name]!);
  });
  for (const name of Object.keys(params)) {
    if (!record.path.includes(`{${name}}`)) {
      throw new AxiError(`Unexpected path parameter: ${name}`, "VALIDATION_ERROR", [
        `Operation ${record.id} accepts path parameters only for its declared route template`,
      ]);
    }
  }
  const url = new URL(path, profile.origin);
  const query = options?.query ?? {};
  for (const [key, value] of Object.entries(query)) {
    if (!record.query.includes(key)) {
      throw new AxiError(`Unsupported query parameter: ${key}`, "VALIDATION_ERROR", [
        `Operation ${record.id} supports: ${record.query.join(", ") || "no query parameters"}`,
      ]);
    }
    if (value === null || value === undefined || typeof value === "object") {
      throw new AxiError(`Invalid query value for: ${key}`, "VALIDATION_ERROR", [
        "Query values must be scalar strings, numbers or booleans",
      ]);
    }
    url.searchParams.set(key, String(value));
  }
  assertDestination(profile, record, url, path);
  return url.href;
}

// Destination enforcement shared by initial requests, redirects and next links.
// A credentialed request never leaves the profile's HTTPS origin, so a denied
// destination fails before credential resolution and before any HTTP call.
function assertDestination(profile: SelectedProfile, record: CapabilityOperation, url: URL, path: string): void {
  if (url.protocol !== "https:" || url.origin !== profile.origin
    || !url.pathname.startsWith(versionPrefix(profile))) {
    throw new AxiError(`Refusing destination outside the profile origin for operation ${record.id}`, "DESTINATION_DENIED", [
      `Destinations must stay under ${profile.origin}${versionPrefix(profile)}; no credential was sent`,
    ]);
  }
  if (url.pathname !== path || [...url.searchParams.keys()].some((key) => !record.query.includes(key))) {
    throw new AxiError(`Refusing destination outside operation ${record.id}`, "DESTINATION_DENIED", [
      "Destinations must retain the operation's bound route and use only its declared query keys; no credential was sent",
    ]);
  }
}

function resolveLink(
  profile: SelectedProfile, record: CapabilityOperation, path: string, current: string, location: string,
): string {
  let url: URL;
  try {
    url = new URL(location, current);
  } catch {
    throw new AxiError(`Invalid redirect destination for operation ${record.id}`, "DESTINATION_DENIED", [
      "The server returned a destination that cannot be parsed as a URL; no credential was sent",
    ]);
  }
  assertDestination(profile, record, url, path);
  return url.href;
}

async function sendRaw(
  profile: SelectedProfile, configPath: LoadedConfig["path"], redactor: SecretRedactor, transport: RawTransport,
  request: { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; location?: string; bodyText: string }> {
  const tls = tlsOptions(profile, configPath);
  try {
    return await transport({ ...request, tls });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : undefined;
    throw authFailure({ code })
      ?? new AxiError(`Request to ${profile.origin} could not complete`, "TRANSPORT_FAILED", [
        redactor.text(error instanceof Error ? error.message : String(error)),
        "Check connectivity to the profile origin; no automatic retry was attempted",
      ]);
  }
}

function decodeResourceBody(response: { status: number; bodyText: string }): unknown {
  const mapped = authFailure({ status: response.status });
  if (mapped) throw mapped;
  if (response.status !== 200) {
    throw new AxiError(`Vectra request returned status ${response.status}`, "REQUEST_FAILED", [
      "The session does not retry failed reads; bounded retry policy arrives with CORE-02",
    ]);
  }
  try {
    return JSON.parse(response.bodyText);
  } catch {
    throw new AxiError("Vectra response is not valid JSON", "RESPONSE_INVALID", [
      "Check the QUX v2.5 API contract for this operation; the response body was discarded",
    ]);
  }
}

// The sole TokenTransport implementation: the named exchange runs over the same
// adapter and destination checks as resource requests, never following redirects.
function exchangeTransport(profile: SelectedProfile, transport: RawTransport): TokenTransport {
  const exchange = inventory.operations.find((record) => record.id === `${profile.kind}.oauth.exchange`);
  const expected = exchange ? new URL(exchange.path, profile.origin).href : undefined;
  return async (request) => {
    if (request.method !== "POST" || request.url !== expected) {
      throw new AxiError("Refusing unexpected credential-exchange destination", "DESTINATION_DENIED", [
        "The OAuth exchange uses the named versioned token route only; no credential was sent",
      ]);
    }
    const response = await transport({ method: "POST", url: request.url, headers: request.headers, body: request.body, tls: request.tls });
    let body: unknown = {};
    try {
      body = response.bodyText ? JSON.parse(response.bodyText) as unknown : {};
    } catch {
      body = {};
    }
    return { status: response.status, body };
  };
}

export function createSession(args: {
  profile: SelectedProfile;
  configPath: LoadedConfig["path"];
  redactor: SecretRedactor;
  transport: RawTransport;
}): Session {
  const { profile, configPath, redactor, transport } = args;
  const snapshot = { name: profile.name, kind: profile.kind, origin: profile.origin, apiVersion: profile.apiVersion };
  const credentials = profile.auth === "oauth"
    ? oauthCredentials(profile, configPath, redactor, exchangeTransport(profile, transport))
    : async () => ({ header: resolveToken(profile, redactor) });

  async function request(operation: string, options?: SessionRequestOptions): Promise<SessionResponse> {
    const record = authorizeOperation(profile, operation);
    let current = buildOperationUrl(profile, record, options);
    const path = new URL(current).pathname;
    const authorization = (await credentials()).header;
    for (let hops = 0; ; hops++) {
      assertDestination(profile, record, new URL(current), path);
      const response = await sendRaw(profile, configPath, redactor, transport,
        { method: "GET", url: current, headers: { Authorization: authorization, Accept: "application/json" } });
      if (response.status < 300 || response.status > 399) return { status: 200, body: decodeResourceBody(response) };
      if (!response.location) {
        throw new AxiError(`Vectra redirect for ${record.id} has no destination`, "REQUEST_FAILED", [
          "The redirect response carried no Location header; no credential was forwarded",
        ]);
      }
      if (hops >= MAX_REDIRECTS) {
        throw new AxiError(`Too many redirects for ${record.id}`, "DESTINATION_DENIED", [
          "The session follows at most 3 same-origin redirects; no credential was forwarded further",
        ]);
      }
      current = resolveLink(profile, record, path, current, response.location);
    }
  }

  // CORE-02 follows collection and checkpoint links through this validator;
  // the session fetches nothing here, so validation alone cannot leak a credential.
  function resolveContinuation(operation: string, next: string, options?: Pick<SessionRequestOptions, "pathParams">): string {
    const record = authorizeOperation(profile, operation);
    const path = new URL(buildOperationUrl(profile, record, options)).pathname;
    let url: URL;
    try {
      url = new URL(next, profile.origin);
    } catch {
      throw new AxiError(`Invalid continuation link for ${record.id}`, "VALIDATION_ERROR", [
        "Continuation links must be absolute HTTPS URLs or server-relative paths",
      ]);
    }
    assertDestination(profile, record, url, path);
    return url.href;
  }

  return { profile: snapshot, request, resolveContinuation };
}

// Production adapter behind the single seam. Synthetic fixtures and fake
// transports cover tests; this function never runs against a real instance there.
export function nodeTransport(): RawTransport {
  return (request) => new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error(`request to ${url.origin} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      fail(error);
      pending.destroy(error);
    }, REQUEST_TIMEOUT_MS);
    const pending = nodeRequest({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: request.headers,
      ca: request.tls.ca,
      rejectUnauthorized: true,
    }, (response) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("response terminated before completion")));
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_BODY_LIMIT_BYTES) {
          const error = new Error(`response exceeded the ${RESPONSE_BODY_LIMIT_BYTES}-byte ceiling`);
          fail(error);
          pending.destroy(error);
        } else {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        clearTimeout(timer);
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          ...(location ? { location: Array.isArray(location) ? location[0] : location } : {}),
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    pending.on("error", fail);
    if (request.body !== undefined) pending.write(request.body);
    pending.end();
  });
}
