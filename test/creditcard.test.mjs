import * as assert from './assert.js';
import {
  computeCCOutstanding,
  outstandingItems,
  billPaymentsTotal,
  canConvertToLoan,
  loanSummary,
  validateLoan,
} from '../src/lib/creditCard.js';
import { computeCCPaymentDue } from '../src/lib/budgeting.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(e);
  }
}

const due = (id, amount, extra = {}) => ({ id, date: '2026-10-05', amount, kind: 'ccOnboarding', category: 'Credit Card Payment Due', ...extra });
const pay = (id, amount, extra = {}) => ({ id, date: '2026-11-01', amount, kind: 'ccPayment', ...extra });

test('outstanding is the sum of hand-entered items plus card purchases minus bill payments', () => {
  const txs = [due('a', 5000), due('b', 2500), { id: 'p', date: '2026-11-02', amount: 700, kind: 'ccPurchase', ccPlanType: 'lumpsum' }, pay('x', 1200)];
  assert.equal(computeCCOutstanding(txs), 7000);
  assert.equal(billPaymentsTotal(txs), 1200);
  assert.equal(outstandingItems(txs).length, 3);
});

test('cleared items and payments stop counting, new ones start from zero', () => {
  const txs = [due('a', 5000, { ccCleared: true }), pay('x', 1200, { ccCleared: true })];
  assert.equal(computeCCOutstanding(txs), 0);
  assert.equal(outstandingItems(txs).length, 0);
  assert.equal(computeCCOutstanding([...txs, due('c', 900)]), 900);
});

test('a cleared lumpsum purchase no longer feeds next month\'s Credit Card Payment Due', () => {
  const purchase = { date: '2026-10-10', amount: 4000, kind: 'ccPurchase', ccPlanType: 'lumpsum' };
  const args = { ccInstallmentPlans: [], atMonthKey: '2026-11' };
  assert.equal(computeCCPaymentDue({ ...args, transactions: [purchase] }), 4000);
  assert.equal(computeCCPaymentDue({ ...args, transactions: [{ ...purchase, ccCleared: true }] }), 0);
});

test('a loan converted from a due does not also count as a lumpsum, only its EMI is due', () => {
  const purchase = { date: '2026-10-10', amount: 12000, kind: 'ccPurchase', ccPlanType: 'loan', ccPlanId: 'p1' };
  const plan = { id: 'p1', monthlyAmount: 1100, tenureMonths: 12, startMonth: '2026-11' };
  assert.equal(computeCCPaymentDue({ transactions: [purchase], ccInstallmentPlans: [plan], atMonthKey: '2026-11' }), 1100);
});

test('only plain one-time charges can be turned into a loan', () => {
  assert.ok(canConvertToLoan(due('a', 100)));
  assert.ok(canConvertToLoan({ kind: 'ccPurchase', ccPlanType: 'lumpsum' }));
  assert.ok(canConvertToLoan({ kind: 'ccPurchase', ccPlanType: 'loan' })); // editable
  assert.ok(!canConvertToLoan({ kind: 'ccPurchase', ccPlanType: 'installment' }));
  assert.ok(!canConvertToLoan(due('a', 100, { ccCleared: true })));
});

test('loan summary uses the typed EMI, tenure and fee — no interest maths', () => {
  const s = loanSummary({ principal: 12000, fee: 500, emi: 1100, tenureMonths: 12 });
  assert.equal(s.totalEmis, 13200);
  assert.equal(s.totalPayable, 13700);
  assert.equal(s.extraOverPrincipal, 1700);
});

test('loan validation catches missing or nonsensical terms', () => {
  const ok = { fee: 0, emi: 1000, tenureMonths: 6, startMonth: '2026-12' };
  assert.equal(validateLoan(ok), null);
  assert.ok(validateLoan({ ...ok, emi: 0 }));
  assert.ok(validateLoan({ ...ok, emi: NaN }));
  assert.ok(validateLoan({ ...ok, tenureMonths: 0 }));
  assert.ok(validateLoan({ ...ok, tenureMonths: 2.5 }));
  assert.ok(validateLoan({ ...ok, fee: -1 }));
  assert.ok(validateLoan({ ...ok, startMonth: '' }));
});

console.log(`\ncreditcard: ${passed} passed, ${failed} failed`);
window.__creditCardTestResults = { passed, failed };
