import { AxiError } from "axi-sdk-js";
import { authFailure, tlsOptions } from "./auth.js";
import type { LoadedConfig, SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

export type OAuthProfile = Extract<SelectedProfile, { auth: "oauth" }>;
export type OAuthCredential = { header: string; expiresAt: number };

export function tokenRoute(profile: Pick<OAuthProfile, "kind" | "apiVersion">): {
  operation: "qux.oauth.exchange" | "rux.oauth.exchange"; url: string;
} {
  if (profile.kind === "rux") return { operation: "rux.oauth.exchange", url: "/oauth2/token" };
  return { operation: "qux.oauth.exchange", url: `/api/v${profile.apiVersion}/oauth2/token` };
}

// CORE-01 implements this named exchange, including destination checks and bounded HTTP.
// This is internal credential material, never a command result or a business POST grant.
export type TokenTransport = (request: {
  operation: "qux.oauth.exchange" | "rux.oauth.exchange";
  method: "POST";
  url: string;
  headers: { Authorization: string; "Content-Type": "application/x-www-form-urlencoded" };
  body: "grant_type=client_credentials" | `grant_type=refresh_token&refresh_token=${string}`;
  tls: ReturnType<typeof tlsOptions>;
  signal?: AbortSignal;
}) => Promise<{ status: number; body: unknown }>;

export function oauthCredentials(
  profile: OAuthProfile, configPath: LoadedConfig["path"], redactor: SecretRedactor, transport: TokenTransport,
): (signal?: AbortSignal) => Promise<OAuthCredential> {
  const { origin, clientId, secretEnv } = profile;
  const route = tokenRoute(profile);
  const generation = profile.kind === "rux" ? "RUX v3.4" : "QUX v2.5";
  let cached: OAuthCredential | undefined;
  let refresh: { token: string; expiresAt?: number } | undefined;
  const spentRefreshTokens = new Set<string>();

  return async (signal) => {
    signal?.throwIfAborted();
    if (cached && Date.now() < cached.expiresAt) return { ...cached };
    cached = undefined;
    const secret = process.env[secretEnv];
    redactor.add(secret);
    if (!secret?.trim()) {
      throw new AxiError("The profile's OAuth secret environment reference is unset or empty", "AUTH_REQUIRED", [
        "Set the environment variable named by secretEnv to the API client's secret; UI login is not reused",
      ]);
    }
    const authorization = `Basic ${Buffer.from(`${clientId}:${secret}`, "utf8").toString("base64")}`;
    redactor.add(authorization.slice("Basic ".length));
    const tls = tlsOptions(profile, configPath);
    const exchange = async (grant: Parameters<TokenTransport>[0]["body"]) => {
      const started = Date.now();
      let response: Awaited<ReturnType<TokenTransport>>;
      try {
        response = await transport({
          operation: route.operation, method: "POST", url: `${origin}${route.url}`,
          headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
          body: grant, tls, ...(signal ? { signal } : {}),
        });
      } catch (error) {
        signal?.throwIfAborted();
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
        throw authFailure({ code }) ?? new AxiError("OAuth credential exchange could not complete", "AUTH_EXCHANGE_FAILED", [
          `Check connectivity and the ${profile.kind === "rux" ? "RUX v3.4" : "QUX"} API client configuration; no automatic retry was attempted`,
        ]);
      }
      const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      for (const key of ["access_token", "refresh_token"] as const) {
        if (typeof body[key] === "string") redactor.add(body[key]);
      }
      signal?.throwIfAborted();
      return { response, body, started };
    };
    const availableRefresh = refresh;
    refresh = undefined;
    let result: Awaited<ReturnType<typeof exchange>>;
    if (availableRefresh && !spentRefreshTokens.has(availableRefresh.token)
      && (availableRefresh.expiresAt === undefined || Date.now() < availableRefresh.expiresAt)) {
      spentRefreshTokens.add(availableRefresh.token);
      result = await exchange(`grant_type=refresh_token&refresh_token=${encodeURIComponent(availableRefresh.token)}`);
      if ([400, 401, 403].includes(result.response.status)) result = await exchange("grant_type=client_credentials");
    } else {
      result = await exchange("grant_type=client_credentials");
    }
    const { response, body, started } = result;
    if (response.status === 401 || (response.status === 400 && body.error === "invalid_client")) {
      throw new AxiError("OAuth client credentials were rejected", "AUTH_FAILED", ["Check clientId and the secret referenced by secretEnv"]);
    }
    const failure = authFailure({ status: response.status });
    if (failure) throw failure;
    if (response.status !== 200) {
      throw new AxiError("OAuth credential exchange failed", "AUTH_EXCHANGE_FAILED", [
        `Check the ${generation} token endpoint and service availability; no automatic retry was attempted`,
      ]);
    }
    if (typeof body.access_token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) || /\s/.test(body.access_token)
      || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
      || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)
      || !Number.isSafeInteger(started + body.expires_in * 1000)) {
      throw new AxiError("OAuth token response is malformed", "AUTH_RESPONSE_INVALID", [
        `Check the ${generation} API contract: access_token, Bearer token_type and numeric expires_in are required`,
      ]);
    }
    // Start conservatively before the exchange, so transport delay cannot extend validity.
    const expiresAt = started + body.expires_in * 1000;
    if (expiresAt <= Date.now()) {
      throw new AxiError("Returned OAuth credential has already expired", "AUTH_EXPIRED", [
        "Check the token endpoint's returned expiry and exchange latency; acquire a new client-credentials token",
      ]);
    }
    cached = { header: `Bearer ${body.access_token}`, expiresAt };
    if (profile.kind === "rux" && typeof body.refresh_token === "string" && body.refresh_token
      && body.refresh_token.isWellFormed() && !spentRefreshTokens.has(body.refresh_token)) {
      const refreshExpiresAt = typeof body.refresh_expires_in === "number"
        ? started + body.refresh_expires_in * 1000 : undefined;
      if (body.refresh_expires_in === undefined
        || (refreshExpiresAt !== undefined && Number.isSafeInteger(refreshExpiresAt) && refreshExpiresAt > Date.now())) {
        refresh = { token: body.refresh_token, ...(refreshExpiresAt === undefined ? {} : { expiresAt: refreshExpiresAt }) };
      }
    }
    return { ...cached };
  };
}
