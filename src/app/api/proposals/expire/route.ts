import { NextRequest } from 'next/server';

import { apiError, apiOk } from '@/lib/api';
import { createSupabaseServerClient } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  try {
    const providedSecret = request.headers.get('x-cron-secret');
    const authorization = request.headers.get('authorization');
    const bearerToken = authorization?.toLowerCase().startsWith('bearer ')
      ? authorization.slice('bearer '.length).trim()
      : null;
    const expectedSecret = process.env.CRON_SECRET;

    if (expectedSecret && providedSecret !== expectedSecret && bearerToken !== expectedSecret) {
      return apiError('Unauthorized', 401);
    }

    const supabase = createSupabaseServerClient();

    const { data, error } = await supabase
      .from('proposals')
      .update({ status: 'expired' })
      .in('status', ['pending', 'ready'])
      .lt('expires_at', new Date().toISOString())
      .select('id');

    if (error) return apiError(error.message, 500);

    return apiOk({ expiredCount: data?.length ?? 0 });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Failed to expire proposals', 500);
  }
}
