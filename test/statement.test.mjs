import * as assert from './assert.js';
import { parseCsv } from '../src/lib/spreadsheet.js';
import {
  parseDate,
  parseStatementRows,
  payeeInfo,
  groupLines,
  suggestCategory,
  buildMonthlyTransactions,
  summarize,
  dayBefore,
  SKIP,
  CC_BILL,
} from '../src/lib/statement.js';

// Synthetic data only — never real statement contents.
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

const HEADER = ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'];
const row = (date, narr, ref, wd, dep, bal) => [date, narr, ref, date, wd, dep, bal];
const SAMPLE = [
  ['Account Statement', '', '', '', '', '', ''],
  ['', '', '', '', '', '', ''],
  HEADER,
  ['********', '********', '********', '********', '********', '********', '********'],
  row('01/08/26', 'NEFT CR-ABCD0000001-ACME CO MONTHLY PAY-X', 'N1', '', 100000, 100500),
  row('02/08/26', 'UPI-ZOMATO-ZOMATO@icici-111', 'U1', 250, '', 100250),
  row('02/08/26', 'UPI-ZOMATO-ZOMATO@icici-222', 'U2', 250, '', 100000),
  row('05/08/26', 'SI HGAMP0111111111111 FRANKLI NTEMPLETON 05 08', 'S1', 7500, '', 92500),
  row('05/09/26', 'SI HGAMP0222222222222 FRANKLI NTEMPLETON 05 09', 'S2', 7500, '', 85000),
  ['', 'STATEMENT SUMMARY', '', '', '', '', ''],
];

test('parseDate understands the common bank date shapes', () => {
  assert.equal(parseDate('01/08/26'), '2026-08-01');
  assert.equal(parseDate('1-8-2026'), '2026-08-01');
  assert.equal(parseDate('2026-08-01 00:00'), '2026-08-01');
  assert.equal(parseDate('01 Aug 2026'), '2026-08-01');
  assert.equal(parseDate(46235), '2026-08-01'); // Excel serial
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate('31/13/26'), null);
});

test('parseStatementRows skips preamble/separator/footer rows and derives balances', () => {
  const { lines, meta } = parseStatementRows(SAMPLE);
  assert.equal(lines.length, 5);
  assert.equal(meta.from, '2026-08-01');
  assert.equal(meta.to, '2026-09-05');
  assert.equal(meta.opening, 500); // 100500 balance after a 100000 credit
  assert.equal(meta.closing, 85000);
});

test('parseStatementRows reads a newest-first statement in date order', () => {
  const reversed = [HEADER, ...SAMPLE.slice(4, 9).reverse()];
  const { lines, meta } = parseStatementRows(reversed);
  assert.equal(lines[0].date, '2026-08-01');
  assert.equal(meta.opening, 500);
  assert.equal(meta.closing, 85000);
});

test('identical same-day lines get distinct import keys (so none are lost to de-duplication)', () => {
  const dup = [HEADER, row('02/08/26', 'UPI-SHOP-s@b-1', '', 100, '', 900), row('02/08/26', 'UPI-SHOP-s@b-1', '', 100, '', 800)];
  const { lines } = parseStatementRows(dup);
  assert.equal(new Set(lines.map((l) => l.key)).size, 2);
});

