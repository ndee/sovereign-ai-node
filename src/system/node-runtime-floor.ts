/**
 * The Node.js range sovereign-node and the OpenClaw gateway support.
 *
 * The lower bound is the pinned OpenClaw's own runtime floor: below it the
 * gateway exits at start-up and systemd's restart policy turns that into a
 * crash loop, so this is a correctness bound, not hygiene. The upper bound
 * keeps every host on the single Node major the runtime is validated on.
 * Keep in sync with `engines.node` in package.json and `NODE_RUNTIME_MIN_*`
 * in scripts/install/lib-runtime-deps.sh.
 */
export const SUPPORTED_NODE_MIN_VERSION = [22, 22, 3] as const;
export const SUPPORTED_NODE_MAJOR_LIMIT = 23;
export const SUPPORTED_NODE_RANGE = ">=22.22.3 <23";

export type NodeVersionTriplet = readonly [number, number, number];

export const parseNodeVersion = (value: string): NodeVersionTriplet | null => {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareTriplets = (left: NodeVersionTriplet, right: NodeVersionTriplet): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const isSupportedNodeVersion = (value: string): boolean => {
  const parsed = parseNodeVersion(value);
  return (
    parsed !== null &&
    parsed[0] < SUPPORTED_NODE_MAJOR_LIMIT &&
    compareTriplets(parsed, SUPPORTED_NODE_MIN_VERSION) >= 0
  );
};
