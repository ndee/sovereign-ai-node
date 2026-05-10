import { z } from "zod";

export const authStageSchema = z.enum(["needs-bootstrap", "needs-password"]);

export const authStateSchema = z.object({
  authenticated: z.boolean(),
  stage: authStageSchema,
  username: z.string().min(1).optional(),
  csrf: z.string().min(1).optional(),
});

export const authLoginRequestSchema = z
  .object({
    token: z.string().min(1).max(64).optional(),
    password: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine((value) => value.token !== undefined || value.password !== undefined, {
    message: "Provide either token or password",
    path: ["token"],
  });

export const authLoginResponseSchema = z.object({
  csrf: z.string().min(1),
  username: z.string().min(1),
});

export const setupUiBootstrapIssueResultSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  ttlMinutes: z.number().int().positive(),
});

export const setupUiBootstrapPublicStateSchema = z.object({
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  consumedAt: z.string().min(1).optional(),
  failedAttempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
});

export type AuthStage = z.infer<typeof authStageSchema>;
export type AuthState = z.infer<typeof authStateSchema>;
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>;
export type SetupUiBootstrapIssueResult = z.infer<typeof setupUiBootstrapIssueResultSchema>;
export type SetupUiBootstrapPublicState = z.infer<typeof setupUiBootstrapPublicStateSchema>;
