import { describe, expect, it } from 'vitest';
import {
  financialWitnessHarnessTimeoutMs,
  financialWitnessTestTimeoutMs,
  runBoundedFinancialWitnessHarness
} from '../../scripts/financial-restore-witness-harness';

describe('financial restore verifier service witness', () => {
  it(
    'executes schema-object, source-parity, deterministic-allocation, audit, payout, and chronology verifier witnesses in PostgreSQL',
    async () => {
      const result = await runBoundedFinancialWitnessHarness();
      const output = `${result.stdout}${result.stderr}`;
      expect(
        result.timedOut,
        `financial witness harness exceeded ${financialWitnessHarnessTimeoutMs}ms; ${
          result.cleanup ?? 'timeout cleanup was not attempted'
        }\n${output.slice(-20_000)}`
      ).toBe(false);
      expect(output).toContain(
        '[restore-verifier] schema-object, issue-identity, source-parity, deterministic-allocation, audit, classification, payout, replay-child, allocation-graph, refund-component, dispute-presentment, and combined-chronology witnesses passed'
      );
      expect(output).toContain(
        '[restore-verifier] plan7a operations schema, catalog, authority, claim, audit, and clear-capability witnesses passed'
      );
      expect(output).not.toContain('A'.repeat(43));
      expect(result.status).toBe(0);
    },
    financialWitnessTestTimeoutMs
  );
});
