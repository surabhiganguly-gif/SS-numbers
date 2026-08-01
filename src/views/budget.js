import { list } from '../state/store.js';
import { formatCurrency, currentMonthKey } from '../lib/format.js';
import {
  categorySpend,
  categoryTransactionsForMonth,
  totalIncome,
  totalSpend,
  totalSavings,
  monthGranularity,
  allMonthKeys,
  spendByCategory,
} from '../lib/reports.js';
import { trendChartHtml, categoryBarChartHtml } from '../lib/charts.js';
import { reworkBudgetMonth } from '../lib/budgetMonthOps.js';
import { openingBalance, closingBalance } from '../lib/bankBalance.js';

function statusFor(pct) {
  if (pct >= 100) return 'critical';
  if (pct >= 70) return 'warning';
  return 'good';
}

function entryListHtml(entries) {
  if (entries.length === 0) return '<div class="hint">No entries this month.</div>';
  return entries
    .map(
      (t) => `<div class="row"><span>${t.date}${t.note ? ' · ' + t.note : ''}</span><span>${formatCurrency(t.amount)}</span></div>`
    )
    .join('');
}

function progressRow(label, spent, budget, entries = []) {
  const pct = budget > 0 ? (spent / budget) * 100 : spent > 0 ? 100 : 0;
  const status = statusFor(pct);
  const remaining = budget - spent;
  return `
    <div class="progress-row">
      <div class="row">
        <span>${label}</span>
        <span class="progress-label">${formatCurrency(spent)} / ${formatCurrency(budget)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${status}" style="width:${Math.min(100, Math.max(0, pct)).toFixed(0)}%"></div></div>
      <div class="progress-label">${pct.toFixed(0)}% used${remaining >= 0 ? ` · ${formatCurrency(remaining)} left` : ` · ${formatCurrency(-remaining)} over`}</div>
      <details>
        <summary class="hint">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</summary>
        ${entryListHtml(entries)}
      </details>
    </div>`;
}

function renderThisMonth(container) {
  const monthKey = currentMonthKey();
  const transactions = list('transaction');
  const budgetMonth = list('budgetMonth').find((b) => b.monthKey === monthKey && b.confirmed);

  if (!budgetMonth) {
    container.innerHTML = `<div class="empty-state">No confirmed budget for ${monthKey} yet. Log a Salary transaction to trigger a budget review, or <a href="#/budget-review">revisit the Budget Review screen</a> if you just reworked this month.</div>`;
    return;
  }

  const {
    squeezeCategoryBudgets,
    floorCategoryBudgets,
    fixedValueBudgets,
    stickyFixedBudgets,
    trailingFixedBudgets,
    goalContributions,
    liquidSavingsAmount,
    ccPaymentDue,
  } = budgetMonth.allocations;
  const goals = list('goal');
  const reconciliations = list('reconciliation');
  const opening = openingBalance(transactions, reconciliations, monthKey);
  const closing = closingBalance(transactions, reconciliations, monthKey);

  const discretionary = { ...squeezeCategoryBudgets, ...floorCategoryBudgets, ...fixedValueBudgets };
  const discretionaryRows = Object.entries(discretionary)
    .map(([cat, budget]) =>
      progressRow(cat, categorySpend(transactions, cat, monthKey), budget, categoryTransactionsForMonth(transactions, cat, monthKey))
    )
    .join('');

  const goalRows = goalContributions
    .map((gc) => {
      const goal = goals.find((g) => g.id === gc.goalId);
      const entries = transactions
        .filter((t) => t.kind === 'goalContribution' && t.goalId === gc.goalId && t.date.slice(0, 7) === monthKey)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const actual = entries.reduce((s, t) => s + t.amount, 0);
      return progressRow(`Goal: ${goal ? goal.name : 'Unknown'}`, actual, gc.amount, entries);
    })
    .join('');

  const liquidEntries = transactions
    .filter((t) => t.kind === 'savingsContribution' && t.category === 'Liquid Savings' && t.date.slice(0, 7) === monthKey)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const liquidActual = liquidEntries.reduce((s, t) => s + t.amount, 0);

  const sipEntries = transactions
    .filter((t) => t.kind === 'savingsContribution' && t.category === 'SIP Savings' && t.date.slice(0, 7) === monthKey)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const sipActual = sipEntries.reduce((s, t) => s + t.amount, 0);

  const ccEntries = transactions
    .filter((t) => t.kind === 'ccPayment' && t.date.slice(0, 7) === monthKey)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const ccActual = ccEntries.reduce((s, t) => s + t.amount, 0);

  const fixedPaymentRows = [
    ...Object.entries(stickyFixedBudgets || {}).filter(([cat]) => cat !== 'SIP Savings'),
    ...Object.entries(trailingFixedBudgets || {}),
  ]
    .map(([cat, budget]) =>
      progressRow(cat, categorySpend(transactions, cat, monthKey), budget, categoryTransactionsForMonth(transactions, cat, monthKey))
    )
    .join('');

  container.innerHTML = `
    <h2>Balance</h2>
    <div class="card">
      <div class="row"><span>Opening (${monthKey}-01)</span><span>${formatCurrency(opening)}</span></div>
      <div class="row"><span>Closing (as of today)</span><span>${formatCurrency(closing)}</span></div>
    </div>

    <h2>Discretionary categories</h2>
    <div class="card">${discretionaryRows || '<div class="hint">No discretionary categories budgeted.</div>'}</div>

    ${goalRows ? `<h2>Goals</h2><div class="card">${goalRows}</div>` : ''}

    <h2>Savings & obligations</h2>
    <div class="card">
      ${progressRow('Liquid Savings', liquidActual, liquidSavingsAmount, liquidEntries)}
      ${progressRow('SIP Savings', sipActual, stickyFixedBudgets?.['SIP Savings'] || 0, sipEntries)}
      ${ccPaymentDue > 0 ? progressRow('Credit Card Payment Due', ccActual, ccPaymentDue, ccEntries) : ''}
    </div>

    <h2>Fixed payments</h2>
    <p class="hint">Some are paid in installments, so these track actual paid so far vs. budgeted, same as discretionary categories.</p>
    <div class="card">
      ${fixedPaymentRows}
      <div class="row"><strong>Total budgeted</strong><strong>${formatCurrency(budgetMonth.allocations.fixedCommitmentTotal)}</strong></div>
    </div>

    <div class="card">
      <button id="rework-btn" class="danger">Delete & rework this month's budget</button>
    </div>
  `;

  container.querySelector('#rework-btn').addEventListener('click', async () => {
    if (!confirm(`Delete the confirmed budget for ${monthKey}? You'll be able to rework it from the Budget Review screen.`)) return;
    await reworkBudgetMonth(budgetMonth);
    renderThisMonth(container);
  });
}

