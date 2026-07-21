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
      'Vehicle Maintenance (Virtus)',
      'Vehicle Maintenance (Jimny)',
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
export const FLOOR_TRAILING_CATEGORIES = [
  'Fuel',
  'Travel',
  'Untracked Cash Withdrawals',
  'Miscellaneous',
];

// Vehicle maintenance categories use a fixed user-set value, not a trailing average.
export const VEHICLE_MAINTENANCE_CATEGORIES = [
  'Vehicle Maintenance (Virtus)',
  'Vehicle Maintenance (Jimny)',
];

export const FIXED_COMMITMENT_NAMES = [
  'Rent',
  'Utilities',
  'Vehicle EMI (Virtus)',
  'Vehicle EMI (Jimny)',
  'Hobbies',
  'Staff/Ironing',
  'Land',
];

export function allCategories(extraGoalNames = []) {
  const groups = { ...CATEGORY_GROUPS, goal: { ...CATEGORY_GROUPS.goal, categories: extraGoalNames } };
  return Object.values(groups).flatMap((g) => g.categories);
}
