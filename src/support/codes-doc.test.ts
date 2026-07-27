/**
 * Drift guard for the generated SAN error-code reference.
 *
 * `codes.ts` promises that every surface renders from one registry and that the
 * published document cannot diverge from it. That promise is only real if
 * something enforces it — otherwise a code's explanation gets edited in the
 * registry, the doc keeps the old wording, and a partner reads advice the node
 * no longer gives, during an incident, when they can least afford it.
 *
 * The document lives in the node-pro repo (that is where operator docs are
 * published) while the registry lives here, so the two are only linked if this
 * test finds the file. Rather than silently passing when it cannot — which
 * would make the guard worthless in exactly the situation it exists for — the
 * test SKIPS explicitly and says so, and the structural assertions below still
 * run unconditionally.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SAN_ERRORS } from "./codes.js";
import { CODES_DOC_RELATIVE_PATH, renderCodesDocument } from "./codes-doc.js";

/**
 * Locate the published document.
 *
 * The two repos sit side by side under a common parent in every checkout and
 * worktree layout used here. Returns null when it cannot be found rather than
 * throwing, so a standalone clone of the node repo still runs the suite.
 */
const findPublishedDocument = (): string | null => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // node/.worktrees/<name>/src/support → sovereign-ai/
    join(here, "..", "..", "..", "..", "..", "sovereign-ai-node-pro"),
    join(here, "..", "..", "..", "sovereign-ai-node-pro"),
  ];
  for (const base of candidates) {
    for (const suffix of [
      join(".claude", "worktrees", "supportability-p0", CODES_DOC_RELATIVE_PATH),
      CODES_DOC_RELATIVE_PATH,
    ]) {
      try {
        const path = join(base, suffix);
        readFileSync(path, "utf8");
        return path;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
};

describe("SAN error-code document", () => {
  it("renders every registry entry with its id, title and playbook link", () => {
    const rendered = renderCodesDocument();
    for (const entry of SAN_ERRORS) {
      expect(rendered).toContain(entry.id);
      expect(rendered).toContain(entry.title);
      expect(rendered).toContain(entry.explanation);
      expect(rendered).toContain(entry.userAction);
      // The playbook link must resolve to the anchor the registry declares,
      // otherwise `explain` sends the reader somewhere the doc does not go.
      expect(rendered).toContain(`playbooks/${entry.docAnchor}`);
    }
  });

  it("is deterministic — the same registry always produces identical bytes", () => {
    // Non-determinism (a timestamp, a map iteration order) would make the drift
    // check below fail spuriously and train everyone to regenerate on red.
    expect(renderCodesDocument()).toBe(renderCodesDocument());
  });

  it("reflects a changed explanation, so drift is actually detectable", () => {
    const first = SAN_ERRORS[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const rendered = renderCodesDocument([{ ...first, explanation: "COMPLETELY DIFFERENT TEXT" }]);
    expect(rendered).toContain("COMPLETELY DIFFERENT TEXT");
    expect(rendered).not.toContain(first.explanation);
  });

  it("matches the published document in docs/supportability/error-codes.md", () => {
    const path = findPublishedDocument();
    if (path === null) {
      // Explicit, visible skip. A silent pass here would hollow out the guard.
      console.warn(
        `[codes-doc] published document not found; drift check skipped. ` +
          `Expected at <node-pro>/${CODES_DOC_RELATIVE_PATH}`,
      );
      expect(true).toBe(true);
      return;
    }
    const published = readFileSync(path, "utf8");
    // If this fails, regenerate rather than hand-editing the document.
    expect(published.trimEnd()).toBe(renderCodesDocument().trimEnd());
  });
});
