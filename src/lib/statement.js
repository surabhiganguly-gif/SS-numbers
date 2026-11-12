// Bank-statement import logic — pure functions, no DOM or storage access.
// Flow: rows -> lines -> payee groups -> (user assigns categories) -> monthly totals.

export const SKIP = '__SKIP__'; // don't import these lines
export const CC_BILL = '__CCBILL__'; // credit card bill payment (a transfer, not an expense)

const CC_CATEGORY = 'Credit Card Payment Due';
const SAVINGS_CATEGORIES = ['SIP Savings', 'Liquid Savings'];
const r2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ parsing

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10); // Excel serial
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (m) return isoDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3})[a-z]*[ \-,]+(\d{2}|\d{4})$/);
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    return isoDate(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()) + 1, Number(m[1]));
  }
  return null;
}

function amount(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[,\s₹]|Rs\.?/gi, ''));
  return Number.isFinite(n) ? n : 0;
}

const findCol = (cells, ...patterns) => {
  for (const p of patterns) {
    const i = cells.findIndex((c) => p.test(c));
    if (i >= 0) return i;
  }
  return -1;
};

export function parseStatementRows(rows) {
  let header = -1;
  let cols = null;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const cells = rows[i].map((c) => String(c ?? '').trim().toLowerCase());
    const candidate = {
      date: findCol(cells, /^date$/, /^(txn|transaction|posting) date$/, /date/),
      narr: findCol(cells, /narration|description|particulars|details|remarks/),
      ref: findCol(cells, /ref|chq|cheque/),
      wd: findCol(cells, /withdrawal|debit/, /^dr\.?$/),
      dep: findCol(cells, /deposit|credit/, /^cr\.?$/),
      bal: findCol(cells, /balance/),
    };
    if (candidate.date >= 0 && candidate.narr >= 0 && (candidate.wd >= 0 || candidate.dep >= 0)) {
      header = i;
      cols = candidate;
      break;
    }
  }
  if (!cols) {
    throw new Error("Couldn't find the transaction table — expected columns like Date, Narration, Withdrawal and Deposit.");
  }

  let lines = [];
  for (const row of rows.slice(header + 1)) {
    const date = parseDate(row[cols.date]);
    if (!date) continue; // separators, totals, footers
    const wd = cols.wd >= 0 ? amount(row[cols.wd]) : 0;
    const dep = cols.dep >= 0 ? amount(row[cols.dep]) : 0;
    if (!wd && !dep) continue;
    lines.push({
      date,
      narr: String(row[cols.narr] ?? '').trim().replace(/\s+/g, ' '),
      ref: cols.ref >= 0 ? String(row[cols.ref] ?? '').trim() : '',
      wd,
      dep,
      bal: cols.bal >= 0 && row[cols.bal] !== '' ? amount(row[cols.bal]) : null,
    });
  }
  if (lines.length > 1 && lines[0].date > lines[lines.length - 1].date) lines = lines.reverse();

  // A stable id per line so a later, overlapping statement doesn't double-count.
  const seen = new Map();
  lines.forEach((l, idx) => {
    const base = `${l.date}|${l.wd ? 'D' + l.wd : 'C' + l.dep}|${l.ref || l.narr.slice(0, 40)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    l.idx = idx;
    l.key = n > 1 ? `${base}#${n}` : base;
  });

  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    lines,
    meta: {
      from: first?.date ?? null,
      to: last?.date ?? null,
      opening: first && first.bal != null ? r2(first.bal - first.dep + first.wd) : null,
      closing: last && last.bal != null ? last.bal : null,
    },
  };
}

// ------------------------------------------------------------------ payees

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const digitCount = (w) => (w.match(/\d/g) || []).length;
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const stripCorporateSuffix = (name) => name.replace(/(\s+(LTD|LIMITED|PVT|PRIVATE))+\.?$/i, '');

