import { randomUUID } from 'crypto';

import { NextRequest } from 'next/server';
import { isAddress, type Hex } from 'viem';

import { apiError, apiOk } from '@/lib/api';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { assertWalletSignedHash, calculateSignedWeight, isParticipant, normalizeAddress } from '@/lib/relay';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { wallet?: string; signature?: string };
    console.info('[cosign-demo][api][proposal-sign] request', {
      proposalId: id,
      wallet: body.wallet ?? null,
      hasSignature: Boolean(body.signature),
    });

    if (!body.wallet || !body.signature) {
      return apiError('wallet and signature are required');
    }
    if (!isAddress(body.wallet)) return apiError('wallet must be a valid EVM address');
    if (!/^0x[0-9a-fA-F]+$/.test(body.signature)) return apiError('signature must be a hex string');

    const supabase = createSupabaseServerClient();

    const { data: proposal, error: proposalError } = await supabase
      .from('proposals')
      .select('*')
      .eq('id', id)
      .single();

    if (proposalError || !proposal) return apiError(proposalError?.message ?? 'Proposal not found', 404);

    if (proposal.status === 'submitted' || proposal.status === 'failed' || proposal.status === 'expired') {
      return apiError(`Cannot sign proposal with status ${proposal.status}`);
    }

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
    if (!isParticipant(room, wallet)) return apiError('Signer is not a room participant', 403);

    await assertWalletSignedHash(wallet, proposal.payload_hash as Hex, body.signature);

    const signatures = { ...(proposal.signatures_json ?? {}) };
    if (!signatures[wallet]) {
      signatures[wallet] = body.signature;
    }

    const signedWeight = calculateSignedWeight(room, signatures);
    const status = signedWeight >= proposal.required_quorum ? 'ready' : 'pending';
    console.info('[cosign-demo][api][proposal-sign] verified', {
      proposalId: id,
      wallet,
      signedWeight,
      requiredQuorum: proposal.required_quorum,
      nextStatus: status,
    });

    const { data: updated, error: updateError } = await supabase
      .from('proposals')
      .update({ signatures_json: signatures, status })
      .eq('id', proposal.id)
      .select('*')
      .single();

    if (updateError || !updated) return apiError(updateError?.message ?? 'Failed to update proposal', 500);

    const { error: eventError } = await supabase.from('events').insert({
      id: randomUUID(),
      room_id: room.id,
      proposal_id: proposal.id,
      actor: wallet,
      event_type: 'proposal_signed',
      event_payload: {
        signedWeight,
        requiredQuorum: proposal.required_quorum,
        status,
      },
      created_at: new Date().toISOString(),
    });

    if (eventError) return apiError(eventError.message, 500);

    console.info('[cosign-demo][api][proposal-sign] success', {
      proposalId: id,
      status,
      signedWeight,
    });
    return apiOk({ proposal: updated, signedWeight });
  } catch (error) {
    console.error('[cosign-demo][api][proposal-sign] failed', error);
    return apiError(error instanceof Error ? error.message : 'Failed to sign proposal', 500);
  }
}
