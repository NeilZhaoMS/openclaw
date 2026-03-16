import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

// Mock appcontainer-paths to avoid filesystem checks for the launcher binary.
vi.mock("./appcontainer-paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./appcontainer-paths.js")>();
  return {
    ...original,
    resolveAppContainerLauncherPath: () => "C:\\fake\\appcontainer-launcher.exe",
    resolveAppContainerProfileName: original.resolveAppContainerProfileName,
    resolveAppContainerBrokerPipeName: original.resolveAppContainerBrokerPipeName,
    resolveAppContainerWorkspaceDir: original.resolveAppContainerWorkspaceDir,
    isAppContainerRuntime: original.isAppContainerRuntime,
  };
});

const {
  createAppContainerProfile,
  launchInAppContainer,
  destroyAppContainerProfile,
  checkAppContainerProfile,
} = await import("./appcontainer.js");

const SUCCESS_RESULT = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

describe("createAppContainerProfile", () => {
  it("calls launcher with create verb and parses JSON output", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"sid":"S-1-15-2-1","name":"OpenClaw.Workspace.abc12345"}',
    });

    const result = await createAppContainerProfile("abc12345");
    expect(result).toEqual({ sid: "S-1-15-2-1", name: "OpenClaw.Workspace.abc12345" });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.arrayContaining(["C:\\fake\\appcontainer-launcher.exe", "create", "--name", "OpenClaw.Workspace.abc12345"]),
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("throws when launcher exits non-zero", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: "",
      stderr: '{"error":"access denied"}',
      code: 1,
    });

    await expect(createAppContainerProfile("abc12345")).rejects.toThrow(
      "createAppContainerProfile failed (exit 1)",
    );
  });

  it("throws on malformed JSON output", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: "not json",
    });

    await expect(createAppContainerProfile("abc12345")).rejects.toThrow(
      "failed to parse JSON output",
    );
  });

  it("throws when JSON is missing required fields", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"foo":"bar"}',
    });

    await expect(createAppContainerProfile("abc12345")).rejects.toThrow(
      "unexpected response",
    );
  });
});

describe("launchInAppContainer", () => {
  const profile = { name: "OpenClaw.Workspace.abc12345", sid: "S-1-15-2-1" };

  it("builds correct args and returns pid", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"pid":12345}',
    });

    const result = await launchInAppContainer({
      profile,
      programArguments: ["node.exe", "server.js"],
      env: { MY_VAR: "hello" },
    });

    expect(result).toEqual({ pid: 12345 });
    const call = runCommandWithTimeout.mock.calls[0][0] as string[];
    expect(call).toContain("launch");
    expect(call).toContain("--sid");
    expect(call).toContain("S-1-15-2-1");
    expect(call).toContain("--program");
    expect(call).toContain("node.exe");
    expect(call).toContain("--arg");
    expect(call).toContain("server.js");
    // Should inject OPENCLAW_APPCONTAINER marker automatically.
    const envIndex = call.indexOf("--env");
    expect(call.slice(envIndex).join(" ")).toContain("OPENCLAW_APPCONTAINER=1");
  });

  it("maps capability names to SID flags", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"pid":999}',
    });

    await launchInAppContainer({
      profile,
      programArguments: ["node.exe"],
      capabilities: ["internet-client", "private-network"],
    });

    const call = runCommandWithTimeout.mock.calls[0][0] as string[];
    expect(call).toContain("--cap");
    expect(call).toContain("S-1-15-3-1");  // internet-client
    expect(call).toContain("S-1-15-3-3");  // private-network
  });

  it("throws when programArguments is empty", async () => {
    await expect(
      launchInAppContainer({ profile, programArguments: [] }),
    ).rejects.toThrow("programArguments must not be empty");
  });

  it("throws when launcher exits non-zero", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      code: 1,
      stderr: '{"error":"createprocess failed"}',
    });

    await expect(
      launchInAppContainer({ profile, programArguments: ["node.exe"] }),
    ).rejects.toThrow("launchInAppContainer failed (exit 1)");
  });
});

describe("destroyAppContainerProfile", () => {
  it("calls destroy verb and resolves on success", async () => {
    // destroy also calls CheckNetIsolation — mock both calls
    runCommandWithTimeout
      .mockResolvedValueOnce({ ...SUCCESS_RESULT, stdout: '{"ok":true}' })
      .mockResolvedValue({ ...SUCCESS_RESULT }); // CheckNetIsolation call

    await expect(destroyAppContainerProfile("abc12345")).resolves.toBeUndefined();
    expect(runCommandWithTimeout.mock.calls[0][0]).toContain("destroy");
  });

  it("swallows not-found errors (idempotent)", async () => {
    runCommandWithTimeout
      .mockResolvedValueOnce({
        ...SUCCESS_RESULT,
        code: 1,
        stderr: '{"error":"not found"}',
      })
      .mockResolvedValue({ ...SUCCESS_RESULT });

    await expect(destroyAppContainerProfile("abc12345")).resolves.toBeUndefined();
  });
});

describe("checkAppContainerProfile", () => {
  it("returns exists: true with SID when profile exists", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"exists":true,"sid":"S-1-15-2-1"}',
    });

    const result = await checkAppContainerProfile("abc12345");
    expect(result).toEqual({ exists: true, sid: "S-1-15-2-1" });
  });

  it("returns exists: false when profile not found", async () => {
    runCommandWithTimeout.mockResolvedValue({
      ...SUCCESS_RESULT,
      stdout: '{"exists":false}',
    });

    const result = await checkAppContainerProfile("abc12345");
    expect(result).toEqual({ exists: false });
  });
});
