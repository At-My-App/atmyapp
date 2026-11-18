import { spawnSync } from "node:child_process";

type Action = "read" | "write" | "delete";
const service = "atmyapp-cli";

/** The token is passed over stdin so it never appears in the child process arguments. */
function run(command: string, args: string[], input?: string): string | null {
  const result = spawnSync(command, args, {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 8000, windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

const windowsCredentialType = `
using System;
using System.Runtime.InteropServices;
public static class CliCredentials {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("Advapi32", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
    [DllImport("Advapi32", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential value, uint flags);
    [DllImport("Advapi32", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("Advapi32")]
    private static extern void CredFree(IntPtr value);
    public static string Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) return null;
        try {
            var value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            return Marshal.PtrToStringUni(value.CredentialBlob, (int)value.CredentialBlobSize / 2);
        } finally { CredFree(pointer); }
    }
    public static bool Write(string target, string password) {
        var blob = Marshal.StringToCoTaskMemUni(password);
        try {
            var value = new Credential {
                Type = 1, TargetName = target, UserName = "atmyapp-cli",
                CredentialBlob = blob, CredentialBlobSize = (uint)password.Length * 2, Persist = 2
            };
            return CredWrite(ref value, 0);
        } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
    }
}
`;

export function nativeCredential(action: Action, account: string, token?: string): string | null {
  // The account is also interpolated into the fixed Windows/macOS commands.
  if (!/^[a-f0-9-]{36}$/.test(account) || (action === "write" && !/^ama_cs_[a-f0-9]{64}$/.test(token ?? ""))) return null;
  switch (process.platform) {
    case "linux": {
      const attributes = ["service", service, "account", account];
      if (action === "read") return run("secret-tool", ["lookup", ...attributes]);
      if (action === "delete") return run("secret-tool", ["clear", ...attributes]);
      return run("secret-tool", ["store", "--label=AtMyApp CLI", ...attributes], token);
    }
    case "darwin": {
      const item = ["-s", service, "-a", account];
      if (action === "read") return run("security", ["find-generic-password", ...item, "-w"]);
      if (action === "delete") return run("security", ["delete-generic-password", ...item]);
      // The security REPL accepts commands on stdin. Verify the stored value since
      // the REPL can exit successfully after a command error.
      run("security", ["-i"], `add-generic-password ${item.join(" ")} -w ${token}\n`);
      return nativeCredential("read", account) === token ? "" : null;
    }
    case "win32": {
      const target = `'${service}:${account}'`;
      const command = action === "write" ? `if (![CliCredentials]::Write(${target}, [Console]::In.ReadToEnd())) { exit 1 }`
        : action === "read" ? `[Console]::Write([CliCredentials]::Read(${target}))`
        : `if (![CliCredentials]::CredDelete(${target}, 1, 0)) { exit 1 }`;
      const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${windowsCredentialType}\n'@\n${command}`;
      return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], token);
    }
    default:
      return null;
  }
}

/** Node's POSIX mode does not constrain inherited ACLs on Windows. */
export function windowsPrivateFile(file: string, set: boolean): boolean {
  const acl = set ? `
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow'))
[System.IO.File]::SetAccessControl($file, $acl)
` : "";
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$file = [Console]::In.ReadToEnd()
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
${acl}
$actual = [System.IO.File]::GetAccessControl($file)
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { exit 1 }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $owner.Value) { exit 1 }
}
`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], file) !== null;
}
