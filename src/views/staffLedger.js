import { list, addEntity, updateEntity } from '../state/store.js';
import { formatCurrency } from '../lib/format.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function outstandingAdvances(staffId) {
  return list('staffAdvance')
    .filter((a) => a.staffId === staffId && a.amount - a.appliedAmount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function outstandingTotal(staffId) {
  return outstandingAdvances(staffId).reduce((sum, a) => sum + (a.amount - a.appliedAmount), 0);
}

async function applyAgainstAdvances(staffId, applyAmount) {
  let remaining = applyAmount;
  for (const advance of outstandingAdvances(staffId)) {
    if (remaining <= 0) break;
    const due = advance.amount - advance.appliedAmount;
    const take = Math.min(due, remaining);
    await updateEntity('staffAdvance', advance.id, { appliedAmount: advance.appliedAmount + take });
    remaining -= take;
  }
}

export function render(container) {
  container.innerHTML = `
    <h1>Staff Ledger</h1>
    <form id="add-staff-form" class="card">
      <label>Staff member name<input type="text" name="name" required /></label>
      <div class="actions"><button type="submit" class="primary">Add staff member</button></div>
    </form>
    <div id="staff-list"></div>
  `;

  container.querySelector('#add-staff-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    await addEntity('staffMember', { name });
    e.target.reset();
    renderStaff();
  });

  function renderStaff() {
    const staff = list('staffMember');
    const el = container.querySelector('#staff-list');
    if (staff.length === 0) {
      el.innerHTML = '<div class="empty-state">No staff members yet.</div>';
      return;
    }
    el.innerHTML = staff
      .map((s) => {
        const outstanding = outstandingTotal(s.id);
        return `
        <div class="card" data-staff-id="${s.id}">
          <div class="row">
            <strong>${s.name}</strong>
            ${outstanding > 0 ? `<span class="pill warning">${formatCurrency(outstanding)} advance outstanding</span>` : ''}
          </div>
          <form class="advance-form">
            <label>Log advance (₹)<input type="number" name="amount" min="0" step="1" required /></label>
            <label>Note<input type="text" name="note" placeholder="optional" /></label>
            <div class="actions"><button type="submit">Log advance</button></div>
          </form>
          <form class="payment-form">
            <label>Log payment (₹)<input type="number" name="amount" min="0" step="1" required /></label>
            ${
              outstanding > 0
                ? `<label class="apply-checkbox"><input type="checkbox" name="applyAdvance" checked style="width:auto;display:inline-block" /> ${formatCurrency(
                    outstanding
                  )} advance outstanding for ${s.name} — apply now?</label>`
                : ''
            }
            <div class="actions"><button type="submit" class="primary">Log payment</button></div>
          </form>
        </div>`;
      })
      .join('');

    el.querySelectorAll('.advance-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const staffId = form.closest('[data-staff-id]').dataset.staffId;
        const staffName = staff.find((s) => s.id === staffId)?.name || '';
        const fd = new FormData(form);
        const amount = Number(fd.get('amount'));
        const customNote = fd.get('note');
        await addEntity('staffAdvance', { staffId, amount, appliedAmount: 0, date: todayStr() });
        await addEntity('transaction', {
          date: todayStr(),
          amount,
          category: 'Staff/Ironing',
          note: customNote ? `Advance to ${staffName} — ${customNote}` : `Advance to ${staffName}`,
          paymentMethod: 'bank',
          kind: 'staffAdvance',
          staffId,
        });
        renderStaff();
      });
    });

    el.querySelectorAll('.payment-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const staffId = form.closest('[data-staff-id]').dataset.staffId;
        const staffName = staff.find((s) => s.id === staffId)?.name || '';
        const fd = new FormData(form);
        const amount = Number(fd.get('amount'));
        const outstanding = outstandingTotal(staffId);
        const applyAdvance = fd.get('applyAdvance') === 'on';
        const appliedAdvanceAmount = applyAdvance ? Math.min(outstanding, amount) : 0;

        if (appliedAdvanceAmount > 0) {
          await applyAgainstAdvances(staffId, appliedAdvanceAmount);
        }

        const note =
          appliedAdvanceAmount > 0
            ? `Payment to ${staffName} — applied ${formatCurrency(appliedAdvanceAmount)} advance`
            : `Payment to ${staffName}`;

        await addEntity('transaction', {
          date: todayStr(),
          amount,
          category: 'Staff/Ironing',
          note,
          paymentMethod: 'bank',
          kind: 'staffPayment',
          staffId,
          appliedAdvanceAmount,
        });
        renderStaff();
      });
    });
  }

  renderStaff();
}
