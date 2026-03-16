#!/usr/bin/env node
// Postinstall integrity check for the pre-built appcontainer-launcher.exe binary.
// Runs only on Windows; exits 0 silently on all other platforms.

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(__dirname, "..", "tools", "windows", "appcontainer-launcher", "bin");
const exePath = resolve(binDir, "appcontainer-launcher.exe");
const sha256Path = resolve(binDir, "appcontainer-launcher.exe.sha256");

// If the binary hasn't been built yet (placeholder state), skip verification.
if (!existsSync(exePath)) {
  console.warn(
    "[openclaw] appcontainer-launcher.exe not found — AppContainer sandbox unavailable.\n" +
    "  See tools/windows/appcontainer-launcher/bin/BUILD_INSTRUCTIONS.txt",
  );
  process.exit(0);
}

// Parse the sha256 manifest.
let expectedHash;
try {
  const manifest = readFileSync(sha256Path, "utf8");
  const firstLine = manifest.split("\n").find((l) => l.trim() && !l.startsWith("#"));
  expectedHash = firstLine?.split(/\s+/)[0]?.toLowerCase();
} catch {
  console.warn("[openclaw] Could not read appcontainer-launcher.exe.sha256 — skipping integrity check.");
  process.exit(0);
}

// Placeholder hash — skip verification until a real binary is present.
if (!expectedHash || expectedHash === "0".repeat(64)) {
  process.exit(0);
}

// Compute SHA-256 of the binary.
const hash = createHash("sha256");
await new Promise((resolve, reject) => {
  const stream = createReadStream(exePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", resolve);
  stream.on("error", reject);
});
const actual = hash.digest("hex").toLowerCase();

if (actual !== expectedHash) {
  console.error(
    `[openclaw] INTEGRITY CHECK FAILED for appcontainer-launcher.exe\n` +
    `  expected: ${expectedHash}\n` +
    `  actual:   ${actual}\n` +
    `  The binary may have been tampered with. Re-install from a trusted source.`,
  );
  process.exit(1);
}
