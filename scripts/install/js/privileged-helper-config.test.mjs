import { describe, expect, it } from "vitest";

import {
  EXIT_REFUSED,
  HELPER_CONFIG_PATH,
  HelperRefusal,
  isCanonicalAbsolutePath,
  loadHelperConfig,
  parseHelperConfig,
  runHelper,
} from "./privileged-helper-config.mjs";

const CONFIG_TEXT = [
  "# Managed by sovereign-ai-node installer.",
  "",
  "SERVICE_USER=sovereign-node",
  "SERVICE_GROUP=sovereign-node",
  "SERVICE_UID=998",
  "SERVICE_GID=997",
  "STATE_DIR=/var/lib/sovereign-node",
  "CONFIG_DIR=/etc/sovereign-node",
  "APP_DIR=/opt/sovereign-ai-node/app",
].join("\n");

const stat = ({ uid = 0, mode = 0o644, file = true, symlink = false } = {}) => ({
  uid,
  mode,
  isFile: () => file,
  isSymbolicLink: () => symlink,
});

const withLine = (key, value) =>
  CONFIG_TEXT.split("\n")
    .map((line) => (line.startsWith(`${key}=`) ? `${key}=${value}` : line))
    .join("\n");

describe("parseHelperConfig", () => {
  it("parses the installer's settings file", () => {
    expect(parseHelperConfig(CONFIG_TEXT)).toEqual({
      serviceUser: "sovereign-node",
      serviceGroup: "sovereign-node",
      serviceUid: 998,
      serviceGid: 997,
      stateDir: "/var/lib/sovereign-node",
      configDir: "/etc/sovereign-node",
      appDir: "/opt/sovereign-ai-node/app",
    });
  });

  it.each([
    ["an unknown key", `${CONFIG_TEXT}\nEXTRA=1`, /unexpected line/],
    ["a malformed line", `${CONFIG_TEXT}\nnot a setting`, /unexpected line/],
    ["a missing key", withLine("APP_DIR", ""), /missing APP_DIR/],
    ["a relative path", withLine("STATE_DIR", "var/lib/x"), /STATE_DIR is not a canonical/],
    ["a bad user name", withLine("SERVICE_USER", "Bad User"), /invalid service user/],
    ["a bad group name", withLine("SERVICE_GROUP", "-x"), /invalid service user/],
    ["a non-numeric uid", withLine("SERVICE_UID", "abc"), /non-numeric/],
    ["a non-numeric gid", withLine("SERVICE_GID", "1e3"), /non-numeric/],
    ["root by uid", withLine("SERVICE_UID", "0"), /names root/],
    ["root by name", withLine("SERVICE_USER", "root"), /names root/],
  ])("refuses %s", (_label, text, message) => {
    expect(() => parseHelperConfig(text)).toThrow(message);
  });
});

describe("isCanonicalAbsolutePath", () => {
  it.each([
    ["/var/lib/sovereign-node", true],
    ["relative/path", false],
    ["/var/lib/../etc", false],
    ["/", false],
    ["/var/lib/", false],
    ["/var/lib/a b", false],
    ["/var/lib/%h", false],
    [undefined, false],
  ])("%s -> %s", (value, expected) => {
    expect(isCanonicalAbsolutePath(value)).toBe(expected);
  });
});

describe("loadHelperConfig", () => {
  const fsWith = (stats) => ({
    lstatSync: (path) => stats[path] ?? stat(),
    readFileSync: () => CONFIG_TEXT,
  });

  it("reads the default path when root owns the file and its directory", () => {
    expect(loadHelperConfig({ fs: fsWith({}) }).serviceUser).toBe("sovereign-node");
    expect(HELPER_CONFIG_PATH).toBe("/usr/local/lib/sovereign-node/privileged-helpers.conf");
  });

  it.each([
    ["a file owned by someone else", { "/x/c.conf": stat({ uid: 998 }) }, /owned by root/],
    ["a group-writable file", { "/x/c.conf": stat({ mode: 0o664 }) }, /owned by root/],
    ["a world-writable directory", { "/x": stat({ mode: 0o757, file: false }) }, /owned by root/],
    ["a symlinked file", { "/x/c.conf": stat({ symlink: true }) }, /must not be a symlink/],
    ["a non-regular file", { "/x/c.conf": stat({ file: false }) }, /regular file/],
  ])("refuses %s", (_label, stats, message) => {
    expect(() => loadHelperConfig({ path: "/x/c.conf", fs: fsWith(stats) })).toThrow(message);
  });
});

describe("runHelper", () => {
  const sink = () => {
    const chunks = [];
    return { chunks, write: (chunk) => chunks.push(chunk) };
  };

  it("returns the main function's status", async () => {
    expect(await runHelper(() => 7, { name: "h", stderr: sink() })).toBe(7);
  });

  it("maps a refusal onto the refused exit code", async () => {
    const stderr = sink();
    const status = await runHelper(
      () => {
        throw new HelperRefusal("nope");
      },
      { name: "h", stderr },
    );
    expect(status).toBe(EXIT_REFUSED);
    expect(stderr.chunks).toEqual(["h: refused: nope\n"]);
  });

  it("maps any other failure onto exit code 1", async () => {
    const stderr = sink();
    expect(
      await runHelper(
        () => {
          throw new Error("boom");
        },
        { name: "h", stderr },
      ),
    ).toBe(1);
    expect(
      await runHelper(
        () => {
          throw "plain";
        },
        { name: "h", stderr },
      ),
    ).toBe(1);
    expect(stderr.chunks).toEqual(["h: failed: boom\n", "h: failed: plain\n"]);
  });

  it("defaults to the process stderr", async () => {
    expect(await runHelper(() => 0)).toBe(0);
  });
});
