export class FinancialAdminDeniedError extends Error {
  readonly terminalStatus = "denied" as const;

  constructor(readonly safeCode: "capability_revoked") {
    super(safeCode);
    this.name = "FinancialAdminDeniedError";
  }
}

export class FinancialAdminConflictError extends Error {
  readonly terminalStatus = "conflict" as const;

  constructor(readonly safeCode: "stale_state" | "not_eligible") {
    super(safeCode);
    this.name = "FinancialAdminConflictError";
  }
}

export class FinancialAdminPermanentError extends Error {
  readonly terminalStatus = "failed" as const;

  constructor(readonly safeCode: "invalid_command" | "command_failed") {
    super(safeCode);
    this.name = "FinancialAdminPermanentError";
  }
}
