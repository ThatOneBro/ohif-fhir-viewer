import { DicomMetadataStore, IWebApiDataSource } from '@ohif/core';
import OHIF from '@ohif/core';

import dcmjs from 'dcmjs';
import {
  fetchPatient,
  fetchImagingStudies,
  fetchImagingStudyById,
  fetchDocumentReferences,
  fetchDicomFile,
  createDocumentReference,
} from './fhirClient';
import { imagingStudyToStudySummary, extractSeriesMetadata } from './fhirToOhif';
import { loadDicomFromAttachment, parseDicomArrayBuffer } from './dicomLoader';
import { getEnvSmartClientId, getEnvFhirServerUrl } from '../envConfig';
import {
  fetchSmartConfiguration,
  generatePKCE,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  saveAuthState,
  loadAuthState,
  clearAuthState,
  saveToken,
  getStoredToken,
  registerSmartClient,
} from './smartAuth';

const metadataProvider = OHIF.classes.MetadataProvider;

const PLACEHOLDER_STUDY_UID = '__fhir_pending__';

// OHIF's own DICOMweb data source, borrowed as an image source. A FHIR
// ImagingStudy names a study and its series, but usually stops there: no
// `series[].instance[]` entries and never pixel data. When it does, this
// extension can still serve as the context layer — which patient, which study,
// which FHIRcast session — and delegate instance metadata and image ids to a
// DICOMweb store, which is where the pixels live anyway.
const DICOMWEB_NAMESPACE = '@ohif/extension-default.dataSourcesModule.dicomweb';

let _config = {
  // Absolute FHIR URLs — the browser calls the FHIR server directly (CORS),
  // so the server must allow the OHIF origin. These are dev fallbacks; a
  // deployment overrides them via the data-source `configuration` in
  // window.config, and a SMART launch overrides them again from the `iss` param.
  fhirBaseUrl: 'http://localhost:3200/baseR4',
  fhirServerRoot: 'http://localhost:3200',
  patientId: '',
  authToken: '',
  iss: '',
  launch: '',
  urlParams: {},
  smartClientId: '',
  smartScope: '',
  smartAuthenticated: false,
  // FHIRcast hub discovery — populated from the SMART token response (`hub.url`/`hub.topic`)
  // when the granted scope includes `fhircast/`. Empty until a launch supplies them.
  hubUrl: '',
  hubTopic: '',
  // DICOMweb image source, used for any study whose ImagingStudy carries no
  // instance-level data. Opt-in: with none of these set, an instance-less
  // ImagingStudy behaves exactly as before (series list only, then the
  // DocumentReference fallback). `dicomWebRoot` sets all three services at
  // once; `dicomWeb` takes a full OHIF DicomWebConfig, so a deployment can hand
  // over the same tuning it already gives OHIF's own `dicomweb` source.
  dicomWebRoot: '',
  qidoRoot: '',
  wadoRoot: '',
  wadoUriRoot: '',
  dicomWeb: null,
};

let _store = {
  studies: [],
  studyInstanceUIDs: [],
  studyToFhirId: new Map(),
  imagingStudyMap: new Map(),
  loadedStudies: new Set(),
  // Studies whose metadata came from DICOMweb rather than the ImagingStudy.
  // Their instances carry wadors image ids, so image-id construction has to go
  // back to the delegate rather than through the FHIR attachment path.
  dicomWebStudies: new Set(),
  dicomWebAttempted: new Set(),
};

let _servicesManager = null;
let _extensionManager = null;
// undefined = not built yet, null = unavailable (not configured, or build failed)
let _dicomWebDelegate;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function wrapSequences(obj) {
  return Object.keys(obj).reduce(
    (acc, key) => {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        acc[key] = wrapSequences(obj[key]);
      } else {
        acc[key] = obj[key];
      }
      if (key.endsWith('Sequence')) {
        acc[key] = OHIF.utils.addAccessors(acc[key]);
      }
      return acc;
    },
    Array.isArray(obj) ? [] : {}
  );
}

export function updateFhirConfig(newConfig) {
  Object.assign(_config, newConfig);

  // The delegate is built once from the roots below; rebuild it if they move
  // (a SMART launch can rewrite the server after the data source is created).
  const rootKeys = ['dicomWebRoot', 'qidoRoot', 'wadoRoot', 'wadoUriRoot', 'dicomWeb'];
  if (newConfig && rootKeys.some(key => key in newConfig)) {
    _dicomWebDelegate = undefined;
    _store.dicomWebAttempted.clear();
  }
}

export function getFhirConfig() {
  return { ..._config };
}

export function getImagingStudyStore() {
  return _store.imagingStudyMap;
}

function base64Random() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  let str = '';
  for (const byte of array) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function _fetchStudyUIDs(patientId) {
  try {
    const studyBundle = await fetchImagingStudies(_config.fhirBaseUrl, patientId, {
      authToken: _config.authToken,
    });

    const entries = studyBundle.entry || [];
    const studies = entries
      .map(e => e.resource)
      .filter(r => r && r.resourceType === 'ImagingStudy');

    if (studies.length !== entries.length) {
      console.log('[FHIR] _fetchStudyUIDs — filtered', entries.length, 'entries to', studies.length, 'ImagingStudy resources');
    }
    const studyUIDs = studies.map(s => {
      const summary = imagingStudyToStudySummary(s, '');
      _store.studyToFhirId.set(summary.studyInstanceUid, s.id);
      _store.imagingStudyMap.set(summary.studyInstanceUid, s);
      return summary.studyInstanceUid;
    });

    // Pre-register all discovered studies in DicomMetadataStore.
    // This ensures getStudiesFromUIDs() never returns undefined entries,
    // preventing HangingProtocolService._matchImages crashes.
    for (const s of studies) {
      const summary = imagingStudyToStudySummary(s, '');
      if (summary.StudyInstanceUID) {
        DicomMetadataStore.addStudy({
          StudyInstanceUID: summary.StudyInstanceUID,
          PatientID: summary.PatientID || '',
          PatientName: summary.PatientName || '',
          StudyDate: summary.StudyDate || '',
          ModalitiesInStudy: summary.Modalities ? summary.Modalities.split('\\') : [],
          StudyDescription: summary.StudyDescription || '',
          AccessionNumber: summary.AccessionNumber || '',
          NumInstances: summary.NumInstances || 0,
        });
        console.log('[FHIR] Pre-registered study in DicomMetadataStore:', summary.StudyInstanceUID);
      }
    }

    const validStudyUIDs = studyUIDs.filter(uid => uid && uid.length > 0);
    if (validStudyUIDs.length !== studyUIDs.length) {
      console.warn('[FHIR] _fetchStudyUIDs — filtered out', studyUIDs.length - validStudyUIDs.length, 'empty UIDs from', studyUIDs.length, 'total');
    }
    _store.studyInstanceUIDs = validStudyUIDs.length > 0 ? validStudyUIDs : [PLACEHOLDER_STUDY_UID];
    return _store.studyInstanceUIDs;
  } catch (error) {
    console.error('[FHIR] Failed to fetch studies:', error);
    _showFhirError(_servicesManager, error, _config.fhirBaseUrl);
    _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
    return [PLACEHOLDER_STUDY_UID];
  }
}

