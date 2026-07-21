export function computeBankBalance(transactions, reconciliations) {
  const txTotal = transactions
    .filter((t) => t.paymentMethod === 'bank')
    .reduce((sum, t) => sum + (t.kind === 'income' ? t.amount : -t.amount), 0);
  const adjustmentTotal = reconciliations
    .filter((r) => r.resolution === 'adjustment')
    .reduce((sum, r) => sum + r.adjustmentAmount, 0);
  return txTotal + adjustmentTotal;
}
