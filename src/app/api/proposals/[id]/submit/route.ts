import { randomUUID } from 'crypto';

import { NextRequest } from 'next/server';
import { isAddress } from 'viem';

import { apiError, apiOk } from '@/lib/api';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { isParticipant, normalizeAddress } from '@/lib/relay';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      wallet?: string;
      outcome?: 'submitted' | 'failed';
      sdkResult?: Record<string, unknown>;
      appSessionId?: string;
      error?: string;
    };
    console.info('[cosign-demo][api][proposal-submit] request', {
      proposalId: id,
      wallet: body.wallet ?? null,
      outcome: body.outcome ?? 'submitted',
      hasSdkResult: Boolean(body.sdkResult),
      hasAppSessionId: Boolean(body.appSessionId),
      error: body.error ?? null,
    });

    if (!body.wallet) return apiError('wallet is required');
    if (!isAddress(body.wallet)) return apiError('wallet must be a valid EVM address');
    if (body.outcome && body.outcome !== 'submitted' && body.outcome !== 'failed') {
      return apiError('outcome must be submitted or failed');
    }

    const supabase = createSupabaseServerClient();

    const { data: proposal, error: proposalError } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', id)
      .single();

    if (proposalError || !proposal) return apiError(proposalError?.message ?? 'Proposal not found', 404);
    if (new Date(proposal.expires_at).getTime() < Date.now()) {
      await supabase.from('proposals').update({ status: 'expired' }).eq('id', proposal.id);
      return apiError('Proposal expired');
    }

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', proposal.room_id)
      .single();

    if (roomError || !room) return apiError(roomError?.message ?? 'Room not found', 404);

    const wallet = normalizeAddress(body.wallet);
    if (!isParticipant(room, wallet)) return apiError('Actor is not a room participant', 403);

    const outcome = body.outcome ?? 'submitted';

    if (outcome === 'submitted' && proposal.status !== 'ready') {
      return apiError(`Proposal must be ready before submission. Current status: ${proposal.status}`);
    }

    const nextStatus = outcome === 'submitted' ? 'submitted' : 'failed';
    const sdkResult = body.sdkResult ?? (body.error ? { error: body.error } : {});
    console.info('[cosign-demo][api][proposal-submit] applying', {
      proposalId: id,
      kind: proposal.kind,
      currentStatus: proposal.status,
      nextStatus,
      roomId: room.id,
    });

    const { data: updated, error: updateError } = await supabase
      .from('proposals')
      .update({
        status: nextStatus,
        sdk_result_json: sdkResult,
      })
      .eq('id', proposal.id)
      .select('*')
      .single();

    if (updateError || !updated) return apiError(updateError?.message ?? 'Failed to update proposal', 500);

    if (outcome === 'submitted' && proposal.kind === 'create_session' && body.appSessionId) {
      const { error: roomUpdateError } = await supabase
        .from('rooms')
        .update({ app_session_id: body.appSessionId })
        .eq('id', room.id);

      if (roomUpdateError) return apiError(roomUpdateError.message, 500);
    }

    if (outcome === 'submitted' && proposal.kind === 'close_session') {
      const { error: roomUpdateError } = await supabase
        .from('rooms')
        .update({ status: 'closed' })
        .eq('id', room.id);

      if (roomUpdateError) return apiError(roomUpdateError.message, 500);
    }

    const { error: eventError } = await supabase.from('events').insert({
      id: randomUUID(),
      room_id: room.id,
      proposal_id: proposal.id,
      actor: wallet,
      event_type: outcome === 'submitted' ? 'proposal_submitted' : 'proposal_failed',
      event_payload: {
        kind: proposal.kind,
        status: nextStatus,
        sdkResult,
      },
      created_at: new Date().toISOString(),
    });

    if (eventError) return apiError(eventError.message, 500);

    console.info('[cosign-demo][api][proposal-submit] success', {
      proposalId: id,
      nextStatus,
      kind: proposal.kind,
      roomId: room.id,
    });
    return apiOk({ proposal: updated });
  } catch (error) {
    console.error('[cosign-demo][api][proposal-submit] failed', error);
    return apiError(error instanceof Error ? error.message : 'Failed to submit proposal', 500);
  }
}
