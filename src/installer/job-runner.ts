import type { ErrorDetail, InstallJobSummary, JobStep, JobStepId } from "../contracts/index.js";

export type InstallContext = {
  jobId: string;
  installationId: string;
};

export interface InstallStep {
  id: JobStepId;
  label: string;
  softFail?: boolean;
  run(ctx: InstallContext): Promise<void>;
}

export type JobRunnerSnapshot = {
  job: InstallJobSummary;
  error?: ErrorDetail;
};

export type JobRunnerObserver = (snapshot: JobRunnerSnapshot) => Promise<void> | void;

export class JobRunner {
  async run(
    ctx: InstallContext,
    steps: InstallStep[],
    observer?: JobRunnerObserver,
  ): Promise<JobRunnerSnapshot> {
    const job: InstallJobSummary = {
      jobId: ctx.jobId,
      state: "pending",
      createdAt: now(),
      steps: steps.map(
        (step): JobStep => ({
          id: step.id,
          label: step.label,
          state: "pending",
        }),
      ),
    };

    await notify(observer, { job });

    job.state = "running";
    job.startedAt = now();
    await notify(observer, { job });

    for (const step of steps) {
      const current = job.steps.find((candidate) => candidate.id === step.id);
      if (current === undefined) {
        const error = normalizeInstallError(new Error(`Unknown job step definition: ${step.id}`));
        job.state = "failed";
        job.endedAt = now();
        delete job.currentStepId;
        await notify(observer, { job, error });
        return { job, error };
      }

      current.state = "running";
      current.startedAt = now();
      job.currentStepId = step.id;
      await notify(observer, { job });

      try {
        await step.run(ctx);
      } catch (caught) {
        const error = normalizeInstallError(caught);
        if (step.softFail === true) {
          current.state = "warned";
          current.endedAt = now();
          current.error = error;
          await notify(observer, { job });
          continue;
        }
        current.state = "failed";
        current.endedAt = now();
        current.error = error;
        job.state = "failed";
        job.endedAt = now();
        await notify(observer, { job, error });
        return { job, error };
      }

      current.state = "succeeded";
      current.endedAt = now();
      await notify(observer, { job });
    }

    job.state = "succeeded";
    job.endedAt = now();
    delete job.currentStepId;
    await notify(observer, { job });
    return { job };
  }
}

const now = () => new Date().toISOString();

const notify = async (
  observer: JobRunnerObserver | undefined,
  snapshot: JobRunnerSnapshot,
): Promise<void> => {
  if (observer === undefined) {
    return;
  }

  await observer({
    job: cloneJson(snapshot.job),
    ...(snapshot.error === undefined ? {} : { error: cloneJson(snapshot.error) }),
  });
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeInstallError = (error: unknown): ErrorDetail => {
  if (isErrorDetailLike(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (error instanceof Error) {
    return {
      code: "INSTALL_STEP_FAILED",
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: "INSTALL_STEP_FAILED",
    message: String(error),
    retryable: false,
  };
};

type ErrorDetailLike = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

const isErrorDetailLike = (value: unknown): value is ErrorDetailLike => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ErrorDetailLike>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
};
