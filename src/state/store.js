import { loadAllDecrypted, saveEncrypted, deleteEncrypted } from '../db/db.js';
import { newId } from '../lib/id.js';
import {
  LEGACY_VEHICLE_MAINTENANCE_CATEGORIES,
  STICKY_FIXED_CATEGORIES,
  FIXED_VALUE_CATEGORIES,
  FIXED_VALUE_DEFAULTS,
} from '../lib/categories.js';
import { effectiveValue, currentMonthKey } from '../lib/format.js';

const listeners = new Set();

const state = {
  unlocked: false,
  encryptionKey: null,
  collections: {
    transaction: [],
    fixedCommitment: [],
    fixedCommitmentVersion: [],
    creditCard: [],
    ccInstallmentPlan: [],
    goal: [],
    staffMember: [],
    staffAdvance: [],
    reconciliation: [],
    budgetMonth: [],
    settings: [],
  },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function getState() {
  return state;
}

export async function unlockWith(key) {
  state.encryptionKey = key;
  const all = await loadAllDecrypted(key);
  for (const type of Object.keys(state.collections)) state.collections[type] = [];
  for (const entity of all) {
    if (state.collections[entity.type]) state.collections[entity.type].push(entity);
  }
  await runMigrations();
  state.unlocked = true;
  notify();
}

// One-time, idempotent data migrations that run right after decrypting existing
// data — for schema/taxonomy changes that need to touch already-saved records,
// not just new ones going forward.
async function runMigrations() {
  await migrateVehicleMaintenanceCategory();
  await migrateStaffTransactionNotes();
  await migrateStaffPaymentMethodToBank();
  await ensureFixedCommitments();
}

// The most recent past month with a logged amount for this category.
function lastActualForCategory(category, atMonthKey) {
  const byMonth = {};
  for (const t of state.collections.transaction) {
    if (t.category !== category) continue;
    const mk = t.date.slice(0, 7);
    if (mk >= atMonthKey) continue;
    byMonth[mk] = (byMonth[mk] || 0) + t.amount;
  }
  const months = Object.keys(byMonth).sort();
  return months.length ? byMonth[months[months.length - 1]] : 0;
}

// "Carry forward last month's value unless told otherwise": every sticky/fixed-value
// commitment needs a starting value, otherwise the budget treats Rent/EMIs/SIP as ₹0.
// Seeds from the fixed default, or else the last month actually logged — and runs on
// unlock and after every import, so it never depends on visiting a settings screen.
export async function ensureFixedCommitments() {
  const atMonthKey = currentMonthKey();
  for (const name of [...STICKY_FIXED_CATEGORIES, ...FIXED_VALUE_CATEGORIES]) {
    let commitment = state.collections.fixedCommitment.find((c) => c.name === name);
    if (!commitment) commitment = await addEntity('fixedCommitment', { name });
    if (state.collections.fixedCommitmentVersion.some((v) => v.commitmentId === commitment.id)) continue;
    const amount = name in FIXED_VALUE_DEFAULTS ? FIXED_VALUE_DEFAULTS[name] : lastActualForCategory(name, atMonthKey);
    if (amount > 0) {
      await addEntity('fixedCommitmentVersion', { commitmentId: commitment.id, amount, effectiveFrom: atMonthKey });
    }
  }
}

// Staff advances/payments are always bank now (no more cash/bank choice) — but
// existing entries logged before that decision may still carry their original
// paymentMethod, which would silently exclude them from the bank balance.
async function migrateStaffPaymentMethodToBank() {
  const txs = state.collections.transaction.filter(
    (t) => (t.kind === 'staffAdvance' || t.kind === 'staffPayment') && t.paymentMethod !== 'bank'
  );
  for (const t of txs) {
    await updateEntity('transaction', t.id, { paymentMethod: 'bank' });
  }
}

async function migrateStaffTransactionNotes() {
  const txs = state.collections.transaction.filter(
    (t) => (t.kind === 'staffAdvance' || t.kind === 'staffPayment') && t.staffId
  );
  for (const t of txs) {
    const staff = state.collections.staffMember.find((s) => s.id === t.staffId);
    if (!staff || (t.note && t.note.includes(staff.name))) continue;
    const prefix = t.kind === 'staffAdvance' ? `Advance to ${staff.name}` : `Payment to ${staff.name}`;
    const newNote = t.note ? `${prefix} — ${t.note}` : prefix;
    await updateEntity('transaction', t.id, { note: newNote });
  }
}

async function migrateVehicleMaintenanceCategory() {
  const NEW_NAME = 'Vehicle Maintenance';
  const oldNames = LEGACY_VEHICLE_MAINTENANCE_CATEGORIES;

  const txsToMigrate = state.collections.transaction.filter((t) => oldNames.includes(t.category));
  for (const t of txsToMigrate) {
    await updateEntity('transaction', t.id, { category: NEW_NAME });
  }

  const oldCommitments = state.collections.fixedCommitment.filter((c) => oldNames.includes(c.name));
  const alreadyMigrated = state.collections.fixedCommitment.some((c) => c.name === NEW_NAME);
  if (oldCommitments.length === 0 || alreadyMigrated) return;

  const atMonthKey = currentMonthKey();
  const combinedValue = oldCommitments.reduce((sum, c) => {
    const versions = state.collections.fixedCommitmentVersion.filter((v) => v.commitmentId === c.id);
    return sum + (versions.length ? effectiveValue(versions, atMonthKey) : 0);
  }, 0);

  const newCommitment = await addEntity('fixedCommitment', { name: NEW_NAME });
  if (combinedValue > 0) {
    await addEntity('fixedCommitmentVersion', { commitmentId: newCommitment.id, amount: combinedValue, effectiveFrom: atMonthKey });
  }
  for (const c of oldCommitments) {
    for (const v of state.collections.fixedCommitmentVersion.filter((v) => v.commitmentId === c.id)) {
      await removeEntity('fixedCommitmentVersion', v.id);
    }
    await removeEntity('fixedCommitment', c.id);
  }
}

export async function addEntity(type, data) {
  const entity = { id: newId(), ...data };
  state.collections[type].push(entity);
  await saveEncrypted(state.encryptionKey, type, entity);
  notify();
  return entity;
}

export async function updateEntity(type, id, patch) {
  const list = state.collections[type];
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`${type} ${id} not found`);
  const updated = { ...list[idx], ...patch };
  list[idx] = updated;
  await saveEncrypted(state.encryptionKey, type, updated);
  notify();
  return updated;
}

// Merge records from a backup into the live store: same id overwrites, new ids
// are added, nothing existing is deleted. Re-encrypts under this device's key.
export async function importRecords(records) {
  let count = 0;
  for (const { type, ...entity } of records) {
    if (!state.collections[type] || !entity.id) continue;
    const idx = state.collections[type].findIndex((e) => e.id === entity.id);
    if (idx === -1) state.collections[type].push(entity);
    else state.collections[type][idx] = entity;
    await saveEncrypted(state.encryptionKey, type, entity);
    count++;
  }
  await runMigrations();
  notify();
  return count;
}

export async function removeEntity(type, id) {
  state.collections[type] = state.collections[type].filter((e) => e.id !== id);
  await deleteEncrypted(id);
  notify();
}

export function list(type) {
  return state.collections[type];
}
