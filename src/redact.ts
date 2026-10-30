import { createHash } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { ResponseDiagnostics } from "./response-diagnostics.js";

const REDACTED = "***redacted***";

export function containsRedactedPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED);
  if (Array.isArray(value)) return value.some(containsRedactedPlaceholder);
  if (value && typeof value === "object") return Object.entries(value).some(([key, child]) => key.includes(REDACTED) || containsRedactedPlaceholder(child));
  return false;
}

// Export configurations can contain vendor-specific TLS and SASL credentials.
export function redactExportSettings(value: unknown, redactor = new SecretRedactor()): unknown {
  if (Array.isArray(value)) return value.map((child) => redactExportSettings(child, redactor));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactor.text(key),
    /password|passwd|pass.?phrase|secret|token|credential|key|cert|auth|url|jaas|connection.?string/i.test(key)
      ? REDACTED : redactExportSettings(child, redactor)]));
  return redactor.payload(value);
}

// One invocation owns this registry, including secrets from every configured profile.
export class SecretRedactor {
  readonly responseDiagnostics = new ResponseDiagnostics(this, ["RESPONSE_INVALID", "MALFORMED_RESPONSE"]);
  private readonly secrets = new Set<string>();
  private readonly notificationStates = new Map<string, string>();

  // Keep secret-only changes visible to the pre-send check without exposing raw state.
  notificationState(id: string): string | undefined {
    return this.notificationStates.get(id);
  }

  notificationSecrets(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.config && typeof record.config === "object" && "destination_params" in record.config
      && typeof record.id === "string") {
      this.notificationStates.set(record.id, createHash("sha256").update(JSON.stringify(value)).digest("hex"));
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "destination_params" && child && typeof child === "object") {
        const params = child as Record<string, unknown>;
        if (typeof params.url === "string") {
          this.add(params.url);
          try {
            const url = new URL(params.url);
            this.add(url.username);
            this.add(url.password);
            for (const token of url.searchParams.values()) this.add(token);
          } catch { /* Malformed webhook URLs are still registered in full. */ }
        }
      }
      if (/token|secret|password|authorization/i.test(key) && typeof child === "string") this.add(child);
      this.notificationSecrets(child);
    }
  }

  add(secret: string | undefined): void {
    if (secret) {
      this.secrets.add(secret);
      this.secrets.add(JSON.stringify(secret).slice(1, -1));
      if (secret.isWellFormed()) this.secrets.add(encodeURIComponent(secret));
    }
  }

  text(value: string): string {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      value = value.split(secret).join(REDACTED);
    }
    return value;
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((child) => this.value(child));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
    }
    return value;
  }

  // Service payloads carry unknown secrets as well as registered credentials.
  payload(value: unknown): unknown {
    this.notificationSecrets(value);
    if (typeof value === "string") return this.text(value)
      .replace(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g, REDACTED)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
      .replace(/(\bAccountKey=)[^;\s]+/gi, `$1${REDACTED}`)
      .replace(/([?&]sig=)[^&\s]+/gi, `$1${REDACTED}`);
    if (Array.isArray(value)) return value.map((child) => this.payload(child));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key),
      /^(?:password|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|accountkey|sas[_-]?token)$/i.test(key) ? REDACTED : this.payload(child)]));
    return value;
  }

  // Discard raw stacks/causes; the SDK only receives sanitized error metadata.
  boundary<T>(action: () => T): T {
    try { return action(); } catch (error) {
      const safe = error instanceof AxiError
        ? new AxiError(this.text(error.message), this.text(error.code), error.suggestions.map((hint) => this.text(hint)))
        : new Error(this.text(error instanceof Error ? error.message : String(error)));
      if (error && typeof error === "object" && "details" in error) {
        Object.assign(safe, { details: this.value(error.details) });
      }
      throw safe;
    }
  }
}
