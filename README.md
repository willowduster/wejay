# WeJay

A shared live DJ booth for up to four DJs, with one stereo master stream (left and right channels) per DJ. Each DJ has a continuously updated, automatically detected BPM and a three-color live waveform. Your hardware or DJ software performs all mixing. WeJay captures its stereo output; it has no track player, library, cue controls, tempo controls, EQ, filters, or crossfader.

## Run Locally

### Session Limits

| Item | Limit |
| --- | --- |
| DJs per room | 4, including the owner |
| Audio per DJ | 1 stereo master stream with left and right channels |
| Streams per room | 4 stereo streams, not 8 independent inputs |
| Tempo display | Automatic BPM detection per DJ |
| Audio source | Live equipment capture only; no file playback or uploads |

Mix and cue on your equipment. Select its stereo master feed in WeJay; left and right stay together throughout capture and peer transport.

### Development Servers

Requires Node.js 20.19+ and Go 1.23+.

```powershell
npm install
npm run dev -- --port 5173
```

In a second terminal:

```powershell
cd server
go run .
```

Open **http://localhost:5173**. Vite forwards `/api` and room WebSockets to Go on port 8080. Localhost supports audio capture; other hosts require HTTPS. Environment variables are read by Go, not automatically loaded from a dotenv file. Use your shell or the container environment to set them.

Redis is optional for local development. Set `REDIS_URL=redis://localhost:6379/0` to enable cached sessions, room metadata, and distributed rate counters. A configured but unavailable Redis instance prevents startup. Account names, email addresses and bcrypt password hashes persist in `server/data/users.json` by default. Keep this directory private and backed up. No audio is written there.

## Start a Session

1. Create an email account, or sign in with Google if configured.
2. Create a room. Share its six-character code or invitation link.
3. Invited DJs enter a name and join without creating an account. Rooms also appear in the open-room list, so invitation codes are not a private access-control boundary. Lock the room to block new arrivals.
4. Choose **Connect audio** and select your OS-visible stereo master feed. Each DJ supplies one stream containing left and right audio channels. Browser permission is required.
5. Enable **Session audio** to listen to remote DJs. Local input is never monitored, preventing feedback. Keep your hardware cue/headphone routing local.
6. The owner can disable new arrivals in **Session settings**. Four DJs maximum, including the host; one stereo stream per member, four streams per room.

Room membership reconnects using a tab-local token for up to 60 seconds after disconnection. Rooms and signaling live in the Go process; a restart ends them. Redis is a cache, not a multi-instance signaling bus. Deploy a single Go instance or use sticky room routing until a cross-instance signaling service is added.

## Equipment and Routing

Serato, Hercules, Rane, Pioneer/AlphaTheta, Numark, Traktor and other setups work **when their audio reaches an input the OS exposes to the browser**. WeJay does not control hardware and needs no MIDI mappings. Brand membership alone does not guarantee compatibility.

- Select a mixer/controller's recording or USB return input when available.
- Output-only or exclusive-ASIO devices may require a hardware loopback cable, virtual audio cable, or OS audio router. Browser audio capture is not system-output capture.
- Route your equipment's mixed stereo master output into one browser-selectable input. Left and right travel together in one WebRTC audio track; separate deck feeds are not captured.
- Capture requires two channels. Inputs reported as mono are rejected; choose a stereo interface or virtual cable. Echo cancellation, noise suppression and automatic gain control are requested off. Actual channel count and sample rate are reported from the capture device where available. Driver and browser behavior can differ.
- Audio permission, capture, and WebRTC work best in current Chromium-based browsers. Test the actual interface and driver before a live set.

## BPM and Waveforms

BPM is detected from the actual captured or received stream using `realtime-bpm-analyzer` in an AudioWorklet. Expect several seconds of rhythmic audio before an estimate. The large BPM readout includes relative candidate confidence and stable/estimating status, clears on silence, and updates as analysis continues. Half/double-time ambiguity is normalized into 70–180 BPM; unusual tempos, syncopation, ambient sections and transitions can produce incorrect estimates. This is an indicator, not beat synchronization.