function renderHistory(container) {
  const transactions = list('transaction');
  const reconciliations = list('reconciliation');
  const monthKeys = allMonthKeys(transactions);

  if (monthKeys.length === 0) {
    container.innerHTML = '<div class="empty-state">No transaction history yet.</div>';
    return;
  }

  const months = monthKeys.map((mk) => ({
    label: mk,
    income: totalIncome(transactions, mk),
    expense: totalSpend(transactions, mk),
    savings: totalSavings(transactions, mk),
    granularity: monthGranularity(transactions, mk),
  }));

  const latestMonth = monthKeys[monthKeys.length - 1];

  const balanceRows = monthKeys
    .slice()
    .reverse()
    .map((mk) => {
      const opening = openingBalance(transactions, reconciliations, mk);
      const closing = closingBalance(transactions, reconciliations, mk);
      return `<tr><td>${mk}</td><td>${formatCurrency(opening)}</td><td>${formatCurrency(closing)}</td></tr>`;
    })
    .join('');

  container.innerHTML = `
    <h2>Income / Expense / Savings by month</h2>
    <div class="card">${trendChartHtml(months)}</div>

    <h2>Opening & closing balance</h2>
    <div class="card">
      <table>
        <thead><tr><th>Month</th><th>Opening</th><th>Closing</th></tr></thead>
        <tbody>${balanceRows}</tbody>
      </table>
    </div>

    <h2>Spend by category</h2>
    <div class="card">
      <label>Month
        <select id="category-month">
          ${monthKeys
            .slice()
            .reverse()
            .map((mk) => `<option value="${mk}" ${mk === latestMonth ? 'selected' : ''}>${mk}</option>`)
            .join('')}
        </select>
      </label>
      <div id="category-chart"></div>
    </div>
  `;

  function renderCategoryChart(mk) {
    container.querySelector('#category-chart').innerHTML = categoryBarChartHtml(spendByCategory(transactions, mk));
  }
  renderCategoryChart(latestMonth);
  container.querySelector('#category-month').addEventListener('change', (e) => renderCategoryChart(e.target.value));
}

export function render(container) {
  container.innerHTML = `
    <h1>Budget</h1>
    <div class="tabs">
      <button id="tab-month" class="active">This Month</button>
      <button id="tab-history">History</button>
    </div>
    <div id="tab-content"></div>
  `;

  const tabMonth = container.querySelector('#tab-month');
  const tabHistory = container.querySelector('#tab-history');
  const content = container.querySelector('#tab-content');

  function showMonth() {
    tabMonth.classList.add('active');
    tabHistory.classList.remove('active');
    renderThisMonth(content);
  }
  function showHistory() {
    tabHistory.classList.add('active');
    tabMonth.classList.remove('active');
    renderHistory(content);
  }

  tabMonth.addEventListener('click', showMonth);
  tabHistory.addEventListener('click', showHistory);

  showMonth();
}
