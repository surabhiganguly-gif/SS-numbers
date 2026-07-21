import { loadAllDecrypted, saveEncrypted, deleteEncrypted } from '../db/db.js';
import { newId } from '../lib/id.js';

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
  state.unlocked = true;
  notify();
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

export async function removeEntity(type, id) {
  state.collections[type] = state.collections[type].filter((e) => e.id !== id);
  await deleteEncrypted(id);
  notify();
}

export function list(type) {
  return state.collections[type];
}
