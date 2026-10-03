import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { vi } from "vitest";

// The inventory suite has no network boundary to exercise.
const denyNetwork = (): never => {
  throw new Error("External network is denied in tests");
};
vi.stubGlobal("fetch", denyNetwork);
vi.spyOn(net.Socket.prototype, "connect").mockImplementation(denyNetwork);
vi.spyOn(tls, "connect").mockImplementation(denyNetwork);
syncBuiltinESMExports();
