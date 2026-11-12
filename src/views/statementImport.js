import { list, addEntity, updateEntity, importRecords } from '../state/store.js';
import { CATEGORY_GROUPS } from '../lib/categories.js';
import { formatCurrency } from '../lib/format.js';
import { newId } from '../lib/id.js';
import { computeBankBalance } from '../lib/bankBalance.js';
import { readSpreadsheet } from '../lib/spreadsheet.js';
import {
  parseStatementRows,
  groupLines,
  suggestCategory,
  buildMonthlyTransactions,
  summarize,
  dayBefore,
  SKIP,
  CC_BILL,
} from '../lib/statement.js';

// Narrations are arbitrary bank text — always escape before putting them in HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => formatCurrency(n);
const moneyExact = (n) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

function choiceLabel(choice) {
  if (choice === SKIP) return "Don't import";
  if (choice === CC_BILL) return 'Credit card bill';
  return choice;
}

function validChoices(direction) {
  if (direction === 'in') return new Set([...CATEGORY_GROUPS.income.categories, SKIP]);
  return new Set([
    ...CATEGORY_GROUPS.fixed.categories,
    ...CATEGORY_GROUPS.variable.categories,
    ...CATEGORY_GROUPS.savings.categories,
    ...list('goal').map((g) => g.name),
    CC_BILL,
    SKIP,
  ]);
}

function categoryOptionsHtml(direction, selected) {
  const opt = (value, label) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const sections =
    direction === 'in'
      ? [['Income', CATEGORY_GROUPS.income.categories]]
      : [
          ['Fixed commitments', CATEGORY_GROUPS.fixed.categories],
          ['Variable spending', CATEGORY_GROUPS.variable.categories],
          ['Savings', CATEGORY_GROUPS.savings.categories],
          ['Goals', list('goal').map((g) => g.name)],
        ];
  const other = direction === 'in' ? [[SKIP, "Don't import these lines"]] : [[CC_BILL, 'Credit card bill payment'], [SKIP, "Don't import these lines"]];
  return (
    `<option value="">Choose a category…</option>` +
    sections
      .filter(([, cats]) => cats.length)
      .map(([label, cats]) => `<optgroup label="${label}">${cats.map((c) => opt(c, c)).join('')}</optgroup>`)
      .join('') +
    `<optgroup label="Other">${other.map(([v, l]) => opt(v, l)).join('')}</optgroup>`
  );
}

function savedRules() {
  return list('settings').find((s) => s.key === 'payeeRules')?.rules ?? {};
}

async function saveRules(newRules) {
  const existing = list('settings').find((s) => s.key === 'payeeRules');
  const rules = { ...(existing?.rules ?? {}), ...newRules };
  if (existing) await updateEntity('settings', existing.id, { rules });
  else await addEntity('settings', { key: 'payeeRules', rules });
}

