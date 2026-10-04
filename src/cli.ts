import { runAxiCli } from "axi-sdk-js";
import { catalogue, DESCRIPTION, help, inventory, parseInvocation } from "./catalogue.js";
import { loadConfig, selectProfile } from "./profiles.js";
import { SecretRedactor } from "./redact.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let invocation: ReturnType<typeof parseInvocation>;
  const redactor = new SecretRedactor();
  const stdout = {
    write: (chunk: string) => process.stdout.write(redactor.text(chunk)),
    on: process.stdout.on.bind(process.stdout),
  };
  await runAxiCli({
    description: DESCRIPTION,
    // Route all input through the catalogue before SDK shortcuts or handlers.
    initialize: () => redactor.boundary(() => { invocation = parseInvocation(argv); }),
    argv: argv.length === 0 ? [] : ["shell"],
    topLevelHelp: "",
    stdout,
    home: () => redactor.boundary(state),
    commands: {
      shell: () => redactor.boundary(() => invocation.help ? help(invocation.home ? undefined : invocation.leaf) : state()),
    },
  });

  function state(): Record<string, unknown> {
    const loaded = loadConfig(invocation.flags.get("config") as string | undefined, redactor);
    const count = Object.keys(loaded.config.profiles).length;
    const selected = count || invocation.flags.has("profile") || process.env.VECTRA_AXI_PROFILE
      ? selectProfile(loaded.config, invocation.flags.get("profile") as string | undefined) : undefined;
    return {
      ...(invocation.home ? {} : { command: `vectra-axi ${invocation.leaf}` }),
      state: selected ? "configured" : "unconfigured",
      profiles: count,
      ...(selected ? { profile: {
        name: selected.name, source: selected.source, kind: selected.kind, origin: selected.origin,
        apiVersion: selected.apiVersion, ...(selected.applianceRelease ? { applianceRelease: selected.applianceRelease } : {}),
        auth: selected.auth, tls: selected.caBundle ? "verified with private CA" : "verified with system CAs",
        writes: "disabled",
      } } : {}),
      setup: {
        config: loaded.path,
        guidance: "Hand-edit profiles in this user config or select --config <path>; secrets use tokenEnv references",
        example: { profiles: { lab: { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "VECTRA_LAB_TOKEN" } } },
        integration: "Session integration is planned in PACK-01",
      },
      capabilities: {
        implemented: Object.keys(catalogue),
        api: "No API operations are implemented",
        planned: inventory.operations.filter((operation) => operation.disposition === "planned").length,
        blocked: inventory.operations.filter((operation) => operation.disposition === "blocked").length,
      },
      help: ["Run vectra-axi setup --help", "Run vectra-axi --help"],
    };
  }
}
