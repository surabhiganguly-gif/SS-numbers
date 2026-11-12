import * as assert from './assert.js';
import { parseCsv } from '../src/lib/spreadsheet.js';
import { APP_VERSION } from '../src/lib/version.js';
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
const pending = [];
function test(name, fn) {
  // Sync and async bodies both work; everything is awaited before the totals are printed.
  pending.push(
    (async () => {
      try {
        await fn();
        passed++;
        console.log(`ok - ${name}`);
      } catch (e) {
        failed++;
        console.error(`FAIL - ${name}`);
        console.error(e);
      }
    })()
  );
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

// ---- .xlsx reading (tiny synthetic workbooks; no real statement data) ----
function b64bytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
// A: written by openpyxl (shared strings, deflate, two sheets, junk rows around the table).
const XLSX_A = 'UEsDBBQAAAAIADWkbF1Gx01IlQAAAM0AAAAQAAAAZG9jUHJvcHMvYXBwLnhtbE3PTQvCMAwG4L9SdreZih6kDkQ9ip68zy51hbYpbYT67+0EP255ecgboi6JIia2mEXxLuRtMzLHDUDWI/o+y8qhiqHke64x3YGMsRoPpB8eA8OibdeAhTEMOMzit7Dp1C5GZ3XPlkJ3sjpRJsPiWDQ6sScfq9wcChDneiU+ixNLOZcrBf+LU8sVU57mym/8ZAW/B7oXUEsDBBQAAAAIADWkbF11Y6DM7gAAACsCAAARAAAAZG9jUHJvcHMvY29yZS54bWzNksFOwzAMhl8F5d66aWGHqOtlEyeQkJgE4hYl3hataaLEqN3bk4atE4IH4Bj7z+fPklvlhXIBX4LzGMhgvJtsP0Sh/JodibwAiOqIVsYyJYbU3LtgJaVnOICX6iQPCHVVrcAiSS1Jwgws/EJkXauVUAEluXDBa7Xg/WfoM0wrwB4tDhSBlxxYN0/056lv4QaYYYTBxu8C6oWYq39icwfYJTlFs6TGcSzHJufSDhzen59e87qFGSLJQWH6FY2gs8c1u05+azbb3SPr6qpeFZwXvN7xB1E14r75mF1/+N2ErdNmb/6x8VWwa+HXXXRfUEsDBBQAAAAIADWkbF2ZXJwjEAYAAJwnAAATAAAAeGwvdGhlbWUvdGhlbWUxLnhtbO1aW3PaOBR+76/QeGf2bQvGNoG2tBNzaXbbtJmE7U4fhRFYjWx5ZJGEf79HNhDLlg3tkk26mzwELOn7zkVH5+g4efPuLmLohoiU8nhg2S/b1ru3L97gVzIkEUEwGaev8MAKpUxetVppAMM4fckTEsPcgosIS3gUy9Zc4FsaLyPW6rTb3VaEaWyhGEdkYH1eLGhA0FRRWm9fILTlHzP4FctUjWWjARNXQSa5iLTy+WzF/NrePmXP6TodMoFuMBtYIH/Ob6fkTlqI4VTCxMBqZz9Wa8fR0kiAgsl9lAW6Sfaj0xUIMg07Op1YznZ89sTtn4zK2nQ0bRrg4/F4OLbL0otwHATgUbuewp30bL+kQQm0o2nQZNj22q6RpqqNU0/T933f65tonAqNW0/Ta3fd046Jxq3QeA2+8U+Hw66JxqvQdOtpJif9rmuk6RZoQkbj63oSFbXlQNMgAFhwdtbM0gOWXin6dZQa2R273UFc8FjuOYkR/sbFBNZp0hmWNEZynZAFDgA3xNFMUHyvQbaK4MKS0lyQ1s8ptVAaCJrIgfVHgiHF3K/99Ze7yaQzep19Os5rlH9pqwGn7bubz5P8c+jkn6eT101CznC8LAnx+yNbYYcnbjsTcjocZ0J8z/b2kaUlMs/v+QrrTjxnH1aWsF3Pz+SejHIju932WH32T0duI9epwLMi15RGJEWfyC265BE4tUkNMhM/CJ2GmGpQHAKkCTGWoYb4tMasEeATfbe+CMjfjYj3q2+aPVehWEnahPgQRhrinHPmc9Fs+welRtH2Vbzco5dYFQGXGN80qjUsxdZ4lcDxrZw8HRMSzZQLBkGGlyQmEqk5fk1IE/4rpdr+nNNA8JQvJPpKkY9psyOndCbN6DMawUavG3WHaNI8ev4F+Zw1ChyRGx0CZxuzRiGEabvwHq8kjpqtwhErQj5iGTYacrUWgbZxqYRgWhLG0XhO0rQR/FmsNZM+YMjszZF1ztaRDhGSXjdCPmLOi5ARvx6GOEqa7aJxWAT9nl7DScHogstm/bh+htUzbCyO90fUF0rkDyanP+kyNAejmlkJvYRWap+qhzQ+qB4yCgXxuR4+5Xp4CjeWxrxQroJ7Af/R2jfCq/iCwDl/Ln3Ppe+59D2h0rc3I31nwdOLW95GblvE+64x2tc0LihjV3LNyMdUr5Mp2DmfwOz9aD6e8e362SSEr5pZLSMWkEuBs0EkuPyLyvAqxAnoZFslCctU02U3ihKeQhtu6VP1SpXX5a+5KLg8W+Tpr6F0PizP+Txf57TNCzNDt3JL6raUvrUmOEr0scxwTh7LDDtnPJIdtnegHTX79l125COlMFOXQ7gaQr4Dbbqd3Do4npiRuQrTUpBvw/npxXga4jnZBLl9mFdt59jR0fvnwVGwo+88lh3HiPKiIe6hhpjPw0OHeXtfmGeVxlA0FG1srCQsRrdguNfxLBTgZGAtoAeDr1EC8lJVYDFbxgMrkKJ8TIxF6HDnl1xf49GS49umZbVuryl3GW0iUjnCaZgTZ6vK3mWxwVUdz1Vb8rC+aj20FU7P/lmtyJ8MEU4WCxJIY5QXpkqi8xlTvucrScRVOL9FM7YSlxi84+bHcU5TuBJ2tg8CMrm7Oal6ZTFnpvLfLQwJLFuIWRLiTV3t1eebnK56Inb6l3fBYPL9cMlHD+U751/0XUOufvbd4/pukztITJx5xREBdEUCI5UcBhYXMuRQ7pKQBhMBzZTJRPACgmSmHICY+gu98gy5KRXOrT45f0Usg4ZOXtIlEhSKsAwFIRdy4+/vk2p3jNf6LIFthFQyZNUXykOJwT0zckPYVCXzrtomC4Xb4lTNuxq+JmBLw3punS0n/9te1D20Fz1G86OZ4B6zh3OberjCRaz/WNYe+TLfOXDbOt4DXuYTLEOkfsF9ioqAEativrqvT/klnDu0e/GBIJv81tuk9t3gDHzUq1qlZCsRP0sHfB+SBmOMW/Q0X48UYq2msa3G2jEMeYBY8wyhZjjfh0WaGjPVi6w5jQpvQdVA5T/b1A1o9g00HJEFXjGZtjaj5E4KPNz+7w2wwsSO4e2LvwFQSwMEFAAAAAgANaRsXWLk83uvAgAAIwkAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWydVu9vojAY/lcaPl6iBTbULUgOEZ25gUTZdrtvFauQFepKnXf311/LJsEdveRoYuyP93ne532K8tonyl7KFGMOfuakKMdayvnhFsIySXGOyj494EKc7CjLERdLtoflgWG0rUA5gaauD2COskJz7GovYo5Nj5xkBY4YKI95jtivCSb0NNYM7byxyvYplxvQsQ9oj9eYPxwiJlawZtlmOS7KjBaA4d1Yc43b+UjGVwGPGT6VjTmQlWwofZGLxXas6VIQJjjhkgGJrzfsYUIkkZDx+sGp1SklsDk/s8+q2kUtG1Rij5KnbMvTsTbSwBbv0JHwFT3d4Y96rFrgFHHk2IyeAJN1OnYiJzK3iMsK6c+aM7GfiUTccZOEHgsO1hxxLOrmNuRCjTyEifgIoprtqma7UrCJ5PiSoIqfqOJDxBiSRrWAPBXIS1/7cIV3/ZD2W3BTFe4RkSMGU96C8VWYp4ynW4ZOiAA3523pZkov8IGWGVfh5sryiIAVezBBBBUJ/sd9XNf3ca3g+vIx2u6kA8brgJl2wPgdMLMOmPn/YS7Mt2rzLQWJbkB9BM1Bm/kqTOjPYuCteu7Em+rVMHquF/jAW4JgGcZ3988gcp9739tuR0lqtN1LB9mzd4z8z31zjEqeDd+ahn4KsBoBF+4NavcGKhmm2j0V5iFa9H4sAzde9n5/3fTayvaU+ZrDMFot66DVHzQcMa3Pfg0u/WoGXPg1rP0aqjRYUL9R+KXCrBfgbu4GkW42Bpit3PDb/QKEsR9E9368DIFuAf2mzU0ls9nmXwft/rDh0ND664FrHt+YQ5V/o7N/k5FKceyKev0wBuuHIHBXz22/fdh4xcr2IUBsnxUlIHgnSPX+UDz/7P2V/L7g9FC1HxvKOc2raSq6GMxkgDjfUcrPC9kR1H2R8wdQSwMEFAAAAAgANaRsXf1L/1BBAQAAGgIAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0Mi54bWxNUtFOwzAM/JUoH7B0SAM0tZXGEIIHpGkT8Jy1bhstiUviUfh7nG6t9lDFZzvnO6f5gOEUOwASv876WMiOqF8rFasOnI4L7MFzpcHgNDEMrYp9AF2Pl5xVd1l2r5w2Xpb5mNuFMsczWeNhF0Q8O6fD3xNYHAq5lFNib9qOUkKVea9bOAB99LvASM0stXHgo0EvAjSF3CzXm7F/bPg0MMSbWCQnR8RTAm91IbMkCCxUlBg0Hz+wBWsTEcv4vnLKeWS6eBtP7C+jd/Zy1BG2aL9MTV0hH6WoodFnS3scXuHqZzULfNakyzzgIELyWeZVCtJs7jM+7edAgfOGB1HpkQR1ICJpAvZNuSJWk4qq4o+JJnEX5rS1dx1a46Ow0DBptnhYSREuSi6AsB+3fkQidGPY8eNBSA1cbxBpAmkR8+9Q/gNQSwMEFAAAAAgANaRsXXzzo9xRAgAA9gkAAA0AAAB4bC9zdHlsZXMueG1s3VbbitswEP0V4Q+ok5g1cUnyUENgoS0Luw99VWI5EejiyvKS9Os7Izl2s6tZKH2rTfDMHJ25G2fT+6sSz2chPLtoZfptdva++5zn/fEsNO8/2U4YQFrrNPegulPed07wpkeSVvlqsShzzaXJdhsz6L32PTvawfhttsjy3aa1ZrYss2iAo1wL9srVNqu5kgcnw1mupbpG8woNR6usYx5SEUgGS/8rwsuoYZajHy2NdWjMY4Tw6MGpVGpKYJVFw27Tce+FM3tQAicY30FslF+uHWRwcvy6XD1kMyE8IMjBuka4uzqjabdRovVAcPJ0xqe3XY6g91aD0Eh+soaHHG6MUQC3R6HUM47oR3vn+9Ky2OvHBtvMsNSbCAmNYnQTFfT/p7fo+5/dsk6+Wv9lgGpM0H8O1osnJ1p5CfqlvY8/hQ6J3EWfrAyXY5t9x51Tswt2GKTy0ozaWTaNMO9qA/eeH2Cp7/zD+Ua0fFD+ZQK32Sx/E40cdDWdesKyxlOz/BVnuCynzYRY0jTiIpp6VN3pEEQGAkQdLyS8RfbhSiMUJ2JpBDEqDpUBxYksKs7/VM+arCdiVG7rJLImOWuSE1kppA43FSfNqeBKV1pVRVGWVEfrOplBTfWtLPGX9kblhgwqDkb6u17T06Y35OM9oGb60YZQldKbSFVK9xqRdN+QUVXpaVNxkEFNgdodjJ+OgzuV5hQFTpXKjXqDaaSqKAR3Mb2jZUl0p8Q7PR/qLSmKqkojiKUzKAoKwbeRRqgMMAcKKYrwHXzzPcpv36l8/qe3+w1QSwMEFAAAAAgANaRsXZeKuxzAAAAAEwIAAAsAAABfcmVscy8ucmVsc52SuW7DMAxAf8XQnjAH0CGIM2XxFgT5AVaiD9gSBYpFnb+v2qVxkAsZeT08EtweaUDtOKS2i6kY/RBSaVrVuAFItiWPac6RQq7ULB41h9JARNtjQ7BaLD5ALhlmt71kFqdzpFeIXNedpT3bL09Bb4CvOkxxQmlISzMO8M3SfzL38ww1ReVKI5VbGnjT5f524EnRoSJYFppFydOiHaV/Hcf2kNPpr2MitHpb6PlxaFQKjtxjJYxxYrT+NYLJD+x+AFBLAwQUAAAACAA1pGxdFQYdIkYBAACxAgAADwAAAHhsL3dvcmtib29rLnhtbLVSXUvDQBD8K+F+gEmDFixNXyxqQWqx0vdLsmmW3ke427TaX+/ehWBAEF98utvZZW5m9pYX606ltafkQyvjC9ESdYs09VULWvob24HhTmOdlsSlO6a+cyBr3wKQVmmeZfNUSzRitRy5di6dFpagIrSGwQAcEC7+ux/K5IweS1RIn4WIdwUi0WhQ4xXqQmQi8a29PFuHV2tIqn3lrFKFmA2NAzjC6ge8DyLfZekjQrJ8kyykEPOMCRt0nuJE5Jes8Qw8PFQ92UdUBG4tCZ6c7Ts0x0DDLtKJjZjDeA4hLtxfYrRNgxWsbdVrMDTk6EAFgca32HmRGKmhEHtiBWEmeOJHNvXgL8CTtNwCueE2dZT4f3K2vE4/kZL/IiWPaY0R1dCggXrLNJ5xXle1c0k4oqX89m52z2vplXpg7NW8WFmPiY+/ZfUFUEsDBBQAAAAIADWkbF2N9yxatAAAAIkCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHPFkk0KgzAQRq8ScoCO2tJFUVfduC1eIOj4g9GEzJTq7Wt1oYEuupGuwjch73swiR+oFbdmoKa1JMZeD5TIhtneAKhosFd0MhaH+aYyrlc8R1eDVUWnaoQoCK7g9gyZxnumyCeLvxBNVbUF3k3x7HHgL2B4GddRg8hS5MrVyImEUW9jguUITzNZiqxMpMvKUMK/hSJPKDpQiHjSSJvNmr3684H1PL/FrX2J69DfyeXjAN7PS99QSwMEFAAAAAgANaRsXW6nJLweAQAAVwQAABMAAABbQ29udGVudF9UeXBlc10ueG1sxZTPTsMwDMZfpcp1ajJ24IDWXYAr7MALhNZdo+afYm90b4/bbpNAo2IqEpdGje3v5/iLsn47RsCsc9ZjIRqi+KAUlg04jTJE8BypQ3Ka+DftVNRlq3egVsvlvSqDJ/CUU68hNusnqPXeUvbc8Taa4AuRwKLIHsfEnlUIHaM1pSaOq4OvvlHyE0Fy5ZCDjYm44AShrhL6yM+AU93rAVIyFWRbnehFO85SnVVIRwsopyWu9Bjq2pRQhXLvuERiTKArbADIWTmKLqbJxBOG8Xs3mz/ITAE5c5tCRHYswe24syV9dR5ZCBKZ6SNeiCw9+3zQu11B9Us2j/cjpHbwA9WwzJ/xV48v+jf2sfrHPt5DaP/6qverdNr4M18N78nmE1BLAQIUABQAAAAIADWkbF1Gx01IlQAAAM0AAAAQAAAAAAAAAAAAAACAAQAAAABkb2NQcm9wcy9hcHAueG1sUEsBAhQAFAAAAAgANaRsXXVjoMzuAAAAKwIAABEAAAAAAAAAAAAAAIABwwAAAGRvY1Byb3BzL2NvcmUueG1sUEsBAhQAFAAAAAgANaRsXZlcnCMQBgAAnCcAABMAAAAAAAAAAAAAAIAB4AEAAHhsL3RoZW1lL3RoZW1lMS54bWxQSwECFAAUAAAACAA1pGxdYuTze68CAAAjCQAAGAAAAAAAAAAAAAAAtoEhCAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsBAhQAFAAAAAgANaRsXf1L/1BBAQAAGgIAABgAAAAAAAAAAAAAALaBBgsAAHhsL3dvcmtzaGVldHMvc2hlZXQyLnhtbFBLAQIUABQAAAAIADWkbF1886PcUQIAAPYJAAANAAAAAAAAAAAAAACAAX0MAAB4bC9zdHlsZXMueG1sUEsBAhQAFAAAAAgANaRsXZeKuxzAAAAAEwIAAAsAAAAAAAAAAAAAAIAB+Q4AAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgANaRsXRUGHSJGAQAAsQIAAA8AAAAAAAAAAAAAAIAB4g8AAHhsL3dvcmtib29rLnhtbFBLAQIUABQAAAAIADWkbF2N9yxatAAAAIkCAAAaAAAAAAAAAAAAAACAAVURAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUABQAAAAIADWkbF1upyS8HgEAAFcEAAATAAAAAAAAAAAAAACAAUESAABbQ29udGVudF9UeXBlc10ueG1sUEsFBgAAAAAKAAoAhAIAAJATAAAAAA==';
// B: hand-built (inline strings, dates as Excel serial numbers, numeric references, a stored entry).
const XLSX_B = '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';

const { readSpreadsheet } = await import('../src/lib/spreadsheet.js');

async function xlsxRows(b64) {
  return readSpreadsheet(new File([b64bytes(b64)], 'statement.xlsx'));
}

test('xlsx: a normal workbook reads, uses the first sheet, and parses into statement lines', async () => {
  const rows = await xlsxRows(XLSX_A);
  const parsed = parseStatementRows(rows);
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.lines[0].date, '2026-08-01');
  assert.equal(parsed.lines[0].dep, 100000);
  assert.equal(parsed.lines[1].wd, 250);
  assert.equal(parsed.meta.opening, 500);
  assert.equal(parsed.meta.closing, 92750);
});

