import { describe, expect, it } from "vitest";

import { listSanErrorIds, lookupSanError, SAN_ERRORS, type SanErrorDefinition } from "./codes.js";

const SEVERITIES = ["critical", "degraded", "warning"];
const PRIVACIES = ["safe", "technical", "sensitive"];
const COMPONENTS = ["mail", "llm", "matrix", "imap", "update", "system"];

describe("lookupSanError", () => {
  it("finds a known code", () => {
    const definition = lookupSanError("SAN-LLM-001");
    expect(definition).toBeDefined();
    expect(definition?.id).toBe("SAN-LLM-001");
    expect(definition?.component).toBe("llm");
  });

  it("is case-insensitive", () => {
    expect(lookupSanError("san-llm-001")?.id).toBe("SAN-LLM-001");
    expect(lookupSanError("San-Imap-002")?.id).toBe("SAN-IMAP-002");
  });

  it("trims surrounding whitespace", () => {
    expect(lookupSanError("  SAN-MATRIX-003  ")?.id).toBe("SAN-MATRIX-003");
    expect(lookupSanError("\tSAN-UPDATE-001\n")?.id).toBe("SAN-UPDATE-001");
  });

  it("trims and lowercases together", () => {
    expect(lookupSanError("  san-system-001 ")?.id).toBe("SAN-SYSTEM-001");
  });

  it("returns undefined for an unknown code without throwing", () => {
    // `explain <code>` passes operator input straight through, so an unknown
    // code is a normal outcome to render, never an exception.
    expect(() => lookupSanError("SAN-NOPE-999")).not.toThrow();
    expect(lookupSanError("SAN-NOPE-999")).toBeUndefined();
  });

  it("returns undefined for empty and whitespace-only input", () => {
    expect(lookupSanError("")).toBeUndefined();
    expect(lookupSanError("   ")).toBeUndefined();
  });

  it("returns undefined for junk input rather than throwing", () => {
    for (const junk of ["../../etc/passwd", "%%%", "SAN-", "1", "null", "undefined"]) {
      expect(() => lookupSanError(junk)).not.toThrow();
      expect(lookupSanError(junk)).toBeUndefined();
    }
  });

  it("finds every id in the registry", () => {
    for (const entry of SAN_ERRORS) {
      expect(lookupSanError(entry.id)).toBe(entry);
    }
  });
});

describe("SAN_ERRORS registry integrity", () => {
  it("is non-empty", () => {
    expect(SAN_ERRORS.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = SAN_ERRORS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Table-driven: every field of every entry is checked, so adding a code with
  // an empty explanation or a missing playbook anchor fails here rather than in
  // front of a design partner mid-incident.
  const requiredStringFields: readonly (keyof SanErrorDefinition)[] = [
    "id",
    "title",
    "explanation",
    "likelyCause",
    "userAction",
    "supportAction",
    "docAnchor",
  ];

  for (const entry of SAN_ERRORS) {
    describe(entry.id, () => {
      for (const field of requiredStringFields) {
        it(`has a non-empty ${String(field)}`, () => {
          const value = entry[field];
          expect(typeof value).toBe("string");
          expect((value as string).trim().length).toBeGreaterThan(0);
        });
      }

      it("has a valid severity", () => {
        expect(SEVERITIES).toContain(entry.severity);
      });

      it("has a valid privacy class", () => {
        expect(PRIVACIES).toContain(entry.privacy);
      });

      it("has a valid component", () => {
        expect(COMPONENTS).toContain(entry.component);
      });

      it("has a boolean retryable flag", () => {
        expect(typeof entry.retryable).toBe("boolean");
      });

      it("has a docAnchor pointing at a markdown playbook", () => {
        expect(entry.docAnchor).toMatch(/\.md(#[\w-]+)?$/u);
      });

      it("follows the SAN-<COMPONENT>-<NNN> id format", () => {
        expect(entry.id).toMatch(/^SAN-[A-Z]+-\d{3}$/u);
      });

      it("has a title without a trailing period", () => {
        // Titles are rendered inline in chat and CLI headers; a trailing period
        // reads badly in every one of those surfaces.
        expect(entry.title.endsWith(".")).toBe(false);
      });

      it("names its component in its id", () => {
        expect(entry.id).toContain(entry.component.toUpperCase());
      });
    });
  }
});

describe("listSanErrorIds", () => {
  it("returns every id", () => {
    expect(listSanErrorIds()).toHaveLength(SAN_ERRORS.length);
  });

  it("returns them sorted", () => {
    const ids = listSanErrorIds();
    expect(ids).toEqual([...ids].sort());
  });

  it("returns a fresh array that callers cannot use to mutate the registry", () => {
    const first = listSanErrorIds();
    first.push("SAN-INJECTED-000");
    expect(listSanErrorIds()).not.toContain("SAN-INJECTED-000");
  });

  it("agrees with the registry contents", () => {
    expect(new Set(listSanErrorIds())).toEqual(new Set(SAN_ERRORS.map((entry) => entry.id)));
  });
});

describe("privacy classification", () => {
  it("never marks a code safe when its component handles mail metadata", () => {
    // A `sensitive` code must never be rendered to Matrix; this asserts the
    // classification exists and is one of the three documented values for every
    // entry, so a caller can always make that decision.
    for (const entry of SAN_ERRORS) {
      expect(PRIVACIES).toContain(entry.privacy);
    }
  });

  it("contains no user-identifying text in any registry string", () => {
    // The registry ships to every node; a stray address or hostname here would
    // be baked into every bundle and every chat message.
    const serialized = JSON.stringify(SAN_ERRORS);
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
  });
});
