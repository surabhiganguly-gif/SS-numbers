import { list, addEntity } from '../state/store.js';
import { CATEGORY_GROUPS } from '../lib/categories.js';
import { formatCurrency } from '../lib/format.js';

const IMPORT_MONTHS = ['2026-06', '2026-07'];

function importCategories() {
  return Object.entries(CATEGORY_GROUPS)
    .filter(([key]) => key !== 'goal' && key !== 'ccPaymentDue')
    .flatMap(([, group]) => group.categories);
}

function kindFor(category) {
  if (category === 'Salary' || category === 'Other Credits') return 'income';
  if (category === 'SIP Savings' || category === 'Liquid Savings') return 'savingsContribution';
  return 'expense';
}

export function render(container) {
  // Bank-statement imports are monthly totals too, but they aren't this screen's one-time import.
  const isHistoricalLump = (t) => t.granularity === 'monthly-lump' && t.source !== 'statement';
  const alreadyImported = list('transaction').some(isHistoricalLump);

  if (alreadyImported) {
    const imported = list('transaction').filter(isHistoricalLump);
    container.innerHTML = `
      <h1>Historical Import</h1>
      <p class="hint">June/July totals were already imported as monthly lump sums (not daily detail) — reports flag this period separately from real daily entries.</p>
      <div id="imported-list"></div>
    `;
    const el = container.querySelector('#imported-list');
    el.innerHTML = imported
      .map((t) => `<div class="card row"><span>${t.date.slice(0, 7)} — ${t.category}</span><span>${formatCurrency(t.amount)}</span></div>`)
      .join('');
    return;
  }

  const categories = importCategories();

  container.innerHTML = `
    <h1>Historical Import</h1>
    <p class="hint">Enter lump-sum totals per category for each month from your spreadsheet. This is a one-time setup — from today onward, log real daily transactions instead.</p>
    <form id="import-form">
      <table>
        <thead><tr><th>Category</th>${IMPORT_MONTHS.map((m) => `<th>${m}</th>`).join('')}</tr></thead>
        <tbody>
          ${categories
            .map(
              (cat) => `<tr>
                <td>${cat}</td>
                ${IMPORT_MONTHS.map(
                  (m) => `<td><input type="number" min="0" step="1" name="${m}__${cat}" style="width:90px" /></td>`
                ).join('')}
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div class="actions"><button type="submit" class="primary">Import</button></div>
    </form>
  `;

  container.querySelector('#import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    for (const month of IMPORT_MONTHS) {
      for (const cat of categories) {
        const raw = fd.get(`${month}__${cat}`);
        if (!raw) continue;
        const amount = Number(raw);
        if (amount <= 0) continue;
        await addEntity('transaction', {
          date: `${month}-01`,
          amount,
          category: cat,
          note: 'Historical monthly lump sum',
          paymentMethod: 'bank',
          kind: kindFor(cat),
          granularity: 'monthly-lump',
        });
      }
    }
    render(container);
  });
}
