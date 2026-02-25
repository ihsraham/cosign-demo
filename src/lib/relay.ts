import { recoverMessageAddress } from 'viem';

import type { Room } from './types';

export function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

export function isParticipant(room: Room, wallet: string): boolean {
  const target = normalizeAddress(wallet);
  return (
    normalizeAddress(room.participant_a) === target ||
    normalizeAddress(room.participant_b) === target
  );
}

export function counterpartOf(room: Room, wallet: string): string {
  const target = normalizeAddress(wallet);
  return normalizeAddress(room.participant_a) === target ? room.participant_b : room.participant_a;
}

export function calculateSignedWeight(
  room: Room,
  signatures: Record<string, string>,
): number {
  let weight = 0;
  const signerAddresses = new Set(Object.keys(signatures).map(normalizeAddress));

  if (signerAddresses.has(normalizeAddress(room.participant_a))) weight += 50;
  if (signerAddresses.has(normalizeAddress(room.participant_b))) weight += 50;

  return weight;
}

export function stripWalletQuorumPrefix(signature: string): `0x${string}` {
  const lower = signature.toLowerCase();
  if (!lower.startsWith('0x')) throw new Error('Signature must start with 0x');

  if (lower.startsWith('0xa1')) {
    return `0x${signature.slice(4)}` as `0x${string}`;
  }

  return signature as `0x${string}`;
}

export async function assertWalletSignedHash(
  wallet: string,
  hash: `0x${string}`,
  quorumSignature: string,
): Promise<void> {
  const rawSignature = stripWalletQuorumPrefix(quorumSignature);
  const recovered = await recoverMessageAddress({
    message: { raw: hash },
    signature: rawSignature,
  });

  if (normalizeAddress(recovered) !== normalizeAddress(wallet)) {
    throw new Error('Signature does not match wallet');
  }
}
