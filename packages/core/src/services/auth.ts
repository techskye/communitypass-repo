import { hash, verify, Algorithm } from '@node-rs/argon2';
import {
  MAGIC_LINK_TTL_MS,
  MEMBER_SESSION_TTL_MS,
  STAFF_INVITE_TTL_MS,
  STAFF_SESSION_TTL_MS,
} from '@communitypass/shared';
import type { Session, User } from '@prisma/client';
import type { CoreContext } from '../context';
import { audit, DomainError, randomToken, sha256Hex } from '../infra';
import { buildMagicLinkEmail, buildStaffInviteEmail } from '../messages';

// OWASP-recommended argon2id parameters.
const ARGON_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
// Pre-computed hash used to keep login timing similar for unknown emails.
let dummyHash: string | null = null;

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, ARGON_OPTS);
}

export async function verifyPassword(hashStr: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
}

export async function createSession(
  ctx: CoreContext,
  p: { kind: 'STAFF'; userId: string; activeOrganizationId?: string | null } | { kind: 'MEMBER'; memberAccountId: string },
): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const ttl = p.kind === 'STAFF' ? STAFF_SESSION_TTL_MS : MEMBER_SESSION_TTL_MS;
  const session = await ctx.prisma.session.create({
    data: {
      kind: p.kind,
      tokenHash: sha256Hex(token),
      userId: p.kind === 'STAFF' ? p.userId : null,
      memberAccountId: p.kind === 'MEMBER' ? p.memberAccountId : null,
      activeOrganizationId: p.kind === 'STAFF' ? p.activeOrganizationId ?? null : null,
      expiresAt: new Date(ctx.now().getTime() + ttl),
    },
  });
  return { token, session };
}

export async function resolveSession(ctx: CoreContext, token: string | undefined, kind: 'STAFF' | 'MEMBER') {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = await ctx.prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: true, memberAccount: true },
  });
  if (!s || s.kind !== kind) return null;
  const now = ctx.now();
  if (s.expiresAt <= now) {
    await ctx.prisma.session.delete({ where: { id: s.id } }).catch(() => undefined);
    return null;
  }
  if (now.getTime() - s.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await ctx.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: now } }).catch(() => undefined);
  }
  return s;
}

export async function destroySession(ctx: CoreContext, token: string | undefined) {
  if (!token) return;
  await ctx.prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

export async function signupCreator(ctx: CoreContext, p: { name: string; email: string; password: string }) {
  const existing = await ctx.prisma.user.findUnique({ where: { email: p.email } });
  if (existing) throw new DomainError('EMAIL_TAKEN', 'An account with this email already exists', 409);
  const user = await ctx.prisma.user.create({
    data: { name: p.name, email: p.email, passwordHash: await hashPassword(p.password) },
  });
  await audit(ctx.prisma, { actorType: 'USER', actorId: user.id, action: 'user.signup', entityType: 'User', entityId: user.id });
  return user;
}

export async function loginStaff(ctx: CoreContext, email: string, password: string): Promise<User> {
  const user = await ctx.prisma.user.findUnique({ where: { email } });
  if (!user) {
    dummyHash ??= await hashPassword('timing-equalizer-password');
    await verifyPassword(dummyHash, password);
    throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401);
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new DomainError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401);
  }
  return user;
}

/**
 * Magic link request. Always resolves the same way whether or not the email exists
 * (no account enumeration). The token is emailed once, stored only as a SHA-256 hash,
 * and placed in the URL fragment so it never reaches server/proxy logs.
 */
