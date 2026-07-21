// Pure, DOM-free budgeting engine — Sections 3.4-3.7 of the requirements doc.
// No IndexedDB/store access here so this is unit-testable from plain Node.

import { monthKey, addMonths, monthsBetween, trailingMonthKeys, effectiveValue } from './format.js';
import {
  SQUEEZE_CATEGORIES,
  FLOOR_TRAILING_CATEGORIES,
  VEHICLE_MAINTENANCE_CATEGORIES,
  FIXED_COMMITMENT_NAMES,
} from './categories.js';

const TRAILING_MONTHS = 3;
const LIQUID_SAVINGS_MIN_PCT = 0.05;
const LIQUID_SAVINGS_MAX_PCT = 0.15;
const SALARY_CHANGE_THRESHOLD = 0.05;
const SQUEEZE_START_PCT = 80;
const SQUEEZE_EASE_STEP = 5;
const SQUEEZE_EASE_AFTER_MONTHS = 2;

export function trailingAverage(transactions, category, atMonthKey, count = TRAILING_MONTHS) {
  const keys = trailingMonthKeys(atMonthKey, count);
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

export function splitShortfall(shortfall, goalContributionTotal, liquidSavingsAmount) {
  const pool = goalContributionTotal + liquidSavingsAmount;
  if (shortfall <= 0 || pool <= 0) return { goalReduction: 0, liquidReduction: 0 };
  const goalReduction = Math.min(shortfall * (goalContributionTotal / pool), goalContributionTotal);
  const liquidReduction = Math.min(shortfall * (liquidSavingsAmount / pool), liquidSavingsAmount);
  return { goalReduction, liquidReduction };
}

// `commitments` is a list of { name, versions: [{ amount, effectiveFrom }] } covering
// both Fixed Monthly Commitments and the two Vehicle Maintenance categories, which
// share the same effective-dated versioning per Section 3.7.
export function commitmentValue(commitments, name, atMonthKey) {
  const c = commitments.find((c) => c.name === name);
  return c ? effectiveValue(c.versions, atMonthKey) : 0;
}

function sumCommitmentValues(commitments, names, atMonthKey) {
  return names.reduce((sum, name) => sum + commitmentValue(commitments, name, atMonthKey), 0);
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
  const fixedCommitmentTotal = sumCommitmentValues(commitments, FIXED_COMMITMENT_NAMES, atMonthKey);
  const ccPaymentDue = computeCCPaymentDue({ transactions, ccInstallmentPlans, atMonthKey });
  const remainingBalance = salaryAmount - fixedCommitmentTotal - ccPaymentDue;

  const floorTrailingTotal = FLOOR_TRAILING_CATEGORIES.reduce(
    (sum, cat) => sum + trailingAverage(transactions, cat, atMonthKey),
    0
  );
  const vehicleMaintenanceBudgets = Object.fromEntries(
    VEHICLE_MAINTENANCE_CATEGORIES.map((cat) => [cat, commitmentValue(commitments, cat, atMonthKey)])
  );
  const vehicleMaintenanceTotal = Object.values(vehicleMaintenanceBudgets).reduce((a, b) => a + b, 0);
  const squeezeFraction = squeezeState.squeezePct / 100;
  const squeezeCategoryBudgets = {};
  let squeezeCategoryTotal = 0;
  for (const cat of SQUEEZE_CATEGORIES) {
    const budget = trailingAverage(transactions, cat, atMonthKey) * squeezeFraction;
    squeezeCategoryBudgets[cat] = budget;
    squeezeCategoryTotal += budget;
  }

  const variableSpendFloor = floorTrailingTotal + vehicleMaintenanceTotal + squeezeCategoryTotal;

  const goalContributions = goals.map((g) => ({ goalId: g.id, amount: g.requiredMonthlyContribution }));
  const goalContributionTotal = goalContributions.reduce((s, g) => s + g.amount, 0);

  const rawLiquidPct =
    remainingBalance > 0
      ? (remainingBalance - variableSpendFloor - goalContributionTotal) / remainingBalance
      : LIQUID_SAVINGS_MIN_PCT;
  const liquidSavingsPct = Math.min(LIQUID_SAVINGS_MAX_PCT, Math.max(LIQUID_SAVINGS_MIN_PCT, rawLiquidPct));
  let liquidSavingsAmount = liquidSavingsPct * remainingBalance;

  const minLiquidSavings = LIQUID_SAVINGS_MIN_PCT * remainingBalance;
  const totalNeeded = fixedCommitmentTotal + ccPaymentDue + goalContributionTotal + minLiquidSavings;
  const shortfall = Math.max(0, totalNeeded - salaryAmount);

  let adjustedGoalContributionTotal = goalContributionTotal;
  if (shortfall > 0) {
    const { goalReduction, liquidReduction } = splitShortfall(shortfall, goalContributionTotal, liquidSavingsAmount);
    adjustedGoalContributionTotal = goalContributionTotal - goalReduction;
    liquidSavingsAmount = Math.max(0, liquidSavingsAmount - liquidReduction);
  }

  return {
    monthKey: atMonthKey,
    salaryAmount,
    fixedCommitmentTotal,
    ccPaymentDue,
    remainingBalance,
    variableSpendFloor,
    squeezePct: squeezeState.squeezePct,
    squeezeCategoryBudgets,
    floorCategoryBudgets: Object.fromEntries(
      FLOOR_TRAILING_CATEGORIES.map((cat) => [cat, trailingAverage(transactions, cat, atMonthKey)])
    ),
    vehicleMaintenanceBudgets,
    goalContributions,
    goalContributionTotal: adjustedGoalContributionTotal,
    liquidSavingsPct,
    liquidSavingsAmount,
    shortfall,
  };
}
