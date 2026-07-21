import { list, addEntity, updateEntity } from '../state/store.js';
import { formatCurrency, monthKey, currentMonthKey, addMonths } from '../lib/format.js';
import { FIXED_COMMITMENT_NAMES, VEHICLE_MAINTENANCE_CATEGORIES, SQUEEZE_CATEGORIES } from '../lib/categories.js';
import {
  computeBudgetProposal,
  computeRequiredMonthlyContribution,
  goalStatus,
  initialSqueezeState,
  advanceSqueezeState,
  detectSalaryChange,
} from '../lib/budgeting.js';

const ALL_COMMITMENT_NAMES = [...FIXED_COMMITMENT_NAMES, ...VEHICLE_MAINTENANCE_CATEGORIES];

function loadCommitments() {
  const versions = list('fixedCommitmentVersion');
  return list('fixedCommitment').map((c) => ({
    name: c.name,
    versions: versions.filter((v) => v.commitmentId === c.id),
  }));
}

function loadGoalsWithRequired(atMonthKey) {
  return list('goal').map((g) => ({
    ...g,
    requiredMonthlyContribution: g.requiredMonthlyContribution ?? computeRequiredMonthlyContribution(g, atMonthKey),
  }));
}

function getSqueezeSettings() {
  return list('settings').find((s) => s.key === 'squeezeState');
}

async function saveSqueezeSettings(squeezeState) {
  const existing = getSqueezeSettings();
  if (existing) return updateEntity('settings', existing.id, squeezeState);
  return addEntity('settings', { key: 'squeezeState', ...squeezeState });
}

