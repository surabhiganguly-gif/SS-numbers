import { monthKey } from './format.js';

// A staff payment that applies against a prior advance isn't new spend for the
// applied portion — that spend was already counted when the advance was logged.
export function effectiveSpendAmount(t) {
  if (t.kind === 'staffPayment') return t.amount - (t.appliedAdvanceAmount || 0);
  return t.amount;
}

export function monthTransactions(transactions, atMonthKey) {
  return transactions.filter((t) => monthKey(t.date) === atMonthKey);
}

const SPEND_KINDS = ['expense', 'ccPurchase', 'staffAdvance', 'staffPayment'];

export function categorySpend(transactions, category, atMonthKey) {
  return monthTransactions(transactions, atMonthKey)
    .filter((t) => t.category === category && SPEND_KINDS.includes(t.kind))
    .reduce((sum, t) => sum + effectiveSpendAmount(t), 0);
}

export function totalIncome(transactions, atMonthKey) {
  return monthTransactions(transactions, atMonthKey)
    .filter((t) => t.kind === 'income')
    .reduce((sum, t) => sum + t.amount, 0);
}

export function totalSpend(transactions, atMonthKey) {
  return monthTransactions(transactions, atMonthKey)
    .filter((t) => SPEND_KINDS.includes(t.kind))
    .reduce((sum, t) => sum + effectiveSpendAmount(t), 0);
}
