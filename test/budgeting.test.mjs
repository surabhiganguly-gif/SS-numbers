import * as assert from './assert.js';
import {
  trailingAverage,
  computeCCPaymentDue,
  computeRequiredMonthlyContribution,
  goalStatus,
  initialSqueezeState,
  advanceSqueezeState,
  detectSalaryChange,
  splitShortfall,
  computeBudgetProposal,
} from '../src/lib/budgeting.js';

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

test('splitShortfall divides proportionally between goal and liquid savings pools', () => {
  const { goalReduction, liquidReduction } = splitShortfall(3000, 6000, 3000);
  // pool = 9000, goal share 2/3, liquid share 1/3
  assert.equal(goalReduction, 2000);
  assert.equal(liquidReduction, 1000);
});

test('splitShortfall never reduces below zero even if shortfall exceeds the pool', () => {
  const { goalReduction, liquidReduction } = splitShortfall(100000, 6000, 3000);
  assert.equal(goalReduction, 6000);
  assert.equal(liquidReduction, 3000);
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
  assert.ok(proposal.shortfall > 0, 'expected a shortfall given tight remaining balance');
  assert.ok(proposal.goalContributionTotal < 5000, 'goal contribution should have absorbed part of the shortfall');
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

console.log(`\n${passed} passed, ${failed} failed`);
window.__budgetingTestResults = { passed, failed };

