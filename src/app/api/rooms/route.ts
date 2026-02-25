import { randomUUID } from 'crypto';

import { NextRequest } from 'next/server';
import { isAddress } from 'viem';

import { ALLOWED_ASSETS, SEPOLIA_CHAIN_ID, ttlDate } from '@/lib/constants';
import { apiError, apiOk } from '@/lib/api';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { normalizeAddress } from '@/lib/relay';

export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet) return apiError('wallet is required');
    if (!isAddress(wallet)) return apiError('wallet must be a valid EVM address');

    const supabase = createSupabaseServerClient();
    const normalized = normalizeAddress(wallet);

    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .or(`participant_a.eq.${normalized},participant_b.eq.${normalized}`)
      .order('created_at', { ascending: false });

    if (error) return apiError(error.message, 500);
    return apiOk({ rooms: data ?? [] });
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Failed to list rooms', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      createdBy?: string;
      participantB?: string;
      assetSymbol?: string;
      chainId?: number;
    };

    if (!body.createdBy || !body.participantB || !body.assetSymbol || !body.chainId) {
      return apiError('createdBy, participantB, assetSymbol and chainId are required');
    }
    if (!isAddress(body.createdBy) || !isAddress(body.participantB)) {
      return apiError('createdBy and participantB must be valid EVM addresses');
    }

    const createdBy = normalizeAddress(body.createdBy);
    const participantB = normalizeAddress(body.participantB);
    const assetSymbol = body.assetSymbol.toLowerCase();

    if (createdBy === participantB) return apiError('Participant must be different from creator');
    if (body.chainId !== SEPOLIA_CHAIN_ID) return apiError('Only Sepolia is supported in this demo');
    if (!ALLOWED_ASSETS.has(assetSymbol)) return apiError('Asset must be usdc or weth');

    const room = {
      id: randomUUID(),
      created_by: createdBy,
      participant_a: createdBy,
      participant_b: participantB,
      chain_id: body.chainId,
      asset_symbol: assetSymbol,
      status: 'open',
      app_session_id: null,
      created_at: new Date().toISOString(),
      expires_at: ttlDate(),
    };

    const supabase = createSupabaseServerClient();

    const { error: roomError } = await supabase.from('rooms').insert(room);
    if (roomError) return apiError(roomError.message, 500);

    const { error: eventError } = await supabase.from('events').insert({
      id: randomUUID(),
      room_id: room.id,
      proposal_id: null,
      actor: createdBy,
      event_type: 'room_created',
      event_payload: { asset: assetSymbol, chainId: body.chainId },
      created_at: new Date().toISOString(),
    });

    if (eventError) return apiError(eventError.message, 500);

    return apiOk({ room }, 201);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Failed to create room', 500);
  }
}