function _showFhirError(servicesManager, error, contextUrl) {
  const { uiNotificationService } = servicesManager?.services || {};
  if (!uiNotificationService) return;

  // A fetch() rejected before any HTTP response arrived — the browser reports
  // this as TypeError('Failed to fetch') for both CORS blocks and the server
  // being down, and hides which one it was from JavaScript.
  const isNetworkOrCorsError =
    error instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(error.message || '');

  if (isNetworkOrCorsError) {
    const serverUrl = contextUrl || 'the FHIR server';
    uiNotificationService.show({
      title: 'FHIR Server Unreachable (CORS or network)',
      message:
        `Could not reach ${serverUrl} from ${window.location.origin}. ` +
        'Check that the server is running and allows this origin via CORS. ' +
        'For NodeOnFHIR servers, set private.cors.allowedOrigins in the Meteor settings file. ' +
        'See the FHIR panel query log for the failed request.',
      type: 'error',
      duration: 15000,
    });
    return;
  }

  // Try to extract the JSON message from the error string
  // Error format: "FHIR request failed: 501 {"message":"..."}"
  let userMessage = error.message || String(error);
  try {
    const jsonMatch = userMessage.match(/\{.*\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.message) {
        userMessage = parsed.message;
      }
    }
  } catch (e) {
    // Use the raw error message if JSON parsing fails
  }

  uiNotificationService.show({
    title: 'FHIR Server Error',
    message: userMessage,
    type: 'error',
    duration: 10000,
  });
}

// Resolve the SMART client ID from the browser-native config surfaces, in
// most-specific-wins order:
//   1. URL `?client_id=`        — per-launch (a launch URL can carry it so one
//                                  deployment can face multiple registrations)
//   2. localStorage             — per-user, set via the SMART Preferences panel
//   3. window.config            — per-deployment, the data-source `configuration`
//                                  already merged into `_config` at registration
// There is no build-time env var: OHIF is a static SPA, so config must arrive at
// runtime through one of these surfaces.
function resolveSmartClientId(query) {
  const fromUrl = query && query.get && query.get('client_id');
  if (fromUrl) return fromUrl;
  try {
    const saved = JSON.parse(localStorage.getItem('fhir_smart_config') || '{}');
    if (saved.smartClientId) return saved.smartClientId;
  } catch (e) {
    /* ignore parse errors */
  }
  return _config.smartClientId || '';
}

// ── DICOMweb image source ───────────────────────────────────────────────────

// Assemble the delegate's DicomWebConfig. `dicomWeb` is passed through verbatim
// so every OHIF knob (staticWado, singlepart, bulkDataURI, accept headers) is
// available; the explicit root keys win over it, and `dicomWebRoot` fills in
// whichever of the three services is left unset. Returns null when no root is
// configured — the delegation is opt-in and silent when absent.
function _resolveDicomWebConfig() {
  const overrides = _config.dicomWeb || {};
  const root = _config.dicomWebRoot || '';
  const qidoRoot = _config.qidoRoot || overrides.qidoRoot || root;
  const wadoRoot = _config.wadoRoot || overrides.wadoRoot || root;

  if (!qidoRoot || !wadoRoot) {
    return null;
  }

  return {
    imageRendering: 'wadors',
    thumbnailRendering: 'wadors',
    enableStudyLazyLoad: true,
    qidoSupportsIncludeField: false,
    supportsFuzzyMatching: false,
    supportsWildcard: true,
    ...overrides,
    friendlyName: 'DICOMweb (via FHIR)',
    name: 'fhir-dicomweb',
    qidoRoot,
    wadoRoot,
    wadoUriRoot: _config.wadoUriRoot || overrides.wadoUriRoot || root,
  };
}

// OHIF's DICOMweb source reads its bearer token from userAuthenticationService,
// while the SMART token lives in _config — so without this bridge every
// delegated QIDO/WADO-RS request goes out unauthenticated. Read _config lazily
// so a token that arrives later (or is refreshed) is picked up, and fall through
// to whatever implementation was installed before (OHIF's OIDC user manager, or
// a `?token=` param) whenever there is no SMART token.
function _bridgeAuthToken() {
  const { userAuthenticationService } = _servicesManager?.services || {};
  if (!userAuthenticationService) {
    return;
  }

  // Capture the underlying implementation, not the public method: the public
  // method dispatches to the implementation we are about to replace, so calling
  // it from the replacement would recurse.
  const previous = userAuthenticationService.serviceImplementation?._getAuthorizationHeader;
  if (previous?.__fhirAuthBridge) {
    return; // already ours
  }

  // Re-checked on every delegate access rather than latched, because anything
  // else in the app may install its own implementation later (OHIF's OIDC
  // provider does, on mount) and drop this one.
  const bridged = () => {
    if (_config.authToken) {
      return { Authorization: `Bearer ${_config.authToken}` };
    }
    return (typeof previous === 'function' ? previous() : undefined) || {};
  };
  bridged.__fhirAuthBridge = true;

  userAuthenticationService.setServiceImplementation({ getAuthorizationHeader: bridged });
}

// Build (once) the DICOMweb data source this one delegates to.
function _getDicomWebDelegate() {
  if (_dicomWebDelegate !== undefined) {
    if (_dicomWebDelegate) {
      _bridgeAuthToken();
    }
    return _dicomWebDelegate;
  }
  _dicomWebDelegate = null;

  const dicomWebConfig = _resolveDicomWebConfig();
  if (!dicomWebConfig) {
    return null;
  }

  if (!_extensionManager) {
    console.warn(
      '[FHIR] DICOMweb roots are configured but no extensionManager was passed to ' +
        'createFhirApi — cannot build the DICOMweb image source.'
    );
    return null;
  }

  const module = _extensionManager.getModuleEntry(DICOMWEB_NAMESPACE);
  if (!module || typeof module.createDataSource !== 'function') {
    console.warn('[FHIR] Could not resolve', DICOMWEB_NAMESPACE, '— is @ohif/extension-default loaded?');
    return null;
  }

  try {
    _bridgeAuthToken();
    const delegate = module.createDataSource(dicomWebConfig, _servicesManager, _extensionManager);
    // The DICOMweb source builds its client in initialize(); params/query only
    // feed its optional onConfiguration hook.
    delegate.initialize({ params: {}, query: new URLSearchParams(window.location.search) });
    _dicomWebDelegate = delegate;
    console.log('[FHIR] DICOMweb image source ready:', {
      qidoRoot: dicomWebConfig.qidoRoot,
      wadoRoot: dicomWebConfig.wadoRoot,
    });
  } catch (error) {
    console.error('[FHIR] Failed to build the DICOMweb image source:', error);
    _dicomWebDelegate = null;
  }

  return _dicomWebDelegate;
}

