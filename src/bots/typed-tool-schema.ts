import { z } from "zod";

import { isOpenClawCoreToolId } from "../openclaw/agent-tool-policy.js";
import {
  TYPED_TOOL_INSTANCE_PLACEHOLDER,
  TYPED_TOOL_MAX_LENGTH_LIMIT,
  TYPED_TOOL_OPENCLAW_PLUGIN_ID,
  TYPED_TOOL_VALUE_PLACEHOLDER,
} from "../openclaw/typed-tool-runtime.js";

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
const FLAG_PATTERN = /^--[a-z][a-z0-9-]*$/;

const compilesAsUnicodeRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
};

const fixedArgvEntrySchema = z
  .string()
  .min(1)
  .refine((value) => !hasControlCharacter(value), {
    message: "must not contain control characters",
  })
  .refine((value) => !value.includes(TYPED_TOOL_VALUE_PLACEHOLDER), {
    message: `fixed argv must not contain ${TYPED_TOOL_VALUE_PLACEHOLDER}`,
  });

const typedToolParamSchema = z
  .object({
    type: z.enum(["string", "boolean"]),
    description: z.string().min(1),
    enum: z.array(z.string().min(1)).min(1).optional(),
    pattern: z
      .string()
      .min(1)
      .refine(compilesAsUnicodeRegex, { message: "must be a valid regex" })
      .optional(),
    maxLength: z.number().int().min(1).max(TYPED_TOOL_MAX_LENGTH_LIMIT).optional(),
    argv: z.array(z.string().min(1)).min(1).max(2),
  })
  .superRefine((param, ctx) => {
    const [flag, value] = param.argv;
    const shapeOk =
      flag !== undefined &&
      FLAG_PATTERN.test(flag) &&
      (param.type === "boolean"
        ? param.argv.length === 1
        : param.argv.length === 2 && value === TYPED_TOOL_VALUE_PLACEHOLDER);
    if (!shapeOk) {
      ctx.addIssue({
        code: "custom",
        path: ["argv"],
        message:
          param.type === "boolean"
            ? "boolean parameters map to exactly one --flag"
            : `string parameters map to exactly ["--flag", "${TYPED_TOOL_VALUE_PLACEHOLDER}"]`,
      });
    }
    if (
      param.type === "boolean" &&
      (param.enum ?? param.pattern ?? param.maxLength) !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "boolean parameters take no enum, pattern or maxLength",
      });
    }
  });

const typedToolConfirmSchema = z.union([
  z.literal("always"),
  z.object({
    param: z.string().min(1),
    values: z.array(z.string().min(1)).min(1),
  }),
]);

const typedToolOperationSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    description: z.string().min(1),
    effect: z.enum(["read", "change"]),
    argv: z.array(fixedArgvEntrySchema).min(1),
    params: z
      .record(
        z
          .string()
          .regex(/^[a-z][A-Za-z0-9]{0,47}$/)
          .refine((name) => name !== "operation", { message: "'operation' is reserved" }),
        typedToolParamSchema,
      )
      .optional(),
    required: z.array(z.string().min(1)).optional(),
    exactlyOneOf: z.array(z.array(z.string().min(1)).min(2)).optional(),
    confirm: typedToolConfirmSchema.optional(),
    confirmPreviewArgv: z.array(fixedArgvEntrySchema.regex(FLAG_PATTERN)).min(1).optional(),
  })
  .superRefine((operation, ctx) => {
    const params = operation.params ?? {};
    const known = (name: string) => Object.hasOwn(params, name);
    for (const name of [...(operation.required ?? []), ...(operation.exactlyOneOf ?? []).flat()]) {
      if (!known(name)) {
        ctx.addIssue({ code: "custom", message: `unknown parameter '${name}'` });
      }
    }
    if (operation.confirm === undefined) {
      if (operation.confirmPreviewArgv !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmPreviewArgv"],
          message: "a preview needs a confirmation",
        });
      }
      return;
    }
    if (operation.effect !== "change") {
      ctx.addIssue({
        code: "custom",
        path: ["confirm"],
        message: "only change operations can ask for confirmation",
      });
      return;
    }
    if (operation.confirm !== "always") {
      const spec = params[operation.confirm.param];
      if (spec?.type !== "string" || spec.enum === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["confirm", "param"],
          message: "confirmation must key on a string parameter with an enum",
        });
        return;
      }
      const allowed = spec.enum;
      if (operation.confirm.values.some((value) => !allowed.includes(value))) {
        ctx.addIssue({
          code: "custom",
          path: ["confirm", "values"],
          message: "values must come from the parameter enum",
        });
      }
    }
  });

export const typedToolTemplateSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .refine((name) => !isOpenClawCoreToolId(name) && name !== TYPED_TOOL_OPENCLAW_PLUGIN_ID, {
        message: "must not shadow a core tool or the plugin id",
      }),
    description: z.string().min(1),
    script: z
      .string()
      .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
      .refine(
        (script) => !script.split("/").some((segment) => segment === "." || segment === ".."),
        {
          message: "must be a relative path inside the bot package",
        },
      ),
    operations: z.array(typedToolOperationSchema).min(1),
  })
  .superRefine((tool, ctx) => {
    const names = new Set<string>();
    const paramTypes = new Map<string, string>();
    for (const operation of tool.operations) {
      if (names.has(operation.name)) {
        ctx.addIssue({ code: "custom", message: `duplicate operation '${operation.name}'` });
      }
      names.add(operation.name);
      if (
        !operation.argv.includes(TYPED_TOOL_INSTANCE_PLACEHOLDER) &&
        operation.effect === "change"
      ) {
        ctx.addIssue({
          code: "custom",
          message: `change operation '${operation.name}' must target ${TYPED_TOOL_INSTANCE_PLACEHOLDER}`,
        });
      }
      for (const [name, spec] of Object.entries(operation.params ?? {})) {
        const previous = paramTypes.get(name);
        if (previous !== undefined && previous !== spec.type) {
          ctx.addIssue({
            code: "custom",
            message: `parameter '${name}' changes type between operations`,
          });
        }
        paramTypes.set(name, spec.type);
      }
    }
  });

export const scanAgentTemplateSchema = z.object({
  toolNames: z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => !isOpenClawCoreToolId(name), {
          message: "scan agents only get plugin tools",
        }),
    )
    .min(1),
});

export type TypedToolTemplate = z.infer<typeof typedToolTemplateSchema>;
export type ScanAgentTemplate = z.infer<typeof scanAgentTemplateSchema>;
