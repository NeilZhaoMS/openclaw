import { APPCONTAINER_BROKER_PIPE_ENV, APPCONTAINER_ENV_MARKER, GATEWAY_SERVICE_MARKER } from "./constants.js";
import {
  resolveAppContainerBrokerPipeName,
  resolveAppContainerLauncherPath,
  resolveAppContainerProfileName,
} from "./appcontainer-paths.js";
import { runCommandWithTimeout } from "../process/exec.js";

const LAUNCHER_TIMEOUT_MS = 10_000;

export type AppContainerLaunchCapability =
  | "internet-client" // S-1-15-3-1
  | "internet-client-server" // S-1-15-3-2
  | "private-network"; // S-1-15-3-3

const CAPABILITY_SIDS: Record<AppContainerLaunchCapability, string> = {
  "internet-client": "S-1-15-3-1",
  "internet-client-server": "S-1-15-3-2",
  "private-network": "S-1-15-3-3",
};

export type AppContainerProfile = {
  name: string;
  sid: string;
};

async function execLauncher(
  args: string[],
  opts?: { launcherPath?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const launcherPath = opts?.launcherPath ?? resolveAppContainerLauncherPath();
  const result = await runCommandWithTimeout([launcherPath, ...args], {
    timeoutMs: opts?.timeoutMs ?? LAUNCHER_TIMEOUT_MS,
    noOutputTimeoutMs: 5_000,
  });
  const timeoutDetail =
    result.termination === "timeout"
      ? `appcontainer-launcher timed out after ${opts?.timeoutMs ?? LAUNCHER_TIMEOUT_MS}ms`
      : result.termination === "no-output-timeout"
        ? `appcontainer-launcher produced no output for 5000ms`
        : "";
  return {
    stdout: result.stdout,
    stderr: result.stderr || timeoutDetail,
    code: typeof result.code === "number" ? result.code : result.killed ? 124 : 1,
  };
}

function parseJsonStdout<T>(stdout: string, context: string): T {
  const line = stdout.trim();
  if (!line) {
    throw new Error(`${context}: empty output from appcontainer-launcher`);
  }
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new Error(`${context}: failed to parse JSON output: ${JSON.stringify(line)}`);
  }
}

export async function createAppContainerProfile(
  workspaceId: string,
  opts?: { launcherPath?: string },
): Promise<AppContainerProfile> {
  const name = resolveAppContainerProfileName(workspaceId);
  const result = await execLauncher(
    ["create", "--name", name, "--display", "OpenClaw Workspace"],
    opts,
  );
  if (result.code !== 0) {
    throw new Error(
      `createAppContainerProfile failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = parseJsonStdout<{ sid: string; name: string }>(result.stdout, "createAppContainerProfile");
  if (!parsed.sid || !parsed.name) {
    throw new Error(`createAppContainerProfile: unexpected response: ${result.stdout.trim()}`);
  }
  return { name: parsed.name, sid: parsed.sid };
}

export async function launchInAppContainer(params: {
  profile: AppContainerProfile;
  programArguments: string[];
  workingDirectory?: string;
  env?: Record<string, string>;
  capabilities?: AppContainerLaunchCapability[];
  allowLoopback?: boolean;
  brokerPipeName?: string;
  launcherPath?: string;
}): Promise<{ pid: number }> {
  const args: string[] = ["launch", "--sid", params.profile.sid];

  if (params.programArguments.length === 0) {
    throw new Error("launchInAppContainer: programArguments must not be empty");
  }
  args.push("--program", params.programArguments[0]);
  for (const arg of params.programArguments.slice(1)) {
    args.push("--arg", arg);
  }

  if (params.workingDirectory) {
    args.push("--cwd", params.workingDirectory);
  }

  // Build the environment to inject into the container.
  const containerEnv: Record<string, string> = {
    ...params.env,
    [APPCONTAINER_ENV_MARKER]: "1",
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
  };
  if (params.brokerPipeName) {
    containerEnv[APPCONTAINER_BROKER_PIPE_ENV] = params.brokerPipeName;
  }
  for (const [k, v] of Object.entries(containerEnv)) {
    args.push("--env", `${k}=${v}`);
  }

  // Capability SIDs.
  for (const cap of params.capabilities ?? []) {
    args.push("--cap", CAPABILITY_SIDS[cap]);
  }

  if (params.allowLoopback) {
    await enableLoopbackExemption(params.profile.name, params.launcherPath);
  }

  const result = await execLauncher(args, { launcherPath: params.launcherPath });
  if (result.code !== 0) {
    throw new Error(
      `launchInAppContainer failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = parseJsonStdout<{ pid: number }>(result.stdout, "launchInAppContainer");
  if (typeof parsed.pid !== "number") {
    throw new Error(`launchInAppContainer: unexpected response: ${result.stdout.trim()}`);
  }
  return { pid: parsed.pid };
}

async function enableLoopbackExemption(profileName: string, _launcherPath?: string): Promise<void> {
  try {
    const result = await runCommandWithTimeout(
      ["CheckNetIsolation.exe", "loopbackexempt", "-a", `-n=${profileName}`],
      { timeoutMs: 8_000 },
    );
    if (result.code !== 0 && !/access is denied/i.test(result.stderr)) {
      // Non-access-denied error: log but don't throw; loopback is best-effort.
      process.stderr.write(
        `[appcontainer] loopback exemption warning (exit ${result.code}): ${result.stderr}\n`,
      );
    }
  } catch {
    process.stderr.write(`[appcontainer] loopback exemption unavailable for ${profileName}\n`);
  }
}

export async function destroyAppContainerProfile(
  workspaceId: string,
  opts?: { launcherPath?: string },
): Promise<void> {
  const name = resolveAppContainerProfileName(workspaceId);
  const result = await execLauncher(["destroy", "--name", name], opts);
  // Treat "not found" as success (idempotent).
  if (result.code !== 0) {
    const isNotFound = /not found|no such/i.test(result.stderr + result.stdout);
    if (!isNotFound) {
      throw new Error(
        `destroyAppContainerProfile failed (exit ${result.code}): ${result.stderr || result.stdout}`,
      );
    }
  }
  // Remove loopback exemption best-effort; ignore errors.
  await runCommandWithTimeout(
    ["CheckNetIsolation.exe", "loopbackexempt", "-d", `-n=${name}`],
    { timeoutMs: 8_000 },
  ).catch(() => undefined);
}

export async function checkAppContainerProfile(
  workspaceId: string,
  opts?: { launcherPath?: string },
): Promise<{ exists: boolean; sid?: string }> {
  const name = resolveAppContainerProfileName(workspaceId);
  const result = await execLauncher(["check", "--name", name], opts);
  if (result.code !== 0) {
    throw new Error(
      `checkAppContainerProfile failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = parseJsonStdout<{ exists: boolean; sid?: string }>(
    result.stdout,
    "checkAppContainerProfile",
  );
  return parsed;
}

export { resolveAppContainerBrokerPipeName };
