export function privatePath(path: string): boolean {
  return (
    /(^|\/)(\.local|output|coverage|dist|node_modules)(\/|$)/.test(path) ||
    (/(^|\/)\.env(?:\..*)?$/.test(path) &&
      !/(^|\/)\.env\.(schema|example)$/.test(path)) ||
    /\.(pem|key)$/.test(path) ||
    /credentials[^/]*\.json$/i.test(path) ||
    (/(^|\/)[^/]*(discord[-_]map|service[-_]account)[^/]*\.json$/i.test(path) &&
      path !== "examples/discord-map.json")
  );
}

if (import.meta.main) {
  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "inherit" },
  );
  const paths = (await new Response(proc.stdout).text())
    .split("\0")
    .filter(Boolean);
  if (await proc.exited) process.exit(1);
  if (paths.some(privatePath)) {
    console.error(
      "Private runtime files are in the publication set. Remove them from Git before continuing. Paths suppressed.",
    );
    process.exit(1);
  }
  console.log("Publication paths contain no private runtime files.");
}
