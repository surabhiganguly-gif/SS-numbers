import { list, addEntity } from '../state/store.js';
import { formatCurrency } from '../lib/format.js';
import { computeBankBalance } from '../lib/bankBalance.js';
import { navigate } from '../router.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function render(container) {
  const appBalance = computeBankBalance(list('transaction'), list('reconciliation'));

  container.innerHTML = `
    <h1>Reconcile Bank Balance</h1>
    <div class="card">
      <div class="hint">App's calculated balance</div>
      <div class="masked-value" style="font-size:1.6rem">${formatCurrency(appBalance)}</div>
    </div>
    <form id="reconcile-form" class="card">
      <label>Actual bank balance (₹)<input type="number" name="actualBalance" step="1" required /></label>
      <div class="actions"><button type="submit" class="primary">Compare</button></div>
    </form>
    <div id="result"></div>
    <h2>History</h2>
    <div id="history"></div>
  `;

  container.querySelector('#reconcile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const actualBalance = Number(new FormData(e.target).get('actualBalance'));
    const difference = actualBalance - appBalance;
    renderResult(actualBalance, difference);
  });

  function renderResult(actualBalance, difference) {
    const resultEl = container.querySelector('#result');
    if (Math.abs(difference) < 1) {
      resultEl.innerHTML = `
        <div class="card">
          <div class="pill success">Matched — no discrepancy.</div>
          <div class="actions"><button id="confirm-match" class="primary">Confirm</button></div>
        </div>`;
      resultEl.querySelector('#confirm-match').addEventListener('click', async () => {
        await addEntity('reconciliation', { date: todayStr(), appBalance, actualBalance, resolution: 'matched', adjustmentAmount: 0 });
        renderHistory();
        resultEl.innerHTML = '<div class="hint">Recorded.</div>';
      });
      return;
    }

    resultEl.innerHTML = `
      <div class="card">
        <div class="pill warning">Discrepancy: ${formatCurrency(difference)} (${difference > 0 ? 'app is under-counting' : 'app is over-counting'})</div>
        <p class="hint">What would you like to do?</p>
        <div class="actions">
          <button id="add-missing">Add a missing transaction</button>
          <button id="accept-adjustment" class="primary">Accept as adjustment</button>
          <button id="dismiss">Dismiss / remind me later</button>
        </div>
      </div>`;

    resultEl.querySelector('#add-missing').addEventListener('click', () => navigate('/transactions'));

    resultEl.querySelector('#accept-adjustment').addEventListener('click', async () => {
      await addEntity('reconciliation', {
        date: todayStr(),
        appBalance,
        actualBalance,
        resolution: 'adjustment',
        adjustmentAmount: difference,
      });
      renderHistory();
      resultEl.innerHTML = '<div class="hint">Adjustment recorded — the app\'s balance now matches your bank.</div>';
    });

    resultEl.querySelector('#dismiss').addEventListener('click', async () => {
      await addEntity('reconciliation', {
        date: todayStr(),
        appBalance,
        actualBalance,
        resolution: 'dismissed',
        adjustmentAmount: 0,
      });
      renderHistory();
      resultEl.innerHTML = '<div class="hint">Dismissed — you\'ll be reminded again next check-in.</div>';
    });
  }

  function renderHistory() {
    const items = [...list('reconciliation')].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
    const el = container.querySelector('#history');
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-state">No reconciliations yet.</div>';
      return;
    }
    el.innerHTML = items
      .map(
        (r) => `<div class="card row">
          <span>${r.date} — ${r.resolution}</span>
          <span>${formatCurrency(r.actualBalance)}</span>
        </div>`
      )
      .join('');
  }

  renderHistory();
}
