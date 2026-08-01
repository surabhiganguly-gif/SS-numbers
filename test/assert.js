// Minimal node:assert/strict replacement so tests run identically under plain
// Node (if available) or directly in a browser via ES modules.
export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected} but got ${actual}`);
  }
}

export function ok(value, message) {
  if (!value) {
    throw new Error(message || `Expected truthy value, got ${value}`);
  }
}

export function approx(actual, expected, epsilon = 1e-6, message) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(message || `Expected ~${expected} but got ${actual}`);
  }
}
