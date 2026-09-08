export const CHAT_LATENCY_STAGES = [
  'worker_claimed',
  'history_loaded',
  'memory_loaded',
  'executor_started',
  'direct_provider_started',
  'direct_provider_completed',
  'hermes_workspace_claimed',
  'hermes_provision_started',
  'hermes_resume_started',
  'hermes_sandbox_ready',
  'hermes_remote_started',
  'hermes_remote_completed',
  'executor_finished',
  'persistence_completed',
] as const;

export type ChatLatencyStage = typeof CHAT_LATENCY_STAGES[number];
export type ChatLatencyMeasurement = {
  worker_claimed_ms: number;
  history_loaded_ms: number | null;
  memory_loaded_ms: number | null;
  executor_started_ms: number | null;
  direct_provider_started_ms: number | null;
  direct_provider_completed_ms: number | null;
  hermes_workspace_claimed_ms: number | null;
  hermes_provision_started_ms: number | null;
  hermes_resume_started_ms: number | null;
  hermes_sandbox_ready_ms: number | null;
  hermes_remote_started_ms: number | null;
  hermes_remote_completed_ms: number | null;
  executor_finished_ms: number | null;
  persistence_completed_ms: number | null;
};

const databaseColumn: Record<ChatLatencyStage, keyof ChatLatencyMeasurement> = {
  worker_claimed: 'worker_claimed_ms',
  history_loaded: 'history_loaded_ms',
  memory_loaded: 'memory_loaded_ms',
  executor_started: 'executor_started_ms',
  direct_provider_started: 'direct_provider_started_ms',
  direct_provider_completed: 'direct_provider_completed_ms',
  hermes_workspace_claimed: 'hermes_workspace_claimed_ms',
  hermes_provision_started: 'hermes_provision_started_ms',
  hermes_resume_started: 'hermes_resume_started_ms',
  hermes_sandbox_ready: 'hermes_sandbox_ready_ms',
  hermes_remote_started: 'hermes_remote_started_ms',
  hermes_remote_completed: 'hermes_remote_completed_ms',
  executor_finished: 'executor_finished_ms',
  persistence_completed: 'persistence_completed_ms',
};

/** Captures only elapsed durations. It never contains prompts, replies, IDs, or credentials. */
export function createChatLatencyTracker(clock: () => number = Date.now) {
  const startedAt = clock();
  const measurement: ChatLatencyMeasurement = {
    worker_claimed_ms: 0,
    history_loaded_ms: null,
    memory_loaded_ms: null,
    executor_started_ms: null,
    direct_provider_started_ms: null,
    direct_provider_completed_ms: null,
    hermes_workspace_claimed_ms: null,
    hermes_provision_started_ms: null,
    hermes_resume_started_ms: null,
    hermes_sandbox_ready_ms: null,
    hermes_remote_started_ms: null,
    hermes_remote_completed_ms: null,
    executor_finished_ms: null,
    persistence_completed_ms: null,
  };

  return {
    mark(stage: ChatLatencyStage) {
      const column = databaseColumn[stage];
      if (measurement[column] === null || stage === 'worker_claimed') {
        measurement[column] = Math.max(0, Math.round(clock() - startedAt));
      }
    },
    snapshot(): ChatLatencyMeasurement {
      return { ...measurement };
    },
  };
}

type LatencyDatabase = {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>;
};

/** Telemetry must not prevent a completed response from reaching the user. */
export async function persistChatLatencyMeasurement(
  database: LatencyDatabase,
  runId: string,
  version: number,
  measurement: ChatLatencyMeasurement,
) {
  try {
    const { error } = await database.rpc('record_chat_latency_measurement', {
      p_run_id: runId,
      p_version: version,
      ...measurement,
    });
    return !error;
  } catch {
    return false;
  }
}
