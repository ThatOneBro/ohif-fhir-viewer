import { DEFAULT_SECRET, DEFAULT_LEASE, WEBSOCKET_CHANNEL_TYPE } from './constants';
import { SubscriptionParams, SubscriptionMode } from './types';
import type { ReceivedEvent, Subscription, WebSocketStatusValue } from './types';

/**
 * The FHIRcast connection, owned at module scope rather than by the panel.
 *
 * OHIF's SidePanel renders only the active tab and `null` for the rest
 * (platform/ui-next/src/components/SidePanel/SidePanel.tsx), and swaps the whole
 * content out when the panel collapses. So FhirCastPanel unmounts on an
 * ordinary tab switch. While the socket and the subscription list lived in
 * component state, that teardown closed the connection and dropped every
 * received event — the subscription stayed alive on the hub (nothing POSTed
 * `hub.mode=unsubscribe`), so toggling tabs leaked a subscription each time and
 * left the panel showing none of them.
 *
 * Here the connection outlives the view. The panel subscribes to this store and
 * renders whatever it currently holds; mounting and unmounting are view
 * lifecycle only. The socket closes when someone unsubscribes, not when React
 * happens to tear the panel down.
 */

export interface SubscribeParams {
  hubUrl: string;
  wsUrl: string;
  topic: string;
  events: string[];
  secret?: string;
  lease?: number;
  /** The real server WebSocket URL for hub.channel.endpoint (before proxy rewrite). */
  serverWsUrl?: string;
  /** Bearer token for Authorization header (e.g. from SMART auth flow). */
  authToken?: string;
}

export interface SessionState {
  wsStatus: WebSocketStatusValue;
  receivedEvents: ReceivedEvent[];
  subscriptions: Record<string, Subscription>;
  // Latest ImagingStudy from context. Here rather than in the panel because the
  // panel unmounts on a tab switch and would otherwise come back showing
  // nothing until the next event happened to arrive.
  imagingStudyId: string;
  imagingStudyStatus: string;
}

// Reconnect pacing. The previous 3-attempt / 4s-ceiling schedule gave up after
// roughly seven seconds, which a backgrounded tab exceeds trivially: Chrome
// freezes or discards it and the socket dies well before it is looked at again.
// Retry indefinitely instead, and lean on the visibility listener below to
// collapse the wait the moment someone comes back to the tab.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Reopening the same endpoint only works while the hub still has it. After a
// couple of failures assume it is gone and re-POST for a fresh one.
const REOPEN_ATTEMPTS_BEFORE_RESUBSCRIBE = 2;

