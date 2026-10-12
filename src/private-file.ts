import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AxiError } from "axi-sdk-js";

type AclAction = "restrict" | "verify" | "check";
export type WindowsAcl = (path: string, action: AclAction, directory: boolean) => void;

export const windowsAcl: WindowsAcl = (path, action, directory) => {
  const quoted = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $p=${quoted}; $item=Get-Item -LiteralPath $p -Force; `
    + `if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }; `
    + `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544'); `
    + (action === "check" ? "" : action === "restrict"
      ? `$acl=New-Object Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); `
        + `foreach ($s in $allowed) { $id=New-Object Security.Principal.SecurityIdentifier($s); $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','${directory ? "ContainerInherit,ObjectInherit" : "None"}','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl`
      : `$acl=Get-Acl -LiteralPath $p; if (!$acl.AreAccessRulesProtected -or $acl.Owner -ne $sid.Translate([Security.Principal.NTAccount]).Value -and $acl.Owner -ne $sid.Value) { throw 'Unprotected ACL' }; `
        + `$seen=@(); foreach ($r in $acl.Access) { $s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if ($s -notin $allowed -or $r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected ACL' }; $seen+=$s }; foreach ($s in $allowed) { if ($s -notin $seen) { throw 'Missing ACL' } }`);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
};

export function toolDirectory(kind: "config" | "state", env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "win32") return join(env[kind === "config" ? "APPDATA" : "LOCALAPPDATA"] ?? join(home, "AppData", kind === "config" ? "Roaming" : "Local"), "vectra-axi");
  const xdg = env[kind === "config" ? "XDG_CONFIG_HOME" : "XDG_STATE_HOME"];
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, kind === "config" ? ".config" : ".local/state"), "vectra-axi");
}

export function configMoved(legacy: string, path: string): AxiError {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return new AxiError(`Configuration moved from ${legacy} to ${path}`, "CONFIG_MOVED", [
    process.platform === "win32" ? `New-Item -ItemType Directory -Force ${psQuote(dirname(path))}; Move-Item -LiteralPath ${psQuote(legacy)} -Destination ${psQuote(path)}`
      : `mkdir -p ${quote(dirname(path))} && mv -n ${quote(legacy)} ${quote(path)}`,
  ]);
}

export function privateFiles(options: { platform?: NodeJS.Platform; acl?: WindowsAcl; uid?: number; rename?: typeof renameSync; wait?: (ms: number) => void } = {}) {
  const platform = options.platform ?? process.platform;
  const acl = options.acl ?? windowsAcl;
  const insecure = (path: string): never => { throw new AxiError(`Insecure private file: ${path}`, "CONFIG_INSECURE", [platform === "win32" ? `Re-run the tool's write to protect ${path}` : `chmod 600 '${path.replaceAll("'", "'\\''")}'`]); };
  function flushDirectory(path: string): void {
    if (platform === "win32") return;
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function check(path: string, secret = false, verifyAcl = false): void {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) insecure(path);
    if (platform === "win32") {
      try { acl(path, verifyAcl ? "verify" : "check", false); } catch { insecure(path); }
    } else if (stat.uid !== (options.uid ?? process.getuid!()) || (stat.mode & (secret ? 0o077 : 0o022)) !== 0) insecure(path);
  }
  function directory(path: string): void {
    const first = mkdirSync(path, { recursive: true, ...(platform === "win32" ? {} : { mode: 0o700 }) });
    let current = path;
    for (;;) {
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) insecure(current);
      try {
        if (platform === "win32") acl(current, "restrict", true);
        else chmodSync(current, 0o700);
      } catch { insecure(current); }
      if (first) flushDirectory(current);
      if (!first || current === first) break;
      current = dirname(current);
    }
    if (first) flushDirectory(dirname(first));
  }
  function protect(path: string): void {
    check(path);
    if (platform === "win32") { try { acl(path, "restrict", false); } catch { insecure(path); } }
    else chmodSync(path, 0o600);
  }
  function write(path: string, content: string): void {
    directory(dirname(path));
    if (existsSync(path)) check(path, true);
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", platform === "win32" ? undefined : 0o600);
      if (platform === "win32") { try { acl(temporary, "restrict", false); } catch { insecure(temporary); } }
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const rename = options.rename ?? renameSync;
      for (let attempt = 0;; attempt++) {
        try { rename(temporary, path); break; } catch (error) {
          if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt === 5) throw error;
          (options.wait ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }))(25 * 2 ** attempt);
        }
      }
      flushDirectory(dirname(path));
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return { check, directory, protect, write, read(path: string, secret = false, verifyAcl = false): string { check(path, secret, verifyAcl); return readFileSync(path, "utf8"); } };
}
