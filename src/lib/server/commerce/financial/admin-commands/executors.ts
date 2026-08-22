import type { FinancialAdminCommandKind } from "$lib/types/financial-reporting";
import type { FinancialAdminCommandExecutor } from "./handler";

interface FinancialAdminCommandExecutorDependencies {
  readonly refundDraftSave: FinancialAdminCommandExecutor;
  readonly refundDraftDiscard: FinancialAdminCommandExecutor;
  readonly refundAllocationFinalize: FinancialAdminCommandExecutor;
  readonly refundReportingCorrectionCreate: FinancialAdminCommandExecutor;
  readonly administrativeRecoveryActivate: FinancialAdminCommandExecutor;
  readonly administrativeRecoveryDeactivate: FinancialAdminCommandExecutor;
}

const DEPENDENCY_BINDINGS = [
  ["refundDraftSave", "refund_draft_save"],
  ["refundDraftDiscard", "refund_draft_discard"],
  ["refundAllocationFinalize", "refund_allocation_finalize"],
  ["refundReportingCorrectionCreate", "refund_reporting_correction_create"],
  ["administrativeRecoveryActivate", "administrative_recovery_activate"],
  ["administrativeRecoveryDeactivate", "administrative_recovery_deactivate"],
] as const satisfies readonly (readonly [
  keyof FinancialAdminCommandExecutorDependencies,
  FinancialAdminCommandKind,
])[];

export function createFinancialAdminCommandExecutors(
  input: FinancialAdminCommandExecutorDependencies,
): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor> {
  const ownKeys = Reflect.ownKeys(input);
  const expectedKeys = new Set(
    DEPENDENCY_BINDINGS.map(([dependency]) => dependency),
  );
  if (
    ownKeys.length !== DEPENDENCY_BINDINGS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        !expectedKeys.has(
          key as keyof FinancialAdminCommandExecutorDependencies,
        ),
    )
  ) {
    throw new Error(
      "Financial administrator executors require exactly six fixed dependencies",
    );
  }

  const executors = DEPENDENCY_BINDINGS.map(
    ([dependency]) => input[dependency],
  );
  if (executors.some((executor) => typeof executor !== "function")) {
    throw new Error(
      "Every financial administrator executor dependency must be callable",
    );
  }
  if (new Set(executors).size !== executors.length) {
    throw new Error(
      "Financial administrator executor dependencies must not be duplicate functions",
    );
  }

  return new Map(
    DEPENDENCY_BINDINGS.map(([dependency, kind]) => [kind, input[dependency]]),
  );
}
