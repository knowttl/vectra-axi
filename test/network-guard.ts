import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

// Shared by Vitest and packaged subprocesses, before any application imports.
const denyNetwork = (): never => {
  throw new Error("External network is denied in tests");
};
globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
syncBuiltinESMExports();
