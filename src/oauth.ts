import { AxiError } from "axi-sdk-js";
import { authFailure, tlsOptions } from "./auth.js";
import type { LoadedConfig, SelectedProfile } from "./profiles.js";
import type { SecretRedactor } from "./redact.js";

export type OAuthProfile = Extract<SelectedProfile, { auth: "oauth" }>;
export type OAuthCredential = { header: string; expiresAt: number };

// CORE-01 implements this named exchange, including destination checks and bounded HTTP.
// This is internal credential material, never a command result or a business POST grant.
export type TokenTransport = (request: {
  operation: "qux.oauth.exchange";
  method: "POST";
  url: string;
  headers: { Authorization: string; "Content-Type": "application/x-www-form-urlencoded" };
  body: "grant_type=client_credentials";
  tls: ReturnType<typeof tlsOptions>;
}) => Promise<{ status: number; body: unknown }>;

export function oauthCredentials(
  profile: OAuthProfile, configPath: LoadedConfig["path"], redactor: SecretRedactor, transport: TokenTransport,
): () => Promise<OAuthCredential> {
  const { origin, apiVersion, clientId, secretEnv } = profile;
  let cached: OAuthCredential | undefined;

  return async () => {
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
    const started = Date.now();
    let response: Awaited<ReturnType<TokenTransport>>;
    try {
      response = await transport({
        operation: "qux.oauth.exchange", method: "POST", url: `${origin}/api/v${apiVersion}/oauth2/token`,
        headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials", tls,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      throw authFailure({ code }) ?? new AxiError("OAuth credential exchange could not complete", "AUTH_EXCHANGE_FAILED", [
        "Check connectivity and the QUX API client configuration; no automatic retry was attempted",
      ]);
    }
    const body = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
    // Register returned credential material even when the response is rejected.
    for (const key of ["access_token", "refresh_token"] as const) {
      if (typeof body[key] === "string") redactor.add(body[key]);
    }
    if (response.status === 401 || (response.status === 400 && body.error === "invalid_client")) {
      throw new AxiError("OAuth client credentials were rejected", "AUTH_FAILED", ["Check clientId and the secret referenced by secretEnv"]);
    }
    const failure = authFailure({ status: response.status });
    if (failure) throw failure;
    if (response.status !== 200) {
      throw new AxiError("OAuth credential exchange failed", "AUTH_EXCHANGE_FAILED", [
        "Check the QUX v2.5 token endpoint and service availability; no automatic retry was attempted",
      ]);
    }
    if (typeof body.access_token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(body.access_token) || /\s/.test(body.access_token)
      || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
      || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)
      || !Number.isSafeInteger(started + body.expires_in * 1000)) {
      throw new AxiError("OAuth token response is malformed", "AUTH_RESPONSE_INVALID", [
        "Check the QUX v2.5 API contract: access_token, Bearer token_type and numeric expires_in are required",
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
    return { ...cached };
  };
}
