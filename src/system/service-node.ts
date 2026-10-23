import { realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

/**
 * Where programs started for or as the service user are looked up.
 *
 * Deliberately not the installer's own PATH: the installer may run under a
 * Node from a version manager or a CI tool cache inside a directory only the
 * installing user can enter, and a unit or privilege-dropped spawn pointed at
 * that binary fails with a permission error.
 */
export const SYSTEM_PROGRAM_SEARCH_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type ServiceNodeResolution =
  | { ok: true; path: string }
  | { ok: false; searchPath: string; problems: string[] };

const OTHERS_EXECUTE = 0o001;

const formatMode = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

// The service user neither owns a system Node nor shares its group, so only
// the "others" execute bit counts, on the binary and on every directory the
// kernel has to search to reach it.
const findPathBlockingOthers = async (path: string): Promise<string | null> => {
  const { mode } = await stat(path);
  if ((mode & OTHERS_EXECUTE) === 0) {
    return `${path} (mode ${formatMode(mode)})`;
  }
  const parent = dirname(path);
  return parent === path ? null : await findPathBlockingOthers(parent);
};

export const resolveServiceNode = async (
  searchPath: string = SYSTEM_PROGRAM_SEARCH_PATH,
): Promise<ServiceNodeResolution> => {
  const problems: string[] = [];
  for (const entry of searchPath.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, "node");
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      continue;
    }
    if (!(await stat(target)).isFile()) {
      problems.push(`${candidate} is not a regular file`);
      continue;
    }
    const blocking =
      (await findPathBlockingOthers(entry)) ?? (await findPathBlockingOthers(target));
    if (blocking === null) {
      return { ok: true, path: candidate };
    }
    const shown = target === candidate ? candidate : `${candidate} (resolves to ${target})`;
    problems.push(
      `${shown} is not executable by the service user: ${blocking} lacks the execute bit for other users`,
    );
  }
  return { ok: false, searchPath, problems };
};

/**
 * The node a privilege-dropped OpenClaw CLI spawn runs with. Without a usable
 * system Node the running one is the only candidate left.
 */
export const resolveServiceNodeCommand = async (
  searchPath: string = SYSTEM_PROGRAM_SEARCH_PATH,
): Promise<string> => {
  const resolution = await resolveServiceNode(searchPath);
  return resolution.ok ? resolution.path : process.execPath;
};
