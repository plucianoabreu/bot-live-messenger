import { createHash } from 'node:crypto';

export const HERMES_SETTLEMENT_KIND = 'hermes_usage' as const;

export type HermesUsageField =
  | 'durationMs' | 'vcpuCount' | 'memoryMib' | 'inputTokens' | 'outputTokens'
  | 'rateCardId' | 'inputMicrosPerToken' | 'outputMicrosPerToken'
  | 'computeMicrosPerVcpuSecond' | 'computeMicrosPerGibSecond' | 'calculationOverflow';

export type HermesUsageMeasurement = {
  durationMs?: number | null;
  vcpuCount?: number | null;
  memoryMib?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

export type HermesUsageRates = {
  rateCardId?: string | null;
  inputMicrosPerToken?: number | null;
  outputMicrosPerToken?: number | null;
  computeMicrosPerVcpuSecond?: number | null;
  computeMicrosPerGibSecond?: number | null;
};

export type HermesUsageConfiguration = {
  rates: Required<HermesUsageRates>;
  vcpuCount: number;
  memoryMib: number;
};

type HermesUsageKnown = {
  status: 'known'; modelCostMicros: number; computeCostMicros: number;
  totalCostMicros: number; usageFingerprint: string;
};
type HermesUsageUnknown = {
  status: 'unknown'; missing: HermesUsageField[]; reservationDisposition: 'retain_full';
  usageFingerprint: string;
};
export type HermesUsageCalculation = HermesUsageKnown | HermesUsageUnknown;

export type HermesSettlement = {
  idempotencyKey: string; settlementKind: typeof HERMES_SETTLEMENT_KIND;
  runId: string; executionVersion: number; reservedMicros: number;
  calculation: HermesUsageCalculation;
};

const measurementFields = ['durationMs', 'vcpuCount', 'memoryMib', 'inputTokens', 'outputTokens'] as const;
const rateFields = ['inputMicrosPerToken', 'outputMicrosPerToken', 'computeMicrosPerVcpuSecond', 'computeMicrosPerGibSecond'] as const;

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isSafeInteger(value);
}

