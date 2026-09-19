import { defineConfig } from "vitest/config";

/**
 * Default config for a bare `vitest run` (`npm test`).
 *
 * Without an explicit `exclude`, vitest's default collection walks into
 * `.worktrees/`, where every sibling feature branch keeps a COMPLETE copy of
 * the test tree. Two things go wrong when it does:
 *
 *  - The run grades stale snapshots of the source. A tree-walking guard in a
 *    sibling worktree reports on that worktree's code, so a green run can be
 *    green about code nobody is changing — precisely the failure mode that
 *    lets a guard look healthy while the branch under test is broken.
 *  - Collection explodes (tens of thousands of extra cases), which is slow and
 *    makes a real failure easy to lose in the noise.
 *
 * The named configs (vitest.unit.config.ts / vitest.integration.config.ts)
 * are already safe because their `include` globs are rooted at this directory.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Sibling worktrees are separate checkouts, not part of this tree.
      "**/.worktrees/**",
    ],
  },
});
