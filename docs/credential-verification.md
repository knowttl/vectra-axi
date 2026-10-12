# Credential migration verification

This migration implements the [AXI credential standard](https://github.com/knowttl/artium-axi/blob/main/docs/credential-standard.md) for vectra-axi and closes I-01, I-03, I-06 and I-16.
It changes config and journal paths, credential references, permission enforcement, local auth inspection and the packaged profile schema.
It does not add a credential store or login flow.

Run build, lint, docs checks and the complete Vitest suite with temporary HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, APPDATA and LOCALAPPDATA directories.
The suite denies external network connections and uses synthetic credentials only.

Verify legacy-path errors, selector precedence, complete and partial env profiles, strict SecretRefs, default references and old-key compatibility.
Verify private-file ownership, regular-file and symlink checks, config versus secret mode checks, atomic replacement, failure cleanup and durable journal ordering.
Verify packaged `config path`, `profile list` and `auth status`, the included schema and its `x-secret` annotations.
Verify exact secret redaction in raw, JSON-escaped, URL-encoded and Basic-auth forms, minted OAuth tokens, service payloads and journal metadata.

Windows directory/file DACL application, verification selection, UNC/device-path rejection and transient rename retries are covered with fakes on Linux.
No real Windows permission run was performed here.
A real Windows config write and `auth status` should be checked before release.