export function payeeInfo(narr) {
  const n = narr.toUpperCase();
  if (/^(ATW|ATM|NWD|EAW|CASH WDL|CASH WITHDRAWAL)\b/.test(n)) {
    return { key: 'ATM CASH WITHDRAWAL', label: 'ATM cash withdrawals' };
  }
  if (n.startsWith('UPI-')) {
    const parts = narr.split('-');
    let name = (parts[1] || '').trim();
    if (!name || /^X{2,}/i.test(name)) name = (parts[2] || '').trim(); // masked payee -> use the handle
    name = stripCorporateSuffix(name.replace(/\s+/g, ' ')).slice(0, 30);
    return { key: `UPI:${name.toUpperCase()}`, label: `${titleCase(name)} (UPI)` };
  }
  // Drop long reference/mandate/card numbers so the same payee groups together each month,
  // but keep bank IFSC codes — they identify the beneficiary bank for NEFT/IMPS.
  const words = n
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !(digitCount(w) >= 6 && !IFSC.test(w)) && !/^\d+$/.test(w)); // also drops stray date fragments
  const key = words.slice(0, 3).join(' ') || n.slice(0, 20);
  return { key, label: titleCase(words.slice(0, 4).join(' ') || n.slice(0, 20)) };
}

export function groupLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    const direction = line.wd ? 'out' : 'in';
    const { key, label } = payeeInfo(line.narr);
    const id = `${key}|${direction}`;
    if (!groups.has(id)) groups.set(id, { id, key, label, direction, lines: [], total: 0, months: new Set() });
    const g = groups.get(id);
    const amt = line.wd || line.dep;
    g.lines.push(line);
    g.total = r2(g.total + amt);
    g.months.add(line.date.slice(0, 7));
  }
  const result = [...groups.values()]
    .map((g) => {
      const amounts = new Set(g.lines.map((l) => l.wd || l.dep));
      return { ...g, sameAmount: amounts.size === 1 && g.months.size >= 3 ? [...amounts][0] : null };
    })
    .sort((a, b) => b.total - a.total);

  // Salary is the biggest bank-transfer credit that keeps coming back (or, for a one-month
  // statement, simply the biggest one) — no employer names baked into the code, and never a
  // person-to-person UPI payment.
  const monthsInStatement = new Set(lines.map((l) => l.date.slice(0, 7))).size;
  const salary = result.find(
    (g) => g.direction === 'in' && !g.key.startsWith('UPI:') && g.months.size >= Math.min(2, monthsInStatement)
  );
  for (const g of result) g.likelySalary = g === salary;
  return result;
}

// ------------------------------------------------------------- suggestions

// First match wins, so more specific rules sit above broader ones.
const OUT_RULES = [
  [/ZOMATO|SWIGGY|EATSURE|DOMINO|PIZZA|KFC|MCDONALD|BURGER|CAFE|RESTAURANT|STARBUCKS|BAKERY/, 'Outside Food'],
  [/BBNOW|BIGBASKET|BIG BASKET|ZEPTO|BLINKIT|INSTAMART|DMART|AVENUE SUPERMARTS|ZAMA ORGANICS|GROCER|SUPERMARKET|KIRANA|MILK|VEGETABLE/, 'Groceries'],
  [/WINE|LIQUOR|BEER|BREW|SPIRITS/, 'Alcohol'],
  [/FRANKLI|MUTUAL FUND|MF UTILITIES|NIPPON|ICICIPRUMF|AXISMF|HDFCMF|SBIMF|KUVERA|GROWW|ZERODHA/, 'SIP Savings'],
  [/HPCL|BPCL|IOCL|INDIAN OIL|PETROL|FUEL|SHELL|NAYARA|FASTAG|NATIONAL HIGHWAYS|NHAI|TOLL/, 'Fuel'],
  [/ACKO|BAJAJ ALLIANZ|ICICI LOMBARD|TATA AIG|NEW INDIA ASSUR|TYRE|CAR WASH|SERVICE CENTRE|MOTORS/, 'Vehicle Maintenance'],
  [/STAR HEALTH|CARE HEALTH|NIVA BUPA|HOSPITAL|CLINIC|DENTAL|PHARM|MEDPLUS|APOLLO|1MG|NETMEDS|DIAGNOSTIC|PATHOLOGY|\bLAB\b/, 'Health'],
  [/AIRTEL|\bJIO\b|VODAFONE|BSNL|ELECTRICITY|MSEDCL|BESCOM|TATA POWER|\bGAS\b|BROADBAND|FIBER|FIBRE|\bDTH\b|WATER BILL|MAHANAGAR/, 'Utilities'],
  [/AMAZON|FLIPKART|MYNTRA|AJIO|NYKAA|MEESHO|RELIANCE BRANDS|TRENDS|LIFESTYLE|DECATHLON|IKEA|CROMA/, 'Shopping'],
  [/HDFCLIFE|HDFC LIFE|\bLIC\b|SBI LIFE|MAX LIFE|INSURANCE/, 'Miscellaneous'],
  [/IB BILLPAY|CREDIT ?CARD|CC PAYMENT|CARD PAYMENT/, CC_BILL],
];

