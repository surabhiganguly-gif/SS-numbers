import * as assert from './assert.js';
import {
  trailingAverage,
  computeCCPaymentDue,
  computeRequiredMonthlyContribution,
  goalStatus,
  initialSqueezeState,
  advanceSqueezeState,
  detectSalaryChange,
  resolveShortfall,
  computeBudgetProposal,
} from '../src/lib/budgeting.js';
import {
  CATEGORY_GROUPS,
  SQUEEZE_CATEGORIES,
  FLOOR_TRAILING_CATEGORIES,
  FIXED_VALUE_CATEGORIES,
  STICKY_FIXED_CATEGORIES,
  TRAILING_FIXED_CATEGORIES,
} from '../src/lib/categories.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(e);
  }
}

test('trailingAverage averages over exactly the trailing N months, ignoring the current month', () => {
  const txs = [
    { category: 'Groceries', date: '2026-04-15', amount: 3000 },
    { category: 'Groceries', date: '2026-05-10', amount: 5000 },
    { category: 'Groceries', date: '2026-06-01', amount: 4000 },
    { category: 'Groceries', date: '2026-07-05', amount: 9999 }, // current month, should be excluded
  ];
  const avg = trailingAverage(txs, 'Groceries', '2026-07');
  assert.equal(avg, (3000 + 5000 + 4000) / 3);
});

test('trailingAverage divides by however many tracked months exist, not always 3', () => {
  const txs = [{ category: 'Utilities', date: '2026-06-10', amount: 6000 }]; // only 1 month on record
  const avg = trailingAverage(txs, 'Utilities', '2026-07');
  assert.equal(avg, 6000); // not 6000/3 — there's only ever been one tracked month
});

test('computeCCPaymentDue sums prior-month lumpsum purchases plus active installments', () => {
  const txs = [
    { kind: 'ccPurchase', ccPlanType: 'lumpsum', date: '2026-06-20', amount: 2000 },
    { kind: 'ccPurchase', ccPlanType: 'lumpsum', date: '2026-05-20', amount: 5000 }, // wrong month, excluded
  ];
  const plans = [
    { startMonth: '2026-05', tenureMonths: 3, monthlyAmount: 1000 }, // active in 05,06,07
    { startMonth: '2026-01', tenureMonths: 3, monthlyAmount: 500 }, // finished by 07
  ];
  const due = computeCCPaymentDue({ transactions: txs, ccInstallmentPlans: plans, atMonthKey: '2026-07' });
  assert.equal(due, 2000 + 1000);
});

test('goal required monthly contribution divides remaining target by remaining months', () => {
  const goal = { targetAmount: 60000, targetDate: '2027-01-15' };
  const required = computeRequiredMonthlyContribution(goal, '2026-07');
  assert.equal(required, 60000 / 6);
});

test('goalStatus reports shortfall growing when contributions lag, without inflating required amount', () => {
  const goal = {
    id: 'g1',
    targetAmount: 60000,
    createdAt: '2026-01-01',
    requiredMonthlyContribution: 5000,
  };
  const txs = [{ kind: 'goalContribution', goalId: 'g1', amount: 5000 }];
  // 3 months since creation (Jan, Feb, Mar inclusive) but only 1 contribution logged.
  const status = goalStatus(goal, txs, '2026-03');
  assert.equal(status.contributed, 5000);
  assert.equal(status.shortfall, 5000 * 3 - 5000);
  assert.equal(status.underfunded, true);
  assert.equal(status.fullyFunded, false);
});

test('squeeze state eases by 5% after 2 consecutive months hitting savings target', () => {
  let state = initialSqueezeState();
  assert.equal(state.squeezePct, 80);
  state = advanceSqueezeState(state, { anyGoalUnderfunded: true, hitSavingsTargetThisMonth: true });
  assert.equal(state.squeezePct, 80); // 1st hit, not yet eased
  state = advanceSqueezeState(state, { anyGoalUnderfunded: true, hitSavingsTargetThisMonth: true });
  assert.equal(state.squeezePct, 85); // 2nd consecutive hit -> eases
});

