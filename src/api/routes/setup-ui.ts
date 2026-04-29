import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

const SETUP_UI_PREFIX = "/setup-ui/";

// Resolve the on-disk root for the setup UI. In dev (`tsx`), this file lives at
// `src/api/routes/setup-ui.ts`, three segments below the repo root that owns
// `public/setup-ui`. In a tsup build, the file is bundled into
// `dist/sovereign-node-api.js`, and the postbuild step copies `public/` to
// `dist/public/`, so `./public/setup-ui` (relative to the bundled file) is the
// correct location. Try the dev path first, fall back to the built layout.
export const resolveSetupUiRoot = (
  baseUrl: string,
  fileExists: (path: string) => boolean = existsSync,
): string => {
  const devCandidate = fileURLToPath(new URL("../../../public/setup-ui/", baseUrl));
  if (fileExists(devCandidate)) {
    return devCandidate;
  }
  return fileURLToPath(new URL("./public/setup-ui/", baseUrl));
};

export const registerSetupUiRoutes = async (server: FastifyInstance): Promise<void> => {
  const root = resolveSetupUiRoot(import.meta.url);
  const vendorPrefix = `${root}vendor${sep}`;

  await server.register(fastifyStatic, {
    root,
    prefix: SETUP_UI_PREFIX,
    index: ["index.html"],
    wildcard: false,
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res, path) => {
      const cacheControl = path.startsWith(vendorPrefix)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      res.setHeader("Cache-Control", cacheControl);
    },
  });

  server.get("/", (_request, reply) => reply.redirect(SETUP_UI_PREFIX, 302));
};
