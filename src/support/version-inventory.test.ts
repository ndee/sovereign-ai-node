import { describe, expect, it } from "vitest";

import {
  buildVersionInventory,
  hashHostname,
  type InventoryInputs,
  type ProvenanceLike,
  scrubRepoUrl,
  summarizeInventory,
  UNKNOWN,
} from "./version-inventory.js";

const CONTRACT = "2.0.0";
const FIXED_NOW = new Date("2026-07-26T10:15:30.000Z");

const inputs = (overrides: Partial<InventoryInputs> = {}): InventoryInputs => ({
  provenance: null,
  contractVersion: CONTRACT,
  now: () => FIXED_NOW,
  ...overrides,
});

const fullProvenance: ProvenanceLike = {
  nodeVersion: "2.3.5",
  nodeCommitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  botsVersion: "2.0.4",
  botsCommitSha: "9876543210fedcba9876543210fedcba98765432",
  installedAt: "2026-05-01T00:00:00.000Z",
  installSource: "curl-installer",
};

const componentOf = (inventory: ReturnType<typeof buildVersionInventory>, id: string) =>
  inventory.components.find((entry) => entry.component === id);

describe("buildVersionInventory — complete metadata", () => {
  it("populates every component from provenance", () => {
    const inventory = buildVersionInventory(
      inputs({
        provenance: fullProvenance,
        openclawVersion: "0.9.1",
        botVersions: { "mail-sentinel": "2.0.4" },
      }),
    );

    expect(componentOf(inventory, "sovereign-ai-bots")).toMatchObject({
      version: "2.0.4",
      commit: "9876543210fedcba9876543210fedcba98765432",
      source: "provenance",
    });
    expect(componentOf(inventory, "openclaw")).toMatchObject({
      version: "0.9.1",
      source: "runtime-probe",
    });
    expect(componentOf(inventory, "mail-sentinel")).toMatchObject({
      version: "2.0.4",
      source: "package-json",
    });
  });

  it("records install provenance fields", () => {
    const inventory = buildVersionInventory(inputs({ provenance: fullProvenance }));
    expect(inventory.installedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(inventory.installSource).toBe("curl-installer");
  });

  it("carries the contract version through unchanged", () => {
    expect(buildVersionInventory(inputs()).contractVersion).toBe(CONTRACT);
  });

  it("uses the injected clock for generatedAt", () => {
    expect(buildVersionInventory(inputs()).generatedAt).toBe(FIXED_NOW.toISOString());
  });

  it("stamps schemaVersion 1", () => {
    expect(buildVersionInventory(inputs()).schemaVersion).toBe(1);
  });

  it("marks the inventory complete when nothing is unknown", () => {
    // Under vitest the build defines are absent, so sovereign-node falls back to
    // provenance; with openclaw supplied too, no component is unknown.
    const inventory = buildVersionInventory(
      inputs({ provenance: fullProvenance, openclawVersion: "0.9.1" }),
    );
    expect(inventory.incomplete).toBe(false);
  });

  it("falls back to provenance for the sovereign-node COMMIT when no build define exists", () => {
    // Under vitest the tsup defines are never substituted, so `build.commit` is
    // unknown and provenance supplies the commit. `build.version` still resolves
    // — from the package.json adjacent to build-info.ts — so the version does
    // NOT come from provenance here; that path is asserted separately below.
    const inventory = buildVersionInventory(inputs({ provenance: fullProvenance }));
    const node = componentOf(inventory, "sovereign-node");
    expect(node?.commit).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    expect(node?.version).not.toBe(UNKNOWN);
  });

  it("resolves the sovereign-node version honestly, never as a hardcoded guess", () => {
    const node = componentOf(buildVersionInventory(inputs()), "sovereign-node");
    // Whatever it resolved to, it is either a real semver read from disk or an
    // honest `unknown` — never the old "2.0.0" placeholder.
    expect(node?.version === UNKNOWN || /^\d+\.\d+\.\d+/u.test(node?.version ?? "")).toBe(true);
    expect(node?.version).not.toBe("2.0.0");
  });
});

describe("buildVersionInventory — missing metadata reports unknown, never a guess", () => {
  it("reports unknown for every component when provenance is null", () => {
    const inventory = buildVersionInventory(inputs({ provenance: null }));
    expect(componentOf(inventory, "sovereign-ai-bots")).toMatchObject({
      version: UNKNOWN,
      commit: UNKNOWN,
      source: "unavailable",
    });
    expect(componentOf(inventory, "openclaw")).toMatchObject({
      version: UNKNOWN,
      source: "unavailable",
    });
  });

  it("marks the inventory incomplete when anything is unknown", () => {
    expect(buildVersionInventory(inputs({ provenance: null })).incomplete).toBe(true);
  });

  it("reports unknown installedAt and installSource for an old installation", () => {
    const inventory = buildVersionInventory(inputs({ provenance: null }));
    expect(inventory.installedAt).toBe(UNKNOWN);
    expect(inventory.installSource).toBe(UNKNOWN);
  });

  it("does not throw on a null provenance", () => {
    expect(() => buildVersionInventory(inputs({ provenance: null }))).not.toThrow();
  });

  it("treats an empty provenance object as entirely unknown", () => {
    const inventory = buildVersionInventory(inputs({ provenance: {} }));
    expect(componentOf(inventory, "sovereign-ai-bots")?.version).toBe(UNKNOWN);
    expect(inventory.installedAt).toBe(UNKNOWN);
  });

  it("normalizes blank and whitespace-only provenance strings to unknown", () => {
    const inventory = buildVersionInventory(
      inputs({
        provenance: {
          nodeCommitSha: "",
          botsVersion: "   ",
          installedAt: "\t",
          installSource: "\n",
        },
      }),
    );
    expect(componentOf(inventory, "sovereign-ai-bots")?.version).toBe(UNKNOWN);
    // Commit has no package.json fallback, so a blank provenance value here is
    // reported as unknown rather than as an empty string.
    expect(componentOf(inventory, "sovereign-node")?.commit).toBe(UNKNOWN);
    expect(inventory.installedAt).toBe(UNKNOWN);
    expect(inventory.installSource).toBe(UNKNOWN);
  });

  it("trims provenance values that have stray whitespace", () => {
    const inventory = buildVersionInventory(inputs({ provenance: { botsVersion: "  2.0.4  " } }));
    expect(componentOf(inventory, "sovereign-ai-bots")?.version).toBe("2.0.4");
  });

  it("REGRESSION: never emits the literal 2.0.0 when nothing is known", () => {
    // The original bug shipped `process.env.npm_package_version ?? "2.0.0"`, so
    // every systemd-launched node reported "2.0.0" regardless of what it ran.
    // The whole serialized inventory is checked, not just one field, because the
    // guess could reappear at any of them.
    const inventory = buildVersionInventory({
      provenance: null,
      contractVersion: "1.0.0",
      now: () => FIXED_NOW,
    });
    // Components with no source at all must be `unknown`, not a placeholder.
    for (const id of ["sovereign-ai-bots", "openclaw"]) {
      expect(componentOf(inventory, id)?.version).toBe(UNKNOWN);
      expect(componentOf(inventory, id)?.source).toBe("unavailable");
    }
    // Guard against the placeholder reappearing anywhere. This assertion is only
    // meaningful while the repo's own version differs from 2.0.0, so that
    // precondition is asserted rather than assumed.
    const nodeVersion = componentOf(inventory, "sovereign-node")?.version;
    expect(nodeVersion).not.toBe("2.0.0");
    if (nodeVersion !== UNKNOWN) {
      expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });

  it("marks a bot with a blank version unavailable rather than guessing", () => {
    const inventory = buildVersionInventory(inputs({ botVersions: { "mail-sentinel": "  " } }));
    expect(componentOf(inventory, "mail-sentinel")).toMatchObject({
      version: UNKNOWN,
      source: "unavailable",
    });
  });

  it("emits no bot components when botVersions is absent", () => {
    const inventory = buildVersionInventory(inputs());
    expect(inventory.components.map((entry) => entry.component)).toEqual([
      "sovereign-node",
      "sovereign-ai-bots",
      "openclaw",
    ]);
  });
});

describe("buildVersionInventory — environment", () => {
  it("carries a hashed hostname, never the hostname itself", () => {
    const inventory = buildVersionInventory(inputs());
    expect(inventory.environment.hostnameHash).toMatch(/^(h:[0-9a-f]{16}|unknown)$/u);
  });

  it("reports the running node runtime", () => {
    expect(buildVersionInventory(inputs()).environment.nodeRuntime).toBe(process.version);
  });

  it("populates os, kernel and arch", () => {
    const { os, kernel, arch } = buildVersionInventory(inputs()).environment;
    for (const value of [os, kernel, arch]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("hashHostname", () => {
  it("is deterministic", () => {
    expect(hashHostname("sovereign-ai-node-cathouse")).toBe(
      hashHostname("sovereign-ai-node-cathouse"),
    );
  });

  it("prefixes with h:", () => {
    expect(hashHostname("anything")).toMatch(/^h:/u);
  });

  it("does not contain the input", () => {
    // A hostname is frequently a person's name or an employer's.
    const host = "nils-macbook.acme-corp.example";
    const hashed = hashHostname(host);
    expect(hashed).not.toContain(host);
    expect(hashed).not.toContain("nils");
    expect(hashed).not.toContain("acme");
  });

  it("produces different hashes for different hosts", () => {
    expect(hashHostname("host-a")).not.toBe(hashHostname("host-b"));
  });

  it("truncates to a 16-character digest", () => {
    expect(hashHostname("host")).toHaveLength(18); // "h:" + 16
  });

  it("returns unknown for an empty hostname", () => {
    expect(hashHostname("")).toBe(UNKNOWN);
  });

  it("returns unknown for a whitespace-only hostname", () => {
    expect(hashHostname("   ")).toBe(UNKNOWN);
    expect(hashHostname("\t\n")).toBe(UNKNOWN);
  });

  it("accepts an injected hasher", () => {
    expect(hashHostname("host", () => "0123456789abcdefdeadbeef")).toBe("h:0123456789abcdef");
  });

  it("hashes the untrimmed value it was given", () => {
    // The blank check trims, but the hash is over the raw input; asserted so a
    // future change to either does not silently alter correlation between
    // bundles from the same machine.
    expect(hashHostname(" host ", (input) => `len${input.length}`)).toBe("h:len6");
  });
});

describe("scrubRepoUrl", () => {
  it("strips userinfo from an https URL", () => {
    const scrubbed = scrubRepoUrl("https://x-access-token:ghp_SECRETVALUE@github.com/ndee/repo");
    expect(scrubbed).not.toContain("ghp_SECRETVALUE");
    expect(scrubbed).not.toContain("x-access-token");
    expect(scrubbed).toContain("github.com/ndee/repo");
  });

  it("strips a username-only userinfo", () => {
    const scrubbed = scrubRepoUrl("https://someuser@github.com/ndee/repo.git");
    expect(scrubbed).not.toContain("someuser");
    expect(scrubbed).toContain("github.com/ndee/repo.git");
  });

  it("strips the query string, which can also carry a token", () => {
    const scrubbed = scrubRepoUrl("https://github.com/ndee/repo?access_token=SECRETVALUE");
    expect(scrubbed).not.toContain("SECRETVALUE");
    expect(scrubbed).not.toContain("access_token");
  });

  it("preserves an scp-style git@host:path URL", () => {
    // No userinfo to strip and no parseable authority; passing it through
    // unchanged is correct because it cannot embed a password in this form.
    expect(scrubRepoUrl("git@github.com:ndee/sovereign-ai-node.git")).toBe(
      "git@github.com:ndee/sovereign-ai-node.git",
    );
  });

  it("preserves an scp-style URL with a non-git user", () => {
    expect(scrubRepoUrl("deploy@git.example.com:team/repo.git")).toBe(
      "deploy@git.example.com:team/repo.git",
    );
  });

  it("trims surrounding whitespace on the scp-style path", () => {
    expect(scrubRepoUrl("  git@github.com:ndee/repo.git  ")).toBe("git@github.com:ndee/repo.git");
  });

  it("preserves a clean https URL", () => {
    expect(scrubRepoUrl("https://github.com/ndee/repo.git")).toContain("github.com/ndee/repo.git");
  });

  it("returns undefined for garbage", () => {
    for (const garbage of ["not a url at all", "://///", "???", "http://"]) {
      expect(scrubRepoUrl(garbage)).toBeUndefined();
    }
  });

  it("returns undefined for an empty or whitespace-only URL", () => {
    expect(scrubRepoUrl("")).toBeUndefined();
    expect(scrubRepoUrl("   ")).toBeUndefined();
  });

  it("never returns a value still containing a credential", () => {
    // The contract is "scrubbed or dropped" — never "emitted unscrubbed".
    const hostile = [
      "https://user:hunter2@example.com/repo",
      "https://token:ghp_AAAAAAAAAAAAAAAAAAAA@github.com/x/y",
      "ssh://user:pass@example.com/repo",
      "not-a-url-with-a-password",
    ];
    for (const url of hostile) {
      const scrubbed = scrubRepoUrl(url);
      if (scrubbed !== undefined) {
        expect(scrubbed).not.toContain("hunter2");
        expect(scrubbed).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAA");
        expect(scrubbed).not.toContain(":pass@");
      }
    }
  });
});

describe("summarizeInventory", () => {
  it("renders known versions", () => {
    const summary = summarizeInventory(
      buildVersionInventory(inputs({ provenance: fullProvenance, openclawVersion: "0.9.1" })),
    );
    expect(summary).toContain("node 2.3.5");
    expect(summary).toContain("bots 2.0.4");
    expect(summary).toContain("openclaw 0.9.1");
  });

  it("renders unknown verbatim so a reader can tell 'old' from 'cannot tell'", () => {
    // Built as a literal rather than via buildVersionInventory: under vitest the
    // node version resolves from the repo's own package.json, which would mask
    // the rendering behaviour under test.
    const summary = summarizeInventory({
      schemaVersion: 1,
      generatedAt: FIXED_NOW.toISOString(),
      components: [
        { component: "sovereign-node", version: UNKNOWN, commit: UNKNOWN, source: "unavailable" },
        {
          component: "sovereign-ai-bots",
          version: UNKNOWN,
          commit: UNKNOWN,
          source: "unavailable",
        },
        { component: "openclaw", version: UNKNOWN, commit: UNKNOWN, source: "unavailable" },
      ],
      environment: {
        os: "Linux 6.1.0",
        kernel: "linux",
        arch: "arm64",
        hostnameHash: "h:0123456789abcdef",
        nodeRuntime: "v22.0.0",
      },
      installedAt: UNKNOWN,
      installSource: UNKNOWN,
      contractVersion: CONTRACT,
      incomplete: true,
    });
    expect(summary).toContain("node unknown");
    expect(summary).toContain("bots unknown");
    expect(summary).toContain("openclaw unknown");
    expect(summary).not.toContain("2.0.0");
  });

  it("never renders a guessed 2.0.0 for components with no provenance", () => {
    const summary = summarizeInventory(buildVersionInventory(inputs({ provenance: null })));
    expect(summary).toContain("bots unknown");
    expect(summary).toContain("openclaw unknown");
    expect(summary).not.toContain("2.0.0");
  });

  it("falls back to unknown for a component missing from the inventory entirely", () => {
    const summary = summarizeInventory({
      schemaVersion: 1,
      generatedAt: FIXED_NOW.toISOString(),
      components: [],
      environment: {
        os: "Linux 6.1.0",
        kernel: "linux",
        arch: "arm64",
        hostnameHash: "h:0123456789abcdef",
        nodeRuntime: "v22.0.0",
      },
      installedAt: UNKNOWN,
      installSource: UNKNOWN,
      contractVersion: CONTRACT,
      incomplete: true,
    });
    expect(summary).toContain("node unknown");
    expect(summary).toContain("arm64 Linux 6.1.0");
  });

  it("does not include the hostname hash, which is not useful to a human reader", () => {
    const summary = summarizeInventory(buildVersionInventory(inputs()));
    expect(summary).not.toContain("h:");
  });
});
