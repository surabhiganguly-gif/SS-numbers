import { list, addEntity } from '../state/store.js';
import { FIXED_COMMITMENT_NAMES, VEHICLE_MAINTENANCE_CATEGORIES } from '../lib/categories.js';
import { formatCurrency, currentMonthKey, effectiveValue } from '../lib/format.js';

const ALL_NAMES = [...FIXED_COMMITMENT_NAMES, ...VEHICLE_MAINTENANCE_CATEGORIES];
const VEHICLE_MAINTENANCE_DEFAULT = 2000;

async function getOrCreateCommitment(name) {
  let c = list('fixedCommitment').find((c) => c.name === name);
  if (!c) {
    c = await addEntity('fixedCommitment', { name });
    if (VEHICLE_MAINTENANCE_CATEGORIES.includes(name)) {
      await addEntity('fixedCommitmentVersion', {
        commitmentId: c.id,
        amount: VEHICLE_MAINTENANCE_DEFAULT,
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
    <p class="hint">Rent, EMIs, and vehicle maintenance defaults each keep an effective-dated history — updating one here doesn't change what past months' reports show.</p>
    <div id="commitments-list"></div>
  `;
  const listEl = container.querySelector('#commitments-list');

  async function ensureAllExist() {
    for (const name of ALL_NAMES) {
      await getOrCreateCommitment(name);
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