let state: SessionState = {
  wsStatus: 'Closed',
  receivedEvents: [],
  subscriptions: {},
  imagingStudyId: '',
  imagingStudyStatus: 'unknown',
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<SessionState>): void {
  // New object identity on every change: useSyncExternalStore compares
  // snapshots by reference.
  state = { ...state, ...patch };
  emit();
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionSnapshot(): SessionState {
  return state;
}

export function setImagingStudyContext(context: {
  imagingStudyId: string;
  imagingStudyStatus: string;
}): void {
  setState(context);
}

// --- Connection internals (module scope: survives panel unmount) ---

let ws: WebSocket | null = null;
let activeParams: SubscribeParams | null = null;
let endpointId: string | null = null;
let boundWsUrl = '';
let intentionallyClosed = true;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityHooked = false;

/** The params of the live subscription, so a remounted panel can show what it is actually connected to. */
export function getActiveParams(): SubscribeParams | null {
  return activeParams;
}

function generateEndpointId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function postToHub(
  hubUrl: string,
  mode: string,
  topic: string,
  events: string[],
  wsUrl: string,
  id: string,
  secret: string,
  lease: number,
  authToken?: string
): Promise<Response> {
  const params = new URLSearchParams();
  params.set(SubscriptionParams.mode, mode);
  params.set(SubscriptionParams.topic, topic);
  params.set(SubscriptionParams.events, events.join(','));
  params.set(SubscriptionParams.secret, secret);
  params.set(SubscriptionParams.lease, String(lease));
  params.set(SubscriptionParams.channelType, WEBSOCKET_CHANNEL_TYPE);
  params.set(SubscriptionParams.channelEndpoint, `${wsUrl}/${id}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return fetch(hubUrl, { method: 'POST', headers, body: params.toString() });
}

/** POST hub.mode=subscribe and return the endpoint the hub wants us on. */
async function requestEndpoint(params: SubscribeParams): Promise<string> {
  const {
    hubUrl,
    wsUrl,
    topic,
    events,
    secret = DEFAULT_SECRET,
    lease = DEFAULT_LEASE,
    serverWsUrl,
    authToken,
  } = params;

  const id = generateEndpointId();
  endpointId = id;

  const response = await postToHub(
    hubUrl,
    SubscriptionMode.subscribe,
    topic,
    events,
    serverWsUrl || wsUrl,
    id,
    secret,
    lease,
    authToken
  );

  if (!response.ok) {
    throw new Error(`Hub subscription failed: ${response.status} ${response.statusText}`);
  }

  // Per FHIRcast spec §2-4 the hub returns the endpoint to bind to.
  const body = await response.json();
  return body['hub.channel.endpoint'] || `${wsUrl}/${id}`;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (intentionallyClosed || !activeParams) {
    return;
  }
  clearReconnectTimer();
  const attempt = ++reconnectAttempts;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
  console.log(`[FhirCast] Reconnecting in ${delay}ms (attempt ${attempt})`);
  setState({ wsStatus: 'Opening' });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnect();
  }, delay);
}

async function reconnect(): Promise<void> {
  if (intentionallyClosed || !activeParams) {
    return;
  }
  try {
    // Early attempts reuse the endpoint the hub already gave us; once that has
    // failed a couple of times the endpoint is probably gone, so ask for a new
    // one. A bare socket reopen against a torn-down endpoint never rebinds.
    if (reconnectAttempts > REOPEN_ATTEMPTS_BEFORE_RESUBSCRIBE || !boundWsUrl) {
      boundWsUrl = await requestEndpoint(activeParams);
    }
    openSocket(boundWsUrl);
  } catch (err) {
    console.warn('[FhirCast] Reconnect failed:', err);
    scheduleReconnect();
  }
}

function openSocket(url: string): void {
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    console.log('[FhirCast] WebSocket opened, waiting for bind...');
  };

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      // Binding confirmation (accept both legacy and spec-compliant shapes).
      if (data.bound === true || data['hub.mode'] === 'subscribe') {
        console.log('[FhirCast] WebSocket bound');
        reconnectAttempts = 0;
        setState({
          wsStatus: 'Open',
          subscriptions: activeParams
            ? {
                ...state.subscriptions,
                [activeParams.topic]: {
                  topic: activeParams.topic,
                  events: [...activeParams.events],
                  status: 'active',
                },
              }
            : state.subscriptions,
        });
        return;
      }

      const event: ReceivedEvent = {
        id: data.id || generateEndpointId(),
        timestamp: data.timestamp || new Date().toISOString(),
        event: data.event || data,
      };
      setState({ receivedEvents: [event, ...state.receivedEvents] });

      // ACK within 10s or the hub raises a SyncError.
      if (data.id && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: data.id, status: '200' }));
      }
    } catch (err) {
      console.warn('[FhirCast] Failed to parse WS message:', err);
    }
  };

  socket.onclose = (evt) => {
    console.log('[FhirCast] WebSocket closed, code:', evt.code, 'reason:', evt.reason);
    if (ws === socket) {
      ws = null;
    }
    if (intentionallyClosed) {
      setState({ wsStatus: 'Closed' });
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.error('[FhirCast] WebSocket error:', err);
    // Leave the retry to onclose, which always follows onerror.
  };
}

/**
 * A frozen or discarded background tab drops the socket, and the backoff may by
 * then be sitting on a long delay. Coming back to the tab is the strongest
 * signal that a retry is worth making now, so reset the schedule and go.
 */
function ensureVisibilityListener(): void {
  if (visibilityHooked || typeof document === 'undefined') {
    return;
  }
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (intentionallyClosed || !activeParams) {
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    console.log('[FhirCast] Tab visible again with a dead socket — reconnecting now');
    clearReconnectTimer();
    reconnectAttempts = 0;
    void reconnect();
  });
}

/** Subscribe at the hub and bind the WebSocket. Resolves once the hub confirms the bind. */
export async function startSubscription(params: SubscribeParams): Promise<void> {
  // Replace any existing connection.
  intentionallyClosed = true;
  clearReconnectTimer();
  if (ws) {
    ws.close();
    ws = null;
  }

  activeParams = params;
  reconnectAttempts = 0;
  ensureVisibilityListener();

  boundWsUrl = await requestEndpoint(params);

  intentionallyClosed = false;
  setState({ wsStatus: 'Opening' });

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      unlisten();
      done();
    };
    const unlisten = subscribeToSession(() => {
      if (state.wsStatus === 'Open') {
        finish(resolve);
      }
    });

    openSocket(boundWsUrl);

    // Don't hang the caller's spinner forever if the bind never confirms; the
    // connection itself keeps retrying in the background regardless.
    setTimeout(() => {
      finish(() =>
        reject(new Error('Timed out waiting for the hub to confirm the WebSocket bind'))
      );
    }, 15000);
  });
}

/** POST hub.mode=unsubscribe, close the socket, and stop reconnecting. */
export async function stopSubscription(topic?: string): Promise<void> {
  const params = activeParams;
  const id = endpointId;

  intentionallyClosed = true;
  clearReconnectTimer();
  if (ws) {
    ws.close();
    ws = null;
  }
  setState({ wsStatus: 'Closed' });

  if (params && id) {
    const {
      hubUrl,
      wsUrl,
      topic: activeTopic,
      events,
      secret = DEFAULT_SECRET,
      lease = DEFAULT_LEASE,
      serverWsUrl,
      authToken,
    } = params;
    try {
      await postToHub(
        hubUrl,
        SubscriptionMode.unsubscribe,
        topic || activeTopic,
        events,
        serverWsUrl || wsUrl,
        id,
        secret,
        lease,
        authToken
      );
    } catch (err) {
      console.warn('[FhirCast] Unsubscribe POST failed:', err);
    }
  }

  const next = { ...state.subscriptions };
  delete next[topic || params?.topic || ''];
  setState({ subscriptions: next });

  activeParams = null;
  endpointId = null;
  boundWsUrl = '';
}
