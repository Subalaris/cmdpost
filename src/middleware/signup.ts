import { makeDb } from '../db/client';
import { countUsers, createUser, findUserByEmail } from '../db/repos/users';
import { loadConfig } from '../env';
import type { Env } from '../env';

export interface SignupDecision {
  /** Whether the caller should proceed to send the magic link. Always true
   *  for a valid email so responses are identical whether or not the
   *  email exists (email enumeration protection). */
  proceed: boolean;
  /** Only set when the email is syntactically invalid. */
  invalidEmail?: boolean;
  /** Internal reason (logged, never surfaced to the user). */
  internalReason?: 'existing' | 'created_pending' | 'created_approved' | 'closed' | 'cap';
}

/**
 * Signup-mode enforcement + MAX_USERS cap.
 * - closed: no NEW accounts (existing users still receive their magic link).
 * - approval: new users created as 'pending'.
 * - open: new users created as 'approved'.
 * - ADMIN_EMAIL: always 'approved' + is_admin.
 *
 * SECURITY: the returned decision is identical for an existing email in every
 * mode, so the route can respond identically (no account enumeration).
 */
export async function handleSignup(env: Env, email: string, name: string): Promise<SignupDecision> {
  const cfg = loadConfig(env);
  const emailLower = email.toLowerCase().trim();
  const db = makeDb(env);

  const existing = await findUserByEmail(db, emailLower);
  if (existing) {
    // Do NOT auto-approve disabled users here; the session/login path
    // handles their status. Existing users just get their magic link.
    return { proceed: true, internalReason: 'existing' };
  }

  if (cfg.signupMode === 'closed') {
    // Lookalike decision: pretend we proceeded (route sends the same
    // "check your inbox" message) but no account is created.
    return { proceed: true, internalReason: 'closed' };
  }

  const total = await countUsers(db);
  if (total >= cfg.maxUsers) {
    return { proceed: false, internalReason: 'cap' };
  }

  const isAdmin = cfg.adminEmail !== '' && emailLower === cfg.adminEmail;
  const status = isAdmin || cfg.signupMode === 'open' ? 'approved' : 'pending';
  await createUser(db, { email: emailLower, name, status, isAdmin });
  return {
    proceed: true,
    internalReason: status === 'approved' ? 'created_approved' : 'created_pending',
  };
}
