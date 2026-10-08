'use client';

import { useRouter } from 'next/navigation';
import { CommunityForm } from '@/components/community-form';
import { PageHeader } from '@/components/ui';

export default function NewCommunity() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="New community" />
      <CommunityForm
        method="POST"
        path="/org/communities"
        initial={{ name: '', description: '', slug: '', imageUrl: null, whatsappInviteUrl: '', accessInstructions: '', gracePeriodDays: 2, adminApprovalEnabled: false, isPublished: false }}
        onSaved={(c) => router.replace(`/creator/communities/${c.id}`)}
      />
    </>
  );
}
