// Client-side-only preference to hide the registration page in this browser.
// This does NOT block account creation on the server: Gitness only exposes
// public-signup control via the GITNESS_USER_SIGNUP_ENABLED deploy-time env
// var, there is no runtime API for it. Anyone can still POST /api/v1/register
// directly. Treat this as a UI convenience, not an access control.
export const REGISTRATION_HIDDEN_KEY = 'nixre_registration_hidden';

export function isRegistrationHidden(): boolean {
  return localStorage.getItem(REGISTRATION_HIDDEN_KEY) === 'true';
}

export function setRegistrationHidden(hidden: boolean): void {
  localStorage.setItem(REGISTRATION_HIDDEN_KEY, String(hidden));
}
