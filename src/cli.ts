import { runAxiCli } from "axi-sdk-js";
import { catalogue, DESCRIPTION, help, inventory, parseInvocation } from "./catalogue.js";
import { listFields, listLimit, listQuery, runDetectionList, runDetectionShow, showId, type LeafResult } from "./detections.js";
import { entityKind, listFields as entityListFields, listLimit as entityListLimit, listQuery as entityListQuery,
  runAccountList, runAccountShow, runEntityList, runEntityShow, runHostList, runHostShow,
  showId as entityShowId } from "./entities.js";
import { loadConfig, selectProfile } from "./profiles.js";
import { SecretRedactor } from "./redact.js";
import { createSession, nodeTransport, type RawTransport } from "./session.js";

export async function main(argv = process.argv.slice(2), transport: RawTransport = nodeTransport()): Promise<void> {
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
    home: () => guarded(async () => state()),
    commands: {
      // Leaf validation throws before any profile or transport work, so
      // unknown flags and invalid combinations never reach credentials.
      shell: () => guarded(async (): Promise<Record<string, unknown>> => {
        if (invocation.help) return help(invocation.home ? undefined : invocation.leaf);
        if (invocation.leaf === "detection list" || invocation.leaf === "detection show") {
          return runDetection(invocation.leaf, invocation.flags);
        }
        if (invocation.leaf === "host list" || invocation.leaf === "host show"
          || invocation.leaf === "account list" || invocation.leaf === "account show"
          || invocation.leaf === "entity list" || invocation.leaf === "entity show") {
          return runEntity(invocation.leaf, invocation.flags);
        }
        return state();
      }),
    },
  });

  // Await async failures before applying the synchronous redactor boundary,
  // so the SDK only receives scrubbed errors.
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      return redactor.boundary((): T => { throw error; });
    }
  }

  // One dispatch for every host/account/entity leaf: validate the kind and
  // flags, select the profile, build the session on the injected transport,
  // and report partial reads with their rows and a nonzero exit status.
  type EntityLeaf = "host list" | "host show" | "account list" | "account show" | "entity list" | "entity show";
  async function runEntity(leaf: EntityLeaf, flags: ReadonlyMap<string, string | boolean>): Promise<Record<string, unknown>> {
    const facade = leaf.startsWith("entity ");
    if (facade) entityKind(flags);
    if (leaf.endsWith(" list")) {
      entityListQuery(flags, facade);
      entityListLimit(flags);
      entityListFields(flags, facade);
    } else {
      entityShowId(flags, leaf);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LeafResult = leaf === "host list" ? await runHostList(session, flags)
      : leaf === "account list" ? await runAccountList(session, flags)
      : leaf === "entity list" ? await runEntityList(session, flags)
      : leaf === "host show" ? await runHostShow(session, flags)
      : leaf === "account show" ? await runAccountShow(session, flags)
      : await runEntityShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
  // One dispatch for every detection leaf: validate flags, select the
  // profile, build the session on the injected transport, and report
  // partial reads with their rows and a nonzero exit status.
  async function runDetection(
    leaf: "detection list" | "detection show", flags: ReadonlyMap<string, string | boolean>,
  ): Promise<Record<string, unknown>> {
    if (leaf === "detection list") {
      listQuery(flags);
      listLimit(flags);
      listFields(flags);
    } else {
      showId(flags);
    }
    const loaded = loadConfig(flags.get("config") as string | undefined, redactor);
    const selected = selectProfile(loaded.config, flags.get("profile") as string | undefined);
    const session = createSession({ profile: selected, configPath: loaded.path, redactor, transport });
    const result: LeafResult = leaf === "detection list"
      ? await runDetectionList(session, flags)
      : await runDetectionShow(session, flags);
    if (result.failed) process.exitCode = 1;
    return result.output;
  }
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
        guidance: "Hand-edit profiles in this user config or select --config <path>; secrets use tokenEnv or secretEnv references",
        example: { profiles: { lab: { kind: "qux", origin: "https://fixture.invalid", apiVersion: "2.5", auth: "token", tokenEnv: "VECTRA_LAB_TOKEN" } } },
        integration: "Detection, host, account and type-qualified entity reads call the session; remaining session integration is planned in PACK-01",
      },
      capabilities: {
        implemented: Object.keys(catalogue),
        api: "QUX v2.5 detection, host, account and type-qualified entity reads; every other operation is planned or blocked",
        planned: inventory.operations.filter((operation) => operation.disposition === "planned").length,
        blocked: inventory.operations.filter((operation) => operation.disposition === "blocked").length,
      },
      help: ["Run vectra-axi setup --help", "Run vectra-axi --help"],
    };
  }
}
