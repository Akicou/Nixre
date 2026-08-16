import { describe, it, expect, beforeEach } from 'vitest';
import { isRegistrationHidden, setRegistrationHidden, REGISTRATION_HIDDEN_KEY } from './authLock';

describe('authLock', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to not hidden when nothing stored', () => {
    expect(isRegistrationHidden()).toBe(false);
  });

  it('reflects true after setRegistrationHidden(true)', () => {
    setRegistrationHidden(true);
    expect(isRegistrationHidden()).toBe(true);
    expect(localStorage.getItem(REGISTRATION_HIDDEN_KEY)).toBe('true');
  });

  it('reflects false after setRegistrationHidden(false)', () => {
    setRegistrationHidden(true);
    setRegistrationHidden(false);
    expect(isRegistrationHidden()).toBe(false);
  });

  it('uses a single canonical storage key (no aether_/nixre_ split)', () => {
    setRegistrationHidden(true);
    // Guard against regressing to the old mismatched keys.
    expect(localStorage.getItem('aether_auth_blocked')).toBeNull();
    expect(REGISTRATION_HIDDEN_KEY).toBe('nixre_registration_hidden');
  });
});
