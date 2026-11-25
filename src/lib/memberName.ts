export type MemberIdentity = {
  /** First name used in the home greeting. Null when no real name is stored. */
  greetingName: string | null;
  /** Full name when one exists, otherwise the greeting name. */
  fullName: string | null;
  /** Source for a two-letter monogram. Falls back to the email local-part only when no name exists. */
  avatarName: string;
};

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function firstToken(value: string) {
  return value.split(' ').filter(Boolean)[0] ?? '';
}

function same(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function present(value: string) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function resolveMemberIdentity(input: {
  metadata: unknown;
  profileFullName?: string | null;
  email?: string | null;
}): MemberIdentity {
  const record = input.metadata && typeof input.metadata === 'object'
    ? input.metadata as Record<string, unknown>
    : null;
  const metaFirst = clean(record?.first_name);
  const metaFull = clean(record?.full_name) || clean(record?.name);
  const profileFull = clean(input.profileFullName);
  const emailLocal = clean(input.email?.split('@')[0]);
  const profileUsable = profileFull && profileFull.toLowerCase() !== 'account' && !same(profileFull, emailLocal)
    ? profileFull
    : '';
  const full = metaFull || profileUsable;
  const greetingSource = metaFirst || firstToken(full);
  const greetingName = greetingSource ? present(greetingSource) : null;
  const fullName = full ? full : greetingName;
  const avatarName = fullName || emailLocal || 'Account';
  return { greetingName, fullName, avatarName };
}
