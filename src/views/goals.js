import { list, addEntity } from '../state/store.js';
import { formatCurrency, currentMonthKey } from '../lib/format.js';
import { computeRequiredMonthlyContribution, goalStatus } from '../lib/budgeting.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function render(container) {
  container.innerHTML = `
    <h1>Goals</h1>
    <form id="goal-form" class="card">
      <label>Goal name<input type="text" name="name" required /></label>
      <label>Target amount (₹)<input type="number" name="targetAmount" min="0" step="1" required /></label>
      <label>Target date<input type="date" name="targetDate" required /></label>
      <div class="actions"><button type="submit" class="primary">Create goal</button></div>
    </form>
    <div id="goals-list"></div>
  `;

  container.querySelector('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const targetAmount = Number(fd.get('targetAmount'));
    const targetDate = fd.get('targetDate');
    const createdAt = todayStr();
    const requiredMonthlyContribution = computeRequiredMonthlyContribution(
      { targetAmount, targetDate },
      currentMonthKey()
    );
    await addEntity('goal', { name: fd.get('name'), targetAmount, targetDate, createdAt, requiredMonthlyContribution });
    e.target.reset();
    renderGoals();
  });

  function renderGoals() {
    const goals = list('goal');
    const txs = list('transaction');
    const el = container.querySelector('#goals-list');
    if (goals.length === 0) {
      el.innerHTML = '<div class="empty-state">No goals yet.</div>';
      return;
    }
    el.innerHTML = goals
      .map((g) => {
        const status = goalStatus(g, txs, currentMonthKey());
        return `
        <div class="card" data-goal-id="${g.id}">
          <div class="row">
            <strong>${g.name}</strong>
            <span class="pill ${status.fullyFunded ? 'success' : status.underfunded ? 'warning' : ''}">
              ${status.fullyFunded ? 'Funded' : status.underfunded ? 'Behind' : 'On track'}
            </span>
          </div>
          <div class="hint">Target ${formatCurrency(g.targetAmount)} by ${g.targetDate}</div>
          <div class="hint">Required/mo: ${formatCurrency(g.requiredMonthlyContribution)} (fixed)</div>
          <div>Contributed so far: ${formatCurrency(status.contributed)}</div>
          ${status.shortfall > 0 ? `<div class="pill warning">Shortfall: ${formatCurrency(status.shortfall)}</div>` : ''}
          <form class="contribute-form">
            <label>Log contribution (₹)<input type="number" name="amount" min="0" step="1" required /></label>
            <label>Payment method
              <select name="paymentMethod">
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
              </select>
            </label>
            <div class="actions"><button type="submit" class="primary">Add contribution</button></div>
          </form>
        </div>`;
      })
      .join('');

    el.querySelectorAll('.contribute-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const goalId = form.closest('[data-goal-id]').dataset.goalId;
        const goal = goals.find((g) => g.id === goalId);
        const fd = new FormData(form);
        const amount = Number(fd.get('amount'));
        await addEntity('transaction', {
          date: todayStr(),
          amount,
          category: goal.name,
          note: '',
          paymentMethod: fd.get('paymentMethod'),
          kind: 'goalContribution',
          goalId,
        });
        renderGoals();
      });
    });
  }

  renderGoals();
}
