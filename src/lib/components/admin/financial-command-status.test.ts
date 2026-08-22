import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinancialAdminCommandStatusDto } from '$lib/types/financial-reporting';
import {
  financialCommandStatusPresentation,
  pollFinancialCommandStatus,
  readFinancialCommandStatus,
  waitForFinancialCommandPoll
} from './financial-command-status';

const COMMAND_ID = '00000000-0000-4000-8000-000000011501';
const REFUND_ID = '00000000-0000-4000-8000-000000011502';
const OCCURRED_AT = '2026-08-22T12:00:00.000Z';

const pending = {
  commandId: COMMAND_ID,
  kind: 'refund_draft_save',
  status: 'pending',
  resultCode: null,
  result: null,
  createdAt: OCCURRED_AT,
  updatedAt: OCCURRED_AT,
  completedAt: null
} as const satisfies FinancialAdminCommandStatusDto;

const succeeded = {
  ...pending,
  status: 'succeeded',
  resultCode: 'draft_saved',
  result: { refundId: REFUND_ID, draftVersion: 2, changed: true },
  completedAt: OCCURRED_AT
} as const satisfies FinancialAdminCommandStatusDto;

const conflict = {
  ...pending,
  status: 'conflict',
  resultCode: 'stale_state',
  result: null,
  completedAt: OCCURRED_AT
} as const satisfies FinancialAdminCommandStatusDto;

afterEach(() => vi.useRealTimers());

describe('financial command status reader', () => {
  it('uses the resolved same-origin endpoint and parses the allowlisted DTO', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(succeeded), { status: 200 }));
    await expect(readFinancialCommandStatus(
      '/admin/sales/commands/resolved-command',
      new AbortController().signal,
      fetcher
    )).resolves.toEqual(succeeded);
    expect(fetcher).toHaveBeenCalledWith('/admin/sales/commands/resolved-command', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: expect.any(AbortSignal)
    });
  });

  it('rejects unavailable responses and non-allowlisted response data', async () => {
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(readFinancialCommandStatus(
      '/admin/sales/commands/unavailable',
      new AbortController().signal,
      unavailable
    )).rejects.toThrow('financial command status unavailable');

    const privateResponse = vi.fn(async () => new Response(JSON.stringify({
      ...pending,
      privateInput: 'must-not-cross-the-boundary'
    })));
    await expect(readFinancialCommandStatus(
      '/admin/sales/commands/private',
      new AbortController().signal,
      privateResponse
    )).rejects.toThrow();
  });
});

describe('financial command status polling', () => {
  it('executes capped backoff, reads one terminal value, stops, and invalidates succeeded facts', async () => {
    const values: FinancialAdminCommandStatusDto[] = [
      pending, pending, pending, pending, pending, succeeded
    ];
    const read = vi.fn(async () => values.shift() ?? succeeded);
    const waits: number[] = [];
    const update = vi.fn();
    const announceUnavailable = vi.fn();
    const invalidate = vi.fn(async () => undefined);

    await expect(pollFinancialCommandStatus({
      signal: new AbortController().signal,
      pollPending: true,
      read,
      wait: async (delay) => { waits.push(delay); },
      update,
      announceUnavailable,
      invalidate
    })).resolves.toBe('terminal');

    expect(waits).toEqual([500, 1_000, 2_000, 4_000, 5_000]);
    expect(read).toHaveBeenCalledTimes(6);
    expect(update).toHaveBeenCalledTimes(6);
    expect(update.mock.calls.filter(([value]) => value.status !== 'pending')).toEqual([[succeeded]]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(announceUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    [succeeded, true],
    [conflict, true],
    [{ ...conflict, status: 'denied', resultCode: 'capability_revoked' } as const, false],
    [{ ...conflict, status: 'failed', resultCode: 'command_failed' } as const, false]
  ])('stops after one %s read and invalidates only succeeded/conflict', async (value, refresh) => {
    const read = vi.fn(async () => value as FinancialAdminCommandStatusDto);
    const invalidate = vi.fn(async () => undefined);
    await expect(pollFinancialCommandStatus({
      signal: new AbortController().signal,
      pollPending: false,
      read,
      wait: vi.fn(),
      update: vi.fn(),
      announceUnavailable: vi.fn(),
      invalidate
    })).resolves.toBe('terminal');
    expect(read).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledTimes(refresh ? 1 : 0);
  });

  it('announces an unavailable read once and stops', async () => {
    const announceUnavailable = vi.fn();
    const read = vi.fn(async (): Promise<FinancialAdminCommandStatusDto> => {
      throw new Error('network details that must not be announced');
    });
    await expect(pollFinancialCommandStatus({
      signal: new AbortController().signal,
      pollPending: true,
      read,
      wait: vi.fn(),
      update: vi.fn(),
      announceUnavailable,
      invalidate: vi.fn()
    })).resolves.toBe('unavailable');
    expect(read).toHaveBeenCalledOnce();
    expect(announceUnavailable).toHaveBeenCalledOnce();
    expect(announceUnavailable).toHaveBeenCalledWith();
  });

  it('clears the pending timeout and stops when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForFinancialCommandPoll(5_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);

    const read = vi.fn(async () => pending);
    await expect(pollFinancialCommandStatus({
      signal: controller.signal,
      pollPending: true,
      read,
      wait: waitForFinancialCommandPoll,
      update: vi.fn(),
      announceUnavailable: vi.fn(),
      invalidate: vi.fn()
    })).resolves.toBe('aborted');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('financial command status presentation', () => {
  it('uses only fixed guidance and safe result values', () => {
    expect(financialCommandStatusPresentation(succeeded)).toEqual({
      label: 'Succeeded',
      guidance: 'Reload current refund facts before editing the shared draft again.',
      summary: 'Shared refund draft saved at version 2.'
    });
    expect(financialCommandStatusPresentation(conflict)).toEqual({
      label: 'Conflict — reload current facts',
      guidance: 'The financial facts changed before this command ran. Reload current facts and review them before taking another action.',
      summary: null
    });
  });
});
