'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import { CommunityForm } from '@/components/community-form';
import { NewPlanForm, PlanRow } from '@/components/plan-editor';
import { Card, ErrorAlert, Loading, PageHeader } from '@/components/ui';
import { useMe } from '@/components/me-context';

export default function CommunityDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data: c, error, loading, reload } = useApi<any>(`/org/communities/${id}`);
  if (loading) return <Loading />;
  if (error) return <ErrorAlert error={error} onRetry={reload} />;
  const owner = me.role === 'OWNER';
  return (
    <>
      <PageHeader title={c.name} subtitle={<Link href={`/c/${c.slug}`} target="_blank" className="text-brand-700 underline">View public page</Link>} />
      <div className="space-y-4">
        <CommunityForm
          key={c.updatedAt}
          method="PUT"
          path={`/org/communities/${c.id}`}
          readOnly={!owner}
          initial={{
            name: c.name, description: c.description, slug: c.slug, imageUrl: c.imageUrl, whatsappInviteUrl: c.whatsappInviteUrl,
            accessInstructions: c.accessInstructions, gracePeriodDays: c.gracePeriodDays, adminApprovalEnabled: c.adminApprovalEnabled, isPublished: c.isPublished,
          }}
          onSaved={() => reload()}
        />
        <Card title="Plans">
          <ul className="space-y-2">{c.plans.map((p: any) => <PlanRow key={p.id} plan={p} canEdit={owner} onSaved={reload} />)}</ul>
        </Card>
        {owner && <NewPlanForm communityId={c.id} onSaved={reload} />}
      </div>
    </>
  );
}
