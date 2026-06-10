/** Must match backend SYSTEM_USER_EMAIL / DEFAULT_SYSTEM_USER_EMAIL. */
export const HIDDEN_SYSTEM_USER_EMAIL = 'admin@taskhub.local';

export function isHiddenTeamMember(member: { email: string }): boolean {
  return member.email.toLowerCase() === HIDDEN_SYSTEM_USER_EMAIL;
}

export function visibleTeamMembers<T extends { email: string }>(members: T[]): T[] {
  return members.filter((m) => !isHiddenTeamMember(m));
}
