import { list, removeEntity, updateEntity } from '../state/store.js';

// Deleting a confirmed budgetMonth to rework it must also roll back the global
// squeeze-state settings to what they were before this month advanced them —
// otherwise re-confirming the same month a second time double-advances the
// squeeze percentage (extra easing that never should have happened).
export async function reworkBudgetMonth(budgetMonth) {
  if (budgetMonth.squeezeStateBefore) {
    const settings = list('settings').find((s) => s.key === 'squeezeState');
    if (settings) {
      await updateEntity('settings', settings.id, budgetMonth.squeezeStateBefore);
    }
  }
  await removeEntity('budgetMonth', budgetMonth.id);
}
