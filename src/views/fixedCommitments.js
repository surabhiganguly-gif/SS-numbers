import { list, addEntity } from '../state/store.js';
import { STICKY_FIXED_CATEGORIES, FIXED_VALUE_CATEGORIES, FIXED_VALUE_DEFAULTS } from '../lib/categories.js';
import { formatCurrency, currentMonthKey, effectiveValue } from '../lib/format.js';

const ALL_NAMES = [...STICKY_FIXED_CATEGORIES, ...FIXED_VALUE_CATEGORIES];

// The most recent past month with a logged amount for this category — used to
// seed a sensible starting value instead of zero when nothing's been set yet.
function lastActualForCategory(transactions, category, atMonthKey) {
  const byMonth = {};
  for (const t of transactions) {
    if (t.category !== category) continue;
    const mk = t.date.slice(0, 7);
    if (mk >= atMonthKey) continue;
    byMonth[mk] = (byMonth[mk] || 0) + t.amount;
  }
  const months = Object.keys(byMonth).sort();
  return months.length ? byMonth[months[months.length - 1]] : 0;
}

async function getOrCreateCommitment(name, transactions) {
  let c = list('fixedCommitment').find((c) => c.name === name);
  if (!c) {
    c = await addEntity('fixedCommitment', { name });
    const defaultAmount = FIXED_VALUE_CATEGORIES.includes(name)
      ? FIXED_VALUE_DEFAULTS[name]
      : lastActualForCategory(transactions, name, currentMonthKey());
    if (defaultAmount > 0) {
      await addEntity('fixedCommitmentVersion', {
        commitmentId: c.id,
        amount: defaultAmount,
        effectiveFrom: currentMonthKey(),
      });
    }
  }
  return c;
}

function versionsFor(commitmentId) {
  return list('fixedCommitmentVersion')
    .filter((v) => v.commitmentId === commitmentId)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}

export function render(container) {
  container.innerHTML = `
    <h1>Fixed Commitments</h1>
    <p class="hint">Rent, EMIs, SIP Savings, vehicle maintenance, and Miscellaneous each keep an effective-dated history — they carry forward last month's value automatically until you update one here. Updating doesn't change what past months' reports show.</p>
    <p class="hint">Utilities, Hobbies, Staff/Ironing, and Land aren't managed here anymore — they're budgeted automatically off a running 3-month average.</p>
    <div id="commitments-list"></div>
  `;
  const listEl = container.querySelector('#commitments-list');

  async function ensureAllExist() {
    const transactions = list('transaction');
    for (const name of ALL_NAMES) {
      await getOrCreateCommitment(name, transactions);
    }
  }

  function renderCommitments() {
    listEl.innerHTML = ALL_NAMES.map((name) => {
      const c = list('fixedCommitment').find((c) => c.name === name);
      if (!c) return '';
      const versions = versionsFor(c.id);
      const current = versions.length ? effectiveValue(versions, currentMonthKey()) : 0;
      return `
        <div class="card" data-commitment-id="${c.id}">
          <div class="row">
            <strong>${name}</strong>
            <span>${formatCurrency(current)}/mo</span>
          </div>
          <details>
            <summary class="hint">History (${versions.length})</summary>
            <table>
              <tbody>
                ${versions
                  .map((v) => `<tr><td>${v.effectiveFrom}</td><td>${formatCurrency(v.amount)}</td></tr>`)
                  .join('')}
              </tbody>
            </table>
          </details>
          <form class="update-form">
            <label>New effective amount (₹)<input type="number" name="amount" min="0" required /></label>
            <label>Effective from (month)<input type="month" name="effectiveFrom" value="${currentMonthKey()}" required /></label>
            <div class="actions"><button type="submit" class="primary">Update</button></div>
          </form>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.update-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const commitmentId = form.closest('[data-commitment-id]').dataset.commitmentId;
        const fd = new FormData(form);
        await addEntity('fixedCommitmentVersion', {
          commitmentId,
          amount: Number(fd.get('amount')),
          effectiveFrom: fd.get('effectiveFrom'),
        });
        renderCommitments();
      });
    });
  }

  ensureAllExist().then(renderCommitments);
}
