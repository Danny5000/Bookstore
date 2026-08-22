import {
  parseFinancialAdminCommandStatus,
  type FinancialAdminCommandReferenceDto,
  type FinancialAdminCommandStatusDto
} from '$lib/types/financial-reporting';

export interface FinancialCommandStatusPresentation {
  readonly label: string;
  readonly guidance: string;
  readonly summary: string | null;
}

type DisplayStatus = FinancialAdminCommandReferenceDto | FinancialAdminCommandStatusDto;
type StatusFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PollOutcome = 'terminal' | 'pending' | 'unavailable' | 'aborted';

interface PollOptions {
  readonly signal: AbortSignal;
  readonly pollPending: boolean;
  readonly read: () => Promise<FinancialAdminCommandStatusDto>;
  readonly wait: (delay: number, signal: AbortSignal) => Promise<void>;
  readonly update: (status: FinancialAdminCommandStatusDto) => void;
  readonly announceUnavailable: () => void;
  readonly invalidate: () => Promise<void> | void;
}

function accessSummary(changed: boolean): string {
  return changed ? 'Access changed.' : 'Access was unchanged.';
}

function emailSummary(queued: boolean): string {
  return queued ? 'Customer email queued.' : 'No customer email was queued.';
}

function referencePresentation(status: DisplayStatus): FinancialCommandStatusPresentation {
  if (status.status === 'pending') return {
    label: 'Pending',
    guidance: 'This command is still processing. Current refund facts will refresh after it finishes.',
    summary: null
  };
  if (status.status === 'succeeded') return {
    label: 'Succeeded',
    guidance: 'Reload current refund facts before taking another financial action.',
    summary: null
  };
  if (status.status === 'denied') return {
    label: 'Denied',
    guidance: 'This command was denied. Reload current facts before taking another action.',
    summary: null
  };
  if (status.status === 'conflict') return {
    label: 'Conflict — reload current facts',
    guidance: 'The financial facts changed. Reload current facts before taking another action.',
    summary: null
  };
  return {
    label: 'Failed',
    guidance: 'The command could not be completed. Reload current facts before taking another action.',
    summary: null
  };
}

export function financialCommandStatusPresentation(
  status: DisplayStatus
): FinancialCommandStatusPresentation {
  if (!('resultCode' in status) || status.resultCode === null) {
    return referencePresentation(status);
  }
  switch (status.resultCode) {
    case 'draft_saved':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before editing the shared draft again.',
        summary: status.result.changed
          ? `Shared refund draft saved at version ${status.result.draftVersion}.`
          : `Shared refund draft already matched version ${status.result.draftVersion}; no changes were needed.`
      };
    case 'draft_discarded':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before editing the shared draft again.',
        summary: status.result.changed
          ? `Shared refund draft version ${status.result.draftVersion} discarded.`
          : `Shared refund draft was already inactive at version ${status.result.draftVersion}; no changes were needed.`
      };
    case 'allocation_finalized':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before taking another financial action.',
        summary: `Refund allocation version ${status.result.finalizedDraftVersion} finalized. ${accessSummary(status.result.accessChanged)} ${emailSummary(status.result.emailQueued)}`
      };
    case 'correction_created':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before taking another financial action.',
        summary: `Reporting correction version ${status.result.correctionVersion} created.`
      };
    case 'recovery_activated':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before taking another financial action.',
        summary: `Administrative recovery activated. ${accessSummary(status.result.accessChanged)} ${emailSummary(status.result.emailQueued)}`
      };
    case 'recovery_deactivated':
      return {
        label: 'Succeeded',
        guidance: 'Reload current refund facts before taking another financial action.',
        summary: `Administrative recovery deactivated. ${accessSummary(status.result.accessChanged)} ${emailSummary(status.result.emailQueued)}`
      };
    case 'capability_revoked':
      return {
        label: 'Denied',
        guidance: 'Your financial administrator permission changed before this command ran. Reload current facts and contact an authorized administrator if the action is still needed.',
        summary: null
      };
    case 'stale_state':
      return {
        label: 'Conflict — reload current facts',
        guidance: 'The financial facts changed before this command ran. Reload current facts and review them before taking another action.',
        summary: null
      };
    case 'not_eligible':
      return {
        label: 'Conflict — reload current facts',
        guidance: 'The requested action is no longer eligible. Reload current facts and review the current state.',
        summary: null
      };
    case 'invalid_command':
      return {
        label: 'Failed',
        guidance: 'The command could not be accepted. Reload current facts and review the request before taking another action.',
        summary: null
      };
    case 'command_failed':
      return {
        label: 'Failed',
        guidance: 'The command could not be completed. Reload current facts; if the problem continues, report the command reference to support.',
        summary: null
      };
  }
}

export async function readFinancialCommandStatus(
  endpoint: string,
  signal: AbortSignal,
  fetcher: StatusFetcher = fetch
): Promise<FinancialAdminCommandStatusDto> {
  const response = await fetcher(endpoint, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    signal
  });
  if (!response.ok) throw new Error('financial command status unavailable');
  return parseFinancialAdminCommandStatus(await response.json());
}

export function waitForFinancialCommandPoll(
  delay: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((complete) => {
    if (signal.aborted) {
      complete();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      complete();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function pollFinancialCommandStatus(options: PollOptions): Promise<PollOutcome> {
  let attempt = 0;
  while (!options.signal.aborted) {
    let status: FinancialAdminCommandStatusDto;
    try {
      status = await options.read();
    } catch (error: unknown) {
      if (options.signal.aborted || isAbortError(error)) return 'aborted';
      options.announceUnavailable();
      return 'unavailable';
    }
    if (options.signal.aborted) return 'aborted';
    options.update(status);
    if (status.status !== 'pending') {
      if (status.status === 'succeeded' || status.status === 'conflict') {
        try {
          await options.invalidate();
        } catch {
          if (options.signal.aborted) return 'aborted';
          options.announceUnavailable();
          return 'unavailable';
        }
      }
      return 'terminal';
    }
    if (!options.pollPending) return 'pending';
    const delay = attempt >= 4 ? 5_000 : 500 * (2 ** attempt);
    attempt += 1;
    try {
      await options.wait(delay, options.signal);
    } catch (error: unknown) {
      if (options.signal.aborted || isAbortError(error)) return 'aborted';
      options.announceUnavailable();
      return 'unavailable';
    }
  }
  return 'aborted';
}
