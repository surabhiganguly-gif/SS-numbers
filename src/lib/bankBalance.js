import { addMonths } from './format.js';
import { effectiveSpendAmount } from './reports.js';

export function computeBankBalance(transactions, reconciliations) {
  const txTotal = transactions
    .filter((t) => t.paymentMethod === 'bank')
    .reduce((sum, t) => sum + (t.kind === 'income' ? t.amount : -effectiveSpendAmount(t)), 0);
  const adjustmentTotal = reconciliations
    .filter((r) => r.resolution === 'adjustment')
    .reduce((sum, r) => sum + r.adjustmentAmount, 0);
  return txTotal + adjustmentTotal;
}

// Balance as of the start of a given month — everything dated before the 1st counts.
export function openingBalance(transactions, reconciliations, monthKey) {
  const cutoff = `${monthKey}-01`;
  return computeBankBalance(
    transactions.filter((t) => t.date < cutoff),
    reconciliations.filter((r) => r.date < cutoff)
  );
}

// Balance as of the end of a given month — everything dated before next month's
// 1st counts. For the current, still-in-progress month this is just "as of now".
export function closingBalance(transactions, reconciliations, monthKey) {
  const cutoff = `${addMonths(monthKey, 1)}-01`;
  return computeBankBalance(
    transactions.filter((t) => t.date < cutoff),
    reconciliations.filter((r) => r.date < cutoff)
  );
}