function salaryTransactionsSorted() {
  return list('transaction')
    .filter((t) => t.category === 'Salary')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function render(container) {
  const salaryTxs = salaryTransactionsSorted();
  if (salaryTxs.length === 0) {
    container.innerHTML = `<h1>Budget Review</h1><div class="empty-state">Log a Salary transaction to trigger a budget review.</div>`;
    return;
  }
  const latestSalary = salaryTxs[salaryTxs.length - 1];
  const prevSalary = salaryTxs.length > 1 ? salaryTxs[salaryTxs.length - 2] : null;
  const atMonthKey = monthKey(latestSalary.date);

  const commitments = loadCommitments();
  const goals = loadGoalsWithRequired(atMonthKey);
  const transactions = list('transaction');
  const ccInstallmentPlans = list('ccInstallmentPlan');

  const salaryChange = detectSalaryChange(prevSalary?.amount, latestSalary.amount);

  const prevMonthKey = addMonths(atMonthKey, -1);
  const prevBudgetMonth = list('budgetMonth').find((b) => b.monthKey === prevMonthKey && b.confirmed);
  let hitSavingsTargetThisMonth = false;
  if (prevBudgetMonth) {
    const actualLiquid = transactions
      .filter((t) => t.kind === 'savingsContribution' && t.category === 'Liquid Savings' && monthKey(t.date) === prevMonthKey)
      .reduce((s, t) => s + t.amount, 0);
    hitSavingsTargetThisMonth = actualLiquid >= prevBudgetMonth.allocations.liquidSavingsAmount;
  }
  const anyGoalUnderfunded = goals.some((g) => goalStatus(g, transactions, atMonthKey).underfunded);
  const prevSqueezeState = getSqueezeSettings() || initialSqueezeState();
  const nextSqueezeState = advanceSqueezeState(prevSqueezeState, { anyGoalUnderfunded, hitSavingsTargetThisMonth });

  const existingBudgetMonth = list('budgetMonth').find((b) => b.monthKey === atMonthKey);
  if (existingBudgetMonth?.confirmed) {
    container.innerHTML = `
      <h1>Budget Review — ${atMonthKey}</h1>
      <div class="card">This month's budget is already confirmed.</div>
    `;
    return;
  }

  const proposal = computeBudgetProposal({
    salaryAmount: latestSalary.amount,
    atMonthKey,
    transactions,
    commitments,
    ccInstallmentPlans,
    goals,
    squeezeState: nextSqueezeState,
  });

  container.innerHTML = `
    <h1>Budget Review — ${atMonthKey}</h1>
    ${
      salaryChange.changed
        ? `<div class="card pill ${salaryChange.direction === 'increase' ? 'success' : 'warning'}" style="display:block">
            Salary ${salaryChange.direction === 'increase' ? 'increased' : 'decreased'} by ${Math.abs(salaryChange.pctChange * 100).toFixed(1)}% vs last time — review budgets/goals below before confirming.
          </div>`
        : ''
    }
    <div class="card">
      <div class="row"><span>Salary</span><span>${formatCurrency(proposal.salaryAmount)}</span></div>
      <div class="row"><span>Fixed Commitments</span><span>${formatCurrency(proposal.fixedCommitmentTotal)}</span></div>
      <div class="row"><span>Credit Card Payment Due</span><span>${formatCurrency(proposal.ccPaymentDue)}</span></div>
      <div class="row"><strong>Remaining balance</strong><strong>${formatCurrency(proposal.remainingBalance)}</strong></div>
    </div>

    <h2>Squeeze categories (${proposal.squeezePct}% of trailing average)</h2>
    <div class="card">
      ${SQUEEZE_CATEGORIES.map(
        (cat) => `<div class="row"><span>${cat}</span><span>${formatCurrency(proposal.squeezeCategoryBudgets[cat])}</span></div>`
      ).join('')}
    </div>

    <h2>Other variable categories (trailing average)</h2>
    <div class="card">
      ${Object.entries(proposal.floorCategoryBudgets)
        .map(([cat, amt]) => `<div class="row"><span>${cat}</span><span>${formatCurrency(amt)}</span></div>`)
        .join('')}
      ${Object.entries(proposal.vehicleMaintenanceBudgets)
        .map(([cat, amt]) => `<div class="row"><span>${cat}</span><span>${formatCurrency(amt)}</span></div>`)
        .join('')}
    </div>

    ${
      proposal.shortfall > 0
        ? `<div class="card pill warning" style="display:block">Shortfall of ${formatCurrency(
            proposal.shortfall
          )} — split between goal contributions and liquid savings below. Edit the amounts if you'd rather split it differently.</div>`
        : ''
    }

    <form id="review-form">
      <h2>Goal contributions (flexible)</h2>
      <div class="card">
        ${proposal.goalContributions
          .map((gc) => {
            const g = goals.find((g) => g.id === gc.goalId);
            return `<label>${g.name}<input type="number" name="goal-${gc.goalId}" value="${gc.amount.toFixed(0)}" min="0" /></label>`;
          })
          .join('') || '<div class="hint">No active goals.</div>'}
      </div>

      <h2>Liquid savings (${(proposal.liquidSavingsPct * 100).toFixed(0)}%)</h2>
      <div class="card">
        <label>Amount (₹)<input type="number" name="liquidSavings" value="${proposal.liquidSavingsAmount.toFixed(0)}" min="0" /></label>
      </div>

      <div class="actions">
        <button type="submit" class="primary">Confirm this month's budget</button>
      </div>
    </form>
  `;

  container.querySelector('#review-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const finalGoalContributions = proposal.goalContributions.map((gc) => ({
      goalId: gc.goalId,
      amount: Number(fd.get(`goal-${gc.goalId}`)),
    }));
    const finalLiquidSavings = Number(fd.get('liquidSavings'));

    await saveSqueezeSettings(nextSqueezeState);

    const allocations = {
      fixedCommitmentTotal: proposal.fixedCommitmentTotal,
      ccPaymentDue: proposal.ccPaymentDue,
      squeezeCategoryBudgets: proposal.squeezeCategoryBudgets,
      floorCategoryBudgets: proposal.floorCategoryBudgets,
      vehicleMaintenanceBudgets: proposal.vehicleMaintenanceBudgets,
      goalContributions: finalGoalContributions,
      liquidSavingsAmount: finalLiquidSavings,
    };

    if (existingBudgetMonth) {
      await updateEntity('budgetMonth', existingBudgetMonth.id, {
        salaryAmount: proposal.salaryAmount,
        allocations,
        squeezePct: nextSqueezeState.squeezePct,
        confirmed: true,
      });
    } else {
      await addEntity('budgetMonth', {
        monthKey: atMonthKey,
        salaryAmount: proposal.salaryAmount,
        allocations,
        squeezePct: nextSqueezeState.squeezePct,
        confirmed: true,
      });
    }

    window.location.hash = '/';
  });
}