test('parseStatementRows explains itself when the table is missing', () => {
  let message = '';
  try { parseStatementRows([['hello', 'world']]); } catch (e) { message = e.message; }
  assert.ok(/Couldn't find the transaction table/.test(message));
});

test('payeeInfo groups the same payee across months despite changing mandate ids and date fragments', () => {
  const a = payeeInfo('SI HGAMP0111111111111 FRANKLI NTEMPLETON 05 08');
  const b = payeeInfo('SI HGAMP0222222222222 FRANKLI NTEMPLETON 05 09');
  assert.equal(a.key, b.key);
});

test('payeeInfo uses the handle when the UPI payee name is masked, and strips company suffixes', () => {
  assert.equal(payeeInfo('UPI-XXXXXXX1234-MERCH0000001-621').key, 'UPI:MERCH0000001');
  assert.equal(payeeInfo('UPI-ZOMATO LTD-z@icici-1').key, payeeInfo('UPI-ZOMATO-z@icici-2').key);
});

test('payeeInfo pools every ATM withdrawal and keeps the IFSC on NEFT lines', () => {
  assert.equal(payeeInfo('ATW 512967XXXXXX1027 CHPUN006').key, payeeInfo('ATW 223487XXXXXX1647 S1ANPU18').key);
  assert.ok(payeeInfo('NEFT DR-ABCD0000123-SOMEONE-N123').key.includes('ABCD0000123'));
});

test('groupLines splits money-in from money-out for the same person and flags fixed monthly amounts', () => {
  const lines = [
    { date: '2026-08-05', narr: 'UPI-A B-a@b-1', wd: 0, dep: 500, key: 'k1' },
    { date: '2026-08-06', narr: 'UPI-A B-a@b-2', wd: 200, dep: 0, key: 'k2' },
    ...['2026-08', '2026-09', '2026-10'].map((m, i) => ({ date: `${m}-10`, narr: 'ACH D BOB LOAN-1', wd: 19368, dep: 0, key: `e${i}` })),
  ];
  const groups = groupLines(lines);
  assert.equal(groups.filter((g) => g.key === 'UPI:A B').length, 2);
  assert.equal(groups.find((g) => g.key.startsWith('ACH D BOB')).sameAmount, 19368);
});

test('suggestCategory: obvious payees get a category, unknown ones are left for the user', () => {
  const suggest = (narr, dir = 'out') => {
    const { lines } = { lines: [{ narr, wd: dir === 'out' ? 1 : 0, dep: dir === 'in' ? 1 : 0, date: '2026-08-01', key: 'k' }] };
    return suggestCategory(groupLines(lines)[0]);
  };
  assert.equal(suggest('UPI-ZOMATO-z@icici-1'), 'Outside Food');
  assert.equal(suggest('SI HGAMP0123456789012 FRANKLI NTEMPLETON'), 'SIP Savings');
  assert.equal(suggest('IB BILLPAY DR-HDFCSI-400000XXXXXX0000'), CC_BILL);
  assert.equal(suggest('UPI-AUTOPAY-x@b-1'), null); // a UPI payee called "autopay" is not a card bill
  assert.equal(suggest('UPI-SOME PERSON-p@b-1'), null);
  assert.equal(suggest('NEFT CR-ABCD0000001-ACME PAYROLL CO', 'in'), 'Salary');
  assert.equal(suggest('UPI-FRIEND-f@b-1', 'in'), 'Other Credits');
});

test('salary is detected as the biggest credit that recurs across months — no employer names needed', () => {
  const credit = (date, narr, dep) => ({ date, narr, wd: 0, dep, key: `${date}${narr}` });
  const lines = [
    credit('2026-08-01', 'NEFT CR-ABCD0000001-ACME CO MONTHLY PAY-A', 200000),
    credit('2026-09-01', 'NEFT CR-ABCD0000001-ACME CO MONTHLY PAY-B', 200000),
    credit('2026-10-01', 'NEFT CR-ABCD0000001-ACME CO MONTHLY PAY-C', 200000),
    credit('2026-09-15', 'NEFT CR-WXYZ0000009-ONE OFF REDEMPTION-D', 300000), // bigger, but only once
    credit('2026-08-05', 'UPI-FAMILY-f@b-1', 5000),
    credit('2026-09-05', 'UPI-FAMILY-f@b-2', 5000),
  ];
  const suggestions = Object.fromEntries(groupLines(lines).map((g) => [g.label, suggestCategory(g)]));
  assert.equal(suggestions['Neft Cr Abcd0000001 Acme'], 'Salary');
  assert.equal(suggestions['Neft Cr Wxyz0000009 One'], 'Other Credits');
  assert.equal(suggestions['Family (UPI)'], 'Other Credits'); // recurs, but smaller than the salary
});

function sampleGroups() {
  const { lines, meta } = parseStatementRows(SAMPLE);
  return { groups: groupLines(lines), meta, lines };
}
const idOf = (groups, startsWith) => groups.find((g) => g.key.startsWith(startsWith)).id;

test('buildMonthlyTransactions makes one total per month+category with the right kinds', () => {
  const { groups } = sampleGroups();
  const assign = {
    [idOf(groups, 'NEFT CR')]: 'Salary',
    [idOf(groups, 'UPI:ZOMATO')]: 'Outside Food',
    [idOf(groups, 'SI')]: 'SIP Savings',
  };
  const txs = buildMonthlyTransactions(groups, assign, []);
  const find = (cat, month) => txs.find((t) => t.category === cat && t.date === `${month}-01`);
  assert.equal(find('Outside Food', '2026-08').amount, 500); // two ₹250 lines
  assert.equal(find('Outside Food', '2026-08').kind, 'expense');
  assert.equal(find('SIP Savings', '2026-08').kind, 'savingsContribution');
  assert.equal(find('SIP Savings', '2026-09').amount, 7500);
  assert.equal(find('Salary', '2026-08').kind, 'income');
  assert.ok(txs.every((t) => t.paymentMethod === 'bank' && t.granularity === 'monthly-lump' && t.source === 'statement'));
  assert.equal(txs.reduce((n, t) => n + t.importKeys.length, 0), 5); // every line accounted for exactly once
});

test('credit card bills, goals and skipped payees are handled specially', () => {
  const lines = [
    { date: '2026-08-11', narr: 'IB BILLPAY DR-HDFCSI-1', wd: 13504, dep: 0, key: 'a' },
    { date: '2026-08-12', narr: 'UPI-BIKE SHOP-b@b-1', wd: 6000, dep: 0, key: 'b' },
    { date: '2026-08-13', narr: 'UPI-INTERNAL-i@b-1', wd: 999, dep: 0, key: 'c' },
  ];
  const groups = groupLines(lines);
  const assign = { [groups[0].id]: CC_BILL, [groups[1].id]: SKIP, [groups[2].id]: SKIP };
  const goalAssign = { ...assign, [groups.find((g) => g.key === 'UPI:BIKE SHOP').id]: 'Bike Fund' };
  const cc = buildMonthlyTransactions(groups, assign, []);
  assert.equal(cc.length, 1);
  assert.equal(cc[0].kind, 'ccPayment');
  assert.equal(cc[0].category, 'Credit Card Payment Due');
  const goal = buildMonthlyTransactions(groups, goalAssign, [{ id: 'g1', name: 'Bike Fund' }]).find((t) => t.category === 'Bike Fund');
  assert.equal(goal.kind, 'goalContribution');
  assert.equal(goal.goalId, 'g1');
});

test('summarize reconciles to the statement exactly when nothing is skipped', () => {
  const { groups, meta } = sampleGroups();
  const assign = Object.fromEntries(groups.map((g) => [g.id, g.direction === 'in' ? 'Salary' : 'Miscellaneous']));
  const s = summarize(groups, assign, meta);
  assert.equal(s.unassignedGroups, 0);
  assert.equal(s.importedClosing, meta.closing);
  assert.equal(s.difference, 0);
});

test('summarize attributes any difference to skipped lines and tracks uncategorised payees', () => {
  const { groups, meta } = sampleGroups();
  const zomato = idOf(groups, 'UPI:ZOMATO');
  const assign = Object.fromEntries(groups.filter((g) => g.id !== zomato).map((g) => [g.id, g.direction === 'in' ? 'Salary' : 'Miscellaneous']));
  const before = summarize(groups, assign, meta);
  assert.equal(before.unassignedGroups, 1);
  assign[zomato] = SKIP;
  const s = summarize(groups, assign, meta);
  assert.equal(s.skippedLines, 2);
  // Skipping a ₹500 payment means the import would show ₹500 more money than the bank
  // really has, so statement-minus-import is negative.
  assert.equal(s.difference, -500);
});

test('dayBefore handles month and year boundaries', () => {
  assert.equal(dayBefore('2026-08-01'), '2026-07-31');
  assert.equal(dayBefore('2026-01-01'), '2025-12-31');
});

test('parseCsv copes with quotes, embedded commas, tabs and a byte-order mark', () => {
  assert.equal(JSON.stringify(parseCsv('﻿a,"b, c",d\n1,2,3')), JSON.stringify([['a', 'b, c', 'd'], ['1', '2', '3']]));
  assert.equal(JSON.stringify(parseCsv('a\tb\n1\t2')), JSON.stringify([['a', 'b'], ['1', '2']]));
  assert.equal(JSON.stringify(parseCsv('x,"say ""hi"""')), JSON.stringify([['x', 'say "hi"']]));
});

console.log(`\nstatement: ${passed} passed, ${failed} failed`);
window.__statementTestResults = { passed, failed };
