import { list } from '../state/store.js';
import { getMeta } from '../db/db.js';
import { formatCurrency, currentMonthKey } from '../lib/format.js';
import { computeBankBalance } from '../lib/bankBalance.js';
import { computeCCOutstanding } from '../lib/creditCard.js';
import { totalIncome, totalSpend, categorySpend } from '../lib/reports.js';

const RECONCILE_REMINDER_DAYS = 14;
const BACKUP_REMINDER_DAYS = 14;

function daysSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

export function render(container) {
  const monthKey = currentMonthKey();
  const transactions = list('transaction');
  const bankBalance = computeBankBalance(transactions, list('reconciliation'));
  const ccOutstanding = computeCCOutstanding(transactions);
  const income = totalIncome(transactions, monthKey);
  const spend = totalSpend(transactions, monthKey);

  const reconciliations = [...list('reconciliation')].sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastReconcile = reconciliations[0];
  const reconcileDue = !lastReconcile || daysSince(lastReconcile.date) >= RECONCILE_REMINDER_DAYS;

  const budgetMonth = list('budgetMonth').find((b) => b.monthKey === monthKey && b.confirmed);

  container.innerHTML = `
    <h1>Home</h1>
    <div class="card">
      <div class="row">
        <span class="hint">Bank balance</span>
        <button id="reveal-toggle" class="reveal-toggle">Reveal</button>
      </div>
      <div class="masked-value" id="balance-value">●●●●●●</div>
      <div class="row" id="income-spend-row" style="display:none">
        <span class="hint">Income this month: <span id="income-value"></span></span>
        <span class="hint">Spend: <span id="spend-value"></span></span>
      </div>
      <div class="row"><span class="hint">Credit Card Outstanding</span><span id="cc-value" class="masked-value" style="font-size:1rem">●●●●●●</span></div>
    </div>

    <div id="backup-reminder"></div>
    ${reconcileDue ? `<div class="card"><a href="#/reconcile">Time to reconcile your bank balance →</a></div>` : ''}

    <h2>Quick budget check</h2>
    <div class="card" id="quick-check">
      ${
        budgetMonth
          ? renderQuickCheck(budgetMonth, transactions, monthKey)
          : '<div class="hint">No confirmed budget for this month yet — log a Salary transaction to trigger a budget review.</div>'
      }
    </div>
    <div class="card"><a href="#/budget">Full budget breakdown & spending history →</a></div>

    <h2>Setup</h2>
    <div class="card">
      <a href="#/import-statement">Import a bank statement →</a><br /><br />
      <a href="#/fixed-commitments">Manage fixed commitments →</a><br /><br />
      <a href="#/historical-import">Historical data import →</a>
    </div>
  `;

  // Your data exists only on this phone — nag gently once there's something worth losing.
  getMeta('lastBackupAt').then((lastBackupAt) => {
    const stale = !lastBackupAt || daysSince(lastBackupAt) >= BACKUP_REMINDER_DAYS;
    if (transactions.length > 0 && stale) {
      container.querySelector('#backup-reminder').innerHTML = `<div class="card"><a href="#/settings">${
        lastBackupAt ? 'Your last backup is over two weeks old' : "You haven't backed up yet"
      } — your data lives only on this phone. Back up to Drive →</a></div>`;
    }
  });

  let revealed = false;
  container.querySelector('#reveal-toggle').addEventListener('click', () => {
    revealed = !revealed;
    const balanceEl = container.querySelector('#balance-value');
    const ccEl = container.querySelector('#cc-value');
    const rowEl = container.querySelector('#income-spend-row');
    const toggleBtn = container.querySelector('#reveal-toggle');
    if (revealed) {
      balanceEl.textContent = formatCurrency(bankBalance);
      ccEl.textContent = formatCurrency(ccOutstanding);
      container.querySelector('#income-value').textContent = formatCurrency(income);
      container.querySelector('#spend-value').textContent = formatCurrency(spend);
      rowEl.style.display = 'flex';
      toggleBtn.textContent = 'Hide';
    } else {
      balanceEl.textContent = '●●●●●●';
      ccEl.textContent = '●●●●●●';
      rowEl.style.display = 'none';
      toggleBtn.textContent = 'Reveal';
    }
  });
}

function renderQuickCheck(budgetMonth, transactions, monthKey) {
  const { squeezeCategoryBudgets, floorCategoryBudgets, fixedValueBudgets } = budgetMonth.allocations;
  const allBudgets = { ...squeezeCategoryBudgets, ...floorCategoryBudgets, ...fixedValueBudgets };
  return Object.entries(allBudgets)
    .map(([cat, budget]) => {
      const spent = categorySpend(transactions, cat, monthKey);
      const remaining = budget - spent;
      const pillClass = remaining < 0 ? 'danger' : remaining < budget * 0.2 ? 'warning' : 'success';
      return `<div class="row">
        <span>${cat}</span>
        <span class="pill ${pillClass}">${formatCurrency(remaining)} left</span>
      </div>`;
    })
    .join('');
}
