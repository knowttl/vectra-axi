import { AxiError } from "axi-sdk-js";

const REDACTED = "***redacted***";

// One invocation owns this registry, including secrets from every configured profile.
export class SecretRedactor {
  private readonly secrets = new Set<string>();

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
