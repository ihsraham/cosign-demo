export type ProposalKind = 'create_session' | 'operate' | 'close_session';
export type ProposalStatus = 'pending' | 'ready' | 'submitted' | 'expired' | 'failed';
export type RoomStatus = 'open' | 'closed';

export interface Room {
  id: string;
  created_by: string;
  participant_a: string;
  participant_b: string;
  chain_id: number;
  asset_symbol: string;
  status: RoomStatus;
  app_session_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface Proposal {
  id: string;
  room_id: string;
  kind: ProposalKind;
  payload_json: Record<string, unknown>;
  payload_hash: string;
  required_quorum: number;
  signatures_json: Record<string, string>;
  status: ProposalStatus;
  sdk_result_json: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

export interface RoomEvent {
  id: string;
  room_id: string;
  proposal_id: string | null;
  actor: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  created_at: string;
}

export interface FriendSessionSummary {
  counterparty: string;
  open: number;
  closed: number;
  total: number;
}
