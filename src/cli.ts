import { AxiError, runAxiCli } from "axi-sdk-js";
import { catalogue, DESCRIPTION, help, inventory, parseInvocation } from "./catalogue.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let invocation: ReturnType<typeof parseInvocation>;
  await runAxiCli({
    description: DESCRIPTION,
    // Route all input through the catalogue before SDK shortcuts or handlers.
    initialize: () => { invocation = parseInvocation(argv); },
    argv: argv.length === 0 ? [] : ["shell"],
    topLevelHelp: "",
    home: () => state(),
    commands: {
      shell: () => invocation.help ? help(invocation.home ? undefined : invocation.leaf) : state(),
    },
  });

  function state(): Record<string, unknown> {
    if (invocation.flags.has("profile")) {
      throw new AxiError("No profiles are configured; profile configuration is planned in AUTH-01", "PROFILE_REQUIRED", [
        "Run vectra-axi setup",
      ]);
    }
    return {
      ...(invocation.home ? {} : { command: `vectra-axi ${invocation.leaf}` }),
      state: "unconfigured",
      profiles: 0,
      setup: "Profile configuration is planned in AUTH-01; session integration is planned in PACK-01",
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