test('squeeze state resets consecutive count on a missed month', () => {
  let state = initialSqueezeState();
  state = advanceSqueezeState(state, { anyGoalUnderfunded: true, hitSavingsTargetThisMonth: true });
  state = advanceSqueezeState(state, { anyGoalUnderfunded: true, hitSavingsTargetThisMonth: false });
  assert.equal(state.consecutiveHitMonths, 0);
  assert.equal(state.squeezePct, 80);
});

test('squeeze state flatlines at 100% once all goals are fully funded', () => {
  let state = initialSqueezeState();
  state = advanceSqueezeState(state, { anyGoalUnderfunded: false, hitSavingsTargetThisMonth: true });
  assert.equal(state.squeezePct, 100);
  assert.equal(state.wasUnderfunded, false);
});

test('squeeze state snaps back to 80% (not gradual) when shortfall reappears after being fine', () => {
  let state = { squeezePct: 100, consecutiveHitMonths: 0, wasUnderfunded: false };
  state = advanceSqueezeState(state, { anyGoalUnderfunded: true, hitSavingsTargetThisMonth: false });
  assert.equal(state.squeezePct, 80);
});

test('detectSalaryChange flags changes beyond 5% either direction', () => {
  assert.equal(detectSalaryChange(100000, 104000).changed, false);
  const increase = detectSalaryChange(100000, 110000);
  assert.equal(increase.changed, true);
  assert.equal(increase.direction, 'increase');
  const decrease = detectSalaryChange(100000, 90000);
  assert.equal(decrease.changed, true);
  assert.equal(decrease.direction, 'decrease');
});

test('resolveShortfall: fits within budget as-is needs no cuts', () => {
  const r = resolveShortfall({
    salary: 100000, fixedTotal: 50000, ccPaymentDue: 0,
    idealGoalTotal: 10000, idealLiquidPct: 0.1, remainingBalance: 50000,
  });
  assert.equal(r.stage, 'none');
  assert.equal(r.liquidAmount, 5000);
  assert.equal(r.goalScaleFactor, 1);
});

test('resolveShortfall stage 1: trimming Liquid Savings by 5pp is enough', () => {
  const r = resolveShortfall({
    salary: 60000, fixedTotal: 50000, ccPaymentDue: 0,
    idealGoalTotal: 8000, idealLiquidPct: 0.15, remainingBalance: 20000,
  });
  assert.equal(r.stage, 'liquid-trimmed');
  assert.approx(r.liquidPct, 0.1);
  assert.approx(r.liquidAmount, 2000);
  assert.equal(r.goalScaleFactor, 1);
});

test('resolveShortfall stage 2: goals cut by less than the 50% cap when that is enough', () => {
  const r = resolveShortfall({
    salary: 60000, fixedTotal: 50000, ccPaymentDue: 0,
    idealGoalTotal: 10000, idealLiquidPct: 0.15, remainingBalance: 20000,
  });
  assert.equal(r.stage, 'goals-cut');
  assert.approx(r.liquidAmount, 2000);
  assert.equal(r.goalScaleFactor, 0.8); // 20% cut, well under the 50% cap
});

test('resolveShortfall stage 3: goals capped at 50% cut, Liquid Savings dropped to zero', () => {
  const r = resolveShortfall({
    salary: 55000, fixedTotal: 50000, ccPaymentDue: 0,
    idealGoalTotal: 10000, idealLiquidPct: 0.15, remainingBalance: 20000,
  });
  assert.equal(r.stage, 'liquid-zeroed');
  assert.equal(r.liquidAmount, 0);
  assert.equal(r.goalScaleFactor, 0.5); // capped, not cut further in this stage
});

test('resolveShortfall stage 4: goals reduced beyond 50% once Liquid Savings is already zero', () => {
  const r = resolveShortfall({
    salary: 52000, fixedTotal: 50000, ccPaymentDue: 0,
    idealGoalTotal: 10000, idealLiquidPct: 0.15, remainingBalance: 20000,
  });
  assert.equal(r.stage, 'goals-reduced-further');
  assert.equal(r.liquidAmount, 0);
  assert.equal(r.goalScaleFactor, 0.2);
});

function commitment(name, amount) {
  return { name, versions: [{ amount, effectiveFrom: '2020-01' }] };
}

