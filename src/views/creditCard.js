import { list, addEntity } from '../state/store.js';
import { formatCurrency } from '../lib/format.js';
import { computeCCOutstanding } from '../lib/creditCard.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function render(container) {
  container.innerHTML = `
    <h1>Credit Card</h1>
    <div class="card">
      <div class="hint">Outstanding balance</div>
      <div class="masked-value" id="cc-outstanding" style="font-size:1.6rem"></div>
    </div>

    <div id="onboarding-card"></div>

    <h2>Log bill payment</h2>
    <p class="hint">A payment settles against next month's Credit Card Payment Due — it's a transfer, not a fresh category expense.</p>
    <form id="payment-form" class="card">
      <label>Date<input type="date" name="date" value="${todayStr()}" required /></label>
      <label>Amount (₹)<input type="number" name="amount" min="0" step="1" required /></label>
      <label>Note<input type="text" name="note" placeholder="optional" /></label>
      <div class="actions"><button type="submit" class="primary">Log payment</button></div>
    </form>

    <h2>Active installment plans</h2>
    <div id="installments-list"></div>

    <p class="hint">To log a new purchase, use the Transactions screen and choose "Credit Card" as the payment method.</p>
  `;

  function renderOutstanding() {
    const outstanding = computeCCOutstanding(list('transaction'));
    container.querySelector('#cc-outstanding').textContent = formatCurrency(outstanding);
  }

  function renderOnboarding() {
    const done = list('transaction').some((t) => t.kind === 'ccOnboarding');
    const el = container.querySelector('#onboarding-card');
    if (done) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <div class="card">
        <div class="hint">One-time setup: if you already have credit card dues from before using this app, log them here so the outstanding balance starts accurate.</div>
        <form id="onboarding-form">
          <label>Existing dues (₹)<input type="number" name="amount" min="0" step="1" required /></label>
          <div class="actions"><button type="submit" class="primary">Add existing dues</button></div>
        </form>
      </div>`;
    el.querySelector('#onboarding-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = Number(new FormData(e.target).get('amount'));
      await addEntity('transaction', {
        date: todayStr(),
        amount,
        category: 'Credit Card Payment Due',
        note: 'Existing dues at app launch',
        paymentMethod: 'creditCard',
        kind: 'ccOnboarding',
      });
      renderOnboarding();
      renderOutstanding();
    });
  }

  function renderInstallments() {
    const plans = list('ccInstallmentPlan');
    const el = container.querySelector('#installments-list');
    if (plans.length === 0) {
      el.innerHTML = '<div class="empty-state">No active installment plans.</div>';
      return;
    }
    el.innerHTML = plans
      .map(
        (p) => `
        <div class="card row">
          <div>
            <div>${p.category}</div>
            <div class="hint">${p.tenureMonths} months from ${p.startMonth}</div>
          </div>
          <div>${formatCurrency(p.monthlyAmount)}/mo</div>
        </div>`
      )
      .join('');
  }

  container.querySelector('#payment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await addEntity('transaction', {
      date: fd.get('date'),
      amount: Number(fd.get('amount')),
      category: 'Credit Card Payment Due',
      note: fd.get('note') || '',
      paymentMethod: 'bank',
      kind: 'ccPayment',
    });
    e.target.reset();
    e.target.querySelector('[name=date]').value = todayStr();
    renderOutstanding();
  });

  renderOutstanding();
  renderOnboarding();
  renderInstallments();
}
