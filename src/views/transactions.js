import { list, addEntity, updateEntity, removeEntity } from '../state/store.js';
import { CATEGORY_GROUPS } from '../lib/categories.js';
import { formatCurrency, currentMonthKey } from '../lib/format.js';
import { navigate } from '../router.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function categoryOptionsHtml() {
  const goals = list('goal');
  const { ccPaymentDue, ...rest } = CATEGORY_GROUPS;
  const groups = {
    ...rest,
    goal: { label: 'Goal-Based Savings', categories: goals.map((g) => g.name) },
  };
  return Object.values(groups)
    .filter((g) => g.categories.length > 0)
    .map(
      (g) => `<optgroup label="${g.label}">${g.categories
        .map((c) => `<option value="${c}">${c}</option>`)
        .join('')}</optgroup>`
    )
    .join('');
}

function inferKind(category, paymentMethod) {
  if (category === 'Salary' || category === 'Other Credits') return 'income';
  if (category === 'SIP Savings' || category === 'Liquid Savings') return 'savingsContribution';
  const goal = list('goal').find((g) => g.name === category);
  if (goal) return { kind: 'goalContribution', goalId: goal.id };
  if (paymentMethod === 'creditCard') return 'ccPurchase';
  return 'expense';
}

export function render(container) {
  container.innerHTML = `
    <h1>Transactions</h1>
    <form id="tx-form" class="card">
      <label>Date<input type="date" name="date" value="${todayStr()}" required /></label>
      <label>Amount (₹)<input type="number" name="amount" min="0" step="1" required /></label>
      <label>Category<select name="category" required><option value="">Select…</option>${categoryOptionsHtml()}</select></label>
      <label>Payment method
        <select name="paymentMethod">
          <option value="cash">Cash</option>
          <option value="bank">Bank</option>
          <option value="creditCard">Credit Card</option>
        </select>
      </label>
      <div id="cc-plan-fields" style="display:none">
        <label>Credit card plan
          <select name="ccPlanType">
            <option value="lumpsum">Lumpsum (due in full next month)</option>
            <option value="installment">Installment</option>
          </select>
        </label>
        <div id="installment-fields" style="display:none">
          <label>Monthly installment amount (₹)<input type="number" name="monthlyAmount" min="0" /></label>
          <label>Tenure (months)<input type="number" name="tenureMonths" min="1" /></label>
        </div>
      </div>
      <label>Note<input type="text" name="note" placeholder="optional" /></label>
      <div class="actions"><button type="submit" class="primary">Add transaction</button></div>
    </form>
    <h2>Recent</h2>
    <div id="tx-list"></div>
  `;

  const form = container.querySelector('#tx-form');
  const paymentSelect = form.querySelector('[name=paymentMethod]');
  const ccPlanFields = form.querySelector('#cc-plan-fields');
  const ccPlanSelect = form.querySelector('[name=ccPlanType]');
  const installmentFields = form.querySelector('#installment-fields');

  paymentSelect.addEventListener('change', () => {
    ccPlanFields.style.display = paymentSelect.value === 'creditCard' ? 'block' : 'none';
  });
  ccPlanSelect.addEventListener('change', () => {
    installmentFields.style.display = ccPlanSelect.value === 'installment' ? 'block' : 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const category = fd.get('category');
    const paymentMethod = fd.get('paymentMethod');
    const amount = Number(fd.get('amount'));
    const date = fd.get('date');
    const note = fd.get('note') || '';

    const inferred = inferKind(category, paymentMethod);
    const kind = typeof inferred === 'string' ? inferred : inferred.kind;
    const extra = typeof inferred === 'object' ? { goalId: inferred.goalId } : {};

    let ccPlanType;
    if (kind === 'ccPurchase') {
      ccPlanType = fd.get('ccPlanType');
      if (ccPlanType === 'installment') {
        const monthlyAmount = Number(fd.get('monthlyAmount'));
        const tenureMonths = Number(fd.get('tenureMonths'));
        const plan = await addEntity('ccInstallmentPlan', {
          category,
          monthlyAmount,
          tenureMonths,
          startMonth: currentMonthKey(),
        });
        extra.ccPlanId = plan.id;
      }
    }

    await addEntity('transaction', {
      date,
      amount,
      category,
      note,
      paymentMethod,
      kind,
      ccPlanType,
      ...extra,
    });

    form.reset();
    form.querySelector('[name=date]').value = todayStr();
    ccPlanFields.style.display = 'none';
    installmentFields.style.display = 'none';
    renderList();

    if (category === 'Salary') {
      navigate('/budget-review');
    }
  });

  function renderList() {
    const txs = [...list('transaction')].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
    const listEl = container.querySelector('#tx-list');
    if (txs.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No transactions yet.</div>';
      return;
    }
    listEl.innerHTML = txs
      .map(
        (t) => `
        <div class="card row" data-id="${t.id}">
          <div>
            <div>${t.category} <span class="pill">${t.paymentMethod}</span></div>
            <div class="hint">${t.date}${t.note ? ' · ' + t.note : ''}</div>
          </div>
          <div style="text-align:right">
            <div>${formatCurrency(t.amount)}</div>
            <button class="delete-tx" data-id="${t.id}">Delete</button>
          </div>
        </div>`
      )
      .join('');
    listEl.querySelectorAll('.delete-tx').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removeEntity('transaction', btn.dataset.id);
        renderList();
      });
    });
  }

  renderList();
}
