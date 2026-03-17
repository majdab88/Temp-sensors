import { User } from '../types';

/** Returns true if the user can rename/delete sensors, approve pairing, manage hubs. */
export function canEdit(user: User | null): boolean {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'owner') return true;
  const level = user.memberships?.[0]?.permission_level;
  return level === 'editor' || level === 'admin';
}