// True when this study's metadata came from DICOMweb, so image ids have to be
// built by the delegate (wadors frame urls) rather than read off a FHIR
// attachment. Keyed by study because a session can mix both kinds.
function _isDicomWebStudy(StudyInstanceUID) {
  return !!StudyInstanceUID && _store.dicomWebStudies.has(StudyInstanceUID);
}

/**
 * Retrieve series/instance metadata for a study from DICOMweb.
 *
 * Returns the delegate's result on success (an array of series promise wrappers
 * when the caller asked for them, which the route starts in hanging-protocol
 * order), or false when there is no DICOMweb source or it has nothing for this
 * study — in which case the caller carries on down the FHIR paths.
 */
async function _retrieveMetadataFromDicomWeb({
  StudyInstanceUID,
  filters,
  sortCriteria,
  sortFunction,
  madeInClient,
  returnPromises,
}) {
  const delegate = _getDicomWebDelegate();
  if (!delegate) {
    return false;
  }
  if (_store.dicomWebAttempted.has(StudyInstanceUID) && !_isDicomWebStudy(StudyInstanceUID)) {
    return false;
  }
  _store.dicomWebAttempted.add(StudyInstanceUID);

  console.log('[FHIR] Retrieving instance metadata from DICOMweb for', StudyInstanceUID);

  // Mark the study delegated before the retrieve, not after: the non-lazy path
  // stores instances (and fires INSTANCES_ADDED) inside the await, and anything
  // that asks for an image id in that window has to be routed to the delegate.
  // Unmarked again below if the retrieve turns out to have nothing for it.
  _store.dicomWebStudies.add(StudyInstanceUID);

  let result;
  try {
    result = await delegate.retrieve.series.metadata({
      StudyInstanceUID,
      filters,
      sortCriteria,
      sortFunction,
      madeInClient,
      returnPromises,
    });
  } catch (error) {
    console.error('[FHIR] DICOMweb metadata retrieve failed for', StudyInstanceUID, error);
    _store.dicomWebStudies.delete(StudyInstanceUID);
    const { qidoRoot } = _resolveDicomWebConfig() || {};
    _showFhirError(_servicesManager, error, qidoRoot);
    return false;
  }

  // The lazy-load path returns before instances land, so count series instead:
  // an empty result means the DICOMweb store doesn't have this study.
  const study = DicomMetadataStore.getStudy(StudyInstanceUID, madeInClient);
  const seriesCount = study?.series?.length || 0;
  if (!seriesCount) {
    console.warn('[FHIR] DICOMweb has no series for', StudyInstanceUID);
    _store.dicomWebStudies.delete(StudyInstanceUID);
    return false;
  }

  console.log(`[FHIR] DICOMweb returned ${seriesCount} series for`, StudyInstanceUID);
  _store.loadedStudies.add(StudyInstanceUID);

  return result === undefined ? true : result;
}

/**
 * Register an ImagingStudy that arrived as FHIRcast context and return its
 * StudyInstanceUID, or null if it has none.
 *
 * A FHIRcast `ImagingStudy-open` (or `DiagnosticReport-open`) event carries the
 * study as context, and per the spec that context is usually a stub — the hub
 * says *which* study is in focus, it doesn't ship its contents. So fetch the
 * full resource when the stub has no series, then seed the same store the
 * study-list path seeds, so `retrieve.series.metadata` can resolve the study
 * when the viewer routes to it.
 *
 * Returns `{ StudyInstanceUID, patientId }`, or null when the resource names no
 * DICOM study.
 */