export function render(container) {
  container.innerHTML = `<h1>Import bank statement</h1><div id="stmt-body"></div>`;
  const body = container.querySelector('#stmt-body');
  renderStart();

  // ------------------------------------------------------------ step 1: pick file
  function renderStart(message, kind) {
    body.innerHTML = `
      <div class="card">
        <p class="hint">Pick your bank statement (.xls or .csv) — tap the box below and look in Downloads, or in Drive if that's where you saved it. You don't need to open the file first. It's read on this phone and never uploaded. Lines are grouped by payee so you categorise each payee once; the result is saved as <strong>monthly category totals</strong>.</p>
        <label>Statement file<input type="file" id="stmt-file" /></label>
        <div class="actions"><button id="stmt-read" class="primary">Read statement</button></div>
        <div id="stmt-status" class="hint ${kind || ''}">${esc(message || '')}</div>
      </div>`;
    body.querySelector('#stmt-read').addEventListener('click', async () => {
      const file = body.querySelector('#stmt-file').files[0];
      const status = body.querySelector('#stmt-status');
      if (!file) { status.textContent = 'Choose a statement file first.'; status.className = 'hint error'; return; }
      status.textContent = 'Reading…';
      status.className = 'hint';
      try {
        const parsed = parseStatementRows(await readSpreadsheet(file));
        start(file.name, parsed);
      } catch (err) {
        status.textContent = err.message;
        status.className = 'hint error';
      }
    });
  }

  // ------------------------------------------------------------ step 2: review
  function start(fileName, parsed) {
    const existingKeys = new Set(list('transaction').flatMap((t) => t.importKeys || []));
    const lines = parsed.lines.filter((l) => !existingKeys.has(l.key));
    const alreadyImported = parsed.lines.length - lines.length;
    if (lines.length === 0) {
      renderStart('Everything in this file has already been imported.', 'error');
      return;
    }

    // Balances for just the new lines (a later statement may overlap an earlier import).
    const first = lines[0];
    const last = lines[lines.length - 1];
    const meta = {
      from: first.date,
      to: last.date,
      opening: first.bal != null ? Math.round((first.bal - first.dep + first.wd) * 100) / 100 : null,
      closing: last.bal,
    };

    const groups = groupLines(lines);
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    const rules = savedRules();
    const assign = {};
    const origin = {};
    const remember = {};
    for (const g of groups) {
      const saved = rules[g.id];
      if (saved && validChoices(g.direction).has(saved)) { assign[g.id] = saved; origin[g.id] = 'saved'; continue; }
      const suggestion = suggestCategory(g);
      if (suggestion) { assign[g.id] = suggestion; origin[g.id] = 'suggested'; }
    }
    const firstImport =
      !list('transaction').some((t) => t.source === 'statement') && !list('reconciliation').some((r) => r.source === 'statement-opening');
    const ui = { filter: 'all', selected: new Set(), setOpening: firstImport && meta.opening != null };

    body.innerHTML = `
      <div class="card" id="stmt-summary"></div>
      <div class="card">
        <label>Show
          <select id="stmt-filter">
            <option value="all">All payees</option>
            <option value="needs">Needs a category</option>
            <option value="suggested">Suggested (not yet confirmed)</option>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </label>
        <div class="actions">
          <button id="stmt-bulk">Categorise selected…</button>
          <button id="stmt-fill">Fill the rest</button>
        </div>
        <p class="hint">Tap a payee to choose its category, or tick several and use "Categorise selected". "Fill the rest" puts uncategorised spending under Miscellaneous and uncategorised credits under Other Credits.</p>
      </div>
      <div id="payee-list"></div>
      <div class="card" id="stmt-footer"></div>`;

    const listEl = body.querySelector('#payee-list');

    function visible(g) {
      switch (ui.filter) {
        case 'needs': return !assign[g.id];
        case 'suggested': return origin[g.id] === 'suggested';
        case 'out': return g.direction === 'out';
        case 'in': return g.direction === 'in';
        default: return true;
      }
    }

    function refresh() {
      const s = summarize(groups, assign, meta);
      const suggestedCount = groups.filter((g) => origin[g.id] === 'suggested').length;
      body.querySelector('#stmt-summary').innerHTML = `
        <div><strong>${esc(fileName)}</strong></div>
        <div class="hint">${lines.length} lines · ${meta.from} → ${meta.to} · ${groups.length} payees${alreadyImported ? ` · ${alreadyImported} lines skipped (already imported)` : ''}</div>
        <div class="row"><span>Payees categorised</span><span>${groups.length - s.unassignedGroups} of ${groups.length}</span></div>
        ${s.unassignedGroups ? `<div class="row"><span>Still to categorise</span><span>${money(s.unassignedAmount)}</span></div>` : ''}
        ${suggestedCount ? `<div class="hint">${suggestedCount} payees have a suggested category — give them a glance.</div>` : ''}`;

      listEl.innerHTML =
        groups
          .filter(visible)
          .map((g) => {
            const choice = assign[g.id];
            const chipClass = !choice ? 'needs' : origin[g.id] === 'suggested' ? 'suggested' : 'chosen';
            const months = [...g.months].sort().map((m) => monthName(m)).join(', ');
            return `
              <div class="card payee-row" data-id="${esc(g.id)}">
                <input type="checkbox" class="payee-select" aria-label="Select ${esc(g.label)}" ${ui.selected.has(g.id) ? 'checked' : ''} />
                <div class="payee-main">
                  <strong>${esc(g.label)}</strong>
                  <div class="hint">${g.direction === 'in' ? 'in' : 'out'} · ${g.lines.length} line${g.lines.length === 1 ? '' : 's'} · ${money(g.total)}${
              g.sameAmount ? ` · ${money(g.sameAmount)} every month` : ` · ${esc(months)}`
            }</div>
                </div>
                <button type="button" class="chip ${chipClass}">${choice ? (chipClass === 'suggested' ? '✨ ' : '') + esc(choiceLabel(choice)) : 'Choose'}</button>
              </div>`;
          })
          .join('') || '<div class="empty-state">Nothing matches this filter.</div>';

      renderFooter(s);
    }

    function currentTransactions() {
      return buildMonthlyTransactions(groups, assign, list('goal'));
    }

    function renderFooter(s) {
      const txs = currentTransactions();
      const months = [...new Set(txs.map((t) => t.date.slice(0, 7)))].sort();
      const cats = [...new Set(txs.map((t) => t.category))];
      const cell = (cat, m) => {
        const sum = txs.filter((t) => t.category === cat && t.date.startsWith(m)).reduce((n, t) => n + t.amount, 0);
        return sum ? money(sum) : '–';
      };
      const preview = txs.length
        ? `<details><summary class="hint">Preview of the monthly totals (${txs.length})</summary>
            <table><thead><tr><th>Category</th>${months.map((m) => `<th>${monthName(m)}</th>`).join('')}</tr></thead>
            <tbody>${cats.map((c) => `<tr><td>${esc(c)}</td>${months.map((m) => `<td>${cell(c, m)}</td>`).join('')}</tr>`).join('')}</tbody></table>
          </details>`
        : '';

      let check = '';
      if (s.importedClosing != null) {
        check =
          s.difference === 0 && !s.unassignedGroups
            ? `<div class="pill success" style="display:block">Matches your statement's closing balance (${moneyExact(meta.closing)}) to the paisa.</div>`
            : `<div class="hint">Statement closing balance ${moneyExact(meta.closing)} · this import would give ${moneyExact(s.importedClosing)}${
                s.unassignedGroups
                  ? ' (some payees still uncategorised).'
                  : s.skippedLines
                  ? ` — the ${moneyExact(Math.abs(s.difference))} difference is the ${s.skippedLines} line(s) you chose not to import.`
                  : '.'
              }</div>`;
      }

      body.querySelector('#stmt-footer').innerHTML = `
        <div class="row"><span>Money in</span><span>${money(s.creditsImported)}</span></div>
        <div class="row"><span>Money out</span><span>${money(s.debitsImported)}</span></div>
        ${s.skippedLines ? `<div class="row"><span>Not imported</span><span>${s.skippedLines} lines</span></div>` : ''}
        ${check}
        ${preview}
        ${
          meta.opening != null
            ? `<label class="check-label"><input type="checkbox" id="stmt-opening" ${ui.setOpening ? 'checked' : ''} /> Also set the opening balance to ${moneyExact(meta.opening)} (so the app's bank balance matches your bank)</label>`
            : ''
        }
        <div class="actions"><button id="stmt-import" class="primary" ${s.unassignedGroups || !txs.length ? 'disabled' : ''}>Import ${txs.length} monthly total${txs.length === 1 ? '' : 's'}</button></div>
        ${s.unassignedGroups ? `<p class="hint">Categorise the remaining ${s.unassignedGroups} payee${s.unassignedGroups === 1 ? '' : 's'} to enable import.</p>` : ''}
        <div id="stmt-import-status" class="hint"></div>`;
    }

    // ---------------------------------------------------------------- dialogs
    function openDialog(html) {
      const dlg = document.createElement('dialog');
      dlg.className = 'stmt-dialog';
      dlg.innerHTML = html;
      container.appendChild(dlg);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.showModal();
      return dlg;
    }

    // Remove explicitly rather than relying on the 'close' event (which still handles
    // the Android back button / Esc closing it natively).
    function closeDialog(dlg) {
      if (dlg.open) dlg.close();
      dlg.remove();
    }

    function openPayeeDialog(id) {
      const g = byId[id];
      const dates = g.lines.map((l) => l.date).sort();
      const samples = g.lines
        .slice(0, 6)
        .map((l) => `<div class="row"><span>${l.date} · ${esc(l.narr.slice(0, 52))}</span><span>${money(l.wd || l.dep)}</span></div>`)
        .join('');
      const dlg = openDialog(`
        <h2>${esc(g.label)}</h2>
        <p class="hint">${g.direction === 'in' ? 'Money in' : 'Money out'} · ${g.lines.length} line${g.lines.length === 1 ? '' : 's'} · ${money(g.total)} · ${dates[0]} → ${dates[dates.length - 1]}${
        g.sameAmount ? ` · ${money(g.sameAmount)} every month` : ''
      }</p>
        <div class="dlg-lines">${samples}${g.lines.length > 6 ? `<div class="hint">…and ${g.lines.length - 6} more</div>` : ''}</div>
        <label>Category<select id="dlg-cat">${categoryOptionsHtml(g.direction, assign[id] || '')}</select></label>
        <label class="check-label"><input type="checkbox" id="dlg-remember" checked /> Remember this for future statements</label>
        <div class="actions">
          <button class="primary" id="dlg-save">Save</button>
          <button id="dlg-cancel">Cancel</button>
        </div>`);
      dlg.querySelector('#dlg-cancel').addEventListener('click', () => closeDialog(dlg));
      dlg.querySelector('#dlg-save').addEventListener('click', () => {
        const value = dlg.querySelector('#dlg-cat').value;
        if (!value) { dlg.querySelector('#dlg-cat').focus(); return; }
        assign[id] = value;
        origin[id] = 'user';
        remember[id] = dlg.querySelector('#dlg-remember').checked;
        closeDialog(dlg);
        refresh();
      });
    }

    function openBulkDialog() {
      const ids = [...ui.selected].filter((id) => byId[id]);
      if (!ids.length) {
        const dlg = openDialog(`<h2>Categorise selected</h2><p class="hint">Tick one or more payees first.</p><div class="actions"><button id="dlg-cancel" class="primary">OK</button></div>`);
        dlg.querySelector('#dlg-cancel').addEventListener('click', () => closeDialog(dlg));
        return;
      }
      const directions = new Set(ids.map((id) => byId[id].direction));
      if (directions.size > 1) {
        const dlg = openDialog(`<h2>Categorise selected</h2><p class="hint">You've ticked both money-in and money-out payees. Select only one kind at a time — they use different categories.</p><div class="actions"><button id="dlg-cancel" class="primary">OK</button></div>`);
        dlg.querySelector('#dlg-cancel').addEventListener('click', () => closeDialog(dlg));
        return;
      }
      const direction = [...directions][0];
      const total = ids.reduce((n, id) => n + byId[id].total, 0);
      const dlg = openDialog(`
        <h2>Categorise ${ids.length} payee${ids.length === 1 ? '' : 's'}</h2>
        <p class="hint">${money(total)} in total</p>
        <div class="dlg-lines">${ids.slice(0, 8).map((id) => `<div class="row"><span>${esc(byId[id].label)}</span><span>${money(byId[id].total)}</span></div>`).join('')}${ids.length > 8 ? `<div class="hint">…and ${ids.length - 8} more</div>` : ''}</div>
        <label>Category<select id="dlg-cat">${categoryOptionsHtml(direction, '')}</select></label>
        <label class="check-label"><input type="checkbox" id="dlg-remember" checked /> Remember this for future statements</label>
        <div class="actions">
          <button class="primary" id="dlg-save">Apply to all ${ids.length}</button>
          <button id="dlg-cancel">Cancel</button>
        </div>`);
      dlg.querySelector('#dlg-cancel').addEventListener('click', () => closeDialog(dlg));
      dlg.querySelector('#dlg-save').addEventListener('click', () => {
        const value = dlg.querySelector('#dlg-cat').value;
        if (!value) { dlg.querySelector('#dlg-cat').focus(); return; }
        const rememberIt = dlg.querySelector('#dlg-remember').checked;
        for (const id of ids) { assign[id] = value; origin[id] = 'user'; remember[id] = rememberIt; }
        ui.selected.clear();
        closeDialog(dlg);
        refresh();
      });
    }

    // ---------------------------------------------------------------- wiring
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('.payee-row');
      if (!row) return;
      const id = row.dataset.id;
      if (e.target.closest('.payee-select')) {
        if (e.target.checked) ui.selected.add(id);
        else ui.selected.delete(id);
        return;
      }
      openPayeeDialog(id);
    });
    body.querySelector('#stmt-filter').addEventListener('change', (e) => { ui.filter = e.target.value; refresh(); });
    body.querySelector('#stmt-bulk').addEventListener('click', openBulkDialog);
    body.querySelector('#stmt-fill').addEventListener('click', () => {
      for (const g of groups) {
        if (assign[g.id]) continue;
        assign[g.id] = g.direction === 'in' ? 'Other Credits' : 'Miscellaneous';
        origin[g.id] = 'user';
        remember[g.id] = false;
      }
      refresh();
    });
    body.querySelector('#stmt-footer').addEventListener('change', (e) => {
      if (e.target.id === 'stmt-opening') ui.setOpening = e.target.checked;
    });
    body.querySelector('#stmt-footer').addEventListener('click', async (e) => {
      if (e.target.id !== 'stmt-import') return;
      const status = body.querySelector('#stmt-import-status');
      e.target.disabled = true;
      status.textContent = 'Importing…';
      try {
        const txs = currentTransactions();
        const records = txs.map((t) => ({ type: 'transaction', id: newId(), ...t }));
        if (ui.setOpening && meta.opening != null) {
          records.push({
            type: 'reconciliation',
            id: newId(),
            date: dayBefore(meta.from),
            appBalance: 0,
            actualBalance: meta.opening,
            resolution: 'adjustment',
            adjustmentAmount: meta.opening,
            source: 'statement-opening',
          });
        }
        const newRules = {};
        for (const g of groups) {
          if (assign[g.id] && remember[g.id] !== false && (origin[g.id] === 'user' || origin[g.id] === 'saved')) newRules[g.id] = assign[g.id];
        }
        if (Object.keys(newRules).length) await saveRules(newRules);
        await importRecords(records);
        renderDone(txs.length, meta, lines.length);
      } catch (err) {
        status.textContent = `Import failed: ${err.message}`;
        status.className = 'hint error';
        e.target.disabled = false;
      }
    });

    refresh();
  }

  // ------------------------------------------------------------ step 3: done
  function renderDone(count, meta, lineCount) {
    const balance = computeBankBalance(list('transaction'), list('reconciliation'));
    body.innerHTML = `
      <div class="card">
        <h2>Imported</h2>
        <p>${count} monthly totals from ${lineCount} statement lines (${meta.from} → ${meta.to}).</p>
        ${
          meta.closing != null
            ? `<div class="row"><span>App bank balance now</span><span>${moneyExact(balance)}</span></div>
               <div class="row"><span>Statement closing balance</span><span>${moneyExact(meta.closing)}</span></div>`
            : ''
        }
      </div>
      <div class="card">
        <a href="#/budget">See your budget & history →</a><br /><br />
        <a href="#/fixed-commitments">Check fixed commitments (Rent, EMIs, SIP are filled in from these months) →</a><br /><br />
        <a href="#/settings">Back up to Drive →</a>
      </div>
      <p class="hint">Credit card <em>purchases</em> aren't in a bank statement — only the bill payments are — so card spending by category isn't included yet.</p>`;
  }
}
