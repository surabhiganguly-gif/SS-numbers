// CC Outstanding is a derived running balance, not a stored entity — Section 3.3.
//
// Anything flagged `ccCleared` was wiped by "Clear outstanding & start again": it stays in
// history (spending reports, bank balance) but no longer counts toward what's owed.
const isLive = (t) => !t.ccCleared;

export function computeCCOutstanding(transactions) {
  return (
    transactions
      .filter((t) => isLive(t) && (t.kind === 'ccPurchase' || t.kind === 'ccOnboarding'))
      .reduce((sum, t) => sum + t.amount, 0) -
    transactions.filter((t) => isLive(t) && t.kind === 'ccPayment').reduce((sum, t) => sum + t.amount, 0)
  );
}

// The individual charges that make up the balance: dues entered by hand plus card purchases.
export function outstandingItems(transactions) {
  return transactions
    .filter((t) => isLive(t) && (t.kind === 'ccPurchase' || t.kind === 'ccOnboarding'))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function billPaymentsTotal(transactions) {
  return transactions.filter((t) => isLive(t) && t.kind === 'ccPayment').reduce((sum, t) => sum + t.amount, 0);
}

// Only a plain one-time charge can be turned into a loan; purchases that were logged as
// installments already have their own plan.
export function canConvertToLoan(t) {
  return (t.kind === 'ccOnboarding' || (t.kind === 'ccPurchase' && t.ccPlanType !== 'installment')) && isLive(t);
}

// The loan terms are typed in by hand — no interest is calculated. This just shows what the
// numbers add up to so a typo (EMI of 1,000 instead of 10,000) is easy to spot.
export function loanSummary({ principal, fee, emi, tenureMonths }) {
  const totalEmis = emi * tenureMonths;
  return {
    totalEmis,
    totalPayable: totalEmis + fee,
    extraOverPrincipal: totalEmis + fee - principal,
  };
}

export function validateLoan({ fee, emi, tenureMonths, startMonth }) {
  if (!Number.isFinite(emi) || emi <= 0) return 'Enter the EMI amount.';
  if (!Number.isInteger(tenureMonths) || tenureMonths < 1) return 'Enter the loan duration in whole months.';
  if (!Number.isFinite(fee) || fee < 0) return 'The one-time fee can be 0 or more.';
  if (!/^\d{4}-\d{2}$/.test(startMonth || '')) return 'Pick the month of the first EMI.';
  return null;
}