function requiredPositiveNumber(value: string | undefined, code: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

export function hermesUsageConfiguration(env: Record<string, string | undefined>): HermesUsageConfiguration {
  const rateCardId = env.HERMES_RATE_CARD_ID?.trim();
  if (!rateCardId || !/^[A-Za-z0-9._-]{1,80}$/.test(rateCardId)) throw new Error('HERMES_RATE_CARD_NOT_CONFIGURED');
  const vcpuCount = requiredPositiveNumber(env.E2B_VCPU_COUNT, 'HERMES_RESOURCE_PRICING_NOT_CONFIGURED');
  const memoryMib = requiredPositiveNumber(env.E2B_MEMORY_MIB, 'HERMES_RESOURCE_PRICING_NOT_CONFIGURED');
  if (!Number.isSafeInteger(vcpuCount) || !Number.isSafeInteger(memoryMib)) throw new Error('HERMES_RESOURCE_PRICING_NOT_CONFIGURED');
  return {
    vcpuCount,
    memoryMib,
    rates: {
      rateCardId,
      inputMicrosPerToken: requiredPositiveNumber(env.OPENAI_INPUT_MICROS_PER_TOKEN, 'HERMES_MODEL_PRICING_NOT_CONFIGURED'),
      outputMicrosPerToken: requiredPositiveNumber(env.OPENAI_OUTPUT_MICROS_PER_TOKEN, 'HERMES_MODEL_PRICING_NOT_CONFIGURED'),
      computeMicrosPerVcpuSecond: requiredPositiveNumber(env.E2B_COMPUTE_MICROS_PER_VCPU_SECOND, 'HERMES_RESOURCE_PRICING_NOT_CONFIGURED'),
      computeMicrosPerGibSecond: requiredPositiveNumber(env.E2B_COMPUTE_MICROS_PER_GIB_SECOND, 'HERMES_RESOURCE_PRICING_NOT_CONFIGURED'),
    },
  };
}

export function assertHermesComputeReservation(
  configuration: HermesUsageConfiguration,
  maxDurationMs = 120_000,
  reservedComputeMicros = 250_000,
) {
  const calculation = calculateHermesUsage({
    durationMs: maxDurationMs,
    vcpuCount: configuration.vcpuCount,
    memoryMib: configuration.memoryMib,
    inputTokens: 0,
    outputTokens: 0,
  }, configuration.rates);
  if (calculation.status !== 'known' || calculation.computeCostMicros > reservedComputeMicros) {
    throw new Error('HERMES_COMPUTE_RESERVATION_INSUFFICIENT');
  }
  return calculation.computeCostMicros;
}

function canonicalFingerprint(measurement: HermesUsageMeasurement, rates: HermesUsageRates) {
  return createHash('sha256').update(JSON.stringify({
    durationMs: measurement.durationMs ?? null,
    vcpuCount: measurement.vcpuCount ?? null,
    memoryMib: measurement.memoryMib ?? null,
    inputTokens: measurement.inputTokens ?? null,
    outputTokens: measurement.outputTokens ?? null,
    rateCardId: rates.rateCardId ?? null,
    inputMicrosPerToken: rates.inputMicrosPerToken ?? null,
    outputMicrosPerToken: rates.outputMicrosPerToken ?? null,
    computeMicrosPerVcpuSecond: rates.computeMicrosPerVcpuSecond ?? null,
    computeMicrosPerGibSecond: rates.computeMicrosPerGibSecond ?? null,
  })).digest('hex');
}

export function calculateHermesUsage(measurement: HermesUsageMeasurement, rates: HermesUsageRates): HermesUsageCalculation {
  const missing: HermesUsageField[] = [];
  for (const field of measurementFields) if (!isNonNegativeInteger(measurement[field])) missing.push(field);
  if (measurement.vcpuCount === 0) missing.push('vcpuCount');
  if (measurement.memoryMib === 0) missing.push('memoryMib');
  if (typeof rates.rateCardId !== 'string' || rates.rateCardId.trim().length === 0) missing.push('rateCardId');
  for (const field of rateFields) if (!isNonNegativeFinite(rates[field])) missing.push(field);

  const usageFingerprint = canonicalFingerprint(measurement, rates);
  if (missing.length > 0) return { status: 'unknown', missing: [...new Set(missing)], reservationDisposition: 'retain_full', usageFingerprint };

  const modelCostMicros = Math.ceil(measurement.inputTokens! * rates.inputMicrosPerToken! + measurement.outputTokens! * rates.outputMicrosPerToken!);
  const computeCostMicros = Math.ceil((measurement.durationMs! / 1_000) *
    (measurement.vcpuCount! * rates.computeMicrosPerVcpuSecond! + (measurement.memoryMib! / 1_024) * rates.computeMicrosPerGibSecond!));
  const totalCostMicros = modelCostMicros + computeCostMicros;
  if (![modelCostMicros, computeCostMicros, totalCostMicros].every(Number.isSafeInteger)) {
    return { status: 'unknown', missing: ['calculationOverflow'], reservationDisposition: 'retain_full', usageFingerprint };
  }
  return { status: 'known', modelCostMicros, computeCostMicros, totalCostMicros, usageFingerprint };
}

export function createHermesSettlement(input: {
  runId: string; executionVersion: number; reservedMicros: number; calculation: HermesUsageCalculation;
}): HermesSettlement {
  if (!input.runId.trim() || input.runId.includes(':')) throw new Error('INVALID_RUN_ID');
  if (!Number.isSafeInteger(input.executionVersion) || input.executionVersion <= 0) throw new Error('INVALID_EXECUTION_VERSION');
  if (!Number.isSafeInteger(input.reservedMicros) || input.reservedMicros < 0) throw new Error('INVALID_RESERVED_MICROS');
  return {
    idempotencyKey: `${input.runId}:${input.executionVersion}:${HERMES_SETTLEMENT_KIND}`,
    settlementKind: HERMES_SETTLEMENT_KIND,
    runId: input.runId,
    executionVersion: input.executionVersion,
    reservedMicros: input.reservedMicros,
    calculation: input.calculation,
  };
}
