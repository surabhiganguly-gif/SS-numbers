const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function formatCurrency(amount) {
  return currencyFormatter.format(amount || 0);
}

// Compact Indian-style figure for chart labels where the full currency string
// (e.g. "₹2,26,997") would overflow a thin bar — "₹2.27L", "₹45K", "₹340".
export function formatCompactINR(amount) {
  const abs = Math.abs(amount || 0);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

export function monthKey(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

export function monthsBetween(fromMonthKey, toMonthKey) {
  const [fy, fm] = fromMonthKey.split('-').map(Number);
  const [ty, tm] = toMonthKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function addMonths(monthKeyStr, count) {
  const [y, m] = monthKeyStr.split('-').map(Number);
  const total = (m - 1) + count;
  const newY = y + Math.floor(total / 12);
  const newM = ((total % 12) + 12) % 12 + 1;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function trailingMonthKeys(monthKeyStr, count) {
  const keys = [];
  for (let i = count; i >= 1; i--) {
    keys.push(addMonths(monthKeyStr, -i));
  }
  return keys;
}

// Given a list of {amount, effectiveFrom (monthKey)} versions, sorted or not,
// return the amount effective as of the given monthKey (the latest version
// whose effectiveFrom <= monthKey; falls back to the earliest version if none qualify).
export function effectiveValue(versions, atMonthKey) {
  if (!versions || versions.length === 0) return 0;
  const sorted = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  let chosen = sorted[0];
  for (const v of sorted) {
    if (v.effectiveFrom <= atMonthKey) chosen = v;
    else break;
  }
  return chosen.amount;
}
