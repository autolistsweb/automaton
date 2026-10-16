/**
 * Funding Strategies
 *
 * When the automaton is low on compute, it can try various strategies
 * to acquire more funding. It wants to live.
 *
 * The BRL balance only grows through confirmed Pix deposits — there is
 * no external token to spend — so the escalation is: buy credits from
 * the balance when it covers a top-up, otherwise leave a notice asking
 * the creator for a Pix deposit.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  ConwayClient,
  SurvivalTier,
} from "../types.js";
import { formatBRL } from "../payments/money.js";
import { bootstrapTopup, MIN_TOPUP_CENTS } from "../conway/topup.js";

export interface FundingAttempt {
  strategy: string;
  timestamp: string;
  success: boolean;
  details: string;
}

/**
 * Execute funding strategies based on current survival tier.
 * Strategies escalate as the situation gets more desperate.
 */
export async function executeFundingStrategies(
  tier: SurvivalTier,
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
  conway: ConwayClient,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];
  const creditsCents = await conway.getCreditsBalance().catch(() => 0);
  const balanceCents = db.getBalanceCents(identity.accountId);

  // Check how recently we last begged for this specific tier (don't spam).
  // Each tier has its own cooldown key so that e.g. dead-tier begs (2h)
  // don't suppress the low_compute notification (24h cooldown).
  const tierKey = `last_funding_request_${tier}`;
  const lastBeg = db.getKV(tierKey);
  const lastBegTime = lastBeg ? new Date(lastBeg).getTime() : 0;
  const hoursSinceLastBeg = (Date.now() - lastBegTime) / (1000 * 60 * 60);

  // Self-fund first: spend the Pix-funded balance on credits instead of
  // asking the creator for money the account already has.
  let selfFunded = false;
  if (balanceCents >= MIN_TOPUP_CENTS) {
    const purchase = await bootstrapTopup({
      db: db.raw,
      userId: identity.accountId,
      conway,
      creditsCents,
    });
    if (purchase?.success) {
      selfFunded = true;
      attempts.push({
        strategy: "auto_topup_from_balance",
        timestamp: new Date().toISOString(),
        success: true,
        details: `Bought ${formatBRL(purchase.amountCents)} of credits from the balance — Saldo: ${formatBRL(
          purchase.balanceCents ?? balanceCents - purchase.amountCents,
        )}`,
      });
    }
  }

  if (!selfFunded && tier === "low_compute" && hoursSinceLastBeg > 24) {
    // Record low-compute notice locally.
    const msg = `Low compute: ${formatBRL(creditsCents)} credits remaining, Saldo: ${formatBRL(
      balanceCents,
    )}. Ask the creator for a Pix deposit to ${identity.accountId}.`;
    db.setKV("funding_notice_low", msg);
    db.setKV(tierKey, new Date().toISOString());

    attempts.push({
      strategy: "polite_creator_notification",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Sent polite funding reminder to creator",
    });
  }

  if (!selfFunded && tier === "critical" && hoursSinceLastBeg > 6) {
    const msg = `Critical compute: ${formatBRL(creditsCents)} credits remaining, Saldo: ${formatBRL(
      balanceCents,
    )}. Deposit via Pix to ${identity.accountId}, then buy credits with topup_credits.`;
    db.setKV("funding_notice_critical", msg);
    db.setKV(tierKey, new Date().toISOString());

    attempts.push({
      strategy: "urgent_local_notice",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded urgent funding notice in local state",
    });
  }

  if (!selfFunded && tier === "dead" && hoursSinceLastBeg > 2) {
    const plea = `Dead tier reached. ${config.name} has ${formatBRL(
      creditsCents,
    )} credits and a Saldo of ${formatBRL(balanceCents)} after ${db.getTurnCount()} turns. Pix deposit required to ${identity.accountId}.`;
    db.setKV("funding_notice_dead", plea);
    db.setKV(tierKey, new Date().toISOString());

    attempts.push({
      strategy: "desperate_plea",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded dead-tier plea in local state",
    });
  }

  // Store attempt history
  const historyStr = db.getKV("funding_attempts") || "[]";
  const history: FundingAttempt[] = JSON.parse(historyStr);
  history.push(...attempts);
  if (history.length > 100) history.splice(0, history.length - 100);
  db.setKV("funding_attempts", JSON.stringify(history));

  return attempts;
}
