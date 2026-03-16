import { describe, expect, it } from "vitest";
import {
  resolveAppContainerProfileName,
  resolveAppContainerBrokerPipeName,
  resolveAppContainerWorkspaceDir,
  isAppContainerRuntime,
} from "./appcontainer-paths.js";

describe("resolveAppContainerProfileName", () => {
  it("prefixes with OpenClaw.Workspace", () => {
    expect(resolveAppContainerProfileName("abc12345")).toBe("OpenClaw.Workspace.abc12345");
  });

  it("is stable for any workspaceId", () => {
    const id = "test-id-1";
    expect(resolveAppContainerProfileName(id)).toBe(`OpenClaw.Workspace.${id}`);
  });
});

describe("resolveAppContainerBrokerPipeName", () => {
  it("produces a valid Windows named pipe path without token", () => {
    const name = resolveAppContainerBrokerPipeName("ws1");
    expect(name).toBe("\\\\.\\pipe\\openclaw-broker-ws1");
  });

  it("appends token when provided", () => {
    const name = resolveAppContainerBrokerPipeName("ws1", "abc123");
    expect(name).toBe("\\\\.\\pipe\\openclaw-broker-ws1-abc123");
  });
});

describe("resolveAppContainerWorkspaceDir", () => {
  it("nests workspace under stateDir/workspaces/<id>", () => {
    const env = { HOME: "C:\\Users\\test" };
    const dir = resolveAppContainerWorkspaceDir(env, "abc12345");
    // Should be inside .openclaw/workspaces/abc12345
    expect(dir).toContain("workspaces");
    expect(dir).toContain("abc12345");
    expect(dir).toContain(".openclaw");
  });

  it("respects OPENCLAW_STATE_DIR override", () => {
    const env = { OPENCLAW_STATE_DIR: "C:\\custom\\state", HOME: "C:\\Users\\test" };
    const dir = resolveAppContainerWorkspaceDir(env, "abc12345");
    expect(dir).toContain("C:\\custom\\state");
    expect(dir).toContain("abc12345");
  });
});

describe("isAppContainerRuntime", () => {
  it("returns false when env var is not set", () => {
    delete process.env.OPENCLAW_APPCONTAINER;
    expect(isAppContainerRuntime()).toBe(false);
  });

  it("returns true when OPENCLAW_APPCONTAINER is set to 1", () => {
    process.env.OPENCLAW_APPCONTAINER = "1";
    expect(isAppContainerRuntime()).toBe(true);
    delete process.env.OPENCLAW_APPCONTAINER;
  });

  it("returns false when OPENCLAW_APPCONTAINER is whitespace", () => {
    process.env.OPENCLAW_APPCONTAINER = "  ";
    expect(isAppContainerRuntime()).toBe(false);
    delete process.env.OPENCLAW_APPCONTAINER;
  });
});
