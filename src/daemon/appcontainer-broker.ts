import net from "node:net";
import { randomUUID } from "node:crypto";
import { grantAppContainerAccess, revokeAppContainerAccess } from "../security/windows-acl.js";
import type { ExecFn } from "../security/windows-acl.js";
import { resolveAppContainerBrokerPipeName } from "./appcontainer-paths.js";

export type BrokerRequest =
  | { type: "file-read-request"; path: string; requestId: string }
  | { type: "file-write-request"; path: string; requestId: string }
  | { type: "state-read"; key: string; requestId: string }
  | { type: "state-write"; key: string; value: unknown; requestId: string }
  | { type: "heartbeat"; requestId: string };

export type BrokerResponse =
  | { requestId: string; ok: true; result?: unknown }
  | { requestId: string; ok: false; error: string };

export type BrokerPolicy = {
  allowedReadPaths: string[];
  allowedWritePaths: string[];
};

export class AppContainerBroker {
  private readonly workspaceId: string;
  private readonly containerSid: string;
  private readonly policy: BrokerPolicy;
  private readonly stateDir: string;
  private readonly exec: ExecFn | undefined;

  private server: net.Server | null = null;
  private pipeName: string | null = null;
  private grantedPaths: Array<{ path: string; rights: "R" | "RW" }> = [];
  private sockets = new Set<net.Socket>();

  constructor(params: {
    workspaceId: string;
    containerSid: string;
    policy: BrokerPolicy;
    stateDir: string;
    exec?: ExecFn;
  }) {
    this.workspaceId = params.workspaceId;
    this.containerSid = params.containerSid;
    this.policy = { ...params.policy };
    this.stateDir = params.stateDir;
    this.exec = params.exec;
  }

  async start(): Promise<{ pipeName: string }> {
    // Include a random token so the pipe name is unguessable — MVP security measure.
    const token = randomUUID().replace(/-/g, "").slice(0, 16);
    const pipeName = resolveAppContainerBrokerPipeName(this.workspaceId, token);
    this.pipeName = pipeName;

    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleRequest(trimmed, socket);
        }
      });

      socket.on("error", () => {
        this.sockets.delete(socket);
      });
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipeName, () => resolve());
    });

    return { pipeName };
  }

  private handleRequest(rawLine: string, socket: net.Socket): void {
    let request: BrokerRequest;
    try {
      request = JSON.parse(rawLine) as BrokerRequest;
    } catch {
      const response: BrokerResponse = {
        requestId: "unknown",
        ok: false,
        error: "invalid-json",
      };
      socket.write(JSON.stringify(response) + "\n");
      return;
    }

    const response = this.applyPolicy(request);
    socket.write(JSON.stringify(response) + "\n");
  }

  private applyPolicy(request: BrokerRequest): BrokerResponse {
    switch (request.type) {
      case "heartbeat":
        return { requestId: request.requestId, ok: true };

      case "file-read-request": {
        const allowed =
          this.policy.allowedReadPaths.some((p) => request.path.startsWith(p)) ||
          this.policy.allowedWritePaths.some((p) => request.path.startsWith(p));
        if (!allowed) {
          return { requestId: request.requestId, ok: false, error: "policy-denied" };
        }
        return { requestId: request.requestId, ok: true };
      }

      case "file-write-request": {
        const allowed = this.policy.allowedWritePaths.some((p) => request.path.startsWith(p));
        if (!allowed) {
          return { requestId: request.requestId, ok: false, error: "policy-denied" };
        }
        return { requestId: request.requestId, ok: true };
      }

      case "state-read":
      case "state-write":
        // State operations are scoped to stateDir — always allowed.
        return { requestId: request.requestId, ok: true };

      default:
        return { requestId: (request as { requestId: string }).requestId, ok: false, error: "unknown-request-type" };
    }
  }

  async grantPathAccess(targetPath: string, rights: "R" | "RW"): Promise<void> {
    await grantAppContainerAccess(targetPath, this.containerSid, {
      isDir: true,
      rights,
      exec: this.exec,
    });
    if (rights === "RW") {
      if (!this.policy.allowedWritePaths.includes(targetPath)) {
        this.policy.allowedWritePaths.push(targetPath);
      }
    } else {
      if (!this.policy.allowedReadPaths.includes(targetPath)) {
        this.policy.allowedReadPaths.push(targetPath);
      }
    }
    this.grantedPaths.push({ path: targetPath, rights });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  async destroy(): Promise<void> {
    await this.stop();
    // Revoke all ACLs granted to the container.
    for (const { path } of this.grantedPaths) {
      await revokeAppContainerAccess(path, this.containerSid, { exec: this.exec }).catch(
        () => undefined,
      );
    }
    this.grantedPaths = [];
  }

  get pipeNameValue(): string | null {
    return this.pipeName;
  }
}
