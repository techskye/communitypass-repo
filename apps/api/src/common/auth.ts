import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CoreContext, resolveSession } from '@communitypass/core';
import type { Session, StaffRole, User } from '@communitypass/core';
import { InjectCore } from './core';
import { MEMBER_COOKIE, STAFF_COOKIE } from './http';

export interface StaffContext {
  user: User;
  session: Session;
  /** Derived from the server-side session + verified staff membership — never from client input. */
  organizationId: string | null;
  role: StaffRole | null;
}

export interface MemberContext {
  memberAccountId: string;
  email: string;
  session: Session;
}

const ROLES_KEY = 'cp_roles';
const NEEDS_ORG_KEY = 'cp_needs_org';
/** Require the caller to have one of these roles in their active organization. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
/** Route works without an organization (e.g. onboarding, /auth/me). */
export const NoOrgRequired = () => SetMetadata(NEEDS_ORG_KEY, false);

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    @InjectCore() private readonly core: CoreContext,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { staff?: StaffContext }>();
    const session = await resolveSession(this.core, req.cookies?.[STAFF_COOKIE], 'STAFF');
    if (!session || !session.user) throw new UnauthorizedException('Please sign in');

    let organizationId: string | null = null;
    let role: StaffRole | null = null;
    if (session.activeOrganizationId) {
      const link = await this.core.prisma.organizationStaff.findUnique({
        where: { organizationId_userId: { organizationId: session.activeOrganizationId, userId: session.userId! } },
        include: { organization: { select: { status: true } } },
      });
      if (link) {
        organizationId = link.organizationId;
        role = link.role;
      }
    }
    if (!organizationId) {
      const first = await this.core.prisma.organizationStaff.findFirst({
        where: { userId: session.userId! },
        orderBy: { createdAt: 'asc' },
      });
      if (first) {
        organizationId = first.organizationId;
        role = first.role;
        await this.core.prisma.session.update({ where: { id: session.id }, data: { activeOrganizationId: organizationId } });
      }
    }
    req.staff = { user: session.user, session, organizationId, role };

    const needsOrg = this.reflector.getAllAndOverride<boolean | undefined>(NEEDS_ORG_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (needsOrg !== false && !organizationId) throw new ForbiddenException('Finish onboarding first');
    if (organizationId) {
      const org = await this.core.prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
      if (needsOrg !== false && org?.status === 'SUSPENDED' && req.method !== 'GET') {
        throw new ForbiddenException('This organization is suspended');
      }
    }
    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && (!role || !roles.includes(role))) {
      throw new ForbiddenException('Only the organization owner can do this');
    }
    return true;
  }
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@InjectCore() private readonly core: CoreContext) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { staff?: StaffContext }>();
    const session = await resolveSession(this.core, req.cookies?.[STAFF_COOKIE], 'STAFF');
    if (!session?.user) throw new UnauthorizedException('Please sign in');
    if (!session.user.isPlatformAdmin) throw new ForbiddenException('Platform administrators only');
    req.staff = { user: session.user, session, organizationId: null, role: null };
    return true;
  }
}

@Injectable()
export class MemberGuard implements CanActivate {
  constructor(@InjectCore() private readonly core: CoreContext) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { member?: MemberContext }>();
    const session = await resolveSession(this.core, req.cookies?.[MEMBER_COOKIE], 'MEMBER');
    if (!session?.memberAccount) throw new UnauthorizedException('Please sign in');
    req.member = { memberAccountId: session.memberAccount.id, email: session.memberAccount.email, session };
    return true;
  }
}

export const Staff = createParamDecorator((_: unknown, ctx: ExecutionContext): StaffContext => {
  return ctx.switchToHttp().getRequest().staff;
});

/** Organization scope for tenant-owned routes. Always derived server-side. */
export const OrgId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const staff: StaffContext | undefined = ctx.switchToHttp().getRequest().staff;
  if (!staff?.organizationId) throw new ForbiddenException('No organization');
  return staff.organizationId;
});

export const Member = createParamDecorator((_: unknown, ctx: ExecutionContext): MemberContext => {
  return ctx.switchToHttp().getRequest().member;
});
