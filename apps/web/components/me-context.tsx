'use client';

import { createContext, useContext } from 'react';

export interface Me {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  activeOrganizationId: string | null;
  role: 'OWNER' | 'STAFF' | null;
  organizations: { id: string; displayName: string; isDemo: boolean; status: string; role: string }[];
}

export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
