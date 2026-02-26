'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MetaMaskSDK from '@metamask/sdk';
import {
  EventPoller,
  NitroliteClient,
  RPCAppStateIntent,
  RPCProtocolVersion,
  blockchainRPCsFromEnv,
  packCreateAppSessionHash,
  packSubmitAppStateHash,
  toWalletQuorumSignature,
  type AppSession,
  type ClearNodeAsset,
  type LedgerBalance,
  type LedgerChannel,
  type LedgerEntry,
  type RPCAppDefinition,
  type RPCAppSessionAllocation,
  type SubmitAppStateRequestParamsV04,
} from '@erc7824/nitrolite-compat';
import {
  createWalletClient,
  custom,
  formatUnits,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
  type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';

import { ALLOWED_ASSETS, SEPOLIA_CHAIN_ID } from '@/lib/constants';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { counterpartOf, normalizeAddress } from '@/lib/relay';
import type {
  FriendSessionSummary,
  Proposal,
  ProposalKind,
  Room,
  RoomEvent,
} from '@/lib/types';

const DEFAULT_WS_URL = 'wss://clearnode-v1-rc.yellow.org/ws';

type EIP1193Provider = {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type WalletProviderSource = 'metamask_extension' | 'metamask_sdk';

type CoreState = {
  assets: ClearNodeAsset[];
  channels: LedgerChannel[];
  balances: LedgerBalance[];
  entries: LedgerEntry[];
  sessions: AppSession[];
};

const EMPTY_CORE: CoreState = {
  assets: [],
  channels: [],
  balances: [],
  entries: [],
  sessions: [],
};

const ONBOARDING_SLIDES = [
  {
    title: 'Connect Wallet',
    subtitle: 'Extension or mobile',
    description:
      'Connect your wallet on Sepolia. You can use MetaMask extension or MetaMask mobile.',
  },
  {
    title: 'Create A Shared Cart',
    subtitle: 'Invite your teammate',
    description:
      'Create a shared cart and send the invite link so your teammate can join from their own browser.',
  },
  {
    title: 'Start Checkout Together',
    subtitle: 'Both must agree',
    description:
      'Start Shared Checkout opens your co-sign flow. Both shoppers must approve before anything is applied.',
  },
  {
    title: 'Add Funds To Checkout',
    subtitle: 'Move channel funds in',
    description:
      'Use Add Funds to move money into the shared checkout balance so purchases can be approved.',
  },
  {
    title: 'Finish And Review',
    subtitle: 'Complete lifecycle',
    description:
      'Approve purchases, finish checkout, and review your activity feed and balances.',
  },
] as const;

function shortAddress(value: string, take = 6): string {
  if (!value) return '-';
  if (value.length < take * 2) return value;
  return `${value.slice(0, take)}...${value.slice(-take)}`;
}

function formatDate(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleString();
}

function toStatusBadgeClass(status: string): string {
  switch (status) {
    case 'open':
      return 'badge badge-open';
    case 'closed':
      return 'badge badge-closed';
    case 'pending':
      return 'badge badge-pending';
    case 'ready':
      return 'badge badge-ready';
    case 'submitted':
      return 'badge badge-submitted';
    case 'failed':
    case 'expired':
      return 'badge badge-failed';
    default:
      return 'badge badge-closed';
  }
}

function toHumanCheckoutStatus(status?: string | null): string {
  if (!status) return '-';
  if (status === 'closed') return 'checked out';
  return status;
}

function toHumanProposalLabel(kind: ProposalKind, payload?: Record<string, unknown> | null): string {
  if (kind === 'create_session') return 'Start Checkout';
  if (kind === 'close_session') return 'Finish Checkout';
  if (kind !== 'operate') return 'Action';

  const intent = (payload as { intent?: string } | null)?.intent;
  if (intent === RPCAppStateIntent.Deposit) return 'Add Funds';
  if (intent === RPCAppStateIntent.Operate) return 'Approve Purchase';
  if (intent === RPCAppStateIntent.Withdraw) return 'Withdraw Funds';
  return 'Action';
}

function toHumanEventType(event: RoomEvent): string {
  const kind = (event.event_payload as { kind?: string } | null)?.kind;
  switch (event.event_type) {
    case 'room_created':
      return 'Shared cart created';
    case 'proposal_created':
      return kind ? `${toHumanProposalLabel(kind as ProposalKind)} requested` : 'Action requested';
    case 'proposal_signed':
      return 'Approval added';
    case 'proposal_submitted':
      return kind ? `${toHumanProposalLabel(kind as ProposalKind)} applied` : 'Action applied';
    case 'proposal_failed':
      return kind ? `${toHumanProposalLabel(kind as ProposalKind)} failed` : 'Action failed';
    default:
      return event.event_type.replaceAll('_', ' ');
  }
}

function getMetaMaskProvider(): EIP1193Provider | null {
  const eth = (window as Window & {
    ethereum?: EIP1193Provider & { providers?: EIP1193Provider[] };
  }).ethereum;

  if (!eth) return null;

  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return eth.providers.find((provider) => provider.isMetaMask) ?? null;
  }

  return eth.isMetaMask ? eth : null;
}

let metaMaskSDK: MetaMaskSDK | null = null;

function getMetaMaskSdkProvider(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;

  if (!metaMaskSDK) {
    metaMaskSDK = new MetaMaskSDK({
      dappMetadata: {
        name: 'Co-Sign Checkout Demo',
        url: window.location.href,
      },
      checkInstallationImmediately: false,
      injectProvider: false,
      shouldShimWeb3: false,
      useDeeplink: true,
    });
  }

  const provider = metaMaskSDK.getProvider();
  return (provider ?? null) as EIP1193Provider | null;
}

function getPreferredWalletProvider(): { provider: EIP1193Provider | null; source: WalletProviderSource | null } {
  const extensionProvider = getMetaMaskProvider();
  if (extensionProvider) {
    return { provider: extensionProvider, source: 'metamask_extension' };
  }

  const sdkProvider = getMetaMaskSdkProvider();
  if (sdkProvider) {
    return { provider: sdkProvider, source: 'metamask_sdk' };
  }

  return { provider: null, source: null };
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? 'Request failed');
  }

  return payload;
}

function InfoHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className="hint-wrap relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="hint-trigger"
        aria-label={text}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}>
        i
      </button>
      <span className={`hint-bubble ${open ? 'hint-open' : ''}`} role="tooltip">
        {text}
      </span>
    </span>
  );
}

const COSIGN_SESSION_CONCEPT = 'team_purchase_approval';
const READY_CHANNEL_STATUSES = new Set(['open', 'resizing']);

function buildCosignSessionData(roomId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    roomId,
    concept: COSIGN_SESSION_CONCEPT,
    ...extra,
  });
}

function parseSessionData(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatSignedUnits(amount: bigint, decimals: number): string {
  const absolute = amount < 0n ? -amount : amount;
  const prefix = amount > 0n ? '+' : amount < 0n ? '-' : '';
  return `${prefix}${formatUnits(absolute, decimals)}`;
}

function isRetryableSubmitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return (
    lower.includes('not connected') ||
    lower.includes('connection closed') ||
    lower.includes('socket closed') ||
    lower.includes('network error') ||
    lower.includes('websocket') ||
    lower.includes('ws closed')
  );
}

function isMissingHomeChannelForDeposit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  return (
    lower.includes('state.homechannelid is required for packing') ||
    lower.includes('no channel exists for asset') ||
    lower.includes('missing home channel id') ||
    lower.includes('missing_home_channel')
  );
}

function toManualFlushErrorMessage(error: unknown, assetSymbol?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const assetLabel = assetSymbol ? assetSymbol.toUpperCase() : 'the selected asset';

  if (
    lower.includes('ongoing state transitions check failed') &&
    lower.includes('home deposit is still ongoing')
  ) {
    return `A previous Add Funds action for ${assetLabel} is still finalizing on-chain. Please wait a few seconds and retry.`;
  }

  if (lower.includes('allowance is not sufficient to cover the deposit amount')) {
    return `Token approval is too low for ${assetLabel}. Approve ${assetLabel} spending, then retry manual flush.`;
  }

  if (lower.includes('0x2e3b1ec0') || lower.includes('insufficientnodebalance')) {
    return `${assetLabel} flush cannot be completed right now because node liquidity is low. Ask the Clearnode operator to top up ${assetLabel} vault liquidity, then retry.`;
  }

  return message;
}

function stringifyDevValue(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === 'bigint') return currentValue.toString();
      if (currentValue instanceof Map) return Object.fromEntries(currentValue);
      if (currentValue instanceof Set) return Array.from(currentValue);

      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) return '[Circular]';
        seen.add(currentValue);
      }

      return currentValue;
    },
    2,
  );
}

