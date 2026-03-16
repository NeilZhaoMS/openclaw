import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../process/kill-tree.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  checkAppContainerProfile,
  createAppContainerProfile,
  destroyAppContainerProfile,
  launchInAppContainer,
} from "./appcontainer.js";
import type { AppContainerLaunchCapability } from "./appcontainer.js";
import { AppContainerBroker } from "./appcontainer-broker.js";
import { resolveAppContainerWorkspaceDir } from "./appcontainer-paths.js";

export type { AppContainerLaunchCapability };

export type WorkspaceHandle = {
  workspaceId: string;
  profileSid: string;
  pid: number;
  pipeName: string;
  stateDir: string;
  /** @internal */ _broker: AppContainerBroker;
};

export type WorkspaceOpenParams = {
  programArguments: string[];
  workingDirectory?: string;
  env?: Record<string, string>;
  capabilities?: AppContainerLaunchCapability[];
  allowLoopback?: boolean;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  gatewayEnv: GatewayServiceEnv;
};

export async function openWorkspace(params: WorkspaceOpenParams): Promise<WorkspaceHandle> {
  const workspaceId = randomUUID().slice(0, 8);
  const stateDir = resolveAppContainerWorkspaceDir(params.gatewayEnv, workspaceId);

  await fs.mkdir(stateDir, { recursive: true });

  const profile = await createAppContainerProfile(workspaceId);

  const broker = new AppContainerBroker({
    workspaceId,
    containerSid: profile.sid,
    policy: {
      allowedReadPaths: params.allowedReadPaths ?? [],
      allowedWritePaths: params.allowedWritePaths ?? [],
    },
    stateDir,
  });

  const { pipeName } = await broker.start();

  // Grant ACL access for each explicitly allowed path.
  for (const p of params.allowedReadPaths ?? []) {
    await broker.grantPathAccess(p, "R").catch(() => undefined);
  }
  for (const p of params.allowedWritePaths ?? []) {
    await broker.grantPathAccess(p, "RW").catch(() => undefined);
  }

  const { pid } = await launchInAppContainer({
    profile,
    programArguments: params.programArguments,
    workingDirectory: params.workingDirectory,
    env: params.env,
    capabilities: params.capabilities,
    allowLoopback: params.allowLoopback,
    brokerPipeName: pipeName,
  });

  return {
    workspaceId,
    profileSid: profile.sid,
    pid,
    pipeName,
    stateDir,
    _broker: broker,
  };
}

export async function closeWorkspace(handle: WorkspaceHandle): Promise<void> {
  killProcessTree(handle.pid);
  await handle._broker.stop();
}

export async function destroyWorkspace(handle: WorkspaceHandle): Promise<void> {
  killProcessTree(handle.pid);
  await handle._broker.destroy();
  await destroyAppContainerProfile(handle.workspaceId);
  await fs.rm(handle.stateDir, { recursive: true, force: true });
}

export { checkAppContainerProfile };
