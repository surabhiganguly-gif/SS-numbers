// Pure, DOM-free budgeting engine — Sections 3.4-3.7 of the requirements doc.
// No IndexedDB/store access here so this is unit-testable from plain Node.

import { monthKey, addMonths, monthsBetween, trailingMonthKeys, effectiveValue } from './format.js';
import {
  SQUEEZE_CATEGORIES,
  FLOOR_TRAILING_CATEGORIES,
  FIXED_VALUE_CATEGORIES,
  STICKY_FIXED_CATEGORIES,
  TRAILING_FIXED_CATEGORIES,
} from './categories.js';

const TRAILING_MONTHS = 3;
const LIQUID_SAVINGS_MIN_PCT = 0.05;
const LIQUID_SAVINGS_MAX_PCT = 0.15;
const LIQUID_CUT_STEP_PCT = 0.05;
const GOAL_CUT_CAP = 0.5; // shortfall stage 2 never cuts a goal by more than this
const SALARY_CHANGE_THRESHOLD = 0.05;
const SQUEEZE_START_PCT = 80;
const SQUEEZE_EASE_STEP = 5;
const SQUEEZE_EASE_AFTER_MONTHS = 2;

// Averages only over months actually present in the transaction history (up to
// `count` months back) — a fixed divide-by-3 would understate the average
// while there's less than 3 months of data on record.
export function trailingAverage(transactions, category, atMonthKey, count = TRAILING_MONTHS) {
  if (transactions.length === 0) return 0;
  const earliestMonthKey = transactions.reduce((min, t) => {
    const mk = monthKey(t.date);
    return !min || mk < min ? mk : min;
  }, null);
  const keys = trailingMonthKeys(atMonthKey, count).filter((mk) => mk >= earliestMonthKey);
  if (keys.length === 0) return 0;
  const total = keys.reduce((sum, mk) => {
    const monthTotal = transactions
      .filter((t) => t.category === category && monthKey(t.date) === mk)
      .reduce((s, t) => s + t.amount, 0);
    return sum + monthTotal;
  }, 0);
  return total / keys.length;
}

export function isInstallmentActiveInMonth(plan, atMonthKey) {
  const monthsElapsed = monthsBetween(plan.startMonth, atMonthKey);
  return monthsElapsed >= 0 && monthsElapsed < plan.tenureMonths;
}

export function computeCCPaymentDue({ transactions, ccInstallmentPlans, atMonthKey }) {
  const prevMonth = addMonths(atMonthKey, -1);
  const lumpsumDue = transactions
    .filter((t) => t.kind === 'ccPurchase' && t.ccPlanType === 'lumpsum' && monthKey(t.date) === prevMonth)
    .reduce((sum, t) => sum + t.amount, 0);
  const installmentsDue = ccInstallmentPlans
    .filter((p) => isInstallmentActiveInMonth(p, atMonthKey))
    .reduce((sum, p) => sum + p.monthlyAmount, 0);
  return lumpsumDue + installmentsDue;
}

// Goal required monthly contribution is computed once (at creation/edit time) and
// intentionally NOT recalculated to compensate for a shortfall — Section 3.4.
export function computeRequiredMonthlyContribution(goal, atMonthKey) {
  const monthsRemaining = Math.max(1, monthsBetween(atMonthKey, monthKey(goal.targetDate)));
  return goal.targetAmount / monthsRemaining;
}

export function goalProgress(goal, transactions) {
  return transactions
    .filter((t) => t.kind === 'goalContribution' && t.goalId === goal.id)
    .reduce((sum, t) => sum + t.amount, 0);
}

export function goalStatus(goal, transactions, atMonthKey) {
  const contributed = goalProgress(goal, transactions);
  const monthsSinceCreation = Math.max(1, monthsBetween(monthKey(goal.createdAt), atMonthKey) + 1);
  const expectedByNow = goal.requiredMonthlyContribution * monthsSinceCreation;
  const shortfall = Math.max(0, expectedByNow - contributed);
  const fullyFunded = contributed >= goal.targetAmount;
  return { contributed, shortfall, fullyFunded, underfunded: shortfall > 0 && !fullyFunded };
}

// Squeeze-percentage state machine — Section 3.5 step 5.
export function initialSqueezeState() {
  return { squeezePct: SQUEEZE_START_PCT, consecutiveHitMonths: 0, wasUnderfunded: true };
}

