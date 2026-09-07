import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHermesComputeReservation, calculateHermesUsage, createHermesSettlement, hermesUsageConfiguration, HERMES_SETTLEMENT_KIND } from '../src/server/billing/hermes-usage';

const measurement = { durationMs: 1_500, vcpuCount: 2, memoryMib: 2_048, inputTokens: 100, outputTokens: 20 };
const rates = {
  rateCardId: 'operator-configured-v1', inputMicrosPerToken: 2, outputMicrosPerToken: 5,
  computeMicrosPerVcpuSecond: 10, computeMicrosPerGibSecond: 5,
};

test('calculates model and compute costs from explicit rates', () => {
  const result = calculateHermesUsage(measurement, rates);
  assert.deepEqual(result, { status: 'known', modelCostMicros: 300, computeCostMicros: 45,
    totalCostMicros: 345, usageFingerprint: result.usageFingerprint });
});

test('rounds each provider component up to whole micros', () => {
  const result = calculateHermesUsage(
    { durationMs: 1, vcpuCount: 1, memoryMib: 512, inputTokens: 1, outputTokens: 0 },
    { ...rates, inputMicrosPerToken: 0.1, computeMicrosPerVcpuSecond: 1, computeMicrosPerGibSecond: 1 },
  );
  assert.equal(result.status, 'known');
  if (result.status === 'known') assert.deepEqual([result.modelCostMicros, result.computeCostMicros, result.totalCostMicros], [1, 1, 2]);
});

test('incomplete usage retains the full reservation', () => {
  const calculation = calculateHermesUsage({ ...measurement, durationMs: null }, { ...rates, computeMicrosPerGibSecond: undefined });
  assert.equal(calculation.status, 'unknown');
  if (calculation.status === 'unknown') {
    assert.deepEqual(calculation.missing, ['durationMs', 'computeMicrosPerGibSecond']);
    assert.equal(calculation.reservationDisposition, 'retain_full');
  }
  const settlement = createHermesSettlement({ runId: '44444444-4444-4444-8444-444444444444', executionVersion: 2, reservedMicros: 250_000, calculation });
  assert.equal(settlement.reservedMicros, 250_000);
});

test('invalid or overflowing measurements never become zero cost', () => {
  const invalid = calculateHermesUsage({ ...measurement, vcpuCount: 0 }, rates);
  assert.equal(invalid.status, 'unknown');
  const overflow = calculateHermesUsage({ ...measurement, inputTokens: Number.MAX_SAFE_INTEGER }, { ...rates, inputMicrosPerToken: Number.MAX_SAFE_INTEGER });
  assert.equal(overflow.status, 'unknown');
});

test('settlement identity is stable while fingerprint detects conflicting retry usage', () => {
  const first = calculateHermesUsage(measurement, rates);
  const retry = calculateHermesUsage({ ...measurement, durationMs: 1_600 }, rates);
  const identity = { runId: '44444444-4444-4444-8444-444444444444', executionVersion: 2, reservedMicros: 250_000 };
  const a = createHermesSettlement({ ...identity, calculation: first });
  const b = createHermesSettlement({ ...identity, calculation: retry });
  assert.equal(a.idempotencyKey, `${identity.runId}:2:${HERMES_SETTLEMENT_KIND}`);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.calculation.usageFingerprint, b.calculation.usageFingerprint);
});

test('settlement rejects malformed durable identity and reservation values', () => {
  const calculation = calculateHermesUsage(measurement, rates);
  assert.throws(() => createHermesSettlement({ runId: 'bad:id', executionVersion: 1, reservedMicros: 1, calculation }), /INVALID_RUN_ID/);
  assert.throws(() => createHermesSettlement({ runId: 'run', executionVersion: 0, reservedMicros: 1, calculation }), /INVALID_EXECUTION_VERSION/);
  assert.throws(() => createHermesSettlement({ runId: 'run', executionVersion: 1, reservedMicros: -1, calculation }), /INVALID_RESERVED_MICROS/);
});

test('operator rates must be complete and fit inside the pre-reserved compute ceiling', () => {
  const configuration = hermesUsageConfiguration({
    HERMES_RATE_CARD_ID: 'e2b-openai-2026-09',
    E2B_VCPU_COUNT: '2', E2B_MEMORY_MIB: '2048',
    OPENAI_INPUT_MICROS_PER_TOKEN: '1', OPENAI_OUTPUT_MICROS_PER_TOKEN: '2',
    E2B_COMPUTE_MICROS_PER_VCPU_SECOND: '10', E2B_COMPUTE_MICROS_PER_GIB_SECOND: '5',
  });
  assert.equal(assertHermesComputeReservation(configuration), 3_600);
  assert.throws(() => hermesUsageConfiguration({}), /HERMES_RATE_CARD_NOT_CONFIGURED/);
  assert.throws(() => assertHermesComputeReservation({
    ...configuration,
    rates: { ...configuration.rates, computeMicrosPerVcpuSecond: 2_000 },
  }), /HERMES_COMPUTE_RESERVATION_INSUFFICIENT/);
});
