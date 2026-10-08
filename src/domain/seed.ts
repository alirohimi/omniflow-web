import type {
  Category,
  UserPreferences,
  VaultBlob,
} from './types';
import { DEFAULT_PREFS, CATEGORIES } from './enums';

/** Fresh, empty vault (used on first launch before any data is entered). */
export function emptyVault(prefs?: Partial<UserPreferences>): VaultBlob {
  const now = Date.now();
  return {
    schema: 1,
    createdAt: now,
    updatedAt: now,
    expenses: [],
    categories: CATEGORIES,
    accounts: [],
    holdings: [],
    prefs: { ...DEFAULT_PREFS, ...prefs },
    llmKey: '',
  };
}