export function CosignDemoApp({ initialRoomId }: { initialRoomId?: string }) {
  const router = useRouter();

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [walletProviderSource, setWalletProviderSource] = useState<WalletProviderSource | null>(null);
  const [client, setClient] = useState<NitroliteClient | null>(null);
  const connectedProviderRef = useRef<EIP1193Provider | null>(null);
  const syncInFlightRef = useRef(false);

  const [core, setCore] = useState<CoreState>(EMPTY_CORE);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(initialRoomId ?? null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [hasAttemptedWalletRestore, setHasAttemptedWalletRestore] = useState(false);

  const [systemMessage, setSystemMessage] = useState<string>('Connect your wallet on Sepolia to begin.');
  const [sessionSyncWarning, setSessionSyncWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [createRoomCounterparty, setCreateRoomCounterparty] = useState<string>('');
  const [createRoomAsset, setCreateRoomAsset] = useState<'usdc' | 'weth'>('usdc');
  const [fundsAssetSymbol, setFundsAssetSymbol] = useState<'usdc' | 'weth'>('usdc');

  const [fundingAmount, setFundingAmount] = useState('5');
  const [withdrawAmount, setWithdrawAmount] = useState('1');
  const [transferAmount, setTransferAmount] = useState('0.5');

  const [proposalAmount, setProposalAmount] = useState('1.25');
  const [proposalPurpose, setProposalPurpose] = useState('Monthly tooling checkout');

  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [aliasInput, setAliasInput] = useState('');

  const [devOpen, setDevOpen] = useState(false);
  const [devOutput, setDevOutput] = useState<string>('{}');
  const [devBusy, setDevBusy] = useState<string | null>(null);
  const [devFlushAssetSymbol, setDevFlushAssetSymbol] = useState<'usdc' | 'weth'>('usdc');
  const [onboardingIndex, setOnboardingIndex] = useState(0);
  const [submitConfirmProposalId, setSubmitConfirmProposalId] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem('cosign_aliases');
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Record<string, string>;
      setAliases(parsed);
    } catch {
      // no-op
    }
  }, []);

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  );

  const knownRoomSessionIds = useMemo(() => {
    return new Set(
      rooms
        .map((room) => room.app_session_id?.toLowerCase())
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );
  }, [rooms]);
  const knownRoomSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    knownRoomSessionIdsRef.current = knownRoomSessionIds;
  }, [knownRoomSessionIds]);

  const activeProposal = useMemo(
    () => proposals.find((proposal) => proposal.status === 'pending' || proposal.status === 'ready') ?? null,
    [proposals],
  );

  const activeProposalLabel = useMemo(() => {
    if (!activeProposal) return '-';
    if (activeProposal.kind !== 'operate') return activeProposal.kind;

    const intent = (activeProposal.payload_json as { intent?: string } | null)?.intent;
    if (intent === RPCAppStateIntent.Deposit) return 'session_deposit';
    if (intent === RPCAppStateIntent.Operate) return 'checkout';
    if (intent === RPCAppStateIntent.Withdraw) return 'withdraw';
    return 'operate';
  }, [activeProposal]);

  const activeProposalDisplayLabel = useMemo(() => {
    if (!activeProposal) return '-';
    return toHumanProposalLabel(activeProposal.kind, activeProposal.payload_json);
  }, [activeProposal]);

  const supportedAssets = useMemo(
    () =>
      core.assets.filter(
        (asset) =>
          asset.chainId === SEPOLIA_CHAIN_ID &&
          ALLOWED_ASSETS.has(asset.symbol.toLowerCase()),
      ),
    [core.assets],
  );

  const selectedAsset = useMemo(() => {
    if (!activeRoom) {
      return (
        supportedAssets.find((asset) => asset.symbol.toLowerCase() === fundsAssetSymbol) ??
        supportedAssets[0] ??
        null
      );
    }
    return (
      supportedAssets.find(
        (asset) => asset.symbol.toLowerCase() === activeRoom.asset_symbol.toLowerCase(),
      ) ?? supportedAssets[0] ?? null
    );
  }, [supportedAssets, activeRoom, fundsAssetSymbol]);

  useEffect(() => {
    if (supportedAssets.length === 0) return;
    const hasSelected = supportedAssets.some(
      (asset) => asset.symbol.toLowerCase() === devFlushAssetSymbol,
    );
    if (!hasSelected) {
      const fallback = supportedAssets[0].symbol.toLowerCase();
      setDevFlushAssetSymbol(fallback === 'weth' ? 'weth' : 'usdc');
    }
  }, [supportedAssets, devFlushAssetSymbol]);

  const activeRoomAsset = useMemo(() => {
    if (!activeRoom) return null;
    return (
      supportedAssets.find(
        (asset) => asset.symbol.toLowerCase() === activeRoom.asset_symbol.toLowerCase(),
      ) ?? null
    );
  }, [activeRoom, supportedAssets]);

  const activeSession = useMemo(() => {
    if (!activeRoom?.app_session_id) return null;
    return (
      core.sessions.find((session) => session.app_session_id === activeRoom.app_session_id) ??
      null
    );
  }, [activeRoom, core.sessions]);

  const isActiveRoomSessionVisible = useMemo(() => {
    if (!activeRoom?.app_session_id) return true;
    return core.sessions.some(
      (session) => normalizeAddress(session.app_session_id) === normalizeAddress(activeRoom.app_session_id!),
    );
  }, [activeRoom, core.sessions]);

  const roomActionLockMessage = useMemo(() => {
    if (!activeRoom?.app_session_id) return null;
    if (!isActiveRoomSessionVisible) {
      return 'This cart points to a session that is not visible on the current Clearnode. Create a new shared cart with your friend.';
    }
    if (activeSession?.status === 'closed') {
      return 'This checkout is already checked out. Create a new shared cart with your friend.';
    }
    return null;
  }, [activeRoom, isActiveRoomSessionVisible, activeSession]);

  const areRoomActionsLocked = roomActionLockMessage !== null;
  const areFundsActionsLocked = false;
  const areCounterpartyTransferLocked = areRoomActionsLocked;

  const hasReadyWalletChannelForActiveRoomAsset = useMemo(() => {
    if (!activeRoom || !activeRoomAsset) return false;

    const expectedToken = activeRoomAsset.token.toLowerCase();
    return core.channels.some((channel) => {
      const status = channel.status.toLowerCase();
      return (
        READY_CHANNEL_STATUSES.has(status) &&
        channel.chain_id === activeRoomAsset.chainId &&
        channel.token.toLowerCase() === expectedToken
      );
    });
  }, [activeRoom, activeRoomAsset, core.channels]);

  const addFundsToCheckoutDisabledReason = useMemo(() => {
    if (!walletAddress) return 'Connect your wallet first.';
    if (!activeRoom?.app_session_id) return 'Start Shared Checkout first.';
    if (areRoomActionsLocked) return roomActionLockMessage;
    if (!activeRoomAsset) return 'Room asset is not available on this Clearnode.';
    if (!hasReadyWalletChannelForActiveRoomAsset) {
      return `Open a channel with ${activeRoom.asset_symbol.toUpperCase()} to be able to add funds to checkout.`;
    }
    return null;
  }, [
    walletAddress,
    activeRoom,
    areRoomActionsLocked,
    roomActionLockMessage,
    activeRoomAsset,
    hasReadyWalletChannelForActiveRoomAsset,
  ]);

  const nextSessionVersion = useMemo(() => {
    let maxVersion = activeSession?.version ?? 0;

    for (const proposal of proposals) {
      if (proposal.status !== 'submitted') continue;

      if (proposal.kind === 'create_session') {
        const v = Number((proposal.sdk_result_json as { version?: string | number } | null)?.version ?? 1);
        if (Number.isFinite(v)) {
          maxVersion = Math.max(maxVersion, v);
        }
        continue;
      }

      const payloadVersion = (proposal.payload_json as { version?: number | string } | null)?.version;
      const v = typeof payloadVersion === 'string' ? Number(payloadVersion) : payloadVersion;
      if (typeof v === 'number' && Number.isFinite(v)) {
        maxVersion = Math.max(maxVersion, v);
      }
    }

    return maxVersion > 0 ? maxVersion + 1 : 2;
  }, [activeSession, proposals]);

  const activeSessionBalanceRows = useMemo(() => {
    if (!activeRoom) return [] as { participant: string; rawAmount: bigint; amount: string }[];

    const decimals = activeRoomAsset?.decimals ?? 6;
    const sessionByParticipant = new Map<string, bigint>([
      [normalizeAddress(activeRoom.participant_a), 0n],
      [normalizeAddress(activeRoom.participant_b), 0n],
    ]);

    for (const allocation of activeSession?.allocations ?? []) {
      if (allocation.asset.toLowerCase() !== activeRoom.asset_symbol.toLowerCase()) continue;
      const participant = normalizeAddress(allocation.participant);
      if (!sessionByParticipant.has(participant)) continue;
      sessionByParticipant.set(participant, BigInt(allocation.amount));
    }

    return [
      activeRoom.participant_a,
      activeRoom.participant_b,
    ].map((participant) => {
      const rawAmount = sessionByParticipant.get(normalizeAddress(participant)) ?? 0n;
      return {
        participant,
        rawAmount,
        amount: formatUnits(rawAmount, decimals),
      };
    });
  }, [activeRoom, activeRoomAsset, activeSession]);

  const activeSessionBalanceTotal = useMemo(() => {
    if (!activeRoom) return '0';
    const decimals = activeRoomAsset?.decimals ?? 6;
    const total = activeSessionBalanceRows.reduce((sum, row) => sum + row.rawAmount, 0n);
    return formatUnits(total, decimals);
  }, [activeRoom, activeRoomAsset, activeSessionBalanceRows]);

  const friendSessionSummary = useMemo<FriendSessionSummary[]>(() => {
    if (!walletAddress) return [];

    const myAddress = normalizeAddress(walletAddress);
    const summary = new Map<string, FriendSessionSummary>();

    for (const session of core.sessions) {
      const participants = session.participants.map(normalizeAddress);
      if (!participants.includes(myAddress)) continue;

      const counterparties = participants.filter((participant) => participant !== myAddress);
      if (counterparties.length === 0) continue;

      const counterparty = counterparties[0];
      const current = summary.get(counterparty) ?? {
        counterparty,
        open: 0,
        closed: 0,
        total: 0,
      };

      current.total += 1;
      if (session.status === 'open') current.open += 1;
      if (session.status === 'closed') current.closed += 1;

      summary.set(counterparty, current);
    }

    return Array.from(summary.values()).sort((a, b) => b.total - a.total);
  }, [core.sessions, walletAddress]);

  const roomByCounterparty = useMemo(() => {
    const map = new Map<string, Room>();
    for (const room of rooms) {
      if (!walletAddress) continue;
      const counterparty = normalizeAddress(counterpartOf(room, walletAddress));
      if (!map.has(counterparty)) map.set(counterparty, room);
    }
    return map;
  }, [rooms, walletAddress]);

  const signatureProgress = useMemo(() => {
    if (!activeProposal || !activeRoom) return 0;

    const signatures = Object.keys(activeProposal.signatures_json ?? {}).map(normalizeAddress);
    let weight = 0;

    if (signatures.includes(normalizeAddress(activeRoom.participant_a))) weight += 50;
    if (signatures.includes(normalizeAddress(activeRoom.participant_b))) weight += 50;

    return Math.min(100, Math.round((weight / activeProposal.required_quorum) * 100));
  }, [activeProposal, activeRoom]);

  const refreshCoreData = useCallback(async () => {
    if (!client) return;
    try {
      const [assets, channels, balances, entries, sessions] = await Promise.all([
        client.getAssetsList(),
        client.getChannels(),
        client.getBalances(),
        client.getLedgerEntries(),
        client.getAppSessionsList(),
      ]);

      const cosignSessions = sessions.filter((session) => {
        const sessionId = session.app_session_id.toLowerCase();
        if (knownRoomSessionIdsRef.current.has(sessionId)) return true;

        const sessionData = parseSessionData(session.sessionData);
        if (!sessionData) return false;

        const concept = typeof sessionData.concept === 'string'
          ? sessionData.concept.toLowerCase()
          : '';
        if (concept === COSIGN_SESSION_CONCEPT) return true;

        return typeof sessionData.roomId === 'string' && sessionData.roomId.length > 0;
      });

      setCore({ assets, channels, balances, entries, sessions: cosignSessions });
      const latestSessionError = client.getLastAppSessionsListError();
      const hiddenSessionCount = Math.max(0, sessions.length - cosignSessions.length);
      setSessionSyncWarning(
        latestSessionError
          ? 'Live checkout summary is temporarily unavailable from the node. Approvals still work.'
          : hiddenSessionCount > 0
          ? `Showing only Co-Sign sessions (${cosignSessions.length}). Hidden ${hiddenSessionCount} sessions from other apps.`
          : null,
      );
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to refresh dashboard data');
    }
  }, [client]);

  const fetchRooms = useCallback(async () => {
    if (!walletAddress) return;

    const response = await fetch(`/api/rooms?wallet=${walletAddress}`, {
      cache: 'no-store',
    });

    const payload = (await response.json()) as { rooms?: Room[]; error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? 'Failed to fetch rooms');
    }

    const fetchedRooms = payload.rooms ?? [];
    setRooms(fetchedRooms);

    if (initialRoomId && !fetchedRooms.some((room) => room.id === initialRoomId)) {
      setActiveRoomId(fetchedRooms[0]?.id ?? null);
      setProposals([]);
      setEvents([]);
      setSystemMessage('This shared cart is only visible to invited shoppers. Open one of your carts instead.');
      router.replace('/');
      return;
    }

    if (activeRoomId && !fetchedRooms.some((room) => room.id === activeRoomId)) {
      setActiveRoomId(fetchedRooms[0]?.id ?? null);
    }

    if (!activeRoomId && fetchedRooms.length > 0) {
      setActiveRoomId(initialRoomId ?? fetchedRooms[0].id);
    }
  }, [walletAddress, activeRoomId, initialRoomId, router]);

  const fetchRoomThread = useCallback(async (roomId: string) => {
    if (!walletAddress) return;

    const response = await fetch(
      `/api/proposals?roomId=${roomId}&wallet=${walletAddress}`,
      { cache: 'no-store' },
    );
    const payload = (await response.json()) as {
      proposals?: Proposal[];
      events?: RoomEvent[];
      error?: string;
    };

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setProposals([]);
        setEvents([]);
        if (initialRoomId) {
          setActiveRoomId(null);
          setSystemMessage('You do not have access to this shared cart. Open one of your carts instead.');
          router.replace('/');
          return;
        }
      }
      throw new Error(payload.error ?? 'Failed to fetch room proposals');
    }

    setProposals(payload.proposals ?? []);
    setEvents(payload.events ?? []);
  }, [walletAddress, initialRoomId, router]);

  const syncRealtimeSnapshot = useCallback(async (roomIdOverride?: string) => {
    if (!walletAddress || !client) return;
    if (syncInFlightRef.current) return;

    syncInFlightRef.current = true;
    try {
      await fetchRooms();

      const roomId = roomIdOverride ?? activeRoomId;
      if (roomId) {
        await fetchRoomThread(roomId);
      }

      await refreshCoreData();
    } catch {
      // keep polling resilient; individual fetchers already set user-facing errors
    } finally {
      syncInFlightRef.current = false;
    }
  }, [walletAddress, client, fetchRooms, activeRoomId, fetchRoomThread, refreshCoreData]);

  useEffect(() => {
    if (!activeRoomId || !walletAddress) {
      setProposals([]);
      setEvents([]);
      return;
    }

    void fetchRoomThread(activeRoomId);
  }, [activeRoomId, walletAddress, fetchRoomThread]);

  useEffect(() => {
    const supabase = supabaseBrowser;
    if (!supabase || !activeRoomId || !walletAddress) return;

    const channel = supabase
      .channel(`room-${activeRoomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'proposals',
          filter: `room_id=eq.${activeRoomId}`,
        },
        () => {
          void syncRealtimeSnapshot(activeRoomId);
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'events',
          filter: `room_id=eq.${activeRoomId}`,
        },
        () => {
          void syncRealtimeSnapshot(activeRoomId);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeRoomId, walletAddress, syncRealtimeSnapshot]);

  useEffect(() => {
    if (!walletAddress || !client) return;

    const tick = () => {
      void syncRealtimeSnapshot();
    };

    const timer = window.setInterval(tick, 3500);
    const onFocus = () => {
      tick();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) tick();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [walletAddress, client, syncRealtimeSnapshot]);

  const initializeWalletSession = useCallback(
    async (
      provider: EIP1193Provider,
      account: string,
      announceSuccess: boolean,
      source: WalletProviderSource,
    ) => {
      const targetChainHex = `0x${SEPOLIA_CHAIN_ID.toString(16)}`;
      try {
        const currentChainHex = (await provider.request({
          method: 'eth_chainId',
        })) as string;

        if (currentChainHex.toLowerCase() !== targetChainHex.toLowerCase()) {
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: targetChainHex }],
          });
        }
      } catch (error: any) {
        if (error?.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: targetChainHex,
                chainName: 'Sepolia',
                nativeCurrency: {
                  name: 'Sepolia ETH',
                  symbol: 'ETH',
                  decimals: 18,
                },
                rpcUrls: [sepolia.rpcUrls.default.http[0]],
                blockExplorerUrls: ['https://sepolia.etherscan.io'],
              },
            ],
          });
        } else if (error?.code === -32002) {
          throw new Error('Your wallet already has a pending request. Open it and finish that step first.');
        } else {
          throw error;
        }
      }

      const viemWallet = createWalletClient({
        account: account as Address,
        chain: sepolia,
        transport: custom(provider),
      });

      const blockchainRPCs = blockchainRPCsFromEnv();
      if (!blockchainRPCs[SEPOLIA_CHAIN_ID]) {
        blockchainRPCs[SEPOLIA_CHAIN_ID] = sepolia.rpcUrls.default.http[0];
      }

      const compatClient = await NitroliteClient.create({
        wsURL: process.env.NEXT_PUBLIC_CLEARNODE_WS_URL ?? DEFAULT_WS_URL,
        // Local file-linked compat package can resolve a different viem type identity.
        walletClient: viemWallet as any,
        chainId: SEPOLIA_CHAIN_ID,
        blockchainRPCs,
      });

      if (client) {
        await client.close().catch(() => null);
      }

      setWalletAddress(account);
      setWalletClient(viemWallet);
      setWalletProviderSource(source);
      setClient(compatClient);
      connectedProviderRef.current = provider;
      setSessionSyncWarning(null);
      if (announceSuccess) {
        setSystemMessage(
          source === 'metamask_sdk'
            ? 'Connected with MetaMask Mobile on Sepolia. Ready for co-sign checkout sessions.'
            : 'Connected on Sepolia. Ready for co-sign checkout sessions.',
        );
      }
    },
    [client],
  );

  const connectWallet = useCallback(async () => {
    const { provider, source } = getPreferredWalletProvider();
    if (!provider) {
      setSystemMessage(
        'MetaMask was not detected. Install the extension or open this page in MetaMask Mobile.',
      );
      return;
    }

    setBusy('connect_wallet');

    try {
      try {
        await provider.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }],
        });
      } catch (error: any) {
        if (error?.code !== -32601) throw error;
      }

      const accounts = (await provider.request({
        method: 'eth_requestAccounts',
      })) as string[];
      const account = accounts[0];
      if (!account || !isAddress(account)) {
        throw new Error('Failed to read connected account from wallet');
      }

      await initializeWalletSession(provider, account, true, source ?? 'metamask_extension');
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to connect wallet');
    } finally {
      setBusy(null);
    }
  }, [initializeWalletSession]);

  useEffect(() => {
    if (walletAddress || client) {
      setHasAttemptedWalletRestore(true);
      return;
    }

    const provider = getMetaMaskProvider();
    if (!provider) {
      setHasAttemptedWalletRestore(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
        const account = accounts[0];
        if (!account || !isAddress(account) || cancelled) return;
        await initializeWalletSession(provider, account, false, 'metamask_extension');
      } catch {
        // Silent restore should never surface errors.
      } finally {
        if (!cancelled) {
          setHasAttemptedWalletRestore(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddress, client, initializeWalletSession]);

  useEffect(() => {
    if (!initialRoomId) return;
    if (!hasAttemptedWalletRestore) return;
    if (walletAddress) return;

    setSystemMessage('Connect your invited wallet to open that shared cart.');
    router.replace('/');
  }, [initialRoomId, hasAttemptedWalletRestore, walletAddress, router]);

  const disconnectWallet = useCallback(async () => {
    setBusy('disconnect_wallet');

    try {
      if (client) {
        await client.close();
      }

      const provider = connectedProviderRef.current ?? getMetaMaskProvider() ?? getMetaMaskSdkProvider();
      if (provider) {
        try {
          await provider.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
          });
        } catch {
          // Some wallet/provider combinations do not support permission revocation.
        }
      }

      setWalletAddress(null);
      setWalletClient(null);
      setWalletProviderSource(null);
      setClient(null);
      connectedProviderRef.current = null;
      setRooms([]);
      setActiveRoomId(initialRoomId ?? null);
      setProposals([]);
      setEvents([]);
      setCore(EMPTY_CORE);
      setSessionSyncWarning(null);
      setSystemMessage('Disconnected. Connect wallet to continue.');
    } finally {
      setBusy(null);
    }
  }, [client, initialRoomId]);

  useEffect(() => {
    if (!client || !walletAddress) return;

    void (async () => {
      try {
        await syncRealtimeSnapshot();
      } catch (error) {
        setSystemMessage(error instanceof Error ? error.message : 'Failed to refresh dashboard data');
      }
    })();
  }, [client, walletAddress, syncRealtimeSnapshot]);

  const createRoom = useCallback(async () => {
    if (!walletAddress) {
      setSystemMessage('Connect wallet before creating a room.');
      return;
    }

    if (!isAddress(createRoomCounterparty)) {
      setSystemMessage('Counterparty address must be a valid EVM address.');
      return;
    }

    setBusy('create_room');

    try {
      const payload = await postJson<{ room: Room }>('/api/rooms', {
        createdBy: walletAddress,
        participantB: createRoomCounterparty,
        assetSymbol: createRoomAsset,
        chainId: SEPOLIA_CHAIN_ID,
      });

      setCreateRoomCounterparty('');
      setRooms((prev) => [payload.room, ...prev]);
      setActiveRoomId(payload.room.id);
      router.push(`/r/${payload.room.id}`);
      setSystemMessage('Room created. Share the room link with your teammate.');
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to create room');
    } finally {
      setBusy(null);
    }
  }, [walletAddress, createRoomCounterparty, createRoomAsset, router]);

  const upsertAlias = useCallback(() => {
    if (!activeRoom) return;
    const key = normalizeAddress(counterpartOf(activeRoom, walletAddress ?? activeRoom.participant_a));
    const nextAliases = { ...aliases, [key]: aliasInput.trim() };

    setAliases(nextAliases);
    window.localStorage.setItem('cosign_aliases', JSON.stringify(nextAliases));
    setAliasInput('');
  }, [activeRoom, walletAddress, aliases, aliasInput]);

  const createProposal = useCallback(
    async (
      kind: ProposalKind,
      payloadJson: Record<string, unknown>,
      payloadHash: string,
      requiredQuorum = 100,
    ) => {
      if (!activeRoom || !walletAddress) return;
      console.info('[cosign-demo] createProposal request', {
        roomId: activeRoom.id,
        actor: walletAddress,
        kind,
        requiredQuorum,
        payloadHash,
        payloadIntent: (payloadJson as { intent?: string }).intent ?? null,
      });

      await postJson('/api/proposals', {
        roomId: activeRoom.id,
        actor: walletAddress,
        kind,
        payloadJson,
        payloadHash,
        requiredQuorum,
      });

      await fetchRoomThread(activeRoom.id);
      const label = toHumanProposalLabel(kind, payloadJson);
      console.info('[cosign-demo] createProposal success', {
        roomId: activeRoom.id,
        kind,
        label,
      });
      setSystemMessage(`${label} request created. Both shoppers must agree.`);
    },
    [activeRoom, walletAddress, fetchRoomThread],
  );

  const getRoomSessionAllocations = useCallback((): RPCAppSessionAllocation[] => {
    if (!activeRoom) return [];

    const participantA = normalizeAddress(activeRoom.participant_a);
    const participantB = normalizeAddress(activeRoom.participant_b);
    const byParticipant = new Map<string, bigint>([
      [participantA, 0n],
      [participantB, 0n],
    ]);

    const fallbackFromProposals =
      activeSession?.allocations && activeSession.allocations.length > 0
        ? activeSession.allocations
        : proposals.find((proposal) => proposal.status === 'submitted')?.payload_json?.allocations;

    const sourceAllocations = Array.isArray(fallbackFromProposals)
      ? (fallbackFromProposals as RPCAppSessionAllocation[])
      : [];

    for (const allocation of sourceAllocations) {
      if (allocation.asset.toLowerCase() !== activeRoom.asset_symbol.toLowerCase()) continue;
      const participant = normalizeAddress(allocation.participant);
      if (!byParticipant.has(participant)) continue;

      byParticipant.set(participant, BigInt(allocation.amount));
    }

    return [
      {
        participant: activeRoom.participant_a as Hex,
        asset: activeRoom.asset_symbol,
        amount: (byParticipant.get(participantA) ?? 0n).toString(),
      },
      {
        participant: activeRoom.participant_b as Hex,
        asset: activeRoom.asset_symbol,
        amount: (byParticipant.get(participantB) ?? 0n).toString(),
      },
    ];
  }, [activeRoom, activeSession, proposals]);

  const activeDepositSubmitter = useMemo(() => {
    if (!activeProposal || activeProposal.kind !== 'operate') return null;

    const payload = activeProposal.payload_json as {
      intent?: string;
      allocations?: RPCAppSessionAllocation[];
    };
    if (payload.intent !== RPCAppStateIntent.Deposit || !Array.isArray(payload.allocations)) {
      return null;
    }

    const baseAllocations = getRoomSessionAllocations();
    const baseByParticipant = new Map<string, bigint>(
      baseAllocations.map((allocation) => [
        `${normalizeAddress(allocation.participant)}::${allocation.asset.toLowerCase()}`,
        BigInt(allocation.amount),
      ]),
    );

    let depositor: string | null = null;
    for (const allocation of payload.allocations) {
      const key = `${normalizeAddress(allocation.participant)}::${allocation.asset.toLowerCase()}`;
      const currentAmount = baseByParticipant.get(key) ?? 0n;
      if (BigInt(allocation.amount) > currentAmount) {
        depositor = normalizeAddress(allocation.participant);
        break;
      }
    }

    return depositor;
  }, [activeProposal, getRoomSessionAllocations]);

  const canSubmitActiveProposal = useMemo(() => {
    if (!activeProposal || activeProposal.status !== 'ready') return false;
    if (!walletAddress) return false;
    if (activeProposalLabel !== 'session_deposit') return true;
    if (!activeDepositSubmitter) return false;
    return normalizeAddress(walletAddress) === activeDepositSubmitter;
  }, [activeProposal, activeProposalLabel, activeDepositSubmitter, walletAddress]);

  const ensureWalletCanSubmitSessionDeposit = useCallback(async (assetSymbol: string) => {
    if (!client || !walletAddress) {
      throw new Error('Connect your wallet before adding funds to checkout.');
    }

    try {
      const latestState = await client.innerClient.getLatestState(
        walletAddress as Address,
        assetSymbol,
        false,
      );
      if (!latestState.homeChannelId) {
        throw new Error('missing_home_channel');
      }
    } catch (error) {
      if (isRetryableSubmitError(error)) throw error;

      throw new Error(
        `This wallet cannot add funds to checkout yet. Add funds to your shared wallet first (${assetSymbol.toUpperCase()}), then try again.`,
      );
    }
  }, [client, walletAddress]);

  const createSessionProposal = useCallback(async () => {
    if (!activeRoom || activeRoom.app_session_id) return;

    setBusy('proposal_create_session');

    try {
      const nonce = Date.now();
      const definition: RPCAppDefinition = {
        application: 'team-checkout-v1',
        protocol: RPCProtocolVersion.NitroRPC_0_4,
        participants: [activeRoom.participant_a as Hex, activeRoom.participant_b as Hex],
        weights: [50, 50],
        quorum: 100,
        challenge: 0,
        nonce,
      };

      const allocations: RPCAppSessionAllocation[] = [
        { participant: activeRoom.participant_a as Hex, asset: activeRoom.asset_symbol, amount: '0' },
        { participant: activeRoom.participant_b as Hex, asset: activeRoom.asset_symbol, amount: '0' },
      ];

      const sessionData = buildCosignSessionData(activeRoom.id);

      const payloadHash = packCreateAppSessionHash({
        application: definition.application,
        participants: [
          { walletAddress: activeRoom.participant_a as Hex, signatureWeight: 50 },
          { walletAddress: activeRoom.participant_b as Hex, signatureWeight: 50 },
        ],
        quorum: 100,
        nonce,
        sessionData,
      });

      await createProposal(
        'create_session',
        {
          definition,
          allocations,
          session_data: sessionData,
        },
        payloadHash,
      );
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to create session proposal');
    } finally {
      setBusy(null);
    }
  }, [activeRoom, createProposal]);

  const createDepositProposal = useCallback(async () => {
    if (!activeRoom || !activeRoom.app_session_id || !client || !walletAddress) return;

    setBusy('proposal_deposit');

    try {
      const assetForRoom = supportedAssets.find(
        (asset) => asset.symbol.toLowerCase() === activeRoom.asset_symbol.toLowerCase(),
      );
      if (!assetForRoom) {
        throw new Error('Room asset is not currently available on this clearnode');
      }

      const rawAmount = await client.parseAmount(assetForRoom.token, proposalAmount);
      if (rawAmount <= 0n) throw new Error('Proposal amount must be greater than 0');

      await ensureWalletCanSubmitSessionDeposit(activeRoom.asset_symbol);

      const nextVersion = nextSessionVersion;
      const requester = normalizeAddress(walletAddress) === normalizeAddress(activeRoom.participant_a)
        ? activeRoom.participant_a
        : activeRoom.participant_b;

      const baseAllocations = getRoomSessionAllocations();
      const allocations = baseAllocations.map((allocation) => {
        if (normalizeAddress(allocation.participant) !== normalizeAddress(requester)) return allocation;
        return {
          ...allocation,
          amount: (BigInt(allocation.amount) + rawAmount).toString(),
        };
      });

      const signingAllocations = allocations.map((allocation) => ({
        ...allocation,
        amount: formatUnits(BigInt(allocation.amount), assetForRoom.decimals),
      }));

      const payload: SubmitAppStateRequestParamsV04 = {
        app_session_id: activeRoom.app_session_id as Hex,
        intent: RPCAppStateIntent.Deposit,
        version: nextVersion,
        allocations,
        session_data: buildCosignSessionData(activeRoom.id, {
          purpose: proposalPurpose,
          requestedBy: walletAddress,
          createdAt: new Date().toISOString(),
          action: 'session_deposit',
        }),
      };

      const payloadHash = packSubmitAppStateHash({
        appSessionId: payload.app_session_id,
        intent: payload.intent,
        version: payload.version,
        allocations: signingAllocations,
        sessionData: payload.session_data,
      });
      console.info('[cosign-demo] createDepositProposal payload', {
        appSessionId: payload.app_session_id,
        version: payload.version,
        requester,
        baseAllocations,
        nextAllocations: payload.allocations,
        quorumHash: payloadHash,
      });

      await createProposal('operate', payload as unknown as Record<string, unknown>, payloadHash);
    } catch (error) {
      console.error('[cosign-demo] createDepositProposal failed', error);
      setSystemMessage(error instanceof Error ? error.message : 'Failed to create deposit proposal');
    } finally {
      setBusy(null);
    }
  }, [
    activeRoom,
    activeSession,
    nextSessionVersion,
    client,
    walletAddress,
    supportedAssets,
    proposalAmount,
    proposalPurpose,
    getRoomSessionAllocations,
    ensureWalletCanSubmitSessionDeposit,
    createProposal,
  ]);

  const createOperateProposal = useCallback(async () => {
    if (!activeRoom || !activeRoom.app_session_id || !client || !walletAddress) return;

    setBusy('proposal_operate');

    try {
      const assetForRoom = supportedAssets.find(
        (asset) => asset.symbol.toLowerCase() === activeRoom.asset_symbol.toLowerCase(),
      );
      if (!assetForRoom) {
        throw new Error('Room asset is not currently available on this clearnode');
      }

      const rawAmount = await client.parseAmount(assetForRoom.token, proposalAmount);
      if (rawAmount <= 0n) throw new Error('Proposal amount must be greater than 0');

      const nextVersion = nextSessionVersion;
      const requester = normalizeAddress(walletAddress) === normalizeAddress(activeRoom.participant_a)
        ? activeRoom.participant_a
        : activeRoom.participant_b;
      const counterparty =
        requester === activeRoom.participant_a
          ? activeRoom.participant_b
          : activeRoom.participant_a;

      const baseAllocations = getRoomSessionAllocations();
      const balanceByParticipant = new Map<string, bigint>(
        baseAllocations.map((allocation) => [normalizeAddress(allocation.participant), BigInt(allocation.amount)]),
      );

      const requesterBalance = balanceByParticipant.get(normalizeAddress(requester)) ?? 0n;
      const counterpartyBalance = balanceByParticipant.get(normalizeAddress(counterparty)) ?? 0n;
      if (requesterBalance < rawAmount) {
        throw new Error('Insufficient app-session balance. Create a Session Deposit Proposal first.');
      }

      const allocations: RPCAppSessionAllocation[] = [
        {
          participant: requester as Hex,
          asset: activeRoom.asset_symbol,
          amount: (requesterBalance - rawAmount).toString(),
        },
        {
          participant: counterparty as Hex,
          asset: activeRoom.asset_symbol,
          amount: (counterpartyBalance + rawAmount).toString(),
        },
      ];
      // Quorum signatures must hash the same human-form amounts that compat submits to clearnode.
      const signingAllocations = allocations.map((allocation) => ({
        ...allocation,
        amount: formatUnits(BigInt(allocation.amount), assetForRoom.decimals),
      }));

      const payload: SubmitAppStateRequestParamsV04 = {
        app_session_id: activeRoom.app_session_id as Hex,
        intent: RPCAppStateIntent.Operate,
        version: nextVersion,
        allocations,
        session_data: buildCosignSessionData(activeRoom.id, {
          purpose: proposalPurpose,
          requestedBy: walletAddress,
          createdAt: new Date().toISOString(),
          action: 'checkout',
        }),
      };

      const payloadHash = packSubmitAppStateHash({
        appSessionId: payload.app_session_id,
        intent: payload.intent,
        version: payload.version,
        allocations: signingAllocations,
        sessionData: payload.session_data,
      });
      console.info('[cosign-demo] createOperateProposal payload', {
        appSessionId: payload.app_session_id,
        version: payload.version,
        requester,
        counterparty,
        baseAllocations,
        nextAllocations: payload.allocations,
        quorumHash: payloadHash,
      });

      await createProposal('operate', payload as unknown as Record<string, unknown>, payloadHash);
    } catch (error) {
      console.error('[cosign-demo] createOperateProposal failed', error);
      setSystemMessage(error instanceof Error ? error.message : 'Failed to create operate proposal');
    } finally {
      setBusy(null);
    }
  }, [
    activeRoom,
    activeSession,
    nextSessionVersion,
    client,
    walletAddress,
    supportedAssets,
    proposalAmount,
    proposalPurpose,
    getRoomSessionAllocations,
    createProposal,
  ]);

  const createCloseProposal = useCallback(async () => {
    if (!activeRoom?.app_session_id) return;

    setBusy('proposal_close');

    try {
      const nextVersion = nextSessionVersion;
      const allocations: RPCAppSessionAllocation[] = getRoomSessionAllocations();

      const payload = {
        app_session_id: activeRoom.app_session_id,
        version: nextVersion,
        allocations,
        session_data: buildCosignSessionData(activeRoom.id, {
          action: 'close_checkout',
          createdAt: new Date().toISOString(),
        }),
      };
      const signingAllocations = allocations.map((allocation) => {
        const asset = core.assets.find(
          (entry) =>
            entry.symbol.toLowerCase() === allocation.asset.toLowerCase() &&
            entry.chainId === SEPOLIA_CHAIN_ID,
        );
        const decimals = asset?.decimals ?? 6;
        return {
          ...allocation,
          amount: formatUnits(BigInt(allocation.amount), decimals),
        };
      });

      const payloadHash = packSubmitAppStateHash({
        appSessionId: activeRoom.app_session_id,
        intent: 'close',
        version: nextVersion,
        allocations: signingAllocations,
        sessionData: payload.session_data,
      });

      await createProposal('close_session', payload, payloadHash);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to create close proposal');
    } finally {
      setBusy(null);
    }
  }, [activeRoom, nextSessionVersion, core.assets, getRoomSessionAllocations, createProposal]);

  const signProposal = useCallback(async (proposal: Proposal) => {
    if (!walletClient || !walletAddress) {
      setSystemMessage('Connect wallet before signing proposals.');
      return;
    }

    setBusy('proposal_sign');

    try {
      if (!walletClient.account) throw new Error('Wallet account is missing');
      const signerAddress = normalizeAddress(walletClient.account.address);
      const connectedAddress = normalizeAddress(walletAddress);
      if (signerAddress !== connectedAddress) {
        throw new Error(
          `Wallet mismatch: active signer ${walletClient.account.address} differs from connected wallet ${walletAddress}. Reconnect wallet and try again.`,
        );
      }

      const rawSig = await walletClient.signMessage({
        account: walletClient.account,
        message: { raw: proposal.payload_hash as Hex },
      });
      const recoveredAddress = normalizeAddress(
        await recoverMessageAddress({
          message: { raw: proposal.payload_hash as Hex },
          signature: rawSig as Hex,
        }),
      );
      if (recoveredAddress !== connectedAddress) {
        throw new Error(
          `Signed with ${recoveredAddress}, expected ${connectedAddress}. Switch to the connected wallet account and sign again.`,
        );
      }
      const quorumSig = toWalletQuorumSignature(rawSig);
      console.info('[cosign-demo] signProposal', {
        proposalId: proposal.id,
        kind: proposal.kind,
        wallet: walletAddress,
        payloadHash: proposal.payload_hash,
      });

      await postJson(`/api/proposals/${proposal.id}/sign`, {
        wallet: walletAddress,
        signature: quorumSig,
      });

      if (activeRoomId) {
        await fetchRoomThread(activeRoomId);
      }

      setSystemMessage('Proposal signed. Waiting for quorum if needed.');
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Failed to sign proposal');
    } finally {
      setBusy(null);
    }
  }, [walletClient, walletAddress, activeRoomId, fetchRoomThread]);

  const submitProposal = useCallback(async (proposal: Proposal) => {
    if (!client || !walletAddress || !activeRoom) return;

    setBusy('proposal_submit');

    const signatures = Object.values(proposal.signatures_json ?? {});
    if (signatures.length === 0) {
      setSystemMessage('No signatures found for this proposal.');
      setBusy(null);
      return;
    }

    let appSessionId: string | undefined;

    try {
      let sdkResult: Record<string, unknown> = {};
      console.info('[cosign-demo] submitProposal start', {
        proposalId: proposal.id,
        kind: proposal.kind,
        wallet: walletAddress,
        signatureCount: signatures.length,
        payloadIntent: (proposal.payload_json as { intent?: string }).intent ?? null,
      });

      if (proposal.kind === 'create_session') {
        const payload = proposal.payload_json as {
          definition: RPCAppDefinition;
          allocations: RPCAppSessionAllocation[];
          session_data?: string;
        };

        const result = await client.createAppSession({
          definition: payload.definition,
          allocations: payload.allocations,
          session_data: payload.session_data,
          quorum_sigs: signatures,
        });

        appSessionId = result.appSessionId;
        sdkResult = result as unknown as Record<string, unknown>;
      }

      if (proposal.kind === 'operate') {
        const payload = proposal.payload_json as unknown as SubmitAppStateRequestParamsV04;
        if (payload.intent === RPCAppStateIntent.Deposit) {
          const baseAllocations = getRoomSessionAllocations();
          const baseByParticipant = new Map<string, bigint>(
            baseAllocations.map((allocation) => [
              `${normalizeAddress(allocation.participant)}::${allocation.asset.toLowerCase()}`,
              BigInt(allocation.amount),
            ]),
          );

          const positiveParticipants = new Set<string>();
          const positiveDeltas: Array<{ participant: string; asset: string }> = [];
          for (const allocation of payload.allocations) {
            const key = `${normalizeAddress(allocation.participant)}::${allocation.asset.toLowerCase()}`;
            const currentAmount = baseByParticipant.get(key) ?? 0n;
            if (BigInt(allocation.amount) > currentAmount) {
              const participant = normalizeAddress(allocation.participant);
              positiveParticipants.add(participant);
              positiveDeltas.push({ participant, asset: allocation.asset });
            }
          }

          if (
            positiveParticipants.size === 1 &&
            !positiveParticipants.has(normalizeAddress(walletAddress))
          ) {
            throw new Error('Only the depositing participant should submit this deposit proposal.');
          }

          if (positiveParticipants.size === 1) {
            const depositor = Array.from(positiveParticipants)[0];
            const depositAsset =
              positiveDeltas.find((delta) => delta.participant === depositor)?.asset ??
              activeRoom.asset_symbol;
            await ensureWalletCanSubmitSessionDeposit(depositAsset);
          }
        }

        const result = await client.submitAppState({
          ...payload,
          app_session_id: payload.app_session_id as Hex,
          quorum_sigs: signatures,
        });
        console.info('[cosign-demo] submitProposal operate result', {
          proposalId: proposal.id,
          intent: payload.intent,
          result,
        });

        sdkResult = result as unknown as Record<string, unknown>;
      }

      if (proposal.kind === 'close_session') {
        const payload = proposal.payload_json as {
          app_session_id: string;
          allocations?: RPCAppSessionAllocation[];
          version?: number;
          session_data?: string;
        };

        const result = await client.closeAppSession({
          app_session_id: payload.app_session_id,
          allocations: payload.allocations ?? [],
          version: payload.version,
          session_data: payload.session_data,
          quorum_sigs: signatures,
        });

        sdkResult = result as unknown as Record<string, unknown>;
      }

      await postJson(`/api/proposals/${proposal.id}/submit`, {
        wallet: walletAddress,
        outcome: 'submitted',
        sdkResult,
        appSessionId,
      });

      await Promise.all([refreshCoreData(), fetchRooms(), fetchRoomThread(activeRoom.id)]);
      setSystemMessage('Proposal submitted successfully.');
    } catch (error) {
      const transient = isRetryableSubmitError(error);
      const missingHomeChannel = isMissingHomeChannelForDeposit(error);
      const recoverable = transient || missingHomeChannel;
      console.error('[cosign-demo] submitProposal failed', {
        proposalId: proposal.id,
        kind: proposal.kind,
        wallet: walletAddress,
        message: error instanceof Error ? error.message : String(error),
        recoverable,
      });

      if (!recoverable) {
        await postJson(`/api/proposals/${proposal.id}/submit`, {
          wallet: walletAddress,
          outcome: 'failed',
          error: error instanceof Error ? error.message : 'Submission failed',
        }).catch(() => null);
      }

      setSystemMessage(
        transient
          ? 'Connection dropped while applying. This decision is still ready. Reconnect and tap Apply Decision again.'
          : missingHomeChannel
          ? 'This wallet cannot add funds to checkout yet. Add funds to your shared wallet first, then tap Apply Decision again.'
          : error instanceof Error
          ? error.message
          : 'Failed to submit proposal',
      );
      await Promise.all([fetchRooms(), fetchRoomThread(activeRoom.id)]).catch(() => null);
    } finally {
      setBusy(null);
    }
  }, [
    client,
    walletAddress,
    activeRoom,
    getRoomSessionAllocations,
    ensureWalletCanSubmitSessionDeposit,
    refreshCoreData,
    fetchRooms,
    fetchRoomThread,
  ]);

  const runDeposit = useCallback(async () => {
    if (!client || !selectedAsset) return;

    setBusy('deposit');
    try {
      const raw = await client.parseAmount(selectedAsset.token, fundingAmount);
      await client.deposit(selectedAsset.token as Address, raw);
      await refreshCoreData();
      setSystemMessage(`Added ${fundingAmount} ${selectedAsset.symbol.toUpperCase()} to your shared wallet.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Deposit failed');
    } finally {
      setBusy(null);
    }
  }, [client, selectedAsset, fundingAmount, refreshCoreData]);

  const runWithdraw = useCallback(async () => {
    if (!client || !selectedAsset) return;

    setBusy('withdraw');
    try {
      const raw = await client.parseAmount(selectedAsset.token, withdrawAmount);
      await client.withdrawal(selectedAsset.token as Address, raw);
      await refreshCoreData();
      setSystemMessage(`Moved ${withdrawAmount} ${selectedAsset.symbol.toUpperCase()} back to your on-chain wallet.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Withdraw failed');
    } finally {
      setBusy(null);
    }
  }, [client, selectedAsset, withdrawAmount, refreshCoreData]);

  const runTransferToCounterparty = useCallback(async () => {
    if (!client || !selectedAsset || !activeRoom) return;

    setBusy('transfer');
    try {
      const counterparty = counterpartOf(activeRoom, walletAddress ?? activeRoom.participant_a);
      const raw = await client.parseAmount(selectedAsset.token, transferAmount);

      await client.transfer(counterparty as Address, [
        {
          asset: selectedAsset.symbol,
          amount: raw.toString(),
        },
      ]);

      await refreshCoreData();
      setSystemMessage(`Transferred ${transferAmount} ${selectedAsset.symbol.toUpperCase()} to counterparty.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Transfer failed');
    } finally {
      setBusy(null);
    }
  }, [client, selectedAsset, activeRoom, walletAddress, transferAmount, refreshCoreData]);

  const runCloseChannel = useCallback(async () => {
    if (!client || !selectedAsset) return;

    setBusy('close_channel');
    try {
      await client.closeChannel({ tokenAddress: selectedAsset.token });
      await refreshCoreData();
      setSystemMessage(`Closed the ${selectedAsset.symbol.toUpperCase()} shared wallet channel.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : 'Close channel failed');
    } finally {
      setBusy(null);
    }
  }, [client, selectedAsset, refreshCoreData]);

  const runDevAction = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setDevBusy(name);
      try {
        const result = await fn();
        setDevOutput(stringifyDevValue({
          action: name,
          at: new Date().toISOString(),
          result,
        }));
      } catch (error) {
        setDevOutput(stringifyDevValue({
          action: name,
          at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setDevBusy(null);
      }
    },
    [],
  );

  const hasSignedActiveProposal = useMemo(() => {
    if (!activeProposal || !walletAddress) return false;
    return Object.keys(activeProposal.signatures_json ?? {})
      .map(normalizeAddress)
      .includes(normalizeAddress(walletAddress));
  }, [activeProposal, walletAddress]);

  const getParticipantDisplayName = useCallback((participant: string): string => {
    const normalized = normalizeAddress(participant);
    if (walletAddress && normalized === normalizeAddress(walletAddress)) return 'You';
    const alias = aliases[normalized];
    if (alias) return `${alias} (Friend)`;
    return `Friend ${shortAddress(participant, 6)}`;
  }, [walletAddress, aliases]);

  const currentCounterparty = useMemo(() => {
    if (!activeRoom || !walletAddress) return null;
    return counterpartOf(activeRoom, walletAddress);
  }, [activeRoom, walletAddress]);

  const submitConfirmProposal = useMemo(() => {
    if (!submitConfirmProposalId) return null;
    if (activeProposal?.id === submitConfirmProposalId) return activeProposal;
    return proposals.find((proposal) => proposal.id === submitConfirmProposalId) ?? null;
  }, [submitConfirmProposalId, activeProposal, proposals]);

  const submitConfirmPreview = useMemo(() => {
    if (!submitConfirmProposal || !activeRoom) return null;

    const payload = submitConfirmProposal.payload_json as {
      intent?: string;
      allocations?: RPCAppSessionAllocation[];
      version?: number | string;
    };

    const decimals = activeRoomAsset?.decimals ?? 6;
    const baseAllocations = getRoomSessionAllocations();
    const beforeByParticipant = new Map<string, bigint>([
      [normalizeAddress(activeRoom.participant_a), 0n],
      [normalizeAddress(activeRoom.participant_b), 0n],
    ]);

    for (const allocation of baseAllocations) {
      if (allocation.asset.toLowerCase() !== activeRoom.asset_symbol.toLowerCase()) continue;
      beforeByParticipant.set(normalizeAddress(allocation.participant), BigInt(allocation.amount));
    }

    const nextAllocations =
      Array.isArray(payload.allocations) && payload.allocations.length > 0
        ? payload.allocations
        : baseAllocations;

    const afterByParticipant = new Map<string, bigint>(beforeByParticipant);
    for (const allocation of nextAllocations) {
      if (allocation.asset.toLowerCase() !== activeRoom.asset_symbol.toLowerCase()) continue;
      const participant = normalizeAddress(allocation.participant);
      if (!afterByParticipant.has(participant)) continue;
      afterByParticipant.set(participant, BigInt(allocation.amount));
    }

    const participants = [activeRoom.participant_a, activeRoom.participant_b];
    const rows = participants.map((participant) => {
      const key = normalizeAddress(participant);
      const before = beforeByParticipant.get(key) ?? 0n;
      const after = afterByParticipant.get(key) ?? 0n;
      const delta = after - before;
      return {
        participant,
        before,
        after,
        delta,
      };
    });

    const positive = rows.find((row) => row.delta > 0n) ?? null;
    const negative = rows.find((row) => row.delta < 0n) ?? null;
    const actionLabel = toHumanProposalLabel(submitConfirmProposal.kind, submitConfirmProposal.payload_json);

    let summary = `This will apply "${actionLabel}" for both shoppers.`;
    if (submitConfirmProposal.kind === 'create_session') {
      summary = 'This starts a shared checkout for this cart. After this, both shoppers can approve add-funds and purchase decisions.';
    } else if (submitConfirmProposal.kind === 'close_session') {
      summary = 'This finishes the shared checkout. No new add-funds or purchase decisions can be applied on this cart.';
    } else if (payload.intent === RPCAppStateIntent.Deposit && positive) {
      summary = `${getParticipantDisplayName(positive.participant)} adds ${formatUnits(positive.delta, decimals)} ${activeRoom.asset_symbol.toUpperCase()} into this checkout.`;
    } else if (payload.intent === RPCAppStateIntent.Operate && positive && negative) {
      summary = `${getParticipantDisplayName(negative.participant)} pays ${formatUnits(-negative.delta, decimals)} ${activeRoom.asset_symbol.toUpperCase()} to ${getParticipantDisplayName(positive.participant)} inside this checkout.`;
    }

    return {
      actionLabel,
      summary,
      rows,
    };
  }, [
    submitConfirmProposal,
    activeRoom,
    activeRoomAsset,
    getRoomSessionAllocations,
    getParticipantDisplayName,
  ]);

  const openSubmitConfirm = useCallback((proposal: Proposal) => {
    setSubmitConfirmProposalId(proposal.id);
  }, []);

  const closeSubmitConfirm = useCallback(() => {
    setSubmitConfirmProposalId(null);
  }, []);

  const confirmSubmitProposal = useCallback(async () => {
    if (!submitConfirmProposal) return;
    const proposal = submitConfirmProposal;
    setSubmitConfirmProposalId(null);
    await submitProposal(proposal);
  }, [submitConfirmProposal, submitProposal]);

  const roomShareUrl = useMemo(() => {
    if (!activeRoomId || typeof window === 'undefined') return '';
    return `${window.location.origin}/r/${activeRoomId}`;
  }, [activeRoomId]);

  const aliasKey = useMemo(
    () => (currentCounterparty ? normalizeAddress(currentCounterparty) : ''),
    [currentCounterparty],
  );
  const onboardingSlide = ONBOARDING_SLIDES[onboardingIndex];

  const nextOnboardingSlide = useCallback(() => {
    setOnboardingIndex((index) => (index + 1) % ONBOARDING_SLIDES.length);
  }, []);

  const prevOnboardingSlide = useCallback(() => {
    setOnboardingIndex((index) => (index - 1 + ONBOARDING_SLIDES.length) % ONBOARDING_SLIDES.length);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setOnboardingIndex((index) => (index + 1) % ONBOARDING_SLIDES.length);
    }, 9000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!submitConfirmProposalId) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSubmitConfirmProposalId(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [submitConfirmProposalId]);

  return (
    <main className="mx-auto max-w-7xl px-4 pb-10 pt-6 md:px-8 md:pt-10">
      <section className="card mb-6 overflow-hidden">
        <div className="bg-hero-grid px-5 py-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-700">Yellow Network Demo</p>
              <div className="mt-2 flex items-center gap-2">
                <h1 className="text-2xl font-black uppercase leading-tight text-black md:text-4xl">
                  Co-Sign Checkout
                </h1>
                <InfoHint text="Business-friendly shared checkout where two people must agree before purchases are applied." />
              </div>
              <p className="mt-2 max-w-2xl text-sm text-neutral-800 md:text-base">
                Two shoppers in two browsers can co-approve purchases with equal weight (50/50).
                Under the hood this uses secure off-chain ledgers, but you can think of it as a shared wallet with approvals.
              </p>
            </div>

            <div className="flex flex-col gap-2 text-sm md:items-end">
              <div className="rounded-lg border border-black/10 bg-white px-3 py-2 font-mono text-xs md:text-sm">
                {walletAddress ? shortAddress(walletAddress, 10) : 'Wallet not connected'}
              </div>
              <p className="text-[11px] text-neutral-700">
                {walletAddress
                  ? walletProviderSource === 'metamask_sdk'
                    ? 'Connected via MetaMask Mobile'
                    : 'Connected via MetaMask extension'
                  : 'Sepolia network required'}
              </p>
              <div className="flex gap-2">
                {!walletAddress ? (
                  <button
                    className="btn-primary rounded-md px-4 py-2 font-semibold"
                    onClick={connectWallet}
                    disabled={busy === 'connect_wallet'}>
                    {busy === 'connect_wallet' ? 'Connecting...' : 'Connect Wallet'}
                  </button>
                ) : (
                  <button
                    className="btn-secondary rounded-md px-4 py-2 font-semibold"
                    onClick={disconnectWallet}
                    disabled={busy === 'disconnect_wallet'}>
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </div>

          <p className="mt-4 rounded-md border border-yellow-300 bg-yellow-100 px-3 py-2 text-sm text-neutral-900">
            {systemMessage}
          </p>
          {sessionSyncWarning ? (
            <p className="mt-2 rounded-md border border-orange-300 bg-orange-100 px-3 py-2 text-sm text-orange-900">
              {sessionSyncWarning}
            </p>
          ) : null}
        </div>
      </section>

      <section className="card mb-6 p-4 md:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">How To Use</h2>
              <InfoHint text="Quick guided flow for first-time users. You can move through each step manually or wait for auto-slide." />
            </div>
            <p className="mt-1 text-xs text-neutral-700">
              Step {onboardingIndex + 1} of {ONBOARDING_SLIDES.length}
            </p>
          </div>

          <div className="flex gap-2">
            <button className="btn-secondary rounded-md px-3 py-1.5 text-sm font-semibold" onClick={prevOnboardingSlide}>
              Back
            </button>
            <button className="btn-primary rounded-md px-3 py-1.5 text-sm font-semibold" onClick={nextOnboardingSlide}>
              Next
            </button>
          </div>
        </div>

        <div className="onboarding-slide mt-4 rounded-xl border p-4 md:p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-700">
            {onboardingSlide.subtitle}
          </p>
          <h3 className="mt-2 text-xl font-bold text-black md:text-2xl">{onboardingSlide.title}</h3>
          <p className="mt-2 max-w-3xl text-sm text-neutral-800 md:text-base">{onboardingSlide.description}</p>
        </div>

        <div className="mt-4 flex items-center gap-2">
          {ONBOARDING_SLIDES.map((slide, index) => (
            <button
              key={slide.title}
              className={`onboarding-dot ${index === onboardingIndex ? 'is-active' : ''}`}
              aria-label={`Go to step ${index + 1}`}
              onClick={() => setOnboardingIndex(index)}
            />
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-4">
          <div className="card p-4 md:p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">Create Shared Cart</h2>
              <InfoHint text="Create a shared cart between two wallet addresses." />
            </div>
            <p className="mt-1 text-sm text-neutral-600">Invite one teammate to co-sign checkout approvals.</p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Counterparty Wallet</span>
                <input
                  value={createRoomCounterparty}
                  onChange={(event) => setCreateRoomCounterparty(event.target.value)}
                  placeholder="0x..."
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">Asset</span>
                <select
                  value={createRoomAsset}
                  onChange={(event) => setCreateRoomAsset(event.target.value as 'usdc' | 'weth')}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm">
                  <option value="usdc">USDC</option>
                  <option value="weth">WETH</option>
                </select>
              </label>

              <button
                className="btn-primary w-full rounded-md px-4 py-2 font-semibold"
                onClick={createRoom}
                disabled={!walletAddress || busy === 'create_room'}>
                {busy === 'create_room' ? 'Creating...' : 'Create Shared Cart'}
              </button>
            </div>
          </div>

          <div className="card p-4 md:p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold">Your Shared Carts</h2>
                <InfoHint text="All shared carts where your wallet participates." />
              </div>
              <span className="text-xs text-neutral-500">{rooms.length} total</span>
            </div>

            <div className="mt-3 space-y-2">
              {rooms.length === 0 ? (
                <p className="text-sm text-neutral-600">No shared carts yet.</p>
              ) : (
                rooms.map((room) => (
                  (() => {
                    const roomSession = room.app_session_id
                      ? core.sessions.find(
                          (session) =>
                            normalizeAddress(session.app_session_id) === normalizeAddress(room.app_session_id!),
                        ) ?? null
                      : null;
                    const roomStatus = roomSession?.status ?? room.status;
                    const roomStatusLabel = toHumanCheckoutStatus(roomStatus);
                    return (
                      <button
                        key={room.id}
                        className={`w-full rounded-md border px-3 py-2 text-left transition ${
                          room.id === activeRoomId
                            ? 'border-black bg-yellow-100'
                            : 'border-neutral-200 bg-white hover:border-neutral-400'
                        }`}
                        onClick={() => {
                          setActiveRoomId(room.id);
                          router.push(`/r/${room.id}`);
                        }}>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs">{shortAddress(room.id, 8)}</span>
                          <span className={toStatusBadgeClass(roomStatus)}>{roomStatusLabel}</span>
                        </div>
                        <p className="mt-1 text-xs text-neutral-600">
                          {room.asset_symbol.toUpperCase()} • {shortAddress(room.participant_a)} + {shortAddress(room.participant_b)}
                        </p>
                      </button>
                    );
                  })()
                ))
              )}
            </div>
          </div>

          <div className="card p-4 md:p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">Sessions With Friends</h2>
              <InfoHint text="Aggregated open and closed Co-Sign sessions grouped by counterparty wallet." />
            </div>
            <div className="mt-3 space-y-2">
              {friendSessionSummary.length === 0 ? (
                <p className="text-sm text-neutral-600">No app sessions yet.</p>
              ) : (
                friendSessionSummary.map((summary) => {
                  const label = aliases[summary.counterparty] || shortAddress(summary.counterparty, 8);
                  const linkedRoom = roomByCounterparty.get(summary.counterparty);
                  return (
                    <div key={summary.counterparty} className="rounded-md border border-neutral-200 p-2 text-sm">
                      <p className="font-semibold">{label}</p>
                      <p className="text-xs text-neutral-600">
                        {summary.total} total • {summary.open} open • {summary.closed} closed
                      </p>
                      {linkedRoom ? (
                        <button
                          className="mt-2 btn-secondary rounded px-2 py-1 text-xs font-semibold"
                          onClick={() => {
                            setActiveRoomId(linkedRoom.id);
                            router.push(`/r/${linkedRoom.id}`);
                          }}>
                          Open Cart
                        </button>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6 lg:col-span-8">
          <div className="card p-4 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold">Shared Cart Workspace</h2>
                  <InfoHint text="Main area for shopper approvals, cart actions, and checkout lifecycle." />
                </div>
                {!activeRoom ? (
                  <p className="mt-1 text-sm text-neutral-600">Select a shared cart to begin.</p>
                ) : (
                  <>
                    <p className="mt-1 font-mono text-xs text-neutral-700">Cart ID: {activeRoom.id}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className={toStatusBadgeClass(activeRoom.status)}>{activeRoom.status}</span>
                      <span className="badge badge-closed">{activeRoom.asset_symbol.toUpperCase()}</span>
                      <span className="badge badge-closed">Sepolia</span>
                    </div>
                  </>
                )}
              </div>

              {activeRoom && roomShareUrl ? (
                <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs">
                  <p className="font-semibold">Share Invite URL</p>
                  <p className="mt-1 font-mono break-all">{roomShareUrl}</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="btn-primary rounded px-2 py-1 text-xs font-semibold"
                      onClick={() => navigator.clipboard.writeText(roomShareUrl)}>
                      Copy
                    </button>
                    <Link href={roomShareUrl} className="btn-secondary rounded px-2 py-1 text-xs font-semibold">
                      Open
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>

            {activeRoom ? (
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-md border border-neutral-200 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">Shoppers</p>
                    <InfoHint text="Both shoppers have equal approval weight (50/50)." />
                  </div>
                  <p className="mt-2 break-all font-mono text-xs leading-relaxed">A: {activeRoom.participant_a}</p>
                  <p className="mt-1 break-all font-mono text-xs leading-relaxed">B: {activeRoom.participant_b}</p>
                  <p className="mt-2 text-xs text-neutral-600">Quorum: 100 (50/50 equal weight)</p>

                  {currentCounterparty ? (
                    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-2">
                      <p className="text-xs font-semibold">Counterparty Label</p>
                      <div className="mt-1 flex gap-2">
                        <input
                          className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
                          placeholder={shortAddress(currentCounterparty, 8)}
                          value={aliasInput}
                          onChange={(event) => setAliasInput(event.target.value)}
                        />
                        <button className="btn-primary rounded px-2 py-1 text-xs font-semibold" onClick={upsertAlias}>
                          Save
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-md border border-neutral-200 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">Checkout Status</p>
                    <InfoHint text="Current shared checkout ID, status, and version for this cart." />
                  </div>
                  <p className="mt-2 text-xs text-neutral-600">
                    App Session ID:
                    <span className="mt-1 block max-w-full break-all font-mono text-[11px] leading-relaxed text-neutral-900">
                      {activeRoom.app_session_id ?? 'Not created'}
                    </span>
                  </p>
                  <p className="mt-2 text-xs text-neutral-600">Current Version: {activeSession?.version ?? '-'}</p>
                  <p className="mt-1 text-xs text-neutral-600">
                    Status: {activeSession ? toHumanCheckoutStatus(activeSession.status) : 'no session'}
                  </p>
                  {activeRoom.app_session_id && !isActiveRoomSessionVisible ? (
                    <p className="mt-2 rounded border border-orange-300 bg-orange-100 px-2 py-1 text-[11px] text-orange-900">
                      This cart points to a session that is not visible on the current Clearnode. Create a new shared cart with your friend.
                    </p>
                  ) : null}
                  <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-2">
                    <p className="text-[11px] font-semibold text-neutral-700">
                      Checkout Balance Breakdown ({activeRoom.asset_symbol.toUpperCase()})
                    </p>
                    {activeSessionBalanceRows.length === 0 ? (
                      <p className="mt-1 text-[11px] text-neutral-600">No funds are inside this checkout yet.</p>
                    ) : (
                      <>
                        <p className="mt-1 text-[11px] text-neutral-700">
                          Total in checkout: {activeSessionBalanceTotal} {activeRoom.asset_symbol.toUpperCase()}
                        </p>
                        {activeSessionBalanceRows.map((row) => (
                          <p key={row.participant} className="mt-1 break-all text-[11px] text-neutral-700">
                            {getParticipantDisplayName(row.participant)}: <span className="font-mono">{row.amount}</span>
                          </p>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {activeRoom ? (
              <div className="mt-4 rounded-md border border-neutral-200 p-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">Cart Actions</h3>
                  <InfoHint text="Each action needs both shoppers to agree before it is applied." />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="inline-flex items-center gap-2">
                    <button
                      className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                      onClick={createSessionProposal}
                      disabled={Boolean(activeRoom.app_session_id) || busy === 'proposal_create_session' || areRoomActionsLocked}>
                      {busy === 'proposal_create_session' ? 'Creating...' : 'Start Shared Checkout'}
                    </button>
                    <InfoHint text="Opens shared checkout for this cart. Both shoppers must approve once." />
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <span title={addFundsToCheckoutDisabledReason ?? undefined} className="inline-flex">
                      <button
                        className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                        onClick={createDepositProposal}
                        disabled={Boolean(addFundsToCheckoutDisabledReason) || busy === 'proposal_deposit'}>
                        {busy === 'proposal_deposit' ? 'Creating...' : 'Add Funds To Checkout'}
                      </button>
                    </span>
                    <InfoHint text="Moves funds into checkout balance. The wallet adding funds must submit after both agree." />
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <button
                      className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                      onClick={createOperateProposal}
                      disabled={!activeRoom.app_session_id || busy === 'proposal_operate' || areRoomActionsLocked}>
                      {busy === 'proposal_operate' ? 'Creating...' : 'Propose Purchase'}
                    </button>
                    <InfoHint text="Approves a purchase by reallocating funds already inside checkout." />
                  </div>
                  <div className="inline-flex items-center gap-2">
                    <button
                      className="btn-secondary rounded px-3 py-2 text-sm font-semibold"
                      onClick={createCloseProposal}
                      disabled={!activeRoom.app_session_id || busy === 'proposal_close' || areRoomActionsLocked}>
                      {busy === 'proposal_close' ? 'Creating...' : 'Finish Checkout'}
                    </button>
                    <InfoHint text="Finishes checkout with final balances so no new purchases can be proposed." />
                  </div>
                </div>
                {activeRoom.app_session_id && activeRoomAsset ? (
                  <p
                    className={`mt-3 rounded border px-3 py-2 text-xs ${
                      hasReadyWalletChannelForActiveRoomAsset
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : 'border-orange-300 bg-orange-100 text-orange-900'
                    }`}>
                    Shared wallet channel for {activeRoom.asset_symbol.toUpperCase()}:{' '}
                    {hasReadyWalletChannelForActiveRoomAsset
                      ? 'ready'
                      : `not ready. Open a channel with ${activeRoom.asset_symbol.toUpperCase()} to be able to add funds to checkout.`}
                  </p>
                ) : null}
                {areRoomActionsLocked ? (
                  <p className="mt-3 rounded border border-neutral-300 bg-neutral-100 px-3 py-2 text-xs text-neutral-700">
                    {roomActionLockMessage}
                  </p>
                ) : null}

                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-neutral-700">Amount ({activeRoom.asset_symbol.toUpperCase()})</span>
                    <input
                      value={proposalAmount}
                      onChange={(event) => setProposalAmount(event.target.value)}
                      disabled={areRoomActionsLocked}
                      className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-neutral-700">Purchase Note</span>
                    <input
                      value={proposalPurpose}
                      onChange={(event) => setProposalPurpose(event.target.value)}
                      disabled={areRoomActionsLocked}
                      className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {activeProposal && activeRoom ? (
              <div className="mt-4 rounded-md border border-black/20 bg-yellow-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold uppercase">Current Decision: {activeProposalDisplayLabel}</p>
                  <span className={toStatusBadgeClass(activeProposal.status)}>{activeProposal.status}</span>
                </div>

                <p className="mt-2 text-xs text-neutral-700">Hash:</p>
                <p className="mt-1 break-all rounded border border-neutral-200 bg-white/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-neutral-800">
                  {activeProposal.payload_hash}
                </p>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span>Team Approval</span>
                    <span>{signatureProgress}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-black/10">
                    <div className="h-full bg-yellow-brand" style={{ width: `${signatureProgress}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-neutral-700">
                    Approvals: {Object.keys(activeProposal.signatures_json ?? {}).length}/2
                  </p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                    onClick={() => signProposal(activeProposal)}
                    disabled={busy === 'proposal_sign' || hasSignedActiveProposal || areRoomActionsLocked}>
                    {hasSignedActiveProposal
                      ? 'Signed'
                      : busy === 'proposal_sign'
                      ? 'Signing...'
                      : 'Agree'}
                  </button>

                  <button
                    className="btn-secondary rounded px-3 py-2 text-sm font-semibold"
                    onClick={() => openSubmitConfirm(activeProposal)}
                    disabled={busy === 'proposal_submit' || !canSubmitActiveProposal || areRoomActionsLocked}>
                    {busy === 'proposal_submit' ? 'Applying...' : 'Review & Apply'}
                  </button>
                </div>
                {activeProposalLabel === 'session_deposit' &&
                activeProposal.status === 'ready' &&
                walletAddress &&
                activeDepositSubmitter &&
                normalizeAddress(walletAddress) !== activeDepositSubmitter ? (
                  <p className="mt-2 text-xs text-neutral-700">
                    Add-funds decisions must be applied by depositor {shortAddress(activeDepositSubmitter, 8)}.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-5">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">Activity Feed</h3>
                <InfoHint text="Chronological feed of cart actions, approvals, and applied decisions." />
              </div>
              <div className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
                {events.length === 0 ? (
                  <p className="text-sm text-neutral-600">No events yet.</p>
                ) : (
                  events.map((event) => (
                    <div key={event.id} className="rounded-md border border-neutral-200 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold uppercase text-neutral-800">{toHumanEventType(event)}</span>
                        <span className="text-neutral-500">{formatDate(event.created_at)}</span>
                      </div>
                      <p className="mt-1 font-mono text-neutral-600">{shortAddress(event.actor, 8)}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="card p-4 md:p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">Shared Wallet</h2>
              <InfoHint text="Add funds, move funds back to your wallet, and send money to your friend." />
            </div>
            <p className="mt-1 text-sm text-neutral-600">
              These actions work even when no shared cart is active.
            </p>

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label>
                <span className="mb-1 block text-xs font-medium">Currency</span>
                <select
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                  value={selectedAsset?.symbol.toLowerCase() ?? ''}
                  disabled={!client || !walletAddress || supportedAssets.length === 0}
                  onChange={(event) => {
                    setFundsAssetSymbol(event.target.value === 'weth' ? 'weth' : 'usdc');
                  }}>
                  {supportedAssets.map((asset) => (
                    <option key={asset.token} value={asset.symbol.toLowerCase()}>
                      {asset.symbol.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium">Add Funds</span>
                <input
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                  value={fundingAmount}
                  onChange={(event) => setFundingAmount(event.target.value)}
                  disabled={areFundsActionsLocked || !client || !selectedAsset}
                />
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium">Move Back To Wallet</span>
                <input
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                  value={withdrawAmount}
                  onChange={(event) => setWithdrawAmount(event.target.value)}
                  disabled={areFundsActionsLocked || !client || !selectedAsset}
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                onClick={runDeposit}
                disabled={busy === 'deposit' || areFundsActionsLocked || !client || !selectedAsset}>
                {busy === 'deposit' ? 'Adding...' : 'Add Funds'}
              </button>
              <button
                className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                onClick={runWithdraw}
                disabled={busy === 'withdraw' || areFundsActionsLocked || !client || !selectedAsset}>
                {busy === 'withdraw' ? 'Moving...' : 'Withdraw To Wallet'}
              </button>
              <button
                className="btn-secondary rounded px-3 py-2 text-sm font-semibold"
                onClick={runCloseChannel}
                disabled={busy === 'close_channel' || areFundsActionsLocked || !client || !selectedAsset}>
                {busy === 'close_channel' ? 'Closing...' : 'Close Shared Wallet'}
              </button>
            </div>

            {activeRoom ? (
              <div className="mt-4 rounded-md border border-neutral-200 p-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">Send To Cart Friend</h3>
                  <InfoHint text="Send money directly from your shared wallet balance to your friend in this cart." />
                </div>
                <p className="mt-1 text-xs text-neutral-600">
                  Destination: {currentCounterparty ? shortAddress(currentCounterparty, 8) : '-'}
                </p>
                <div className="mt-2 flex gap-2">
                  <input
                    className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm"
                    value={transferAmount}
                    onChange={(event) => setTransferAmount(event.target.value)}
                    disabled={areCounterpartyTransferLocked || !client || !selectedAsset}
                    placeholder="0.5"
                  />
                  <button
                    className="btn-secondary rounded px-3 py-2 text-sm font-semibold"
                    onClick={runTransferToCounterparty}
                    disabled={busy === 'transfer' || areCounterpartyTransferLocked || !client || !selectedAsset}>
                    {busy === 'transfer' ? 'Sending...' : 'Transfer'}
                  </button>
                </div>
                {areCounterpartyTransferLocked ? (
                  <p className="mt-3 rounded border border-neutral-300 bg-neutral-100 px-3 py-2 text-xs text-neutral-700">
                    {roomActionLockMessage}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border border-neutral-200 p-3">
                <div className="flex items-center gap-2">
                  <p className="font-semibold">Wallet Balances</p>
                  <InfoHint text="How much of each currency is currently available in your shared wallet." />
                </div>
                <div className="mt-2 space-y-1 text-sm">
                  {core.balances.length === 0 ? (
                    <p className="text-neutral-600">No balances.</p>
                  ) : (
                    core.balances.map((balance) => {
                      const asset = core.assets.find(
                        (a) => a.symbol.toLowerCase() === balance.asset.toLowerCase() && a.chainId === SEPOLIA_CHAIN_ID,
                      );
                      const formatted = asset
                        ? formatUnits(BigInt(balance.amount), asset.decimals)
                        : balance.amount;

                      return (
                        <p key={`${balance.asset}-${balance.amount}`}>
                          <span className="font-semibold uppercase">{balance.asset}</span>: {formatted}
                        </p>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="rounded-md border border-neutral-200 p-3">
                <div className="flex items-center gap-2">
                  <p className="font-semibold">Wallet Connections</p>
                  <InfoHint text="Background payment links used to move funds quickly during shared checkout." />
                </div>
                <div className="mt-2 space-y-1 text-sm">
                  {core.channels.length === 0 ? (
                    <p className="text-neutral-600">No channels.</p>
                  ) : (
                    core.channels.map((channel) => (
                      <p key={channel.channel_id}>
                        <span className="font-mono text-xs">{shortAddress(channel.channel_id, 8)}</span>{' '}
                        <span className={toStatusBadgeClass(channel.status)}>{channel.status}</span>
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="card p-4 md:p-5">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold">Recent Wallet Activity</h2>
              <InfoHint text="Recent incoming and outgoing money movements with timestamps." />
            </div>
            <div className="mt-3 space-y-2">
              {core.entries.length === 0 ? (
                <p className="text-sm text-neutral-600">No recent wallet activity found.</p>
              ) : (
                core.entries.slice(0, 8).map((entry) => (
                  <div key={`${entry.id}-${entry.created_at}`} className="rounded-md border border-neutral-200 p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold uppercase">{entry.asset}</span>
                      <span>{formatDate(entry.created_at)}</span>
                    </div>
                    <p className="mt-1 text-neutral-700">
                      incoming: {entry.credit} • outgoing: {entry.debit}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card mt-6 p-4 md:p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">Developer Console</h2>
            <InfoHint text="Advanced compat API controls for debugging, diagnostics, and raw JSON inspection." />
          </div>
          <button
            className="btn-secondary rounded px-3 py-1 text-sm font-semibold"
            onClick={() => setDevOpen((open) => !open)}>
            {devOpen ? 'Hide' : 'Show'}
          </button>
        </div>

        {devOpen ? (
          <>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('ping', async () => client?.ping())} disabled={!client || !!devBusy}>ping</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getConfig', async () => client?.getConfig())} disabled={!client || !!devBusy}>getConfig</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getAssetsList', async () => client?.getAssetsList())} disabled={!client || !!devBusy}>getAssetsList</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('refreshAssets', async () => client?.refreshAssets())} disabled={!client || !!devBusy}>refreshAssets</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getChannels', async () => client?.getChannels())} disabled={!client || !!devBusy}>getChannels</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getBalances', async () => client?.getBalances())} disabled={!client || !!devBusy}>getBalances</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getLedgerEntries', async () => client?.getLedgerEntries())} disabled={!client || !!devBusy}>getLedgerEntries</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getAppSessionsList', async () => client?.getAppSessionsList())} disabled={!client || !!devBusy}>getAppSessionsList</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getAppDefinition', async () => activeRoom?.app_session_id ? client?.getAppDefinition(activeRoom.app_session_id) : 'no app session')} disabled={!client || !!devBusy}>getAppDefinition</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getAccountInfo', async () => client?.getAccountInfo())} disabled={!client || !!devBusy}>getAccountInfo</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('resolveToken', async () => selectedAsset ? client?.resolveToken(selectedAsset.token) : 'no asset')} disabled={!client || !!devBusy}>resolveToken</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('resolveAsset', async () => selectedAsset ? client?.resolveAsset(selectedAsset.symbol) : 'no asset')} disabled={!client || !!devBusy}>resolveAsset</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('resolveAssetDisplay', async () => selectedAsset ? client?.resolveAssetDisplay(selectedAsset.token) : 'no asset')} disabled={!client || !!devBusy}>resolveAssetDisplay</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getTokenDecimals', async () => selectedAsset ? client?.getTokenDecimals(selectedAsset.token) : 'no asset')} disabled={!client || !!devBusy}>getTokenDecimals</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('formatAmount', async () => selectedAsset ? client?.formatAmount(selectedAsset.token, 1000000n) : 'no asset')} disabled={!client || !!devBusy}>formatAmount</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('parseAmount', async () => selectedAsset ? client?.parseAmount(selectedAsset.token, '1.0') : 'no asset')} disabled={!client || !!devBusy}>parseAmount</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('findOpenChannel', async () => selectedAsset ? client?.findOpenChannel(selectedAsset.token, SEPOLIA_CHAIN_ID) : 'no asset')} disabled={!client || !!devBusy}>findOpenChannel</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('getChannelData', async () => core.channels.length > 0 ? client?.getChannelData(core.channels[0].channel_id) : 'no channels')} disabled={!client || !!devBusy}>getChannelData</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('resizeChannel', async () => {
                if (!selectedAsset) return 'no asset';
                const amount = await client?.parseAmount(selectedAsset.token, '0.1');
                if (!amount || !client) return 'no amount';
                return client.resizeChannel({ allocate_amount: amount, token: selectedAsset.token });
              })} disabled={!client || !!devBusy}>resizeChannel</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('challengeChannel', async () => {
                if (!client || core.channels.length === 0) return 'no channels';
                const data = await client.getChannelData(core.channels[0].channel_id);
                return client.challengeChannel({ state: data.state });
              })} disabled={!client || !!devBusy}>challengeChannel</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('classifyError', async () => {
                const classified = NitroliteClient.classifyError(new Error('allowance insufficient'));
                return { name: classified.constructor.name, message: classified.message };
              })} disabled={!!devBusy}>classifyError</button>
              <button className="btn-primary rounded px-2 py-1 font-semibold" onClick={() => runDevAction('EventPoller', async () => {
                if (!client) return 'client not ready';
                const result = { balances: 0, assets: 0, channels: 0, errors: 0 };

                const poller = new EventPoller(
                  client,
                  {
                    onBalanceUpdate: (balances) => {
                      result.balances = balances.length;
                    },
                    onAssetsUpdate: (assets) => {
                      result.assets = assets.length;
                    },
                    onChannelUpdate: (channels) => {
                      result.channels = channels.length;
                    },
                    onError: () => {
                      result.errors += 1;
                    },
                  },
                  1500,
                );

                poller.start();
                await new Promise((resolve) => setTimeout(resolve, 2600));
                poller.stop();

                return result;
              })} disabled={!client || !!devBusy}>EventPoller</button>
            </div>

            <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-[11px] font-semibold uppercase text-neutral-700">
                Manual Flush Pending State
              </p>
              <p className="mt-1 text-xs text-neutral-600">
                Use this when an asset is stuck with an ongoing home deposit transition.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-neutral-700">Asset</span>
                  <select
                    className="rounded border border-neutral-300 px-2 py-1 text-xs"
                    value={devFlushAssetSymbol}
                    onChange={(event) =>
                      setDevFlushAssetSymbol(event.target.value === 'weth' ? 'weth' : 'usdc')
                    }
                    disabled={!client || !!devBusy || supportedAssets.length === 0}>
                    {supportedAssets.length === 0 ? (
                      <option value="usdc">No assets</option>
                    ) : (
                      supportedAssets.map((asset) => (
                        <option key={`dev-flush-${asset.token}`} value={asset.symbol.toLowerCase()}>
                          {asset.symbol.toUpperCase()}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <button
                  className="btn-primary rounded px-2 py-1 font-semibold"
                  onClick={() =>
                    runDevAction('manualFlushPendingState', async () => {
                      if (!client || !walletAddress) return 'client or wallet not ready';

                      const targetAsset =
                        supportedAssets.find(
                          (asset) => asset.symbol.toLowerCase() === devFlushAssetSymbol,
                        ) ?? selectedAsset;
                      if (!targetAsset) return 'no asset selected';

                      const tokenInfo = await client.resolveToken(targetAsset.token as Address);
                      let txHash: string;
                      try {
                        txHash = await client.innerClient.checkpoint(tokenInfo.symbol);
                      } catch (error) {
                        throw new Error(toManualFlushErrorMessage(error, tokenInfo.symbol));
                      }
                      await new Promise((resolve) => setTimeout(resolve, 900));
                      await refreshCoreData();

                      return {
                        asset: tokenInfo.symbol,
                        txHash,
                      };
                    })
                  }
                  disabled={!client || !!devBusy || supportedAssets.length === 0}>
                  manualFlushPendingState
                </button>
              </div>
            </div>

            <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-neutral-200 bg-neutral-950 p-3 font-mono text-xs text-green-300">
              {devBusy ? `Running: ${devBusy}\n` : ''}
              {devOutput}
            </pre>
          </>
        ) : null}
      </section>

      {submitConfirmProposal && submitConfirmPreview && activeRoom ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 px-4"
          onClick={closeSubmitConfirm}>
          <div
            className="card w-full max-w-2xl p-4 md:p-5"
            onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-bold">Confirm {submitConfirmPreview.actionLabel}</h3>
              <span className="badge badge-pending">{activeRoom.asset_symbol.toUpperCase()}</span>
            </div>

            <p className="mt-2 text-sm text-neutral-700">{submitConfirmPreview.summary}</p>

            <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs font-semibold uppercase text-neutral-700">
                Checkout Allocation Change
              </p>
              <div className="mt-2 space-y-2">
                {submitConfirmPreview.rows.map((row) => (
                  <div
                    key={`confirm-${row.participant}`}
                    className="grid grid-cols-1 gap-1 rounded border border-neutral-200 bg-white/80 px-3 py-2 text-xs md:grid-cols-[1.4fr,1fr,1fr,1fr] md:items-center">
                    <span className="font-semibold text-neutral-800">{getParticipantDisplayName(row.participant)}</span>
                    <span className="font-mono text-neutral-700">Before: {formatUnits(row.before, activeRoomAsset?.decimals ?? 6)}</span>
                    <span className="font-mono text-neutral-700">After: {formatUnits(row.after, activeRoomAsset?.decimals ?? 6)}</span>
                    <span className={`font-mono ${row.delta > 0n ? 'text-emerald-700' : row.delta < 0n ? 'text-rose-700' : 'text-neutral-700'}`}>
                      Change: {formatSignedUnits(row.delta, activeRoomAsset?.decimals ?? 6)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button className="btn-secondary rounded px-3 py-2 text-sm font-semibold" onClick={closeSubmitConfirm}>
                Cancel
              </button>
              <button
                className="btn-primary rounded px-3 py-2 text-sm font-semibold"
                onClick={confirmSubmitProposal}
                disabled={busy === 'proposal_submit'}>
                {busy === 'proposal_submit' ? 'Applying...' : 'Confirm & Apply'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
