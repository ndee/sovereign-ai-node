import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveInstallRequest } from "./install.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveInstallRequest", () => {
  it("uses the default saved install request when it exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-command-test-"));
    tempRoots.push(tempRoot);
    const requestPath = join(tempRoot, "install-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: {
          secretRef: "file:/tmp/openrouter-secret",
        },
        imap: {
          host: "127.0.0.1",
          port: 1143,
          tls: true,
          username: "bridge-user",
          secretRef: "file:/tmp/imap-secret",
          mailbox: "INBOX",
        },
        matrix: {
          homeserverDomain: "matrix.example.org",
          publicBaseUrl: "https://matrix.example.org",
        },
        operator: {
          username: "operator",
        },
      }),
      "utf8",
    );

    const req = await resolveInstallRequest({}, requestPath);

    expect(req.imap).toMatchObject({
      host: "127.0.0.1",
      port: 1143,
      tls: true,
      username: "bridge-user",
      secretRef: "file:/tmp/imap-secret",
      mailbox: "INBOX",
    });
    expect(req.openrouter.secretRef).toBe("file:/tmp/openrouter-secret");
  });

  it("falls back to scaffold defaults when the saved request file is missing", async () => {
    const req = await resolveInstallRequest({}, join(tmpdir(), "missing-install-request.json"));

    expect(req.mode).toBe("bundled_matrix");
    expect(req.imap).toBeUndefined();
    expect(req.connectivity?.mode).toBe("relay");
    expect(req.operator.username).toBe("operator");
  });

  it("prefers an explicit request file over the default path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sovereign-node-install-command-test-"));
    tempRoots.push(tempRoot);
    const explicitPath = join(tempRoot, "explicit.json");
    await writeFile(
      explicitPath,
      JSON.stringify({
        mode: "bundled_matrix",
        openrouter: {
          secretRef: "file:/tmp/openrouter-explicit",
        },
        matrix: {
          homeserverDomain: "explicit.example.org",
          publicBaseUrl: "https://explicit.example.org",
        },
        operator: {
          username: "explicit-operator",
        },
      }),
      "utf8",
    );

    const req = await resolveInstallRequest(
      { requestFile: explicitPath },
      join(tempRoot, "default-does-not-matter.json"),
    );

    expect(req.matrix.homeserverDomain).toBe("explicit.example.org");
    expect(req.operator.username).toBe("explicit-operator");
  });
});
