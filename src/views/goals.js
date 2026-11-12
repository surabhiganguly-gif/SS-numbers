import { list, addEntity, removeEntity } from '../state/store.js';
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
    <div id="goals-notice"></div>
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
          <div class="delete-area">
            <button type="button" class="danger delete-goal-btn">Delete goal</button>
            <div class="delete-confirm" style="display:none">
              <p class="hint">Delete "${g.name}"? Contributions you've already logged stay in your transaction log and bank balance — only the goal itself goes away.</p>
              <button type="button" class="danger confirm-delete-goal-btn">Yes, delete goal</button>
              <button type="button" class="cancel-delete-goal-btn">Cancel</button>
            </div>
          </div>
        </div>`;
      })
      .join('');

    el.querySelectorAll('[data-goal-id]').forEach((card) => {
      const goalId = card.dataset.goalId;
      const deleteBtn = card.querySelector('.delete-goal-btn');
      const confirmBox = card.querySelector('.delete-confirm');

      deleteBtn.addEventListener('click', () => {
        deleteBtn.style.display = 'none';
        confirmBox.style.display = 'block';
      });
      card.querySelector('.cancel-delete-goal-btn').addEventListener('click', () => {
        confirmBox.style.display = 'none';
        deleteBtn.style.display = 'inline-block';
      });
      card.querySelector('.confirm-delete-goal-btn').addEventListener('click', async () => {
        const monthKey = currentMonthKey();
        const budgetStillUsesGoal = list('budgetMonth').some(
          (b) => b.monthKey === monthKey && b.confirmed && b.allocations.goalContributions.some((gc) => gc.goalId === goalId)
        );
        await removeEntity('goal', goalId);
        container.querySelector('#goals-notice').innerHTML = budgetStillUsesGoal
          ? `<div class="card pill warning" style="display:block">Goal deleted. This month's confirmed budget still includes it — on the Budget tab, use "Delete &amp; rework this month's budget" to recalculate without it.</div>`
          : '';
        renderGoals();
      });
    });

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