test('computeBudgetProposal: Fixed Commitments and CC Payment Due are protected first, shortfall hits goal/liquid only', () => {
  const proposal = computeBudgetProposal({
    salaryAmount: 50000,
    atMonthKey: '2026-07',
    transactions: [],
    commitments: [
      commitment('Rent', 45000),
      commitment('Vehicle Maintenance (Virtus)', 2000),
      commitment('Vehicle Maintenance (Jimny)', 2000),
    ],
    ccInstallmentPlans: [],
    goals: [{ id: 'g1', requiredMonthlyContribution: 5000 }],
    squeezeState: initialSqueezeState(),
  });
  assert.equal(proposal.fixedCommitmentTotal, 45000);
  assert.equal(proposal.remainingBalance, 5000);
  assert.ok(proposal.shortfallStage !== 'none', 'expected a shortfall given tight remaining balance');
  assert.equal(proposal.unresolvedShortfall, 0);
  assert.ok(proposal.goalContributionTotal < 5000, 'goal contribution should have absorbed part of the shortfall');
});

test('computeBudgetProposal: sticky-fixed categories use the commitment value, trailing-fixed use a running average', () => {
  const txs = [
    { category: 'Utilities', date: '2026-05-05', amount: 5000 },
    { category: 'Utilities', date: '2026-06-05', amount: 7000 },
    { category: 'Utilities', date: '2026-07-05', amount: 9999 }, // current month excluded
  ];
  const proposal = computeBudgetProposal({
    salaryAmount: 200000,
    atMonthKey: '2026-07',
    transactions: txs,
    commitments: [commitment('Rent', 33880), commitment('SIP Savings', 10000)],
    ccInstallmentPlans: [],
    goals: [],
    squeezeState: initialSqueezeState(),
  });
  assert.equal(proposal.stickyFixedBudgets['Rent'], 33880);
  assert.equal(proposal.stickyFixedBudgets['SIP Savings'], 10000);
  assert.equal(proposal.trailingFixedBudgets['Utilities'], (5000 + 7000) / 2); // only 2 tracked months
});

test('computeBudgetProposal: Miscellaneous defaults to its fixed-value commitment, not a trailing average', () => {
  const txs = [{ category: 'Miscellaneous', date: '2026-06-05', amount: 30000 }]; // one wild month
  const proposal = computeBudgetProposal({
    salaryAmount: 200000,
    atMonthKey: '2026-07',
    transactions: txs,
    commitments: [commitment('Miscellaneous', 10000)],
    ccInstallmentPlans: [],
    goals: [],
    squeezeState: initialSqueezeState(),
  });
  assert.equal(proposal.fixedValueBudgets['Miscellaneous'], 10000); // unaffected by June's spike
});

test('computeBudgetProposal clamps liquid savings pct to the 5-15% band', () => {
  const generous = computeBudgetProposal({
    salaryAmount: 200000,
    atMonthKey: '2026-07',
    transactions: [],
    commitments: [commitment('Rent', 20000)],
    ccInstallmentPlans: [],
    goals: [],
    squeezeState: initialSqueezeState(),
  });
  assert.equal(generous.liquidSavingsPct, 0.15);
});

test('every fixed/variable category is budgeted somewhere — none silently fall through', () => {
  // Categories handled outside the generic buckets below, by name, elsewhere in
  // the engine/UI (Liquid Savings has its own dedicated amount, not a bucket).
  const SPECIALLY_HANDLED = ['Liquid Savings'];

  const budgetedCategories = new Set([
    ...SQUEEZE_CATEGORIES,
    ...FLOOR_TRAILING_CATEGORIES,
    ...FIXED_VALUE_CATEGORIES,
    ...STICKY_FIXED_CATEGORIES,
    ...TRAILING_FIXED_CATEGORIES,
    ...SPECIALLY_HANDLED,
  ]);

  const loggableCategories = [...CATEGORY_GROUPS.fixed.categories, ...CATEGORY_GROUPS.variable.categories, ...CATEGORY_GROUPS.savings.categories];

  const missing = loggableCategories.filter((cat) => !budgetedCategories.has(cat));
  assert.equal(missing.join(', '), '', `Categories loggable but not budgeted anywhere: ${missing.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
window.__budgetingTestResults = { passed, failed };

