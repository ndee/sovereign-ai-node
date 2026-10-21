import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderRelayTunnelUnit } from "../../../src/installer/real-service-relay-tunnel.ts";
import { RELAY_TUNNEL_DEFAULT_IMAGE, RELAY_TUNNEL_SYSTEMD_UNIT } from "../../../src/installer/real-service-shared.ts";
import {
  installSystemdUnit,
  MANAGED_UNITS,
  MAX_UNIT_BYTES,
  parseUnitFile,
  RELAY_TUNNEL_CONTAINER,
  RELAY_TUNNEL_IMAGE,
  RELAY_TUNNEL_UNIT,
  renderRelayTunnelUnitTemplate,
  SYSTEMD_UNIT_DIR,
  validateUnit,
  writeUnitFile,
} from "./privileged-systemd-unit.mjs";

const identity = {
  serviceUser: "sovereign-node",
  serviceGroup: "sovereign-node",
  serviceUid: 998,
  serviceGid: 997,
  stateDir: "/var/lib/sovereign-node",
  configDir: "/etc/sovereign-node",
  appDir: "/opt/sovereign-ai-node/app",
};

const GATEWAY_UNIT = [
  "[Unit]",
  "Description=Sovereign OpenClaw Gateway",
  "After=network-online.target docker.service",
  "Wants=network-online.target",
  "Requires=docker.service",
  "",
  "[Service]",
  "Type=simple",
  "User=sovereign-node",
  "Group=sovereign-node",
  "WorkingDirectory=/var/lib/sovereign-node/openclaw-home",
  "Environment=HOME=/var/lib/sovereign-node/openclaw-home",
  "Environment=PATH=/var/lib/sovereign-node/.npm-global/bin:/usr/bin:/bin",
  "EnvironmentFile=-/var/lib/sovereign-node/openclaw-home/gateway.env",
  "ExecStartPre=/usr/bin/env sh -lc 'attempt=0; exit 0'",
  "ExecStart=/usr/bin/openclaw gateway run --allow-unconfigured --bind loopback",
  "Restart=always",
  "RestartSec=3",
  "NoNewPrivileges=yes",
  "CapabilityBoundingSet=",
  "RestrictSUIDSGID=yes",
  "LockPersonality=yes",
  "RestrictNamespaces=yes",
  "PrivateDevices=yes",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectKernelLogs=yes",
  "ProtectControlGroups=yes",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
  "ProtectSystem=strict",
  "PrivateTmp=yes",
  "ProtectHome=yes",
  "InaccessiblePaths=-/run/docker.sock -/run/containerd/containerd.sock",
  "ReadWritePaths=-/var/lib/sovereign-node",
  "ReadOnlyPaths=-/var/lib/sovereign-node/.npm-global",
  "NoExecPaths=/",
  "ExecPaths=-/usr/lib -/usr/bin/node",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

const SCAN_SERVICE = [
  "[Unit]",
  "Description=Sovereign Mail Sentinel Scan mail-sentinel",
  "After=network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=oneshot",
  "User=sovereign-node",
  "Group=sovereign-node",
  "WorkingDirectory=/var/lib/sovereign-node/mail-sentinel/workspace",
  "Environment=HOME=/var/lib/sovereign-node/openclaw-home",
  "ExecStart=/usr/bin/env node /var/lib/sovereign-node/mail-sentinel/workspace/bin/mail-sentinel.js scan --json",
  "TimeoutStartSec=300",
  "",
  "[Install]",
  "",
].join("\n");

const SCAN_TIMER = [
  "[Unit]",
  "Description=Sovereign Mail Sentinel Scan Timer mail-sentinel",
  "",
  "[Timer]",
  "Unit=sovereign-mail-sentinel-scan.service",
  "OnActiveSec=5min",
  "OnUnitActiveSec=30min",
  "AccuracySec=1min",
  "Persistent=true",
  "",
  "[Install]",
  "WantedBy=timers.target",
  "",
].join("\n");

const gatewayWith = (line, replacing) =>
  replacing === undefined
    ? GATEWAY_UNIT.replace("[Install]", `${line}\n\n[Install]`)
    : GATEWAY_UNIT.replace(replacing, line);

describe("validateUnit", () => {
  it.each([
    ["sovereign-openclaw-gateway.service", GATEWAY_UNIT],
    ["sovereign-mail-sentinel-scan.service", SCAN_SERVICE],
    ["sovereign-mail-sentinel-scan.timer", SCAN_TIMER],
  ])("accepts the node's %s", (name, content) => {
    expect(() => validateUnit(name, content, identity)).not.toThrow();
  });

  it("refuses a unit name outside the managed set", () => {
    expect(() => validateUnit("ssh.service", GATEWAY_UNIT, identity)).toThrow(/not a managed unit/);
  });

  it.each([
    ["another user", "User=root", "User=sovereign-node", /User=root is not accepted/],
    ["another group", "Group=docker", "Group=sovereign-node", /Group=docker/],
    ["a privileged command prefix", "ExecStartPre=+/bin/sh -c id", undefined, /ExecStartPre/],
    ["a combined privileged prefix", "ExecStart=-!/bin/sh", "ExecStart=/usr/bin/openclaw gateway run --allow-unconfigured --bind loopback", /ExecStart/],
    ["an empty command", "ExecStop=", undefined, /ExecStop=/],
    ["supplementary groups", "SupplementaryGroups=docker", undefined, /SupplementaryGroups= is not accepted/],
    ["ambient capabilities", "AmbientCapabilities=CAP_SYS_ADMIN", undefined, /AmbientCapabilities/],
    ["a bind mount", "BindPaths=/var/lib/x:/etc/sudoers", undefined, /BindPaths/],
    ["a credential load", "LoadCredential=x:/etc/shadow", undefined, /LoadCredential/],
    ["file output", "StandardOutput=file:/etc/passwd", undefined, /StandardOutput/],
    ["a state directory", "StateDirectory=sudo", undefined, /StateDirectory/],
    ["an environment file elsewhere", "EnvironmentFile=/etc/shadow", undefined, /EnvironmentFile/],
    ["a relative working dir", "WorkingDirectory=tmp", "WorkingDirectory=/var/lib/sovereign-node/openclaw-home", /WorkingDirectory/],
    ["an arbitrary wanted unit", "Wants=reboot.target", "Wants=network-online.target", /Wants=reboot.target/],
    ["an arbitrary install target", "WantedBy=sshd.service", "WantedBy=multi-user.target", /WantedBy/],
    ["an alias", "Alias=ssh.service", "WantedBy=multi-user.target", /Alias/],
    ["a failure hook", "OnFailure=reboot.target", "Wants=network-online.target", /OnFailure/],
    ["a bad restart policy", "Restart=sometimes", "Restart=always", /Restart=sometimes/],
  ])("refuses %s", (_label, line, replacing, message) => {
    expect(() =>
      validateUnit("sovereign-openclaw-gateway.service", gatewayWith(line, replacing), identity),
    ).toThrow(message);
  });

  it("requires User= and Group= on a service unit", () => {
    const withoutUser = GATEWAY_UNIT.replace("User=sovereign-node\n", "");
    expect(() =>
      validateUnit("sovereign-openclaw-gateway.service", withoutUser, identity),
    ).toThrow(/must set User= and Group=/);
    const withoutGroup = SCAN_SERVICE.replace("Group=sovereign-node\n", "");
    expect(() =>
      validateUnit("sovereign-mail-sentinel-scan.service", withoutGroup, identity),
    ).toThrow(/must set User= and Group=/);
  });

  it("refuses a section that does not belong to the unit type", () => {
    expect(() =>
      validateUnit("sovereign-mail-sentinel-scan.timer", `${SCAN_TIMER}\n[Service]\nType=simple\n`, identity),
    ).toThrow(/section \[Service\] is not accepted/);
  });

  it("only lets the timer activate its own service", () => {
    const other = SCAN_TIMER.replace(
      "Unit=sovereign-mail-sentinel-scan.service",
      "Unit=poweroff.target",
    );
    expect(() => validateUnit("sovereign-mail-sentinel-scan.timer", other, identity)).toThrow(
      /Unit=poweroff.target/,
    );
  });
});

describe("parseUnitFile", () => {
  it("skips blank and comment lines", () => {
    expect(parseUnitFile("# c\n; c\n\n[Unit]\nDescription=x\n")).toEqual([
      { where: "line 5", section: "Unit", key: "Description", value: "x" },
    ]);
  });

  it.each([
    ["a continuation line", "[Service]\nExecStart=/bin/true \\\n  /bin/sh"],
    ["a carriage return", "[Service]\nType=simple\r"],
    ["a directive outside a section", "Type=simple"],
    ["a line that is not a directive", "[Service]\n.include /etc/x"],
  ])("refuses %s", (_label, content) => {
    expect(() => parseUnitFile(content)).toThrow();
  });
});

describe("relay tunnel unit", () => {
  it("matches the installer's renderer for the same inputs", () => {
    expect(RELAY_TUNNEL_IMAGE).toBe(RELAY_TUNNEL_DEFAULT_IMAGE);
    expect(RELAY_TUNNEL_UNIT).toBe(RELAY_TUNNEL_SYSTEMD_UNIT);
    const configPath = "/var/lib/sovereign-node/relay/frpc.toml";
    expect(
      renderRelayTunnelUnit({
        configPath,
        containerName: RELAY_TUNNEL_CONTAINER,
        image: RELAY_TUNNEL_DEFAULT_IMAGE,
      }),
    ).toBe(renderRelayTunnelUnitTemplate({ configPath }));
  });

  it.each(["/var/lib/sovereign-node", "/etc/sovereign-node"])(
    "accepts the template with the frpc config under %s",
    (root) => {
      const content = renderRelayTunnelUnitTemplate({ configPath: `${root}/relay/frpc.toml` });
      expect(() => validateUnit(RELAY_TUNNEL_UNIT, content, identity)).not.toThrow();
    },
  );

  it("refuses any deviation from the template", () => {
    const content = renderRelayTunnelUnitTemplate({
      configPath: "/var/lib/sovereign-node/relay/frpc.toml",
    }).replace("Type=simple", "Type=simple\nExecStartPost=/bin/sh -c id");
    expect(() => validateUnit(RELAY_TUNNEL_UNIT, content, identity)).toThrow(/does not match/);
    const elsewhere = renderRelayTunnelUnitTemplate({ configPath: "/etc/shadow" });
    expect(() => validateUnit(RELAY_TUNNEL_UNIT, elsewhere, identity)).toThrow(/does not match/);
  });
});

describe("writeUnitFile", () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "privileged-unit-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the unit atomically and replaces a symlink instead of following it", async () => {
    const outside = join(dir, "outside");
    await writeFile(outside, "untouched");
    await symlink(outside, join(dir, "sovereign-openclaw-gateway.service"));
    const target = writeUnitFile("sovereign-openclaw-gateway.service", GATEWAY_UNIT, {
      unitDir: dir,
    });
    expect(target).toBe(join(dir, "sovereign-openclaw-gateway.service"));
    expect(await readFile(target, "utf8")).toBe(GATEWAY_UNIT);
    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect((await readdir(dir)).sort()).toEqual(["outside", "sovereign-openclaw-gateway.service"]);
  });

  it("removes the temp file when the write fails", async () => {
    const calls = [];
    const fs = {
      openSync: () => 42,
      writeSync: () => {
        throw new Error("ENOSPC");
      },
      fsyncSync: () => {},
      closeSync: (fd) => calls.push(["close", fd]),
      renameSync: () => calls.push(["rename"]),
      rmSync: (path) => calls.push(["rm", path.startsWith(join(dir, ".sovereign-x.service."))]),
    };
    expect(() => writeUnitFile("sovereign-x.service", "x", { unitDir: dir, fs })).toThrow("ENOSPC");
    expect(calls).toEqual([
      ["close", 42],
      ["rm", true],
    ]);
  });

  it("targets the system unit directory by default", () => {
    expect(SYSTEMD_UNIT_DIR).toBe("/etc/systemd/system");
  });
});

