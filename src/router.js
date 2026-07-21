const routes = {};
let container = null;
let currentUnmount = null;

export function registerRoute(path, view) {
  routes[path] = view;
}

export function initRouter(el) {
  container = el;
  window.addEventListener('hashchange', renderCurrentRoute);
  renderCurrentRoute();
}

export function navigate(path) {
  window.location.hash = path;
}

function renderCurrentRoute() {
  const path = window.location.hash.slice(1) || '/';
  const view = routes[path] || routes['/'];
  if (currentUnmount) {
    currentUnmount();
    currentUnmount = null;
  }
  container.innerHTML = '';
  if (view) {
    const result = view.render(container);
    if (typeof result === 'function') currentUnmount = result;
  }
}

export function rerenderCurrentRoute() {
  renderCurrentRoute();
}
