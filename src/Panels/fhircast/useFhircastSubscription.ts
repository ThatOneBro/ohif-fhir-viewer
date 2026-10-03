import { useSyncExternalStore } from 'react';
import {
  getActiveParams,
  getSessionSnapshot,
  startSubscription,
  stopSubscription,
  subscribeToSession,
} from './fhircastSession';
import type { SubscribeParams } from './fhircastSession';

export type { SubscribeParams };

/**
 * A view onto the module-scoped FHIRcast session.
 *
 * The connection used to live in this hook, which meant it died with the panel
 * — and OHIF unmounts a side-panel tab as soon as you switch away from it. The
 * socket, the subscription list and the event log now live in fhircastSession;
 * this just re-renders whoever is looking when they change. Mounting no longer
 * connects and unmounting no longer disconnects.
 */
export function useFhircastSubscription() {
  const snapshot = useSyncExternalStore(subscribeToSession, getSessionSnapshot, getSessionSnapshot);

  return {
    wsStatus: snapshot.wsStatus,
    receivedEvents: snapshot.receivedEvents,
    subscriptions: snapshot.subscriptions,
    imagingStudyId: snapshot.imagingStudyId,
    imagingStudyStatus: snapshot.imagingStudyStatus,
    activeParams: getActiveParams(),
    subscribe: startSubscription,
    unsubscribe: stopSubscription,
  };
}
