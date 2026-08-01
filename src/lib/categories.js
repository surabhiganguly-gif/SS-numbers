// Category taxonomy — Section 3.2 of the requirements doc.
export const CATEGORY_GROUPS = {
  income: {
    label: 'Income',
    categories: ['Salary', 'Other Credits'],
  },
  fixed: {
    label: 'Fixed Monthly Commitments',
    categories: [
      'Rent',
      'Utilities',
      'Vehicle EMI (Virtus)',
      'Vehicle EMI (Jimny)',
      'Hobbies',
      'Staff/Ironing',
      'Land',
    ],
  },
  variable: {
    label: 'Variable/Discretionary Expenses',
    categories: [
      'Groceries',
      'Fuel',
      'Health',
      'Outside Food',
      'Alcohol',
      'Shopping',
      'Travel',
      'Untracked Cash Withdrawals',
      'Miscellaneous',
      'Vehicle Maintenance',
    ],
  },
  savings: {
    label: 'Savings & Investments',
    categories: ['SIP Savings', 'Liquid Savings'],
  },
  goal: {
    label: 'Goal-Based Savings',
    categories: [], // populated dynamically from user-defined goals
  },
  ccPaymentDue: {
    label: 'Credit Card Payment Due',
    categories: ['Credit Card Payment Due'],
  },
};

// Categories whose budget is the trailing-3-month-average x squeeze% (Section 3.5 step 5).
export const SQUEEZE_CATEGORIES = ['Groceries', 'Outside Food', 'Shopping', 'Alcohol'];

// Non-target variable categories that feed the variable-spend floor at plain trailing average.
export const FLOOR_TRAILING_CATEGORIES = ['Fuel', 'Travel', 'Untracked Cash Withdrawals'];

// Historical category names merged into the single "Vehicle Maintenance"
// category — kept around only so the one-time migration (store.js) knows what
// to fold in.
export const LEGACY_VEHICLE_MAINTENANCE_CATEGORIES = ['Vehicle Maintenance (Virtus)', 'Vehicle Maintenance (Jimny)'];

// Variable-taxonomy categories budgeted as a fixed, user-editable value (sticky,
// carried forward until changed) rather than a trailing average or a squeeze.
export const FIXED_VALUE_DEFAULTS = {
  'Vehicle Maintenance': 4000,
  Miscellaneous: 10000,
};
export const FIXED_VALUE_CATEGORIES = Object.keys(FIXED_VALUE_DEFAULTS);

// "Fixed" commitments split into two budgeting treatments:
// - sticky: carries forward last month's value unchanged until the user updates
//   it (via Fixed Commitments), same mechanism as Vehicle Maintenance's default.
// - trailing: genuinely varies month to month, so it's budgeted off a running
//   3-month average (or fewer months early on) instead of a manually-set value.
export const STICKY_FIXED_CATEGORIES = ['Rent', 'Vehicle EMI (Virtus)', 'Vehicle EMI (Jimny)', 'SIP Savings'];

export const TRAILING_FIXED_CATEGORIES = ['Utilities', 'Hobbies', 'Staff/Ironing', 'Land'];

// All categories reported under the "Fixed Monthly Commitments" taxonomy group,
// regardless of which budgeting treatment they get.
export const FIXED_COMMITMENT_NAMES = ['Rent', 'Vehicle EMI (Virtus)', 'Vehicle EMI (Jimny)', ...TRAILING_FIXED_CATEGORIES];

export function allCategories(extraGoalNames = []) {
  const groups = { ...CATEGORY_GROUPS, goal: { ...CATEGORY_GROUPS.goal, categories: extraGoalNames } };
  return Object.values(groups).flatMap((g) => g.categories);
}