export function advanceSqueezeState(prevState, { anyGoalUnderfunded, hitSavingsTargetThisMonth }) {
  if (!anyGoalUnderfunded) {
    return { squeezePct: 100, consecutiveHitMonths: 0, wasUnderfunded: false };
  }
  if (prevState.wasUnderfunded === false) {
    // Shortfall reappeared after goals were previously fine — snap back, don't ease gradually.
    return { squeezePct: SQUEEZE_START_PCT, consecutiveHitMonths: 0, wasUnderfunded: true };
  }
  let consecutiveHitMonths = hitSavingsTargetThisMonth ? prevState.consecutiveHitMonths + 1 : 0;
  let squeezePct = prevState.squeezePct;
  if (consecutiveHitMonths >= SQUEEZE_EASE_AFTER_MONTHS) {
    squeezePct = Math.min(100, squeezePct + SQUEEZE_EASE_STEP);
    consecutiveHitMonths = 0;
  }
  return { squeezePct, consecutiveHitMonths, wasUnderfunded: true };
}

export function detectSalaryChange(prevSalary, newSalary) {
  if (!prevSalary) return { changed: false, pctChange: 0, direction: null };
  const pctChange = (newSalary - prevSalary) / prevSalary;
  const changed = Math.abs(pctChange) > SALARY_CHANGE_THRESHOLD;
  return { changed, pctChange, direction: pctChange > 0 ? 'increase' : 'decrease' };
}

// Staged shortfall waterfall: everything except Liquid Savings and Goals is
// already fixed/protected by this point, so a shortfall is absorbed in order —
// (1) trim Liquid Savings by 5 percentage points, (2) cut all goals uniformly
// by up to 50%, (3) drop Liquid Savings to zero, (4) cut goals further (beyond
// 50%, down to zero if needed) until the month's numbers fit the salary.
export function resolveShortfall({ salary, fixedTotal, ccPaymentDue, idealGoalTotal, idealLiquidPct, remainingBalance }) {
  const base = Math.max(0, remainingBalance);
  const idealLiquidAmount = Math.max(0, idealLiquidPct) * base;
  const availableForGoalsAndLiquid = salary - fixedTotal - ccPaymentDue;

  if (idealGoalTotal + idealLiquidAmount <= availableForGoalsAndLiquid) {
    return { liquidPct: idealLiquidPct, liquidAmount: idealLiquidAmount, goalScaleFactor: 1, stage: 'none' };
  }

  // Stage 1 — trim Liquid Savings by 5 percentage points (floored at the band minimum).
  const stage1LiquidPct = Math.max(LIQUID_SAVINGS_MIN_PCT, idealLiquidPct - LIQUID_CUT_STEP_PCT);
  const stage1LiquidAmount = stage1LiquidPct * base;
  if (idealGoalTotal + stage1LiquidAmount <= availableForGoalsAndLiquid) {
    return { liquidPct: stage1LiquidPct, liquidAmount: stage1LiquidAmount, goalScaleFactor: 1, stage: 'liquid-trimmed' };
  }

  // Stage 2 — cut every goal by the same percentage, capped at 50%.
  const neededForGoals = availableForGoalsAndLiquid - stage1LiquidAmount;
  const rawScale = idealGoalTotal > 0 ? neededForGoals / idealGoalTotal : 1;
  const stage2Scale = Math.max(1 - GOAL_CUT_CAP, Math.min(1, rawScale));
  if (idealGoalTotal * stage2Scale + stage1LiquidAmount <= availableForGoalsAndLiquid + 1e-6) {
    return { liquidPct: stage1LiquidPct, liquidAmount: stage1LiquidAmount, goalScaleFactor: stage2Scale, stage: 'goals-cut' };
  }

  // Stage 3 — drop Liquid Savings to zero, goals stay at the 50% cap.
  if (idealGoalTotal * stage2Scale <= availableForGoalsAndLiquid) {
    return { liquidPct: 0, liquidAmount: 0, goalScaleFactor: stage2Scale, stage: 'liquid-zeroed' };
  }

  // Stage 4 — reduce goals further (beyond 50%, down to zero) until it fits.
  const stage4Scale = idealGoalTotal > 0 ? Math.max(0, availableForGoalsAndLiquid / idealGoalTotal) : 0;
  return { liquidPct: 0, liquidAmount: 0, goalScaleFactor: stage4Scale, stage: 'goals-reduced-further' };
}

// `commitments` is a list of { name, versions: [{ amount, effectiveFrom }] } covering
// every sticky-fixed category (Rent, EMIs, SIP Savings, Vehicle Maintenance,
// Miscellaneous) — all share the same effective-dated versioning per Section 3.7.
export function commitmentValue(commitments, name, atMonthKey) {
  const c = commitments.find((c) => c.name === name);
  return c ? effectiveValue(c.versions, atMonthKey) : 0;
}

