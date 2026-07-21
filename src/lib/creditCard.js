// CC Outstanding is a derived running balance, not a stored entity — Section 3.3.
export function computeCCOutstanding(transactions) {
  return transactions
    .filter((t) => t.kind === 'ccPurchase' || t.kind === 'ccOnboarding')
    .reduce((sum, t) => sum + t.amount, 0)
    - transactions.filter((t) => t.kind === 'ccPayment').reduce((sum, t) => sum + t.amount, 0);
}