export async function requestMagicLink(ctx: CoreContext, email: string): Promise<void> {
  const account = await ctx.prisma.memberAccount.findUnique({ where: { email } });
  if (!account) return;
  const now = ctx.now();
  const recent = await ctx.prisma.magicLinkToken.count({
    where: { memberAccountId: account.id, createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (recent >= 5) return; // silently rate-limited
  const token = randomToken(32);
  await ctx.prisma.magicLinkToken.create({
    data: {
      memberAccountId: account.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
    },
  });
  const link = `${ctx.config.webBaseUrl}/member/verify#token=${token}`;
  const mail = buildMagicLinkEmail(link);
  const outcome = await ctx.adapters.email.send({ to: account.email, ...mail });
  if (outcome.kind !== 'accepted') {
    ctx.logger.warn({ code: outcome.code }, 'magic link email not accepted');
  }
}

/** Atomically consumes a magic link (single use, unexpired). */
export async function consumeMagicLink(ctx: CoreContext, token: string) {
  const now = ctx.now();
  const tokenHash = sha256Hex(token);
  const rows = await ctx.prisma.$queryRaw<{ memberAccountId: string }[]>`
    UPDATE magic_link_tokens SET "usedAt" = ${now}
    WHERE "tokenHash" = ${tokenHash} AND "usedAt" IS NULL AND "expiresAt" > ${now}
    RETURNING "memberAccountId"`;
  if (!rows.length) {
    throw new DomainError('INVALID_LINK', 'This sign-in link is invalid, expired or already used', 401);
  }
  return createSession(ctx, { kind: 'MEMBER', memberAccountId: rows[0].memberAccountId });
}

export async function createStaffInvite(
  ctx: CoreContext,
  p: { organizationId: string; email: string; role: 'OWNER' | 'STAFF'; invitedByUserId: string },
) {
  const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: p.organizationId } });
  const already = await ctx.prisma.organizationStaff.findFirst({
    where: { organizationId: p.organizationId, user: { email: p.email } },
  });
  if (already) throw new DomainError('ALREADY_STAFF', 'This person is already on your team', 409);
  const token = randomToken(32);
  const invite = await ctx.prisma.staffInvite.create({
    data: {
      organizationId: p.organizationId,
      email: p.email,
      role: p.role,
      tokenHash: sha256Hex(token),
      invitedByUserId: p.invitedByUserId,
      expiresAt: new Date(ctx.now().getTime() + STAFF_INVITE_TTL_MS),
    },
  });
  await audit(ctx.prisma, {
    organizationId: p.organizationId,
    actorType: 'USER',
    actorId: p.invitedByUserId,
    action: 'staff.invited',
    entityType: 'StaffInvite',
    entityId: invite.id,
    metadata: { email: p.email, role: p.role },
  });
  const link = `${ctx.config.webBaseUrl}/creator/accept-invite#token=${token}`;
  await ctx.adapters.email.send({ to: p.email, ...buildStaffInviteEmail(org.displayName, link) });
  return invite;
}

export async function acceptStaffInvite(
  ctx: CoreContext,
  p: { token: string; name: string; password: string },
) {
  const now = ctx.now();
  const invite = await ctx.prisma.staffInvite.findUnique({ where: { tokenHash: sha256Hex(p.token) } });
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
    throw new DomainError('INVALID_INVITE', 'This invite is invalid or has expired', 400);
  }
  return ctx.prisma.$transaction(async (tx) => {
    const claimed = await tx.staffInvite.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: now },
    });
    if (!claimed.count) throw new DomainError('INVALID_INVITE', 'This invite was already used', 400);
    let user = await tx.user.findUnique({ where: { email: invite.email } });
    if (user) {
      if (!(await verifyPassword(user.passwordHash, p.password))) {
        throw new DomainError('INVALID_CREDENTIALS', 'Use your existing CommunityPass password to accept', 401);
      }
    } else {
      user = await tx.user.create({
        data: { email: invite.email, name: p.name, passwordHash: await hashPassword(p.password) },
      });
    }
    await tx.organizationStaff.upsert({
      where: { organizationId_userId: { organizationId: invite.organizationId, userId: user.id } },
      create: { organizationId: invite.organizationId, userId: user.id, role: invite.role },
      update: {},
    });
    await audit(tx, {
      organizationId: invite.organizationId,
      actorType: 'USER',
      actorId: user.id,
      action: 'staff.joined',
      entityType: 'OrganizationStaff',
      entityId: user.id,
    });
    return { user, organizationId: invite.organizationId };
  });
}
