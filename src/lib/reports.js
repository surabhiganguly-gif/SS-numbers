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

export function totalSavings(transactions, atMonthKey) {
  return monthTransactions(transactions, atMonthKey)
    .filter((t) => t.kind === 'savingsContribution' || t.kind === 'goalContribution')
    .reduce((sum, t) => sum + t.amount, 0);
}

export function monthGranularity(transactions, atMonthKey) {
  const inMonth = monthTransactions(transactions, atMonthKey);
  return inMonth.some((t) => t.granularity === 'monthly-lump') ? 'monthly-lump' : 'daily';
}

export function allMonthKeys(transactions) {
  return [...new Set(transactions.map((t) => monthKey(t.date)))].sort();
}

export function spendByCategory(transactions, atMonthKey) {
  const byCategory = {};
  for (const t of monthTransactions(transactions, atMonthKey)) {
    if (!SPEND_KINDS.includes(t.kind)) continue;
    byCategory[t.category] = (byCategory[t.category] || 0) + effectiveSpendAmount(t);
  }
  return Object.entries(byCategory)
    .map(([category, value]) => ({ label: category, value }))
    .filter((it) => it.value > 0)
    .sort((a, b) => b.value - a.value);
}
