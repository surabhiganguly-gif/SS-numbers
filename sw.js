const CACHE_NAME = 'finance-tracker-v11';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/app.css',
  './src/app.js',
  './src/router.js',
  './src/state/store.js',
  './src/db/db.js',
  './src/crypto/crypto.js',
  './src/lib/format.js',
  './src/lib/categories.js',
  './src/lib/budgeting.js',
  './src/lib/budgetMonthOps.js',
  './src/lib/id.js',
  './src/lib/bankBalance.js',
  './src/lib/creditCard.js',
  './src/lib/reports.js',
  './src/lib/charts.js',
  './src/lib/spreadsheet.js',
  './src/lib/statement.js',
  './src/views/auth.js',
  './src/views/home.js',
  './src/views/budget.js',
  './src/views/transactions.js',
  './src/views/fixedCommitments.js',
  './src/views/creditCard.js',
  './src/views/budgetReview.js',
  './src/views/goals.js',
  './src/views/staffLedger.js',
  './src/views/reconciliation.js',
  './src/views/historicalImport.js',
  './src/views/settings.js',
  './src/views/statementImport.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell (HTML/JS/CSS) so a new deployment shows up on
// the very next reload instead of waiting for the old service worker to cycle
// out — cache is only the offline fallback, never the primary source when online.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
