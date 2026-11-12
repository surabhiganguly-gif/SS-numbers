import { list, addEntity, updateEntity, removeEntity } from '../state/store.js';
import { formatCurrency, currentMonthKey } from '../lib/format.js';
import {
  computeCCOutstanding,
  outstandingItems,
  billPaymentsTotal,
  canConvertToLoan,
  loanSummary,
  validateLoan,
} from '../lib/creditCard.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const DUE_CATEGORY = 'Credit Card Payment Due';

export function render(container) {
  container.innerHTML = `
    <h1>Credit Card</h1>
    <div class="card">
      <div class="hint">Outstanding balance</div>
      <div class="masked-value" id="cc-outstanding" style="font-size:1.6rem"></div>
      <div class="hint" id="cc-breakdown"></div>
    </div>

    <h2>Add an outstanding item</h2>
    <p class="hint">Enter what you owe on the card one charge at a time — each one can later be turned into a loan.</p>
    <form id="due-form" class="card">
      <label>Date of the charge<input type="date" name="date" value="${todayStr()}" required /></label>
      <label>Amount (₹)<input type="number" name="amount" min="1" step="any" required /></label>
      <label>What was it for?<input type="text" name="note" placeholder="e.g. Phone purchase" /></label>
      <div class="actions"><button type="submit" class="primary">Add item</button></div>
      <div id="due-status" class="hint"></div>
    </form>

    <h2>Outstanding items</h2>
    <div id="items-list"></div>

    <h2>Log bill payment</h2>
    <p class="hint">A payment settles against next month's Credit Card Payment Due — it's a transfer, not a fresh category expense.</p>
    <form id="payment-form" class="card">
      <label>Date<input type="date" name="date" value="${todayStr()}" required /></label>
      <label>Amount (₹)<input type="number" name="amount" min="0" step="1" required /></label>
      <label>Note<input type="text" name="note" placeholder="optional" /></label>
      <div class="actions"><button type="submit" class="primary">Log payment</button></div>
    </form>

    <h2>Loans &amp; installment plans</h2>
    <div id="installments-list"></div>

    <h2>Start again</h2>
    <div class="card" id="clear-card"></div>

    <p class="hint">To log a new purchase, use the Transactions screen and choose "Credit Card" as the payment method.</p>
  `;

  let openForm = null; // id of the item whose loan form is open
  let confirmClear = false;

  const txById = (id) => list('transaction').find((t) => t.id === id);
  const planFor = (t) => (t.ccPlanType === 'loan' && t.ccPlanId ? list('ccInstallmentPlan').find((p) => p.id === t.ccPlanId) : null);

  function renderOutstanding() {
    const txs = list('transaction');
    container.querySelector('#cc-outstanding').textContent = formatCurrency(computeCCOutstanding(txs));
    const charges = outstandingItems(txs).reduce((s, t) => s + t.amount, 0);
    const paid = billPaymentsTotal(txs);
    const onLoan = outstandingItems(txs)
      .filter((t) => t.ccPlanType === 'loan')
      .reduce((s, t) => s + t.amount, 0);
    container.querySelector('#cc-breakdown').textContent =
      `Charges ${formatCurrency(charges)} − bill payments ${formatCurrency(paid)}` +
      (onLoan > 0 ? ` · ${formatCurrency(onLoan)} of the charges is on loan` : '');
  }

  function loanFormHtml(t, plan) {
    const fee = plan?.feeAmount ?? 0;
    return `
      <form class="loan-form" data-id="${esc(t.id)}" style="margin-top:.75rem">
        <div class="hint">Type in the terms your bank gave you — nothing is calculated from an interest rate.</div>
        <label>One-time fee (₹)<input type="number" name="fee" min="0" step="any" value="${fee}" /></label>
        <label>Loan duration (months)<input type="number" name="tenure" min="1" step="1" value="${plan?.tenureMonths ?? ''}" required /></label>
        <label>EMI per month (₹)<input type="number" name="emi" min="1" step="any" value="${plan?.monthlyAmount ?? ''}" required /></label>
        <label>Month of first EMI<input type="month" name="start" value="${esc(plan?.startMonth ?? currentMonthKey())}" required /></label>
        <div class="hint loan-preview"></div>
        <div class="actions">
          <button type="submit" class="primary">${plan ? 'Save changes' : 'Save as loan'}</button>
          <button type="button" class="loan-cancel">Cancel</button>
        </div>
        <div class="hint loan-error error"></div>
      </form>`;
  }

  function renderItems() {
    const items = outstandingItems(list('transaction'));
    const el = container.querySelector('#items-list');
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-state">Nothing outstanding. Add an item above.</div>';
      return;
    }
    el.innerHTML = items
      .map((t) => {
        const plan = planFor(t);
        const badge = plan
          ? `<span class="pill success">Loan · ${formatCurrency(plan.monthlyAmount)} × ${plan.tenureMonths}</span>`
          : t.ccPlanType === 'installment'
          ? '<span class="pill">Installment</span>'
          : '<span class="pill">One-time</span>';
        const canDelete = t.kind === 'ccOnboarding';
        return `
          <div class="card cc-item" data-id="${esc(t.id)}">
            <div class="row">
              <div>
                <div>${esc(t.note || (t.kind === 'ccPurchase' ? t.category : 'Outstanding item'))}</div>
                <div class="hint">${esc(t.date)}${t.kind === 'ccPurchase' ? ' · card purchase' : ''}</div>
              </div>
              <div style="text-align:right"><strong>${formatCurrency(t.amount)}</strong><div>${badge}</div></div>
            </div>
            <div class="actions">
              ${canConvertToLoan(t) ? `<button class="loan-open">${plan ? 'Edit loan' : 'Change to loan'}</button>` : ''}
              ${plan ? '<button class="loan-revert">Back to one-time</button>' : ''}
              ${canDelete ? '<button class="danger item-delete">Delete</button>' : ''}
            </div>
            ${openForm === t.id ? loanFormHtml(t, plan) : ''}
            <div class="hint item-error error"></div>
          </div>`;
      })
      .join('');

    el.querySelectorAll('.cc-item').forEach((card) => {
      const id = card.dataset.id;
      const t = txById(id);
      const showError = (msg) => {
        card.querySelector('.item-error').textContent = msg;
      };

      card.querySelector('.loan-open')?.addEventListener('click', () => {
        openForm = openForm === id ? null : id;
        renderItems();
      });
      card.querySelector('.loan-revert')?.addEventListener('click', async () => {
        try {
          await revertLoan(t);
          refresh();
        } catch (err) {
          showError(err.message);
        }
      });
      card.querySelector('.item-delete')?.addEventListener('click', async () => {
        try {
          const plan = planFor(t);
          if (plan) await removeLoanRecords(plan);
          await removeEntity('transaction', id);
          refresh();
        } catch (err) {
          showError(err.message);
        }
      });

      const form = card.querySelector('.loan-form');
      if (!form) return;
      const read = () => {
        const fd = new FormData(form);
        return {
          fee: Number(fd.get('fee') || 0),
          emi: Number(fd.get('emi')),
          tenureMonths: Number(fd.get('tenure')),
          startMonth: fd.get('start'),
        };
      };
      const preview = () => {
        const v = read();
        const out = form.querySelector('.loan-preview');
        if (validateLoan(v)) {
          out.textContent = '';
          return;
        }
        const s = loanSummary({ principal: t.amount, ...v });
        out.textContent =
          `${formatCurrency(v.emi)} × ${v.tenureMonths} = ${formatCurrency(s.totalEmis)}` +
          (v.fee ? ` + ${formatCurrency(v.fee)} fee` : '') +
          ` = ${formatCurrency(s.totalPayable)} in all` +
          (s.extraOverPrincipal !== 0
            ? ` (${formatCurrency(Math.abs(s.extraOverPrincipal))} ${s.extraOverPrincipal > 0 ? 'more' : 'less'} than the ${formatCurrency(t.amount)} charge)`
            : '');
      };
      form.addEventListener('input', preview);
      preview();
      form.querySelector('.loan-cancel').addEventListener('click', () => {
        openForm = null;
        renderItems();
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = read();
        const problem = validateLoan(v);
        if (problem) {
          form.querySelector('.loan-error').textContent = problem;
          return;
        }
        try {
          await saveLoan(t, v);
          openForm = null;
          refresh();
        } catch (err) {
          form.querySelector('.loan-error').textContent = err.message;
        }
      });
    });
  }

  // --- loan bookkeeping -------------------------------------------------------------------
  // A loan is: an installment plan (drives the monthly Credit Card Payment Due in the budget),
  // an optional one-time-fee charge on the card, and a marker on the original item.

  async function saveLoan(t, { fee, emi, tenureMonths, startMonth }) {
    const label = t.note || (t.kind === 'ccPurchase' ? t.category : 'Outstanding item');
    const existing = planFor(t);
    const planData = { category: t.category, label, monthlyAmount: emi, tenureMonths, startMonth, feeAmount: fee, sourceTxId: t.id };

    // The fee is real money charged to the card, so it's its own charge (and counts as spending).
    let feeTxId = existing?.feeTxId;
    const feeTx = feeTxId ? txById(feeTxId) : null;
    if (fee > 0 && feeTx) {
      await updateEntity('transaction', feeTx.id, { amount: fee });
    } else if (fee > 0) {
      const created = await addEntity('transaction', {
        date: todayStr(),
        amount: fee,
        category: 'Miscellaneous',
        note: `Loan fee — ${label}`,
        paymentMethod: 'creditCard',
        kind: 'ccPurchase',
        ccPlanType: 'lumpsum',
      });
      feeTxId = created.id;
    } else if (feeTx) {
      await removeEntity('transaction', feeTx.id);
      feeTxId = undefined;
    }

    const plan = existing
      ? await updateEntity('ccInstallmentPlan', existing.id, { ...planData, feeTxId })
      : await addEntity('ccInstallmentPlan', { ...planData, feeTxId });
    await updateEntity('transaction', t.id, { ccPlanType: 'loan', ccPlanId: plan.id });
  }

  async function removeLoanRecords(plan) {
    if (plan.feeTxId && txById(plan.feeTxId)) await removeEntity('transaction', plan.feeTxId);
    await removeEntity('ccInstallmentPlan', plan.id);
  }

  async function revertLoan(t) {
    const plan = planFor(t);
    if (plan) await removeLoanRecords(plan);
    // Purchases go back to "due in full next month"; hand-entered dues just lose the marker.
    await updateEntity('transaction', t.id, {
      ccPlanType: t.kind === 'ccPurchase' ? 'lumpsum' : undefined,
      ccPlanId: undefined,
    });
  }

  // --- plans list --------------------------------------------------------------------------
  function renderInstallments() {
    const plans = list('ccInstallmentPlan');
    const el = container.querySelector('#installments-list');
    if (plans.length === 0) {
      el.innerHTML = '<div class="empty-state">No loans or installment plans.</div>';
      return;
    }
    el.innerHTML = plans
      .map((p) => {
        const orphan = p.sourceTxId && !txById(p.sourceTxId);
        const s = loanSummary({ principal: 0, fee: p.feeAmount || 0, emi: p.monthlyAmount, tenureMonths: p.tenureMonths });
        return `
        <div class="card" data-plan="${esc(p.id)}">
          <div class="row">
            <div>
              <div>${esc(p.label || p.category)}${p.sourceTxId ? ' <span class="pill success">Loan</span>' : ''}</div>
              <div class="hint">${p.tenureMonths} months from ${esc(p.startMonth)}${p.feeAmount ? ` · one-time fee ${formatCurrency(p.feeAmount)}` : ''}</div>
              <div class="hint">Total to repay ${formatCurrency(s.totalEmis)}</div>
            </div>
            <div>${formatCurrency(p.monthlyAmount)}/mo</div>
          </div>
          ${orphan ? '<div class="actions"><button class="danger plan-remove">Remove (its charge was deleted)</button></div>' : ''}
        </div>`;
      })
      .join('');
    el.querySelectorAll('.plan-remove').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.closest('[data-plan]').dataset.plan;
        await removeEntity('ccInstallmentPlan', id);
        refresh();
      })
    );
  }

  // --- clear & start again -----------------------------------------------------------------
  // Nothing is deleted from the books: everything on the card is flagged as cleared, so it stops
  // counting toward what's owed but spending reports and the bank balance stay correct.
  function renderClear() {
    const live = list('transaction').filter((t) => !t.ccCleared && ['ccPurchase', 'ccOnboarding', 'ccPayment'].includes(t.kind));
    const el = container.querySelector('#clear-card');
    if (live.length === 0) {
      el.innerHTML = '<div class="hint">The card is at zero — nothing to clear.</div>';
      return;
    }
    el.innerHTML = confirmClear
      ? `<div class="hint">This sets the outstanding balance back to ₹0 and removes ${list('ccInstallmentPlan').length ? 'every loan and installment plan' : 'the items above'} from the card. Your past spending and bank balance are not touched, and bill payments you already made from the bank stay in your bank history. Then you can enter the balance again, item by item.</div>
         <div class="actions"><button class="danger" id="clear-yes">Yes, clear it</button><button id="clear-no">Keep it</button></div>
         <div class="hint error" id="clear-error"></div>`
      : `<div class="hint">Got it wrong, or want to re-enter what you owe from scratch? Clear the balance back to zero first.</div>
         <div class="actions"><button class="danger" id="clear-start">Clear outstanding &amp; start again</button></div>`;
    el.querySelector('#clear-start')?.addEventListener('click', () => {
      confirmClear = true;
      renderClear();
    });
    el.querySelector('#clear-no')?.addEventListener('click', () => {
      confirmClear = false;
      renderClear();
    });
    el.querySelector('#clear-yes')?.addEventListener('click', async () => {
      try {
        for (const t of live) await updateEntity('transaction', t.id, { ccCleared: true });
        for (const p of [...list('ccInstallmentPlan')]) await removeEntity('ccInstallmentPlan', p.id);
        confirmClear = false;
        openForm = null;
        refresh();
      } catch (err) {
        el.querySelector('#clear-error').textContent = `Couldn't clear: ${err.message}`;
      }
    });
  }

  function refresh() {
    renderOutstanding();
    renderItems();
    renderInstallments();
    renderClear();
  }

  container.querySelector('#due-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const amount = Number(fd.get('amount'));
    if (!(amount > 0)) return;
    await addEntity('transaction', {
      date: fd.get('date'),
      amount,
      category: DUE_CATEGORY,
      note: String(fd.get('note') || '').trim() || 'Outstanding item',
      paymentMethod: 'creditCard',
      kind: 'ccOnboarding',
    });
    form.reset();
    form.querySelector('[name=date]').value = todayStr();
    container.querySelector('#due-status').textContent = `Added ${formatCurrency(amount)}.`;
    refresh();
  });

  container.querySelector('#payment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await addEntity('transaction', {
      date: fd.get('date'),
      amount: Number(fd.get('amount')),
      category: DUE_CATEGORY,
      note: fd.get('note') || '',
      paymentMethod: 'bank',
      kind: 'ccPayment',
    });
    e.target.reset();
    e.target.querySelector('[name=date]').value = todayStr();
    refresh();
  });

  refresh();
}