function sumCommitmentValues(commitments, names, atMonthKey) {
  return names.reduce((sum, name) => sum + commitmentValue(commitments, name, atMonthKey), 0);
}

function sumTrailingValues(transactions, names, atMonthKey) {
  return names.reduce((sum, name) => sum + trailingAverage(transactions, name, atMonthKey), 0);
}

/**
 * Computes the full editable budget proposal for a month, triggered when a Salary
 * transaction is logged. All inputs are plain data — no store/db access.
 */
export function computeBudgetProposal({
  salaryAmount,
  atMonthKey,
  transactions,
  commitments,
  ccInstallmentPlans,
  goals, // [{ ...goal, requiredMonthlyContribution }]
  squeezeState,
}) {
  const stickyFixedBudgets = Object.fromEntries(
    STICKY_FIXED_CATEGORIES.map((cat) => [cat, commitmentValue(commitments, cat, atMonthKey)])
  );
  const trailingFixedBudgets = Object.fromEntries(
    TRAILING_FIXED_CATEGORIES.map((cat) => [cat, trailingAverage(transactions, cat, atMonthKey)])
  );
  const fixedCommitmentTotal =
    sumCommitmentValues(commitments, STICKY_FIXED_CATEGORIES, atMonthKey) +
    sumTrailingValues(transactions, TRAILING_FIXED_CATEGORIES, atMonthKey);

  const ccPaymentDue = computeCCPaymentDue({ transactions, ccInstallmentPlans, atMonthKey });
  const remainingBalance = salaryAmount - fixedCommitmentTotal - ccPaymentDue;

  const floorTrailingTotal = FLOOR_TRAILING_CATEGORIES.reduce(
    (sum, cat) => sum + trailingAverage(transactions, cat, atMonthKey),
    0
  );
  const fixedValueBudgets = Object.fromEntries(
    FIXED_VALUE_CATEGORIES.map((cat) => [cat, commitmentValue(commitments, cat, atMonthKey)])
  );
  const fixedValueTotal = Object.values(fixedValueBudgets).reduce((a, b) => a + b, 0);
  const squeezeFraction = squeezeState.squeezePct / 100;
  const squeezeCategoryBudgets = {};
  let squeezeCategoryTotal = 0;
  for (const cat of SQUEEZE_CATEGORIES) {
    const budget = trailingAverage(transactions, cat, atMonthKey) * squeezeFraction;
    squeezeCategoryBudgets[cat] = budget;
    squeezeCategoryTotal += budget;
  }

  const variableSpendFloor = floorTrailingTotal + fixedValueTotal + squeezeCategoryTotal;

  const goalContributions = goals.map((g) => ({ goalId: g.id, amount: g.requiredMonthlyContribution }));
  const idealGoalTotal = goalContributions.reduce((s, g) => s + g.amount, 0);

  const rawLiquidPct =
    remainingBalance > 0
      ? (remainingBalance - variableSpendFloor - idealGoalTotal) / remainingBalance
      : LIQUID_SAVINGS_MIN_PCT;
  const idealLiquidPct = Math.min(LIQUID_SAVINGS_MAX_PCT, Math.max(LIQUID_SAVINGS_MIN_PCT, rawLiquidPct));

  const resolved = resolveShortfall({
    salary: salaryAmount,
    fixedTotal: fixedCommitmentTotal,
    ccPaymentDue,
    idealGoalTotal,
    idealLiquidPct,
    remainingBalance,
  });

  const finalGoalContributions = goalContributions.map((gc) => ({
    ...gc,
    amount: gc.amount * resolved.goalScaleFactor,
  }));
  const goalContributionTotal = idealGoalTotal * resolved.goalScaleFactor;
  const unresolvedShortfall = Math.max(
    0,
    fixedCommitmentTotal + ccPaymentDue + goalContributionTotal + resolved.liquidAmount - salaryAmount
  );

  return {
    monthKey: atMonthKey,
    salaryAmount,
    fixedCommitmentTotal,
    stickyFixedBudgets,
    trailingFixedBudgets,
    ccPaymentDue,
    remainingBalance,
    variableSpendFloor,
    squeezePct: squeezeState.squeezePct,
    squeezeCategoryBudgets,
    floorCategoryBudgets: Object.fromEntries(
      FLOOR_TRAILING_CATEGORIES.map((cat) => [cat, trailingAverage(transactions, cat, atMonthKey)])
    ),
    fixedValueBudgets,
    goalContributions: finalGoalContributions,
    goalContributionTotal,
    liquidSavingsPct: resolved.liquidPct,
    liquidSavingsAmount: resolved.liquidAmount,
    shortfallStage: resolved.stage,
    unresolvedShortfall,
  };
}
