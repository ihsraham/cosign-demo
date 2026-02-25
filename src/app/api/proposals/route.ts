import { randomUUID } from 'crypto';

import { NextRequest } from 'next/server';
import { isAddress } from 'viem';

import { apiError, apiOk } from '@/lib/api';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { isParticipant, normalizeAddress } from '@/lib/relay';
import { ttlDate } from '@/lib/constants';
import type { ProposalKind } from '@/lib/types';

const ACTIVE_STATUSES = ['pending', 'ready'] as const;

function isValidKind(kind: string): kind is ProposalKind {
  return kind === 'create_session' || kind === 'operate' || kind === 'close_session';
}

export async function GET(request: NextRequest) {
  try {
    const roomId = request.nextUrl.searchParams.get('roomId');
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!roomId) return apiError('roomId is required');
    if (!wallet) return apiError('wallet is required', 401);
    if (!isAddress(wallet)) return apiError('wallet must be a valid EVM address');
    console.info('[cosign-demo][api][proposals][GET] request', { roomId, wallet });

    const supabase = createSupabaseServerClient();
    const normalizedWallet = normalizeAddress(wallet);

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .single();

    if (roomError || !room) return apiError(roomError?.message ?? 'Room not found', 404);
    if (!isParticipant(room, normalizedWallet)) {
      return apiError('Wallet is not a participant in this room', 403);
    }

    const [{ data: proposals, error: proposalError }, { data: events, error: eventError }] = await Promise.all([
      supabase
        .from('proposals')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false }),
      supabase
        .from('events')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (proposalError) return apiError(proposalError.message, 500);
    if (eventError) return apiError(eventError.message, 500);

    console.info('[cosign-demo][api][proposals][GET] success', {
      roomId,
      wallet: normalizedWallet,
      proposalCount: proposals?.length ?? 0,
      eventCount: events?.length ?? 0,
    });
    return apiOk({ proposals: proposals ?? [], events: events ?? [] });
  } catch (error) {
    console.error('[cosign-demo][api][proposals][GET] failed', error);
    return apiError(error instanceof Error ? error.message : 'Failed to fetch proposals', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      roomId?: string;
      actor?: string;
      kind?: string;
      payloadJson?: Record<string, unknown>;
      payloadHash?: string;
      requiredQuorum?: number;
    };

    if (!body.roomId || !body.actor || !body.kind || !body.payloadJson || !body.payloadHash || body.requiredQuorum === undefined) {
      return apiError('roomId, actor, kind, payloadJson, payloadHash, requiredQuorum are required');
    }
    if (typeof body.payloadJson !== 'object' || body.payloadJson === null) {
      return apiError('payloadJson must be a JSON object');
    }
    if (!isAddress(body.actor)) return apiError('actor must be a valid EVM address');
    if (!Number.isInteger(body.requiredQuorum) || body.requiredQuorum <= 0) {
      return apiError('requiredQuorum must be a positive integer');
    }

    if (!isValidKind(body.kind)) return apiError('Invalid proposal kind');
    if (!body.payloadHash.startsWith('0x') || body.payloadHash.length !== 66) {
      return apiError('payloadHash must be a 32-byte hex string');
    }
    console.info('[cosign-demo][api][proposals][POST] request', {
      roomId: body.roomId,
      actor: body.actor,
      kind: body.kind,
      requiredQuorum: body.requiredQuorum,
      payloadHash: body.payloadHash,
      payloadIntent: (body.payloadJson as { intent?: string }).intent ?? null,
    });

    const supabase = createSupabaseServerClient();

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', body.roomId)
      .single();

    if (roomError || !room) return apiError(roomError?.message ?? 'Room not found', 404);

    const actor = normalizeAddress(body.actor);
    if (!isParticipant(room, actor)) return apiError('Actor is not a room participant', 403);

    const { data: active, error: activeError } = await supabase
      .from('proposals')
      .select('id')
      .eq('room_id', body.roomId)
      .eq('kind', body.kind)
      .in('status', [...ACTIVE_STATUSES])
      .limit(1);

    if (activeError) return apiError(activeError.message, 500);
    if ((active ?? []).length > 0) {
      return apiError(`An active ${body.kind} proposal already exists in this room`);
    }

    const proposal = {
      id: randomUUID(),
      room_id: body.roomId,
      kind: body.kind,
      payload_json: body.payloadJson,
      payload_hash: body.payloadHash,
      required_quorum: body.requiredQuorum,
      signatures_json: {},
      status: 'pending',
      sdk_result_json: null,
      created_at: new Date().toISOString(),
      expires_at: ttlDate(),
    };

    const { error: proposalInsertError } = await supabase.from('proposals').insert(proposal);
    if (proposalInsertError) return apiError(proposalInsertError.message, 500);

    const { error: eventError } = await supabase.from('events').insert({
      id: randomUUID(),
      room_id: body.roomId,
      proposal_id: proposal.id,
      actor,
      event_type: 'proposal_created',
      event_payload: {
        kind: body.kind,
        requiredQuorum: body.requiredQuorum,
      },
      created_at: new Date().toISOString(),
    });

    if (eventError) return apiError(eventError.message, 500);

    console.info('[cosign-demo][api][proposals][POST] success', {
      proposalId: proposal.id,
      roomId: body.roomId,
      kind: body.kind,
      status: proposal.status,
    });
    return apiOk({ proposal }, 201);
  } catch (error) {
    console.error('[cosign-demo][api][proposals][POST] failed', error);
    return apiError(error instanceof Error ? error.message : 'Failed to create proposal', 500);
  }
}