export function suggestCategory(group) {
  const text = `${group.key} ${group.lines[0]?.narr ?? ''}`.toUpperCase();
  if (group.direction === 'in') return group.likelySalary || /SALARY|PAYROLL/.test(text) ? 'Salary' : 'Other Credits';
  for (const [pattern, category] of OUT_RULES) {
    // A card bill goes through net-banking bill-pay, not a UPI payee that merely has "card" in its name.
    if (category === CC_BILL && group.key.startsWith('UPI:')) continue;
    if (pattern.test(text)) return category;
  }
  return null;
}

// -------------------------------------------------------------- the result

// One transaction per (month, category) — monthly totals, like the historical import.
export function buildMonthlyTransactions(groups, assignments, goals = []) {
  const buckets = new Map();
  for (const g of groups) {
    const choice = assignments[g.id];
    if (!choice || choice === SKIP) continue;
    const out = g.direction === 'out';
    const category = choice === CC_BILL ? CC_CATEGORY : choice;
    const goal = out ? goals.find((x) => x.name === category) : null;
    const kind = !out
      ? 'income'
      : choice === CC_BILL
      ? 'ccPayment'
      : SAVINGS_CATEGORIES.includes(category)
      ? 'savingsContribution'
      : goal
      ? 'goalContribution'
      : 'expense';
    for (const line of g.lines) {
      const month = line.date.slice(0, 7);
      const k = [month, category, kind, goal?.id ?? ''].join('|');
      const b = buckets.get(k) || { month, category, kind, goalId: goal?.id, amount: 0, lines: 0, importKeys: [] };
      b.amount = r2(b.amount + (out ? line.wd : line.dep));
      b.lines += 1;
      b.importKeys.push(line.key);
      buckets.set(k, b);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => (a.month === b.month ? a.category.localeCompare(b.category) : a.month < b.month ? -1 : 1))
    .map((b) => ({
      date: `${b.month}-01`,
      amount: b.amount,
      category: b.category,
      kind: b.kind,
      note: `Bank statement · ${b.lines} line${b.lines === 1 ? '' : 's'}`,
      paymentMethod: 'bank',
      granularity: 'monthly-lump',
      source: 'statement',
      importKeys: b.importKeys,
      ...(b.goalId ? { goalId: b.goalId } : {}),
    }));
}

// Progress + reconciliation against the statement's own balances.
export function summarize(groups, assignments, meta) {
  let creditsImported = 0;
  let debitsImported = 0;
  let skippedLines = 0;
  let skippedAmount = 0;
  let unassignedGroups = 0;
  let unassignedAmount = 0;
  for (const g of groups) {
    const choice = assignments[g.id];
    if (!choice) { unassignedGroups++; unassignedAmount = r2(unassignedAmount + g.total); continue; }
    if (choice === SKIP) { skippedLines += g.lines.length; skippedAmount = r2(skippedAmount + g.total); continue; }
    if (g.direction === 'in') creditsImported = r2(creditsImported + g.total);
    else debitsImported = r2(debitsImported + g.total);
  }
  const allCredits = r2(groups.filter((g) => g.direction === 'in').reduce((s, g) => s + g.total, 0));
  const allDebits = r2(groups.filter((g) => g.direction === 'out').reduce((s, g) => s + g.total, 0));
  const canReconcile = meta.opening != null && meta.closing != null;
  const importedClosing = canReconcile ? r2(meta.opening + creditsImported - debitsImported) : null;
  return {
    creditsImported,
    debitsImported,
    skippedLines,
    skippedAmount,
    unassignedGroups,
    unassignedAmount,
    allCredits,
    allDebits,
    importedClosing,
    difference: canReconcile ? r2(meta.closing - importedClosing) : null,
  };
}

export function dayBefore(isoDay) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
