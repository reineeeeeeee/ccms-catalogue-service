import { ROLE_LIST, Errors, assertOfficeAccess, authenticate, hasValidServiceKey } from 'ccms-shared';

/**
 * Engine and holiday endpoints are for other services (shared service key) and for signed-in users.
 * Returns { service: true } or { service: false, user }. A missing or wrong credential is a 401.
 * The engine only reads data, even though POST /working-minutes and /deadline carry a body, so the
 * Executive role's "no writes" rule does not apply: it is checked against the role list only.
 */
export async function authenticateCaller(request) {
  if (hasValidServiceKey(request)) return { service: true, user: null };
  const user = await authenticate(request);
  if (!ROLE_LIST.includes(user.role)) throw Errors.forbidden();
  return { service: false, user };
}

/** Office Head / Office Staff may only ask about their own office; the service key and other roles may ask about any. */
export function assertCallerOffice(caller, officeId) {
  if (!caller.service && officeId) assertOfficeAccess(caller.user, officeId);
}
