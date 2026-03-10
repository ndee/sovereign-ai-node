import pino from "pino";

export const createLogger = () =>
  pino(
    {
      name: "sovereign-node",
      level: process.env.LOG_LEVEL ?? "info",
    },
    pino.destination(2),
  );

export type Logger = ReturnType<typeof createLogger>;
