import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveGatewayStateDir } from "./paths.js";
import { APPCONTAINER_PROFILE_PREFIX } from "./constants.js";

export function resolveAppContainerWorkspaceDir(
  env: Record<string, string | undefined>,
  workspaceId: string,
): string {
  return path.join(resolveGatewayStateDir(env), "workspaces", workspaceId);
}

export function resolveAppContainerLauncherPath(): string {
  const envOverride = process.env.OPENCLAW_APPCONTAINER_LAUNCHER?.trim();
  if (envOverride) {
    return envOverride;
  }
  // Walk up from the compiled output directory to find the package root.
  // In dist/: __dirname is something like <root>/dist, so go up one level.
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = path.dirname(process.execPath);
  }
  // Traverse upward until we find package.json (package root).
  let cursor = dir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(
      cursor,
      "tools",
      "windows",
      "appcontainer-launcher",
      "bin",
      "appcontainer-launcher.exe",
    );
    try {
      // Use synchronous existence check — this runs at startup, not in hot path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").accessSync(candidate);
      return candidate;
    } catch {
      // not here, go up
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Fall back to a predictable relative path from cwd; callers will surface a
  // meaningful error when the binary is missing.
  return path.join(process.cwd(), "tools", "windows", "appcontainer-launcher", "bin", "appcontainer-launcher.exe");
}

export function resolveAppContainerProfileName(workspaceId: string): string {
  return `${APPCONTAINER_PROFILE_PREFIX}.${workspaceId}`;
}

export function resolveAppContainerBrokerPipeName(workspaceId: string, token?: string): string {
  const suffix = token ? `-${token}` : "";
  return `\\\\.\\pipe\\openclaw-broker-${workspaceId}${suffix}`;
}

export function isAppContainerRuntime(): boolean {
  return Boolean(process.env.OPENCLAW_APPCONTAINER?.trim());
}