test('xlsx: inline strings, serial-number dates, numeric references and a stored entry', async () => {
  const rows = await xlsxRows(XLSX_B);
  const parsed = parseStatementRows(rows);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].date, '2026-08-01');
  assert.equal(parsed.lines[0].wd, 100);
  assert.equal(parsed.lines[1].dep, 500);
  assert.equal(parsed.meta.opening, 1000);
  assert.equal(parsed.meta.closing, 1400);
});

test('xlsx: a damaged file gives a readable error, not a crash', async () => {
  const bytes = b64bytes(XLSX_A).slice(0, 200);
  let message = '';
  try { await readSpreadsheet(new File([bytes], 'bad.xlsx')); } catch (e) { message = e.message; }
  assert.ok(message.length > 0);
});

test('the same line gets the same key whether its reference is text with zeros or a number', () => {
  const head = ['Date', 'Narration', 'Chq./Ref.No.', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'];
  const a = parseStatementRows([head, ['01/08/26', 'X', '0000000000000111', 5, '', 95]]);
  const b = parseStatementRows([head, ['01/08/26', 'X', 111, 5, '', 95]]);
  assert.equal(a.lines[0].key, b.lines[0].key);
});

// The label in Settings is only useful if it can't drift from what's actually deployed.
const swSource = await (await fetch(new URL('../sw.js', import.meta.url))).text();
test('the app version shown in Settings matches the service worker cache version', () => {
  assert.equal(swSource.match(/finance-tracker-(v\d+)/)[1], APP_VERSION);
});
test('the service worker revalidates instead of trusting the 10-minute HTTP cache', () => {
  assert.ok(/cache:\s*'no-cache'/.test(swSource));
});

await Promise.all(pending);
console.log(`\nstatement: ${passed} passed, ${failed} failed`);
window.__statementTestResults = { passed, failed };