describe("installSystemdUnit", () => {
  const write = (name, content) => `${name}:${content.length}`;

  it("validates and writes a managed unit", () => {
    expect(
      installSystemdUnit({
        argv: ["sovereign-mail-sentinel-scan.timer"],
        stdinText: SCAN_TIMER,
        identity,
        write,
      }),
    ).toBe(`sovereign-mail-sentinel-scan.timer:${SCAN_TIMER.length}`);
  });

  it.each([
    ["no unit name", [], SCAN_TIMER, /usage/],
    ["extra arguments", ["a", "b"], SCAN_TIMER, /usage/],
    ["empty content", ["sovereign-mail-sentinel-scan.timer"], "", /between 1 and/],
    ["oversized content", ["sovereign-mail-sentinel-scan.timer"], "#".repeat(MAX_UNIT_BYTES + 1), /between 1 and/],
    ["an invalid unit", ["sovereign-mail-sentinel-scan.timer"], "[Timer]\nUnit=x.service\n", /Unit=x.service/],
  ])("refuses %s", (_label, argv, stdinText, message) => {
    expect(() => installSystemdUnit({ argv, stdinText, identity, write })).toThrow(message);
  });

  it("covers every managed unit kind", () => {
    expect(new Set(Object.values(MANAGED_UNITS).map((unit) => unit.kind))).toEqual(
      new Set(["service", "timer", "relay-tunnel"]),
    );
  });

  it.skipIf(process.getuid?.() === 0)("uses the atomic writer by default", () => {
    // The default writer targets /etc/systemd/system, which a test runner
    // cannot write; reaching it proves validation passed.
    expect(() =>
      installSystemdUnit({
        argv: ["sovereign-mail-sentinel-scan.timer"],
        stdinText: SCAN_TIMER,
        identity,
      }),
    ).toThrow(/EACCES|ENOENT|EPERM/);
  });
});
