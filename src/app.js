import { registerRoute, initRouter, navigate } from './router.js';
import { getState, subscribe } from './state/store.js';
import { isDevEnvironment } from './crypto/crypto.js';

import * as authView from './views/auth.js';
import * as homeView from './views/home.js';
import * as budgetView from './views/budget.js';
import * as transactionsView from './views/transactions.js';
import * as fixedCommitmentsView from './views/fixedCommitments.js';
import * as creditCardView from './views/creditCard.js';
import * as budgetReviewView from './views/budgetReview.js';
import * as goalsView from './views/goals.js';
import * as staffLedgerView from './views/staffLedger.js';
import * as reconciliationView from './views/reconciliation.js';
import * as historicalImportView from './views/historicalImport.js';
import * as settingsView from './views/settings.js';

const NAV_ITEMS = [
  { path: '/', icon: '🏠', label: 'Home' },
  { path: '/budget', icon: '📊', label: 'Budget' },
  { path: '/transactions', icon: '📝', label: 'Log' },
  { path: '/creditcard', icon: '💳', label: 'Card' },
  { path: '/goals', icon: '🎯', label: 'Goals' },
  { path: '/staff', icon: '🧾', label: 'Staff' },
  { path: '/reconcile', icon: '⚖️', label: 'Reconcile' },
  { path: '/settings', icon: '⚙️', label: 'Settings' },
];

function guarded(view) {
  return {
    render(container) {
      if (!getState().unlocked) {
        navigate('/auth');
        return;
      }
      return view.render(container);
    },
  };
}

registerRoute('/auth', authView);
registerRoute('/', guarded(homeView));
registerRoute('/budget', guarded(budgetView));
registerRoute('/transactions', guarded(transactionsView));
registerRoute('/fixed-commitments', guarded(fixedCommitmentsView));
registerRoute('/creditcard', guarded(creditCardView));
registerRoute('/budget-review', guarded(budgetReviewView));
registerRoute('/goals', guarded(goalsView));
registerRoute('/staff', guarded(staffLedgerView));
registerRoute('/reconcile', guarded(reconciliationView));
registerRoute('/historical-import', guarded(historicalImportView));
registerRoute('/settings', guarded(settingsView));

function renderNav() {
  const nav = document.getElementById('bottom-nav');
  const { unlocked } = getState();
  if (!unlocked) {
    nav.classList.add('hidden');
    return;
  }
  nav.classList.remove('hidden');
  const current = window.location.hash.slice(1) || '/';
  nav.innerHTML = NAV_ITEMS.map(
    (item) => `
      <a href="#${item.path}" class="${current === item.path ? 'active' : ''}">
        <span class="icon">${item.icon}</span>
        <span>${item.label}</span>
      </a>`
  ).join('');
}

window.addEventListener('hashchange', renderNav);
subscribe(renderNav);

initRouter(document.getElementById('view'));
renderNav();

if (!isDevEnvironment() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
