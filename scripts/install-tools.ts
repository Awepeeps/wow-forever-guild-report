import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checksums: Record<string, string> = {
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  linux_arm64:
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  darwin_x64:
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
};
const platform = `${process.platform}_${process.arch}`;
const checksum = checksums[platform];
if (!checksum)
  throw new Error("Use official Gitleaks 8.30.1 for this platform.");
const response = await fetch(
  `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${platform}.tar.gz`,
  { signal: AbortSignal.timeout(60_000) },
);
if (!response.ok) throw new Error("Gitleaks download failed.");
const bytes = new Uint8Array(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksum)
  throw new Error("Gitleaks checksum mismatch.");
const temp = await mkdtemp(join(tmpdir(), "roster-tools-"));
try {
  const archive = join(temp, "gitleaks.tar.gz");
  await Bun.write(archive, bytes);
  await mkdir(".local/bin", { recursive: true, mode: 0o700 });
  const proc = Bun.spawn(
    ["tar", "-xzf", archive, "-C", ".local/bin", "gitleaks"],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await proc.exited) throw new Error("Gitleaks extraction failed.");
  await chmod(".local/bin/gitleaks", 0o700);
  console.log("Installed checksum-verified Gitleaks 8.30.1 in .local/bin.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
