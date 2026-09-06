// Client-side-only preference to hide the registration page in this browser.
//
// This does NOT block account creation on the server: it only hides the route
// in this browser. Anyone can still POST /api/v1/register directly.
//
// (The previous comment described a Gitness limitation that no longer applies.
// Nixre has had a real server-side kill switch since the sovereignty work:
// `NIXRE_REGISTRATION_CLOSED` for the boot default plus
// `PUT /api/v1/admin/registration` to flip it live from the admin console —
// see backend/src/lib/instanceSettings.js. It defaults to CLOSED when unset.)
//
// Treat this module as a UI convenience, not an access control.
export const REGISTRATION_HIDDEN_KEY = 'nixre_registration_hidden';

export function isRegistrationHidden(): boolean {
  return localStorage.getItem(REGISTRATION_HIDDEN_KEY) === 'true';
}

export function setRegistrationHidden(hidden: boolean): void {
  localStorage.setItem(REGISTRATION_HIDDEN_KEY, String(hidden));
}
