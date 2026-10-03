import React, { useState, useEffect } from 'react';
import { useSystem } from '@ohif/core';
import { PanelSection } from '@ohif/ui-next';
import SubscribeForm from './fhircast/SubscribeForm';
import SubscriptionList from './fhircast/SubscriptionList';
import EventsList from './fhircast/EventsList';
import { DEFAULT_HUB_URL, DEFAULT_WS_URL, DEFAULT_TOPIC, DEFAULT_SELECTED_EVENTS } from './fhircast/constants';
import type { Subscription } from './fhircast/types';
import { useFhircastSubscription } from './fhircast/useFhircastSubscription';
import { getActiveParams, setImagingStudyContext } from './fhircast/fhircastSession';
import './fhircast/fhircast.css';
import { getFhirConfig, getImagingStudyStore } from '../FhirDataSource';

function FhirCastPanel() {
  const config = getFhirConfig();
  const { servicesManager } = useSystem();
  const { uiNotificationService } = servicesManager?.services || {};

  // Ordered hub-base candidates to probe when the SMART token didn't supply hub.url.
  // /api/hub first (Node on FHIR and the FHIRcast reference sandbox — also the fallback default
  // when discovery fails); Medplum mounts versioned hubs under /fhircast/STU3 (3.0.0) and
  // /fhircast/STU2; some hubs mount at the origin root.
  const buildCandidates = (iss: string): string[] => {
    try {
      const origin = new URL(iss).origin;
      return [`${origin}/api/hub`, `${origin}/fhircast/STU3`, `${origin}/fhircast/STU2`, origin];
    } catch {
      return [];
    }
  };

  // Derive a default WebSocket URL from a resolved hub base. The hub returns the definitive
  // endpoint in the subscribe response (hub.channel.endpoint), so this is only the displayed value.
  const deriveWsUrl = (hub: string): string => {
    try {
      const u = new URL(hub, window.location.origin);
      const wsProtocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      const path = u.pathname.includes('/fhircast/') ? '/ws/fhircast' : '/bind';
      return `${wsProtocol}//${u.host}${path}`;
    } catch {
      return DEFAULT_WS_URL;
    }
  };

  // A live connection outlives this component, so on a remount the fields should
  // describe what is actually connected rather than re-deriving a fresh guess.
  const liveParams = getActiveParams();

  // Best synchronous guess (refined asynchronously by discovery below): prefer the SMART token's
  // hub.url, else the first probe candidate, else the static default.
  const tokenHubUrl = config.hubUrl || '';
  const initialHubUrl =
    liveParams?.hubUrl || tokenHubUrl || buildCandidates(config.iss)[0] || DEFAULT_HUB_URL;
  const initialWsUrl = liveParams?.wsUrl || deriveWsUrl(initialHubUrl);

  // Prefer the FHIRcast session topic from the SMART launch, else the patient id.
  const initialTopic = liveParams?.topic || config.hubTopic || config.patientId || DEFAULT_TOPIC;

  // Form state
  const [hubUrl, setHubUrl] = useState(initialHubUrl);
  const [wsUrl, setWsUrl] = useState(initialWsUrl);
  const [topic, setTopic] = useState(initialTopic);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    liveParams?.events ? [...liveParams.events] : [...DEFAULT_SELECTED_EVENTS]
  );
  const [saveToClient, setSaveToClient] = useState(true);
  const [saveToServer, setSaveToServer] = useState(false);

  // Subscription hook — a view onto the module-scoped session, so this survives
  // the unmount that OHIF performs whenever another side-panel tab is selected.
  const {
    wsStatus,
    receivedEvents,
    subscriptions,
    imagingStudyId,
    imagingStudyStatus,
    subscribe,
    unsubscribe,
  } = useFhircastSubscription();


  // Discover the FHIRcast hub on mount: SMART token hub.url → FHIR CapabilityStatement extension →
  // probe versioned/legacy candidates by their .well-known document. First match wins and updates
  // the hub/WS fields. Depends on iss + token hub.url (not hubUrl) to avoid a set-state loop.
  useEffect(() => {
    let cancelled = false;

    const fetchWellKnown = async (base: string) => {
      const res = await fetch(`${base}/.well-known/fhircast-configuration`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    };

    // Read hub.url from the FHIR server's CapabilityStatement fhircast-configuration-extension.
    const fetchCapabilityHubUrl = async (): Promise<string | null> => {
      if (!config.iss) return null;
      try {
        const metadataUrl = new URL('metadata', config.iss).toString();
        const res = await fetch(metadataUrl, { headers: { Accept: 'application/fhir+json' } });
        if (!res.ok) return null;
        const cap = await res.json();
        for (const rest of Array.isArray(cap?.rest) ? cap.rest : []) {
          for (const ext of rest?.extension || []) {
            if (typeof ext?.url === 'string' && ext.url.includes('fhircast-configuration-extension')) {
              for (const sub of ext.extension || []) {
                if (sub?.url === 'hub.url' && sub?.valueUrl) {
                  return sub.valueUrl as string;
                }
              }
            }
          }
        }
      } catch {
        // ignore — fall back to probing
      }
      return null;
    };

    const applyHub = (base: string, caps: unknown, how: string) => {
      if (cancelled) return;
      console.log(`[FhirCast] Hub discovered (${how}):`, base, caps);
      setHubUrl(base);
      setWsUrl(deriveWsUrl(base));
    };

    const discover = async () => {
      // Never re-point the fields at a different hub while one is connected:
      // this effect also runs on every remount, and the panel remounts on any
      // side-panel tab switch. The connected hub is the answer already.
      if (getActiveParams()) {
        return;
      }

      // 1. Token-provided hub.url — trust it even if a cross-origin probe is blocked.
      if (tokenHubUrl) {
        try {
          const caps = await fetchWellKnown(tokenHubUrl);
          applyHub(tokenHubUrl, caps, 'token hub.url');
        } catch (err) {
          if (!cancelled) {
            console.warn('[FhirCast] token hub.url well-known check failed, using it anyway:', err);
            setHubUrl(tokenHubUrl);
            setWsUrl(deriveWsUrl(tokenHubUrl));
          }
        }
        return;
      }

      // 2. CapabilityStatement extension.
      const capHubUrl = await fetchCapabilityHubUrl();
      if (capHubUrl) {
        try {
          const caps = await fetchWellKnown(capHubUrl);
          applyHub(capHubUrl, caps, 'CapabilityStatement');
          return;
        } catch {
          // fall through to probing
        }
      }

      // 3. Probe candidates; first whose well-known returns 200 wins.
      for (const candidate of buildCandidates(config.iss)) {
        if (cancelled) return;
        try {
          const caps = await fetchWellKnown(candidate);
          applyHub(candidate, caps, 'probe');
          return;
        } catch {
          // try next candidate
        }
      }

      if (!cancelled) {
        console.warn('[FhirCast] Hub discovery failed; using default:', initialHubUrl);
      }
    };

    discover();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.iss, tokenHubUrl]);

  // Seed the context banner once, if a study is already known and no event has
  // set it yet. Guarded on the session value so a remount cannot overwrite what
  // the listener has since recorded.
  useEffect(() => {
    if (imagingStudyId) {
      return;
    }
    const studyMap = getImagingStudyStore();
    const firstStudy = studyMap && studyMap.size > 0 ? studyMap.values().next().value : null;
    if (firstStudy) {
      setImagingStudyContext({
        imagingStudyId: firstStudy.id || '',
        imagingStudyStatus: firstStudy.status || 'unknown',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reacting to context events lives in fhircastContextListener, registered from
  // the extension's onModeEnter. It used to be an effect here, which meant the
  // viewer only followed context while the FHIRcast tab happened to be the one
  // on screen. The panel now just displays what the listener records.

  const hasSubscriptions = Object.keys(subscriptions).length > 0;
  const [subscribeError, setSubscribeError] = useState('');

  // Translate raw fetch/HTTP errors into something actionable for the panel.
  const describeSubscribeError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b(404|405)\b/.test(message)) {
      return `No FHIRcast hub answered at ${hubUrl}. Check the Hub URL — NodeOnFHIR hubs listen at /api/hub.`;
    }
    if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(message)) {
      return `Could not reach ${hubUrl} from ${window.location.origin}. The hub may be down or blocking this origin via CORS.`;
    }
    return message;
  };

  const showSubscribeError = (err: unknown, action: string) => {
    console.error(`[FhirCastPanel] ${action} failed:`, err);
    const message = describeSubscribeError(err);
    setSubscribeError(message);
    uiNotificationService?.show({
      title: `FHIRcast ${action} Failed`,
      message,
      type: 'error',
      duration: 10000,
    });
  };

  const handleSubscribe = async () => {
    setSubscribeError('');
    try {
      await subscribe({ hubUrl, wsUrl, topic, events: selectedEvents, authToken: config.authToken || undefined });
    } catch (err) {
      showSubscribeError(err, 'Subscribe');
    }
  };

  const handleUnsubscribe = async () => {
    setSubscribeError('');
    try {
      await unsubscribe(topic);
    } catch (err) {
      showSubscribeError(err, 'Unsubscribe');
    }
  };

  const handleUnsubscribeSub = (sub: Subscription) => {
    unsubscribe(sub.topic).catch((err) => showSubscribeError(err, 'Unsubscribe'));
  };

  return (
    <div className="ohif-scrollbar fhircast-panel-scroll flex select-none flex-col">
      <PanelSection defaultOpen={true}>
        <PanelSection.Header>Study Context</PanelSection.Header>
        <PanelSection.Content className="bg-muted space-y-2 px-4 pt-2 pb-4">
          <div className="space-y-1.5">
            <div className="text-muted-foreground text-xs">ImagingStudy ID</div>
            <div className="rounded border border-white/10 bg-black/30 px-2 py-1.5">
              <span className="font-mono text-xs text-white">
                {imagingStudyId || 'N/A'}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-muted-foreground text-xs">Status</div>
            <div>
              <span
                className={`fhircast-status-badge ${
                  imagingStudyStatus === 'available' || imagingStudyStatus === 'reported'
                    ? 'fhircast-status-badge--good'
                    : imagingStudyStatus === 'registered' || imagingStudyStatus === 'unread'
                      ? 'fhircast-status-badge--pending'
                      : imagingStudyStatus === 'unknown'
                        ? 'fhircast-status-badge--unknown'
                        : 'fhircast-status-badge--other'
                }`}
              >
                {imagingStudyStatus}
              </span>
            </div>
          </div>
        </PanelSection.Content>
      </PanelSection>

      <PanelSection defaultOpen={true}>
        <PanelSection.Header>Subscribe to Events</PanelSection.Header>
        <PanelSection.Content className="bg-muted space-y-2 px-4 pt-2 pb-4">
          <SubscribeForm
            hubUrl={hubUrl}
            onHubUrlChange={setHubUrl}
            wsUrl={wsUrl}
            onWsUrlChange={setWsUrl}
            wsStatus={wsStatus}
            topic={topic}
            onTopicChange={setTopic}
            selectedEvents={selectedEvents}
            onSelectedEventsChange={setSelectedEvents}
            saveToClient={saveToClient}
            onSaveToClientChange={setSaveToClient}
            saveToServer={saveToServer}
            onSaveToServerChange={setSaveToServer}
            hasSubscriptions={hasSubscriptions}
            onSubscribe={handleSubscribe}
            onUnsubscribe={handleUnsubscribe}
            subscribeError={subscribeError}
          />
        </PanelSection.Content>
      </PanelSection>

      <PanelSection defaultOpen={true}>
        <PanelSection.Header>Subscriptions</PanelSection.Header>
        <PanelSection.Content className="bg-muted px-4 pt-2 pb-4">
          <SubscriptionList
            subscriptions={subscriptions}
            onUnsubscribe={handleUnsubscribeSub}
          />
        </PanelSection.Content>
      </PanelSection>

      <PanelSection defaultOpen={true}>
        <PanelSection.Header>Received Events</PanelSection.Header>
        <PanelSection.Content className="bg-muted px-4 pt-2 pb-4">
          <EventsList events={receivedEvents} />
        </PanelSection.Content>
      </PanelSection>
    </div>
  );
}

export default FhirCastPanel;
