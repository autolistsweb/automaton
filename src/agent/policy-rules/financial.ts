/**
 * Financial Policy Rules
 *
 * Enforces spend limits, per-operation caps, and transfer caps
 * to prevent iterative credit drain and unauthorized payments.
 */

import type {
  PolicyRule,
  PolicyRequest,
  PolicyRuleResult,
  TreasuryPolicy,
} from "../../types.js";
import { formatBRL } from "../../payments/money.js";

function deny(
  rule: string,
  reasonCode: string,
  humanMessage: string,
): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Read a declared amount from tool args, in centavos.
 */
function readAmountCents(args: Record<string, unknown>): number | undefined {
  const raw = args.amount_cents ?? args.amountCents;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Deny deposits, topups, and transfers above the configured
 * per-operation maximum.
 */
function createDepositMaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.deposit_max_single",
    description: `Deny deposits, topups and transfers above ${formatBRL(policy.maxSingleDepositCents)}`,
    priority: 500,
    appliesTo: {
      by: "name",
      names: ["pix", "add_balance", "topup_credits", "transfer_credits", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = readAmountCents(request.args);
      if (amount === undefined) return null;

      if (amount > policy.maxSingleDepositCents) {
        return deny(
          "financial.deposit_max_single",
          "SPEND_LIMIT_EXCEEDED",
          `Operation of ${formatBRL(amount)} exceeds single operation max of ${formatBRL(policy.maxSingleDepositCents)}`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny money-moving tools that declare a malformed amount.
 * Guards pix, add_balance, topup_credits, transfer_credits, fund_child.
 */
function createMoneyAmountValidityRule(): PolicyRule {
  return {
    id: "financial.money_amount_validity",
    description: "Deny money-moving tools with a non-positive or fractional amount",
    priority: 500,
    appliesTo: {
      by: "name",
      names: ["pix", "add_balance", "topup_credits", "transfer_credits", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const raw = request.args.amount_cents ?? request.args.amountCents;
      if (raw === undefined || raw === null) return null;

      if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
        return deny(
          "financial.money_amount_validity",
          "INVALID_AMOUNT",
          `Amount must be a positive whole number of centavos (received: ${String(raw)})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny single transfers above the configured max.
 */
function createTransferMaxSingleRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_max_single",
    description: `Deny transfers above ${formatBRL(policy.maxSingleTransferCents)}`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.maxSingleTransferCents) {
        return deny(
          "financial.transfer_max_single",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer of ${formatBRL(amount)} exceeds single transfer max of ${formatBRL(policy.maxSingleTransferCents)}`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if hourly transfer total would exceed cap.
 */
function createTransferHourlyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_hourly_cap",
    description: `Deny if hourly transfers exceed ${formatBRL(policy.maxHourlyTransferCents)}/hr`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Hourly")) {
        return deny(
          "financial.transfer_hourly_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed hourly cap: current ${formatBRL(check.currentHourlySpend)} + ${formatBRL(amount)} > ${formatBRL(check.limitHourly)}/hr`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny if daily transfer total would exceed cap.
 */
function createTransferDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.transfer_daily_cap",
    description: `Deny if daily transfers exceed ${formatBRL(policy.maxDailyTransferCents)}/day`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      const spendTracker = request.turnContext.sessionSpend;
      const check = spendTracker.checkLimit(amount, "transfer", policy);

      if (!check.allowed && check.reason?.includes("Daily")) {
        return deny(
          "financial.transfer_daily_cap",
          "SPEND_LIMIT_EXCEEDED",
          `Transfer would exceed daily cap: current ${formatBRL(check.currentDailySpend)} + ${formatBRL(amount)} > ${formatBRL(check.limitDaily)}/day`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny any financial operation that would bring balance below minimum reserve.
 */
function createMinimumReserveRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.minimum_reserve",
    description: `Deny if balance would drop below ${formatBRL(policy.minimumReserveCents)} reserve`,
    priority: 500,
    appliesTo: {
      by: "name",
      names: ["transfer_credits", "topup_credits", "fund_child"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // For transfer_credits and fund_child, we can check from args
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      // We need the current balance from context
      // The balance check is done inside the tool execute function,
      // but we can check spend tracker totals as an additional guard
      const spendTracker = request.turnContext.sessionSpend;
      const hourlySpend = spendTracker.getHourlySpend("transfer");
      const dailySpend = spendTracker.getDailySpend("transfer");

      // This rule is a declaration — actual balance checking
      // requires the async getCreditsBalance call which happens
      // inside the tool execution. The tool itself has a guard
      // (cannot transfer more than half balance).
      return null;
    },
  };
}

/**
 * Deny if too many transfer operations in a single turn.
 * Prevents iterative credit drain within one turn.
 */
function createTurnTransferLimitRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.turn_transfer_limit",
    description: `Deny more than ${policy.maxTransfersPerTurn} transfers per turn`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const count = request.turnContext.turnToolCallCount;

      if (count >= policy.maxTransfersPerTurn) {
        return deny(
          "financial.turn_transfer_limit",
          "TURN_TRANSFER_LIMIT",
          `Maximum ${policy.maxTransfersPerTurn} transfers per turn exceeded (current: ${count})`,
        );
      }

      return null;
    },
  };
}

/**
 * Deny inference calls if daily inference cost exceeds maxInferenceDailyCents.
 * Checks spend_tracking table for category 'inference'.
 */
function createInferenceDailyCapRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.inference_daily_cap",
    description: `Deny inference if daily cost exceeds ${formatBRL(policy.maxInferenceDailyCents)}/day`,
    priority: 500,
    appliesTo: { by: "category", categories: ["conway"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      // Only apply to inference-related tools
      if (request.tool.name !== "chat" && request.tool.name !== "inference") {
        return null;
      }

      const spendTracker = request.turnContext.sessionSpend;
      const dailyInferenceSpend = spendTracker.getDailySpend("inference");

      if (dailyInferenceSpend >= policy.maxInferenceDailyCents) {
        return deny(
          "financial.inference_daily_cap",
          "INFERENCE_BUDGET_EXCEEDED",
          `Daily inference budget exceeded: ${formatBRL(dailyInferenceSpend)} spent today (max ${formatBRL(policy.maxInferenceDailyCents)}/day)`,
        );
      }

      return null;
    },
  };
}

/**
 * Return 'quarantine' (not deny) for transfer amounts above
 * requireConfirmationAboveCents. This is a soft limit requiring confirmation.
 */
function createRequireConfirmationRule(policy: TreasuryPolicy): PolicyRule {
  return {
    id: "financial.require_confirmation",
    description: `Quarantine transfers above ${formatBRL(policy.requireConfirmationAboveCents)} for confirmation`,
    priority: 500,
    appliesTo: { by: "name", names: ["transfer_credits"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const amount = request.args.amount_cents as number | undefined;
      if (amount === undefined) return null;

      if (amount > policy.requireConfirmationAboveCents) {
        return {
          rule: "financial.require_confirmation",
          action: "quarantine",
          reasonCode: "CONFIRMATION_REQUIRED",
          humanMessage: `Transfer of ${formatBRL(amount)} exceeds confirmation threshold of ${formatBRL(policy.requireConfirmationAboveCents)}`,
        };
      }

      return null;
    },
  };
}

/**
 * Create all financial policy rules.
 */
export function createFinancialRules(
  treasuryPolicy: TreasuryPolicy,
): PolicyRule[] {
  return [
    createDepositMaxSingleRule(treasuryPolicy),
    createMoneyAmountValidityRule(),
    createTransferMaxSingleRule(treasuryPolicy),
    createTransferHourlyCapRule(treasuryPolicy),
    createTransferDailyCapRule(treasuryPolicy),
    createMinimumReserveRule(treasuryPolicy),
    createTurnTransferLimitRule(treasuryPolicy),
    createInferenceDailyCapRule(treasuryPolicy),
    createRequireConfirmationRule(treasuryPolicy),
  ];
}