async function registerImagingStudyContext(resource) {
  if (!resource || resource.resourceType !== 'ImagingStudy') {
    return null;
  }

  let study = resource;
  if (!study.series && study.id) {
    try {
      study = await fetchImagingStudyById(_config.fhirBaseUrl, study.id, {
        authToken: _config.authToken,
      });
    } catch (error) {
      console.warn('[FHIR] Could not fetch the ImagingStudy named by FHIRcast context:', error);
      study = resource;
    }
  }

  const summary = imagingStudyToStudySummary(study, '');
  const StudyInstanceUID = summary.StudyInstanceUID;
  if (!StudyInstanceUID) {
    console.warn('[FHIR] FHIRcast ImagingStudy context carries no study UID:', resource);
    return null;
  }

  if (study.id) {
    _store.studyToFhirId.set(StudyInstanceUID, study.id);
  }
  _store.imagingStudyMap.set(StudyInstanceUID, study);

  // Front of the list: getStudyInstanceUIDs() hands these to the route in order,
  // and the first one is what the hanging protocol opens.
  const others = _store.studyInstanceUIDs.filter(
    uid => uid && uid !== StudyInstanceUID && uid !== PLACEHOLDER_STUDY_UID
  );
  _store.studyInstanceUIDs = [StudyInstanceUID, ...others];

  // Keep the study resolvable even before any metadata arrives — the hanging
  // protocol service crashes on a StudyInstanceUID the store can't resolve.
  DicomMetadataStore.addStudy({
    StudyInstanceUID,
    PatientID: summary.PatientID || '',
    PatientName: summary.PatientName || '',
    StudyDate: summary.StudyDate || '',
    ModalitiesInStudy: summary.Modalities ? summary.Modalities.split('\\') : [],
    StudyDescription: summary.StudyDescription || '',
    AccessionNumber: summary.AccessionNumber || '',
    NumInstances: summary.NumInstances || 0,
  });

  // Follow the subject as well. A FHIRcast event moves the whole context, so
  // leaving _config.patientId on the previous patient would refill the study
  // browser with that patient's studies alongside this one's.
  const patientId = (study.subject?.reference || '').replace(/^Patient\//, '');
  if (patientId && patientId !== _config.patientId) {
    console.log('[FHIR] FHIRcast context switched patient:', _config.patientId, '->', patientId);
    _config.patientId = patientId;
  }

  console.log('[FHIR] Registered ImagingStudy from FHIRcast context:', StudyInstanceUID);
  return { StudyInstanceUID, patientId: patientId || _config.patientId || '' };
}

function createFhirApi(fhirConfig, servicesManager, extensionManager) {
  _servicesManager = servicesManager;
  _extensionManager = extensionManager || _extensionManager;
  if (fhirConfig) {
    Object.assign(_config, fhirConfig);
  }

  // Client ID resolves from the data-source `configuration` merged above
  // (e.g. `smartClientId` in the OHIF data source config). localStorage —
  // populated by the SMART Preferences panel — overrides it when present.
  let clientIdSource = _config.smartClientId ? 'dataSourceConfig' : 'none';

  const savedSmartConfig = localStorage.getItem('fhir_smart_config');
  if (savedSmartConfig) {
    try {
      const parsed = JSON.parse(savedSmartConfig);
      if (parsed.smartClientId) {
        _config.smartClientId = parsed.smartClientId;
        clientIdSource = 'localStorage';
      }
      if (parsed.smartScope) _config.smartScope = parsed.smartScope;
      if (parsed.fhirBaseUrl) _config.fhirBaseUrl = parsed.fhirBaseUrl;
    } catch (e) { /* ignore parse errors */ }
  }

  // Highest precedence: SMART_CLIENT_ID / SMART_FHIR_SERVER_URL env vars,
  // inlined at build time by the DefinePlugin entries scripts/setup.js patches
  // into webpack.pwa.js. Env wins over localStorage because the Preferences UI
  // locks these fields when an env value is present.
  const envClientId = getEnvSmartClientId();
  if (envClientId) {
    _config.smartClientId = envClientId;
    clientIdSource = 'environment';
  }
  const envFhirServerUrl = getEnvFhirServerUrl();
  if (envFhirServerUrl) {
    _config.fhirBaseUrl = envFhirServerUrl;
  }

  if (!_config.smartClientId) {
    console.warn(
      '[FHIR] No SMART client ID configured. SMART on FHIR authentication ' +
        'requires `smartClientId` in the data-source configuration, or a value ' +
        'set via the SMART Preferences panel.'
    );
  }

  console.log('[FHIR] Data source initialized with config:', {
    fhirBaseUrl: _config.fhirBaseUrl,
    smartClientId: _config.smartClientId || '(not set)',
    smartScope: _config.smartScope || '(default)',
    source: clientIdSource,
  });

  const implementation = {
    initialize: async ({ params, query }) => {
      // Capture all URL query params for display in the sidebar
      if (query && query.entries) {
        const allParams = {};
        for (const [key, value] of query.entries()) {
          allParams[key] = value;
        }
        _config.urlParams = allParams;
      }

      const qGet = (key) => query && query.get && query.get(key);
      const code = qGet('code');
      const state = qGet('state');
      const iss = qGet('iss');
      const launch = qGet('launch');

      // ── CASE A: OAuth callback — exchange code for token ──
      if (code && state) {
        console.log('[FHIR] OAuth callback detected, exchanging code for token...');
        const authState = loadAuthState();

        if (!authState || authState.state !== state) {
          console.error('[FHIR] OAuth state mismatch or missing auth state');
          clearAuthState();
          _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
          return [PLACEHOLDER_STUDY_UID];
        }

        try {
          const redirectUri = window.location.origin + window.location.pathname;
          const tokenResponse = await exchangeCodeForToken({
            tokenEndpoint: authState.tokenEndpoint,
            code,
            clientId: authState.clientId,
            redirectUri,
            codeVerifier: authState.codeVerifier,
          });

          saveToken(tokenResponse);
          clearAuthState();

          _config.authToken = tokenResponse.access_token;
          _config.iss = authState.iss;
          _config.fhirBaseUrl = authState.iss;
          _config.smartAuthenticated = true;

          // FHIRcast launch parameters (SMART launch, per FHIRcast IG §2-1 Session Discovery).
          // Present only when the granted scope includes `fhircast/`. These let the FHIRcast
          // panel target the hub directly instead of guessing its URL.
          _config.hubUrl = tokenResponse['hub.url'] || '';
          _config.hubTopic = tokenResponse['hub.topic'] || '';

          try {
            const url = new URL(authState.iss);
            _config.fhirServerRoot = url.origin;
          } catch (e) {
            console.warn('[FHIR] Could not parse ISS URL:', e);
          }

          // Use patient from token response or saved state
          const patientId = tokenResponse.patient || authState.patientId || '';
          _config.patientId = patientId;
          _config.launch = authState.launch || '';

          // Restore original URL params saved before the OAuth redirect
          _config.urlParams = authState.urlParams || {};

          // Clean the URL — remove code/state params
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('code');
          cleanUrl.searchParams.delete('state');
          window.history.replaceState({}, '', cleanUrl.toString());

          if (!patientId) {
            console.warn('[FHIR] Authenticated but no patient ID. Use the FHIR Config panel.');
            _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
            return [PLACEHOLDER_STUDY_UID];
          }

          return await _fetchStudyUIDs(patientId);
        } catch (error) {
          console.error('[FHIR] Token exchange failed:', error);
          clearAuthState();
          _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
          return [PLACEHOLDER_STUDY_UID];
        }
      }

      // ── CASE B: EHR launch — discover endpoints & redirect to authorize ──
      if (iss && launch) {
        console.log('[FHIR] SMART EHR launch detected, starting OAuth flow...');
        const clientId = resolveSmartClientId(query);
        if (!clientId) {
          console.error('[FHIR] No smartClientId configured — cannot start OAuth flow');
          const { uiNotificationService } = _servicesManager?.services || {};
          if (uiNotificationService) {
            uiNotificationService.show({
              title: 'SMART on FHIR',
              message:
                'No SMART client ID configured. Set `smartClientId` in the data-source configuration, or via the SMART Preferences panel.',
              type: 'error',
              duration: 15000,
            });
          }
          _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
          return [PLACEHOLDER_STUDY_UID];
        }
        // FHIRcast scopes (`fhircast/...`) trigger the hub to return hub.url/hub.topic SMART launch
        // params (Medplum: oauth/token.ts). The registered ClientApplication must permit these scopes.
        const scope =
          _config.smartScope ||
          'launch openid fhirUser patient/*.read fhircast/Patient-open.read fhircast/ImagingStudy-open.read';
        const patientId = qGet('patient') || qGet('patientId') || _config.patientId;

        try {
          const endpoints = await fetchSmartConfiguration(iss);
          const { codeVerifier, codeChallenge } = await generatePKCE();
          const stateValue = base64Random();
          const redirectUri = window.location.origin + window.location.pathname;

          saveAuthState({
            state: stateValue,
            codeVerifier,
            iss,
            launch,
            patientId,
            clientId,
            tokenEndpoint: endpoints.token_endpoint,
            urlParams: _config.urlParams,
          });

          const authorizeUrl = buildAuthorizationUrl({
            authorizationEndpoint: endpoints.authorization_endpoint,
            clientId,
            redirectUri,
            scope,
            state: stateValue,
            codeChallenge,
            iss,
            launch,
          });

          console.log('[FHIR] Redirecting to authorization endpoint...');
          window.location.href = authorizeUrl;

          // Return placeholder — page will redirect before rendering
          _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
          return [PLACEHOLDER_STUDY_UID];
        } catch (error) {
          console.error('[FHIR] SMART discovery failed:', error);
          // Fall through to manual config
        }
      }

      // ── CASE C: No OAuth params — check cached token or use manual config ──

      // Capture SMART launch params from URL (non-OAuth scenario)
      if (iss) {
        _config.iss = iss;
        _config.fhirBaseUrl = iss;
        try {
          const url = new URL(iss);
          _config.fhirServerRoot = url.origin;
        } catch (e) {
          console.warn('[FHIR] Could not parse ISS URL:', e);
        }
      }
      if (launch) {
        _config.launch = launch;
      }

      // Check for cached OAuth token
      if (!_config.authToken) {
        const cached = getStoredToken();
        if (cached) {
          _config.authToken = cached.access_token;
          _config.smartAuthenticated = true;
          // Restore FHIRcast launch params captured at token exchange (saveToken preserves them).
          _config.hubUrl = cached['hub.url'] || _config.hubUrl;
          _config.hubTopic = cached['hub.topic'] || _config.hubTopic;
          console.log('[FHIR] Using cached OAuth token');
        }
      }

      const patientId = qGet('patient') || qGet('patientId') || _config.patientId;

      if (!patientId) {
        console.warn('[FHIR] No patientId configured. Use the FHIR Config panel to set one.');
        _store.studyInstanceUIDs = [PLACEHOLDER_STUDY_UID];
        return [PLACEHOLDER_STUDY_UID];
      }

      _config.patientId = patientId;
      return await _fetchStudyUIDs(patientId);
    },

    query: {
      studies: {
        mapParams: () => {},
        search: async (param) => {
          // Return a stub for the placeholder so the study browser doesn't
          // redirect to /notfoundstudy when no real studies are loaded yet.
          const requestedUid = param?.studyInstanceUid || param?.studyInstanceUID;
          if (requestedUid === PLACEHOLDER_STUDY_UID) {
            return [{
              StudyInstanceUID: PLACEHOLDER_STUDY_UID,
              studyInstanceUid: PLACEHOLDER_STUDY_UID,
              StudyDate: '',
              StudyDescription: 'Awaiting FHIR context...',
              ModalitiesInStudy: '',
              NumInstances: 0,
              PatientName: '',
              PatientID: '',
              AccessionNumber: '',
            }];
          }

          const patientId = _config.patientId;
          if (!patientId) return [];

          const opts = { authToken: _config.authToken };

          let patientName = '';
          try {
            const patient = await fetchPatient(_config.fhirBaseUrl, patientId, opts);
            if (patient.name && patient.name.length > 0) {
              const name = patient.name[0];
              const given = (name.given || []).join(' ');
              const family = name.family || '';
              patientName = `${family}^${given}`.trim();
            }
          } catch (error) {
            console.warn('[FHIR] Could not fetch patient name:', error);
          }

          try {
            const studyBundle = await fetchImagingStudies(_config.fhirBaseUrl, patientId, opts);
            const entries = studyBundle.entry || [];
            const studies = entries.map(e => e.resource);

            _store.studies = studies.map(s => {
              const summary = imagingStudyToStudySummary(s, patientName);
              _store.studyToFhirId.set(summary.studyInstanceUid, s.id);
              _store.imagingStudyMap.set(summary.studyInstanceUid, s);
              return summary;
            });

            _store.studyInstanceUIDs = _store.studies.map(s => s.studyInstanceUid);

            return _store.studies;
          } catch (error) {
            console.error('[FHIR] Failed to search studies:', error);
            return [];
          }
        },
        processResults: () => {
          console.warn('[FHIR] processResults not implemented');
        },
      },
      series: {
        search: () => {
          console.warn('[FHIR] series search not implemented');
        },
      },
      instances: {
        search: () => {
          console.warn('[FHIR] instances search not implemented');
        },
      },
    },

    retrieve: {
      directURL: params => {
        const StudyInstanceUID = params?.instance?.StudyInstanceUID;
        if (_isDicomWebStudy(StudyInstanceUID)) {
          return _getDicomWebDelegate()?.retrieve?.directURL?.(params);
        }
        return params?.instance?.url || params?.tag;
      },

      // Study-browser thumbnails and bulkdata, for delegated studies only: a
      // FHIR attachment has no thumbnail or bulkdata endpoint to ask, and the
      // callers treat a missing result as "none" rather than an error. Gated on
      // the study so studies loaded from FHIR don't fire requests at a DICOMweb
      // server that has never heard of them.
      getGetThumbnailSrc: (thumbnailContext, imageId) => {
        if (!_isDicomWebStudy(thumbnailContext?.StudyInstanceUID)) {
          return undefined;
        }
        return _getDicomWebDelegate()?.retrieve?.getGetThumbnailSrc?.(thumbnailContext, imageId);
      },

      bulkDataURI: params => {
        if (!_isDicomWebStudy(params?.StudyInstanceUID)) {
          return undefined;
        }
        return _getDicomWebDelegate()?.retrieve?.bulkDataURI?.(params);
      },
      series: {
        metadata: async ({
          filters = {},
          StudyInstanceUID,
          madeInClient = false,
          sortCriteria,
          sortFunction,
          returnPromises = false,
        } = {}) => {
          if (!StudyInstanceUID || StudyInstanceUID === PLACEHOLDER_STUDY_UID) {
            return;
          }

          if (_store.loadedStudies.has(StudyInstanceUID)) {
            // Skipping is only safe while the work this function did is still
            // standing, and that is two separate stores. DicomMetadataStore is a
            // module singleton that survives route changes, but display sets do
            // not: Mode.tsx calls displaySetService.init() on every mode entry
            // and that assigns `activeDisplaySets = []`. Navigating back to an
            // already-visited study therefore arrives with the metadata still
            // cached and the display sets gone, and skipping on the metadata
            // alone left the viewport black — nothing re-adds the instances, so
            // no INSTANCES_ADDED fires and nothing rebuilds the display sets.
            //
            // Nothing else clears this either: deleteStudyMetadataPromise is the
            // only hook that would, and OHIF calls it in exactly one place, after
            // a STOW upload, never on navigation.
            const displaySetService = _servicesManager?.services?.displaySetService;
            const hasDisplaySets = !!displaySetService
              ?.getActiveDisplaySets()
              ?.some((ds) => ds.StudyInstanceUID === StudyInstanceUID);

            if (DicomMetadataStore.getStudy(StudyInstanceUID) && hasDisplaySets) {
              console.log('[FHIR] metadata() — study already loaded, skipping:', StudyInstanceUID);
              return;
            }
            console.warn('[FHIR] metadata() — study marked loaded but not renderable (metadata:',
              !!DicomMetadataStore.getStudy(StudyInstanceUID), 'displaySets:', hasDisplaySets,
              '), reprocessing:', StudyInstanceUID);
            // Reprocessing re-derives all three, so drop the DICOMweb bookkeeping
            // with it rather than leaving a stale verdict about where this study
            // came from.
            _store.loadedStudies.delete(StudyInstanceUID);
            _store.dicomWebAttempted.delete(StudyInstanceUID);
            _store.dicomWebStudies.delete(StudyInstanceUID);
          }

          console.log('[FHIR] metadata() called for StudyInstanceUID:', StudyInstanceUID);

          try {
          const opts = { authToken: _config.authToken };

          // ── Try ImagingStudy series/instance data first ──
          let imagingStudy = _store.imagingStudyMap.get(StudyInstanceUID);

          if (!imagingStudy) {
            // Re-fetch if not cached (e.g. deep-link scenario)
            const fhirStudyId = _store.studyToFhirId.get(StudyInstanceUID);
            if (fhirStudyId) {
              try {
                imagingStudy = await fetchImagingStudyById(
                  _config.fhirBaseUrl,
                  fhirStudyId,
                  opts
                );
              } catch (error) {
                console.warn('[FHIR] Could not re-fetch ImagingStudy:', error);
              }
            }
          }

          console.log('[FHIR] metadata() — imagingStudy found:', !!imagingStudy, 'for', StudyInstanceUID);

          if (imagingStudy) {
            // Ensure the study exists in DicomMetadataStore with FHIR metadata.
            // The hanging protocol requires every StudyInstanceUID to resolve —
            // without this, studies with no series/instances cause a crash.
            const studySummary = imagingStudyToStudySummary(imagingStudy, '');
            DicomMetadataStore.addStudy({
              StudyInstanceUID,
              PatientID: studySummary.PatientID,
              PatientName: studySummary.PatientName,
              StudyDate: studySummary.StudyDate,
              ModalitiesInStudy: studySummary.Modalities
                ? studySummary.Modalities.split('\\')
                : [],
              StudyDescription: studySummary.StudyDescription,
              AccessionNumber: studySummary.AccessionNumber,
              NumInstances: studySummary.NumInstances,
            });
            console.log('[FHIR] metadata() — addStudy called, verify:', !!DicomMetadataStore.getStudy(StudyInstanceUID));

            // Diagnostic: log what keys the cached ImagingStudy has
            console.log('[FHIR] Cached ImagingStudy keys:', Object.keys(imagingStudy));

            // Log endpoint references (diagnostic — shows if WADO-RS is available)
            if (imagingStudy.endpoint && imagingStudy.endpoint.length > 0) {
              console.log('[FHIR] ImagingStudy endpoint references:', imagingStudy.endpoint);
            }

            let { seriesList, instancesBySeriesUID } = extractSeriesMetadata(
              imagingStudy,
              StudyInstanceUID
            );

            // If cached ImagingStudy has no series data, re-fetch the full resource by ID
            if (seriesList.length === 0) {
              const fhirStudyId = imagingStudy.id || _store.studyToFhirId.get(StudyInstanceUID);
              if (fhirStudyId) {
                console.log('[FHIR] Re-fetching full ImagingStudy by ID...');
                try {
                  const fullStudy = await fetchImagingStudyById(
                    _config.fhirBaseUrl,
                    fhirStudyId,
                    opts
                  );
                  if (fullStudy) {
                    // Update cache with the full resource
                    _store.imagingStudyMap.set(StudyInstanceUID, fullStudy);
                    imagingStudy = fullStudy;
                    ({ seriesList, instancesBySeriesUID } = extractSeriesMetadata(
                      fullStudy,
                      StudyInstanceUID
                    ));
                    if (seriesList.length === 0) {
                      console.log('[FHIR] Full ImagingStudy also has no series data');
                    }
                  }
                } catch (error) {
                  console.warn('[FHIR] Could not re-fetch full ImagingStudy:', error);
                }
              }
            }

            // If the launch URL includes a gridfsFileId, use it to override
            // stale extension values in the ImagingStudy. The RIS constructs
            // the launch URL from the current GridFS file, so it's authoritative.
            const urlGridfsFileId = _config.urlParams?.gridfsFileId;
            if (urlGridfsFileId) {
              let gridfsInstanceCount = 0;
              for (const [, instances] of instancesBySeriesUID) {
                for (const inst of instances) {
                  if (inst.gridfsFileId) gridfsInstanceCount++;
                }
              }
              // Only override for single-instance studies (we can't map a single
              // URL param to multiple instances)
              if (gridfsInstanceCount === 1) {
                for (const [, instances] of instancesBySeriesUID) {
                  for (const inst of instances) {
                    if (inst.gridfsFileId && inst.gridfsFileId !== urlGridfsFileId) {
                      console.warn(
                        '[FHIR] Overriding stale gridfsFileId from ImagingStudy extension:',
                        inst.gridfsFileId, '→', urlGridfsFileId
                      );
                      inst.gridfsFileId = urlGridfsFileId;
                    }
                  }
                }
              }
            }

            let fhirInstanceCount = 0;
            for (const [, instances] of instancesBySeriesUID) {
              fhirInstanceCount += instances.length;
            }

            console.log('[FHIR] metadata() — seriesList.length:', seriesList.length, 'instances:', fhirInstanceCount, 'for', StudyInstanceUID);

            // The ImagingStudy names the study and its series but carries no
            // instances, so it cannot locate a single image: no
            // `series[].instance[]` means no SOP Instance UIDs, and the study
            // would load as a populated series list over an empty viewport.
            // Ask DICOMweb for the instance level instead. Only reached when a
            // DICOMweb root is configured; otherwise the series-only path below
            // runs exactly as before.
            if (fhirInstanceCount === 0) {
              const delegated = await _retrieveMetadataFromDicomWeb({
                StudyInstanceUID,
                filters,
                sortCriteria,
                sortFunction,
                madeInClient,
                returnPromises,
              });
              if (delegated !== false) {
                return delegated === true ? undefined : delegated;
              }
            }

            if (seriesList.length > 0) {
              let totalInstances = 0;
              const hasGridFs = seriesList.some(seriesMeta => {
                const instances = instancesBySeriesUID.get(seriesMeta.SeriesInstanceUID) || [];
                return instances.some(inst => inst.gridfsFileId);
              });

              if (hasGridFs) {
                // ── GridFS path: fetch DICOM files, parse metadata, use blob URLs ──
                console.log('[FHIR] Instances have gridfsFileId — fetching DICOM from GridFS');

                // Collect all instances that need fetching
                const fetchTasks = [];
                for (const seriesMeta of seriesList) {
                  const instances = instancesBySeriesUID.get(seriesMeta.SeriesInstanceUID) || [];
                  totalInstances += instances.length;
                  for (const inst of instances) {
                    if (inst.gridfsFileId) {
                      fetchTasks.push({ inst, seriesMeta });
                    } else {
                      // Non-GridFS instance — use WADO-RS fallback
                      const imageId = `dicomweb:${_config.fhirBaseUrl}/studies/${StudyInstanceUID}/series/${seriesMeta.SeriesInstanceUID}/instances/${inst.SOPInstanceUID}`;
                      inst.url = imageId;
                      inst.imageId = imageId;
                      metadataProvider.addImageIdToUIDs(imageId, {
                        StudyInstanceUID,
                        SeriesInstanceUID: seriesMeta.SeriesInstanceUID,
                        SOPInstanceUID: inst.SOPInstanceUID,
                      });
                    }
                  }
                }

                // Fetch with concurrency limit
                const CONCURRENCY = 6;
                for (let i = 0; i < fetchTasks.length; i += CONCURRENCY) {
                  const batch = fetchTasks.slice(i, i + CONCURRENCY);
                  const results = await Promise.allSettled(
                    batch.map(async ({ inst, seriesMeta }) => {
                      const filePath = `/api/dicom/files/${inst.gridfsFileId}`;
                      const arrayBuffer = await fetchDicomFile(
                        _config.fhirServerRoot,
                        filePath,
                        { authToken: _config.authToken }
                      );

                      const metadata = parseDicomArrayBuffer(
                        arrayBuffer,
                        `GridFS:${inst.gridfsFileId}`
                      );

                      const blob = new Blob([arrayBuffer], { type: 'application/dicom' });
                      const blobUrl = URL.createObjectURL(blob);
                      const imageId = `wadouri:${blobUrl}`;

                      Object.assign(inst, wrapSequences(metadata));
                      // Restore FHIR-assigned UIDs — the DICOM file may contain different
                      // StudyInstanceUID/SeriesInstanceUID than what FHIR uses. The rest
                      // of the system (routing, DicomMetadataStore, hanging protocol) relies
                      // on the FHIR UIDs, so we must preserve them.
                      inst.StudyInstanceUID = StudyInstanceUID;
                      inst.SeriesInstanceUID = seriesMeta.SeriesInstanceUID;
                      inst.url = imageId;
                      inst.imageId = imageId;

                      metadataProvider.addImageIdToUIDs(imageId, {
                        StudyInstanceUID,
                        SeriesInstanceUID: seriesMeta.SeriesInstanceUID,
                        SOPInstanceUID: inst.SOPInstanceUID,
                      });
                    })
                  );

                  for (const result of results) {
                    if (result.status === 'rejected') {
                      console.warn('[FHIR] GridFS fetch failed for an instance:', result.reason?.message);
                    }
                  }
                }
              } else {
                // ── WADO-RS path: construct DICOMweb URLs (for DICOMweb-capable servers) ──
                for (const seriesMeta of seriesList) {
                  const instances = instancesBySeriesUID.get(seriesMeta.SeriesInstanceUID) || [];
                  totalInstances += instances.length;

                  for (const inst of instances) {
                    const imageId = `dicomweb:${_config.fhirBaseUrl}/studies/${StudyInstanceUID}/series/${seriesMeta.SeriesInstanceUID}/instances/${inst.SOPInstanceUID}`;
                    inst.url = imageId;
                    inst.imageId = imageId;

                    metadataProvider.addImageIdToUIDs(imageId, {
                      StudyInstanceUID,
                      SeriesInstanceUID: seriesMeta.SeriesInstanceUID,
                      SOPInstanceUID: inst.SOPInstanceUID,
                    });
                  }
                }
              }

              console.log(`[FHIR] Loaded ${seriesList.length} series with ${totalInstances} instances from ImagingStudy`);

              DicomMetadataStore.addSeriesMetadata(seriesList, madeInClient);

              for (const [, instances] of instancesBySeriesUID) {
                if (instances.length > 0) {
                  DicomMetadataStore.addInstances(instances, madeInClient);
                }
              }

              _store.loadedStudies.add(StudyInstanceUID);

              const study = DicomMetadataStore.getStudy(StudyInstanceUID, madeInClient);
              if (study) {
                study.isLoaded = true;
              }

              return;
            }
          }

          // No usable ImagingStudy (missing resource, or no series at all). Try
          // DICOMweb before DocumentReferences: a FHIRcast context can name a
          // study by UID alone, which is all the DICOMweb query needs.
          {
            const delegated = await _retrieveMetadataFromDicomWeb({
              StudyInstanceUID,
              filters,
              sortCriteria,
              sortFunction,
              madeInClient,
              returnPromises,
            });
            if (delegated !== false) {
              return delegated === true ? undefined : delegated;
            }
          }

          // ── Fallback: DocumentReference path (for servers without ImagingStudy series data) ──
          console.log('[FHIR] ImagingStudy has no series data, falling back to DocumentReferences');

          const fhirStudyId = _store.studyToFhirId.get(StudyInstanceUID);
          let docBundle;
          try {
            docBundle = await fetchDocumentReferences(
              _config.fhirBaseUrl,
              {
                patientId: _config.patientId,
                imagingStudyId: fhirStudyId,
              },
              opts
            );
          } catch (error) {
            console.error('[FHIR] Failed to fetch DocumentReferences:', error);
            return;
          }

          const docEntries = docBundle.entry || [];
          const documents = docEntries.map(e => e.resource);
          console.log('[FHIR] metadata() — DocumentReferences found:', documents.length, 'documents for', StudyInstanceUID);

          const seriesMap = new Map();

          for (const doc of documents) {
            if (!doc.content || doc.content.length === 0) continue;

            for (const content of doc.content) {
              const attachment = content.attachment;
              if (!attachment) continue;

              try {
                const { imageId, metadata } = await loadDicomFromAttachment(
                  attachment,
                  _config.fhirServerRoot,
                  _config.authToken
                );

                const SeriesInstanceUID = metadata.SeriesInstanceUID;
                const SOPInstanceUID = metadata.SOPInstanceUID;

                if (!seriesMap.has(SeriesInstanceUID)) {
                  seriesMap.set(SeriesInstanceUID, {
                    SeriesInstanceUID,
                    StudyInstanceUID,
                    SeriesDescription: metadata.SeriesDescription || '',
                    SeriesNumber: metadata.SeriesNumber || '',
                    Modality: metadata.Modality || '',
                    instances: [],
                  });
                }

                const wrappedMetadata = wrapSequences(metadata);

                const instanceData = {
                  ...wrappedMetadata,
                  StudyInstanceUID,
                  SeriesInstanceUID,
                  SOPInstanceUID,
                  url: imageId,
                  imageId,
                };

                seriesMap.get(SeriesInstanceUID).instances.push(instanceData);

                metadataProvider.addImageIdToUIDs(imageId, {
                  StudyInstanceUID,
                  SeriesInstanceUID,
                  SOPInstanceUID,
                });
              } catch (error) {
                console.warn('[FHIR] Failed to load DICOM from attachment:', error.message);
              }
            }
          }

          const seriesSummaryMetadata = [];
          for (const [, seriesData] of seriesMap) {
            const { instances, ...seriesSummary } = seriesData;
            seriesSummaryMetadata.push(seriesSummary);
          }

          console.log('[FHIR] metadata() — DocumentReferences produced', seriesSummaryMetadata.length, 'series for', StudyInstanceUID);

          if (seriesSummaryMetadata.length > 0) {
            DicomMetadataStore.addSeriesMetadata(seriesSummaryMetadata, madeInClient);

            for (const [, seriesData] of seriesMap) {
              DicomMetadataStore.addInstances(seriesData.instances, madeInClient);
            }
          }

          _store.loadedStudies.add(StudyInstanceUID);

          const study = DicomMetadataStore.getStudy(StudyInstanceUID, madeInClient);
          if (study) {
            study.isLoaded = true;
          }

          } finally {
            // Safety net: guarantee every processed StudyInstanceUID has a study
            // in DicomMetadataStore, regardless of which code path executed.
            if (!DicomMetadataStore.getStudy(StudyInstanceUID)) {
              console.warn('[FHIR] Safety net — creating minimal study for:', StudyInstanceUID);
              DicomMetadataStore.addStudy({
                StudyInstanceUID,
                PatientID: '',
                PatientName: '',
                StudyDate: '',
                ModalitiesInStudy: [],
                StudyDescription: '',
                AccessionNumber: '',
                NumInstances: 0,
              });
            }
            console.log('[FHIR] metadata() — complete for', StudyInstanceUID, ', study in store:', !!DicomMetadataStore.getStudy(StudyInstanceUID));
          }
        },
      },
    },

    store: {
      dicom: async (dataset) => {
        console.log('[FHIR] store.dicom called — creating DocumentReference for SR');

        // 1. Convert naturalized dataset to DICOM Part 10 binary
        const { DicomDict, DicomMetaDictionary } = dcmjs.data;
        const meta = {
          MediaStorageSOPClassUID: dataset.SOPClassUID,
          MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
          TransferSyntaxUID: '1.2.840.10008.1.2.1',
          ImplementationClassUID: '2.25.270695996825855179949881587723571202391',
          ImplementationVersionName: 'OHIF-FHIR-SR-0.1',
        };
        const denaturalized = DicomMetaDictionary.denaturalizeDataset(meta);
        const dicomDict = new DicomDict(denaturalized);
        dicomDict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
        const part10Buffer = dicomDict.write();

        // 2. Base64-encode for FHIR attachment
        const base64Data = arrayBufferToBase64(part10Buffer);
        console.log('[FHIR] SR encoded — Part10 size:', part10Buffer.byteLength, 'bytes, base64 length:', base64Data.length);

        // 3. Build FHIR DocumentReference
        const patientId = _config.patientId;
        const docRef = {
          resourceType: 'DocumentReference',
          status: 'current',
          type: {
            coding: [{
              system: 'http://loinc.org',
              code: '18748-4',
              display: 'Diagnostic imaging study',
            }],
          },
          subject: patientId ? { reference: `Patient/${patientId}` } : undefined,
          description: 'DICOM Structured Report — TID 1500 Imaging Measurement Report',
          content: [{
            attachment: {
              contentType: 'application/dicom',
              data: base64Data,
            },
          }],
        };

        // 4. POST to FHIR server
        const result = await createDocumentReference(_config.fhirBaseUrl, docRef, {
          authToken: _config.authToken,
        });
        console.log('[FHIR] DocumentReference created:', result.id);
        return result;
      },
    },

    getImageIdsForDisplaySet(displaySet) {
      if (_isDicomWebStudy(displaySet?.StudyInstanceUID)) {
        return _getDicomWebDelegate().getImageIdsForDisplaySet(displaySet);
      }

      const images = displaySet.images;
      const imageIds = [];

      if (!images) return imageIds;

      images.forEach(instance => {
        const NumberOfFrames = instance.NumberOfFrames || 1;
        if (NumberOfFrames > 1) {
          for (let i = 0; i < NumberOfFrames; i++) {
            const frameImageId = instance.imageId
              ? `${instance.imageId}&frame=${i}`
              : instance.url
                ? `${instance.url}&frame=${i}`
                : '';
            if (frameImageId) imageIds.push(frameImageId);
          }
        } else {
          const imageId = instance.imageId || instance.url || '';
          if (imageId) imageIds.push(imageId);
        }
      });

      return imageIds;
    },

    getImageIdsForInstance({ instance, frame }) {
      if (_isDicomWebStudy(instance?.StudyInstanceUID)) {
        return _getDicomWebDelegate().getImageIdsForInstance({ instance, frame });
      }

      const baseImageId = instance.imageId || instance.url || '';
      if (frame !== undefined) {
        return `${baseImageId}&frame=${frame}`;
      }
      return baseImageId;
    },

    deleteStudyMetadataPromise: (StudyInstanceUID) => {
      console.log('[FHIR] deleteStudyMetadataPromise called for', StudyInstanceUID);
      _store.loadedStudies.delete(StudyInstanceUID);
      _store.dicomWebAttempted.delete(StudyInstanceUID);
      if (_store.dicomWebStudies.delete(StudyInstanceUID)) {
        // Drop the delegate's cached study-metadata promise too, or a reopen
        // resolves against metadata that is no longer in the store.
        _getDicomWebDelegate()?.deleteStudyMetadataPromise?.(StudyInstanceUID);
      }
    },

    getStudyInstanceUIDs: ({ params, query } = {}) => {
      // A StudyInstanceUIDs param takes precedence: it is how the study list
      // and the FHIRcast panel say which study to open. The rest of the store
      // follows so the study browser still lists the patient's other studies.
      const requested = [];
      if (query && typeof query.getAll === 'function') {
        for (const value of [...query.getAll('StudyInstanceUIDs'), ...query.getAll('studyInstanceUIDs')]) {
          requested.push(...String(value).split(','));
        }
      }
      const fromParams = params?.StudyInstanceUIDs || params?.studyInstanceUIDs;
      if (fromParams) {
        requested.push(...(Array.isArray(fromParams) ? fromParams : [fromParams]));
      }

      const uids = [];
      for (const uid of [...requested, ..._store.studyInstanceUIDs]) {
        const trimmed = typeof uid === 'string' ? uid.trim() : uid;
        if (trimmed && !uids.includes(trimmed)) {
          uids.push(trimmed);
        }
      }

      // The placeholder only stands in for an empty list; drop it once a real
      // study is present or the browser shows an "Awaiting FHIR context" row
      // next to a study that is loading fine.
      const real = uids.filter(uid => uid !== PLACEHOLDER_STUDY_UID);
      return real.length > 0 ? real : [PLACEHOLDER_STUDY_UID];
    },
  };

  return IWebApiDataSource.create(implementation);
}

export {
  createFhirApi,
  PLACEHOLDER_STUDY_UID,
  registerSmartClient,
  registerImagingStudyContext,
};
