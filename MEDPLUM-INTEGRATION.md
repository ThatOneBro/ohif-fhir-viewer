# Medplum Integration

Step-by-step guide for setting up [Medplum](https://www.medplum.com/) as the FHIR R4
backend (and FHIRcast hub) for the OHIF FHIR Viewer.

Medplum is a good fit for this viewer's **CORS-direct** model: it ships with
`allowedOrigins: "*"` in development, so the browser calls the FHIR and FHIRcast
endpoints directly — no dev proxy required.

## 1. Install and Run the OHIF Viewer
Begin by installing the OHIF Viewer

```bash
# (terminal Z) create a working directory
mkdir demo && cd demo

# install OHIF and the NOF FHIR extension
#git clone https://github.com/OHIF/Viewers

git clone https://github.com/awatson1978/Viewers
cd Viewers
git fetch origin
git checkout fhircast-mvd

# install the extension
cd extensions
git clone https://github.com/node-on-fhir/ohif-fhir-viewer
cd ..

# install dependencies and run the app
brew install pnpm
pnpm install
pnpm dev

# run with with the extension
OHIF_PORT=3200 EXTRA_EXTENSIONS=@ohif/fhir-viewer pnpm dev
```

> **Mode auto-detection:** when an `EXTRA_EXTENSIONS` package contains a `mode/`
> subdirectory with a `package.json`, that mode is registered automatically. Use
> `EXTRA_MODES` only to override or add other modes explicitly.

The viewer is now available at `http://localhost:3200/fhir-viewer`.

## 2. Install and Run Medplum

Medplum needs Redis and PostgreSQL (provided via Docker), the API server, and the
admin app. See the [Medplum local dev docs](https://www.medplum.com/docs/contributing/run-the-stack)
for first-time clone/build steps.

| Service | URL | Notes |
|---|---|---|
| Medplum server | `http://localhost:8103` | FHIR R4 API + FHIRcast hub |
| Medplum app | `http://localhost:3000` | Admin UI for resource management |
| Redis | `localhost:6379` | Docker container `redis-1` |
| PostgreSQL | `localhost:5432` | Docker container `postgres-1` |

```bash
# (terminal A) clone the repository
# git clone https://github.com/medplum/medplum
# cd medplum
cd 

# (terminal A) clone the repository
git clone https://github.com/awatson1978/medplum
cd medplum
git fetch origin
git checkout fhircast-r4 
npm install
npm run build:fast

# Redis and Postgres with Docker (Colima)
brew install colima docker docker-compose
colima start # docker runtime
docker compose up     # with logs
docker compose up -d  # without logs
docker compose ps

# (terminal B) Medplum API server (FHIR R4 + FHIRcast hub) on :8103
cd packages/server
npm install
npm run dev

# (terminal C) Medplum app
cd packages/app
npm install
npm run dev

```

The Medplum admin app runs on `http://localhost:3000` (start it per the Medplum
docs if it isn't already running).

> **CORS:** Medplum's dev config sets `allowedOrigins: "*"`, so OHIF (on `:3200`)
> can call the FHIR, OAuth, and FHIRcast endpoints on `:8103` directly. No
> `/fhir-proxy` and no `FHIR_SERVER` setting are involved — the browser talks to
> Medplum at its absolute origin.

## 3. Register the Viewer as a Client

OHIF authenticates against Medplum using SMART on FHIR (OAuth 2.0). Register a
`ClientApplication` so Medplum knows which app is requesting access.

1. In the Medplum app, navigate to `http://localhost:3000/ClientApplication/new`.
2. Set:
   - **Name**: `OHIF Viewer`
   - **Redirect URI**: `http://localhost:3200/fhir-viewer`
   - **Launch URI**: `http://localhost:3200/fhir-viewer`
3. Save.
4. **Copy the ClientApplication UUID** from the URL bar
   (`http://localhost:3000/ClientApplication/<uuid>`) — this is your SMART client ID.

Supply that UUID to OHIF at **runtime** — there is no `SMART_CLIENT_ID` build var
(OHIF is a static SPA). Use any of, most-specific wins:

1. **URL** — `?client_id=<uuid>` appended to the launch (per-launch).

2. **SMART Preferences panel** 
```bash
# Client ID
<uuid>
# FHIR Server URL
http://http://localhost:8103/fhir/R4
```
SAVE

in OHIF — paste/register the client ID (per-user, saved to localStorage).
3. **`window.config`** — the `smartClientId` field in the data source `configuration` of the served `app-config.js` (per-deployment).

## 4. Order and Complete an Exam on a Patient

### A. Create test data in the Medplum app (`http://localhost:3000`)

1. **Patient** — sidebar → **Patient** → **New…**, fill name fields, save. Note the Patient ID.
2. **ServiceRequest** (the order) — **New…**, set `status: active`, `intent: order`,
   `subject: Patient/<id>`, a `code` (e.g. "CT Chest"), save.
3. **DiagnosticReport** (optional) — **New…**, set `status: preliminary`, `subject`,
   `basedOn: ServiceRequest/<id>`, a `code`, save.
4. **ImagingStudy** (optional) — **New…**, `status: available`, link to the Patient via `subject`.

### B. Trigger the SMART launch

1. Navigate to the Patient: `http://localhost:3000/Patient/<patient-id>`.
2. Click the **Apps** tab → click **OHIF Viewer**.
3. Medplum redirects the browser to
   `http://localhost:3200/fhir-viewer?iss=http://localhost:8103/fhir/R4&launch=<launch-id>`.
4. OHIF detects both `iss` and `launch` (Case B), discovers SMART config at
   `http://localhost:8103/fhir/R4/.well-known/smart-configuration`, and redirects to
   Medplum's authorize endpoint.
5. Authenticate at Medplum (or use the existing session) and grant consent. Medplum
   redirects back with `?code=…&state=…`; OHIF exchanges the code for a token at
   `/oauth2/token` and loads the patient's studies.

## 5. Verify FHIRcast

The fastest interop check skips the OAuth dance by injecting a token manually.

### A. Quick test with a manual token

1. **Get a token** — in the Medplum app console (`http://localhost:3000`):
   ```js
   JSON.parse(localStorage.getItem('@medplum:activeLogin')).accessToken
   ```
2. **Open OHIF with the ISS** (Case C — sets the FHIR server without an OAuth redirect):
   ```
   http://localhost:3200/fhir-viewer?iss=http://localhost:8103/fhir/R4
   ```
3. **Inject the token** in the OHIF tab's console, then **reload the same tab**
   (`sessionStorage` is per-tab):
   ```js
   sessionStorage.setItem('fhir_smart_token', JSON.stringify({
     access_token: '<PASTE-TOKEN>',
     expires_in: 3600,
     _savedAt: Date.now(),
   }));
   ```

### B. Subscribe and publish

1. Open the **FhirCast** panel. The hub URL is auto-discovered (SMART token `hub.url` →
   CapabilityStatement → probe) as `http://localhost:8103/fhircast/STU3`. The equivalent alias
   `http://localhost:8103/api/hub` also works. All called directly — no proxy.
2. Enter a topic (any string), select `Patient-open` / `ImagingStudy-open`, click **Subscribe**.
   Expect HTTP 202 and the WebSocket status to go **Open** (Medplum returns
   `ws://localhost:8103/ws/fhircast/<uuid>` in `hub.channel.endpoint`, used directly).
3. Publish a `Patient-open` event from a terminal. The canonical hub is `/fhircast/STU3`; the
   `/api/hub` alias accepts the same request:
   ```bash
   TOKEN="<access-token>"
   TOPIC="<topic-from-panel>"
   curl -s -X POST "http://localhost:8103/api/hub/$TOPIC" \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
       "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
       "id": "'$(uuidgen)'",
       "event": {
         "hub.topic": "'$TOPIC'",
         "hub.event": "Patient-open",
         "context": [{"key": "patient", "resource": {"resourceType": "Patient", "id": "test-patient-123"}}]
       }
     }'
   ```
4. The event should appear in the panel's **Received Events**. Wait 10+ seconds —
   **no `syncerror`** should appear (confirms OHIF's ACK reached Medplum). Click
   **Unsubscribe** for a clean disconnect.

### Success criteria

| Check | Expected |
|---|---|
| `.well-known/fhircast-configuration` | JSON with `eventsSupported` |
| Token injection | Persists after reload (same tab) |
| Hub URL auto-discovered | `http://localhost:8103/fhircast/STU3` (alias: `/api/hub`) |
| Subscription POST | HTTP 202 Accepted |
| WebSocket | Opens successfully |
| Event delivery | Appears in OHIF panel |
| Event ACK | No SyncError after 10s |
| Unsubscribe | Clean disconnect |

## 6. Load Images over DICOMweb

Medplum's `ImagingStudy` resources carry series summaries but no
`series[].instance[]` entries, so the FHIR resource names a study without being
able to locate a single image of it: the study browser fills in and the viewport
stays black. Medplum serves the pixels over DICOMweb at `<server>/dicomweb`, so
point the `fhir` data source at it. Any study whose `ImagingStudy` has no
instance data then gets its instance metadata and image ids from DICOMweb;
studies that do inline instances are unaffected, and with no DICOMweb root set
the behaviour is unchanged.

```js
{
  namespace: '@ohif/fhir-viewer.dataSourcesModule.fhir',
  sourceName: 'fhir',
  configuration: {
    fhirServerRoot: 'http://localhost:8103/',
    fhirBaseUrl: 'http://localhost:8103/fhir/R4',
    // Sets qidoRoot, wadoRoot and wadoUriRoot at once.
    dicomWebRoot: 'http://localhost:8103/dicomweb',
    // Optional: any OHIF DicomWebConfig field, passed through to the
    // DICOMweb source. Medplum only implements WADO-RS frames, so render
    // thumbnails from loaded images rather than the /thumbnail route.
    dicomWeb: { imageRendering: 'wadors', thumbnailRendering: 'wadors', staticWado: true },
    // DicomStudy/DicomSeries/DicomInstance are outside the patient
    // compartment, so `patient/*.read` cannot reach them.
    smartScope: 'launch openid fhirUser user/*.rs fhircast/Patient-open.read fhircast/ImagingStudy-open.read',
  },
}
```

The SMART token is forwarded to the DICOMweb requests. Without a SMART launch,
FHIR reads, DICOMweb requests and hub POSTs fall back to the bearer token from
OHIF's own `oidc` login, so a deployment that signs in to Medplum through OHIF
does not need a separate launch.

### Open a study from FHIRcast context

With the panel subscribed to `ImagingStudy-open`, publish an event naming an
`ImagingStudy`. A stub with just an `id` is enough; the viewer fetches the full
resource, takes the study UID from its `urn:dicom:uid` identifier, and opens it:

```bash
curl -s -X POST "http://localhost:8103/fhircast/STU3/$TOPIC" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "id": "'$(uuidgen)'",
    "event": {
      "hub.topic": "'$TOPIC'",
      "hub.event": "ImagingStudy-open",
      "context": [{"key": "study", "resource": {"resourceType": "ImagingStudy", "id": "<imaging-study-id>"}}]
    }
  }'
```

The viewer follows context whichever side-panel tab is selected, and the
subscription survives switching tabs or backgrounding the browser tab.

---

For the full SMART EHR launch walkthrough, isolated curl hub tests, the Medplum
demo app, comparison testing, and troubleshooting, see `CLAUDE-MEDPLUM-TESTING.md`
in the workspace root.
