/**
 * Render the SAN error registry as operator-facing Markdown.
 *
 * Kept in `src/` rather than in a script so the drift test can import it
 * directly: `codes-doc.test.ts` regenerates the document from the live registry
 * and compares it against the committed file. That makes it impossible for a
 * code's shipped explanation to diverge from its documented one — a class of
 * drift that is otherwise invisible until a partner reads the wrong advice
 * during an incident.
 *
 * Pure string building, no I/O, so the test needs no filesystem fixture.
 */

import { SAN_ERRORS, type SanErrorDefinition } from "./codes.js";

/** Path of the generated document, relative to the node-pro repo root. */
export const CODES_DOC_RELATIVE_PATH = "docs/supportability/error-codes.md";

const indexRow = (entry: SanErrorDefinition): string =>
  `| \`${entry.id}\` | ${entry.component} | ${entry.severity} | ` +
  `${entry.retryable ? "yes" : "no"} | ${entry.privacy} | ${entry.title} |`;

const section = (entry: SanErrorDefinition): string => {
  const playbookFile = entry.docAnchor.split("#")[0] ?? entry.docAnchor;
  return [
    `### ${entry.id} — ${entry.title}`,
    "",
    entry.explanation,
    "",
    "| | |",
    "|---|---|",
    `| **Component** | ${entry.component} |`,
    `| **Severity** | ${entry.severity} |`,
    `| **Retryable** | ${entry.retryable ? "yes — may clear on its own" : "no — needs action"} |`,
    `| **Privacy class** | ${entry.privacy} |`,
    `| **Playbook** | [\`${playbookFile}\`](playbooks/${entry.docAnchor}) |`,
    "",
    `**Likely cause.** ${entry.likelyCause}`,
    "",
    `**What you can do.** ${entry.userAction}`,
    "",
    `**Founder action.** ${entry.supportAction}`,
    "",
  ].join("\n");
};

/** Build the full document. Deterministic — same registry, same bytes. */
export const renderCodesDocument = (
  entries: readonly SanErrorDefinition[] = SAN_ERRORS,
): string => {
  const example = entries[0]?.id ?? "SAN-LLM-001";
  return [
    "# SAN error codes",
    "",
    "**Generated from `src/support/codes.ts` in `sovereign-ai-node`. Do not edit by hand.**",
    "",
    "A drift test (`src/support/codes-doc.test.ts`) fails if this file disagrees with the",
    "registry, so a code's documented explanation can never diverge from the one the node",
    "actually emits.",
    "",
    "Look a code up directly from a node with:",
    "",
    "```bash",
    `sovereign-node explain ${example}`,
    "```",
    "",
    "Codes are stable: once shipped, an id is never renumbered or reused. The registry stays",
    "deliberately small — every code here has a real emitter in the running system, and codes",
    "are added when the emitting path is added, never in advance.",
    "",
    "## Index",
    "",
    "| Code | Component | Severity | Retryable | Privacy | Title |",
    "|---|---|---|---|---|---|",
    ...entries.map(indexRow),
    "",
    "---",
    "",
    entries.map(section).join("\n---\n\n"),
  ].join("\n");
};