Waveforms are generated live, locally, from three frequency ranges: low (below 250 Hz), mid (250–2,500 Hz), and high (above 2,500 Hz). Empty channels remain flat. No waveform or BPM is invented, and no audio files can be uploaded.

## Audio Quality and Latency

Audio travels directly between peers over encrypted WebRTC/DTLS-SRTP. With four DJs, each sender connects to three peers. One stereo Opus track is negotiated at a **320 kbps per-stream target**, voice processing is disabled where supported, and discontinuous transmission is disabled. Browser behavior and available bandwidth determine the actual bitrate. Allow roughly 960 kbps upstream per DJ for Opus payloads to three peers, plus transport overhead.

**Opus is lossy, not lossless. Near-lossless listening quality is a goal, not a guarantee.** Strict lossless/PCM transport is not implemented. WebRTC uses an adaptive jitter buffer; round-trip network time shown in the UI is not measured end-to-end audio latency. Internet jitter, audio hardware and geographic distance limit live back-to-back timing. No cross-peer sample-accurate synchronization or drift compensation is provided. Do not use remote audio as your local beatmatching cue.

No application server records or stores audio. Go receives signaling and text room events, not audio payloads. A TURN server may relay encrypted packets in transit; configure it without media recording. Browser processing buffers exist only in memory. Do not add gzip around Opus packets; Opus already provides domain-specific audio compression.

## Google Sign-In

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL`. Register `${PUBLIC_URL}/api/auth/google/callback` as the Google OAuth redirect URI. The backend uses OpenID Connect signature/audience/issuer/expiry checks, verified email, a nonce, state, and PKCE. Without credentials, email login works and the Google button is explicitly disabled. Email verification, password reset, account deletion and account recovery are not implemented; add them before public account hosting.

## Deploy With Redis

Requires a running Docker engine. Configure a `.env` file from `.env.example`, setting `PUBLIC_URL` to the HTTPS origin users will visit. For local containers, use `http://localhost:8080`.

```powershell
docker compose build --no-cache
docker compose up -d
```

The container serves the built frontend and Go API together on **http://localhost:8080**. Redis is internal, transient and never stores audio. Account hashes persist in the `accounts` volume. Terminate HTTPS at a reverse proxy and forward WebSocket upgrades; the supplied host binding is localhost-only.

Set `TURN_URL` (comma-separated URLs), `TURN_USERNAME` and `TURN_CREDENTIAL` for restrictive networks. The default STUN-only setup cannot guarantee connectivity across all NATs. TURN credentials are visible to browsers, so use restricted/short-lived accounts and rotation in production. External Google fonts, the equipment image and the default STUN service create outbound requests; self-host assets and configure your own STUN/TURN service for stricter privacy.

## Checks

```powershell
npm test
npm run build
npx playwright install chromium
npm run test:browser
cd server
go test ./...
go vet ./...
```

Backend tests cover credential hashing, login/logout, persisted accounts, guest access, four-DJ capacity, owner-only locking, WebSocket authentication, single-stereo-stream limits, origin rejection, and Redis session/room/rate-limit expiry. Browser tests cover mobile/desktop layout, live 120 BPM detection, three-band canvas pixels, clearing BPM on silence, bidirectional peer audio reception, left/right stereo separation, one transceiver per peer, guest chat and owner locking. Generated beat fixtures exist only in the test harness, never in the application. The browser runner starts or reuses the local Go and Vite servers. Account tests create isolated test accounts in the local account store.

Before production use, also verify real equipment and drivers, four physical clients on separate networks, audio permissions, BPM through musical transitions, and HTTPS/TURN connectivity. The optional `go test -race ./...` check requires a CGO-enabled Go environment and a C compiler.