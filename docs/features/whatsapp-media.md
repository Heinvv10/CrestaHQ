# WhatsApp media — inbound + outbound attachments

The implementation plan for photo, voice-note, video, sticker and document support
across all three WhatsApp rails. Recovered into the repo on 2026-09-16; before that
it existed only in a session scratchpad, which is why §0 below still reads as a
pre-implementation document. It is kept verbatim: the deviations recorded in each
PR body are meaningful only against the plan they deviate from.

## Status

| Plan unit | Branch | PR | State |
|---|---|---|---|
| A0 — foundation (types, storage, serving route, rendering, `storage.rules`) | `feat/wa-media-foundation` | [#146](https://github.com/Heinvv10/CrestaHQ/pull/146) | merged, deployed 2026-09-16 |
| A1a — Cloud webhook redelivery guard | `fix/whatsapp-cloud-redelivery-guard` | [#144](https://github.com/Heinvv10/CrestaHQ/pull/144) | merged |
| A2 — LeadStack bridge webhook accepts `media` | `feat/wa-media-bridge-webhook` | [#148](https://github.com/Heinvv10/CrestaHQ/pull/148) | merged |
| A1b — Cloud inbound media | `feat/wa-media-cloud-inbound` | [#151](https://github.com/Heinvv10/CrestaHQ/pull/151) | open |
| A3 — Go bridge downloads and forwards media | `feat/wa-bridge-inbound-media` | [#145](https://github.com/Heinvv10/CrestaHQ/pull/145) | open |
| B1 — Cloud outbound media + composer file picker | `feat/wa-media-outbound` | [#149](https://github.com/Heinvv10/CrestaHQ/pull/149) | open |
| follow-up — media route answers cleanly when the bucket cannot be resolved | `fix/wa-media-serve-bucket-throw` | [#157](https://github.com/Heinvv10/CrestaHQ/pull/157) | open, not part of the original plan |
| follow-up — outbound video on both rails, H.264/AAC only (codecs read from the MP4 before upload; `video-codec.ts` + bridge `internal/videocodec`) | `feat/whatsapp-video-send` | — | open; real-handset delivery NOT yet proven |

Each PR body records where it deviated from this plan and why. §5 ("Explicitly NOT
building") is the list a future session should read before assuming a capability
exists — in particular there is **no retention policy** for stored media, which is a
named POPIA and storage-cost gap, not an oversight.

---


Implementation plan. Written against `origin/main` @ `b4e6850`. Every shape below was read
out of `git show origin/main:<path>`; nothing is assumed.

---

## 0. Findings that contradict or refine the rulings

These are reported rather than silently worked around. Each names the file it came from.

### 0.1 `whatsappMessages` outbound rows ALREADY carry an `attachment` field — ruling 3 collides with it

`src/lib/server/conversation-send/whatsapp.ts` writes, on every outbound row:

```ts
attachment: attachment ? { filename, contentType } : null,
```

Nothing reads it. `git grep attachment origin/main -- src/components src/types src/lib/conversations`
returns only the **email** thread's `attachments` array (`src/types/email.ts`, rendered at
`conversation-thread.tsx:414`). The WhatsApp `attachment` field has no reader anywhere in the app.

**Recommendation:** `media` becomes the one field, and B1 stops writing `attachment` on new rows.
Historic rows keep theirs; nothing renders them today and nothing will after. Do **not** carry both
forward — two fields describing one file is exactly the drift the CLAUDE.md lint-baseline story
warns about. This is a deviation from ruling 3 (which implied `media` is purely additive); it is
additive on the *inbound* rails and a replacement on the outbound one.

### 0.2 A 20-second inline Cloud media fetch will cause duplicate AI auto-replies (ruling 5)

Ruling 5 recommends "inline with a hard 20s budget". That is unsafe **as the route stands today**:

`src/app/api/webhooks/whatsapp-cloud/route.ts` has **no redelivery guard**. The bridge route
(`.../whatsapp/bridge/[subAccountId]/route.ts`) computes `isRedelivery` and uses it to skip the two
non-idempotent effects — `upsertConversationForMessage` and `maybeRespondWithAi`. The Cloud route
has neither. Its message row is idempotent on the wamid doc id; **the conversation bump and the AI
auto-reply are not**.

Meta retries a webhook it considers failed, and its delivery timeout is on the order of seconds, not
twenty. So a 20s inline download turns every media message into a Meta retry, and every retry into
a second real WhatsApp message sent to a real person plus a second LLM call. That is the same defect
the bridge route's long comment block documents having already been burned by.

**Recommendation, in two parts:**

1. **PR A1a adds the redelivery guard to the Cloud route**, mirroring the bridge's (`some()` over
   every matched contact, gating only the conversation upsert and the AI reply, never the opt-out
   flip). This is needed whether or not media ships — it is a live defect — but it is media that
   makes it reachable routinely, so it is a prerequisite, not scope creep.
2. **Budget the fetch at 3s per Graph call (6s worst case), not 20s.** Two calls: the metadata GET
   and the bytes GET. On expiry → write the row text-only with `mediaDropped: "fetch_failed"` and
   ack. Meta's media URL lives 5 minutes, so nothing is lost that a follow-up could not recover;
   the message itself is never lost.

If measured drops turn out to be material, the documented escalation is QStash (`publishCallback`
in `src/lib/automations/qstash.ts`, then a worker at `/api/whatsapp/media-fetch` verifying
`Upstash-Signature`). It is **not** built now: it adds a signed worker route, a pending-row state
and a second write, for a problem we have no evidence of.

### 0.3 The media-serving route cannot be keyed on `messageId` alone (ruling 2)

Messages live at `contacts/{contactId}/whatsappMessages/{messageId}`. There is no collection-group
path from a sub-account to a message. `GET /api/sa/[subAccountId]/whatsapp-media/[messageId]` as
written cannot locate the doc without a collection-group query.

Also, the repo has **no `/api/sa/*` namespace at all** — every sub-account API route is
`/api/sub-accounts/[id]/…`. `/sa/[subAccountId]/*` is the *page* namespace, not the API one.

**Recommendation:** `GET /api/comms/whatsapp/media/[contactId]/[messageId]`, authorised with
`requireUid` + `requireContactAccessible` from `src/lib/comms/route-auth.ts` — byte for byte the
same pair `/api/comms/whatsapp/send` already uses, and it already handles both the agency-owner
shortcut and active sub-account membership. Sitting it under `/api/comms/whatsapp/` puts it beside
the send route it mirrors.

### 0.4 The bridge's outbound media allow-list is narrower than ruling 6's composer

`services/wa-agent-bridge/api/server.go`:

```go
const maxMediaBytes = 8 << 20          // 8 MiB, not 16 MB
const maxSendBodyBytes = 12 << 20
const maxMediaFilenameBytes = 255
var allowedMediaMimeTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "application/pdf": true,
}
```

Ruling 6 asks the composer to accept "images/audio/video/pdf/office docs" at 16 MB. On the **bridge**
rail that is wrong in both dimensions: the bridge refuses everything but PNG/JPEG/PDF, and refuses
anything over 8 MiB. It refuses them *correctly* (`decodeMedia` returns `media_unsupported_type` /
`media_too_large`, which `bridge-client.ts` surfaces as `providerErrorCode` and
`conversation-send/whatsapp.ts` turns into a 400 the operator can read) — so nothing breaks, but an
operator on the bridge rail would be offered a file picker that accepts an MP4 and then rejects it
after the upload.

**Recommendation:** the composer's accept-list and size cap are **rail-derived**, not constant.
B1 exposes them off the already-existing `capabilitiesFor(provider)` seam in
`src/lib/comms/whatsapp/provider.ts`, which is where the repo already states per-rail facts:

```ts
export interface WhatsAppProviderCapabilities {
  supportsTemplates: boolean;
  enforcesWindow: boolean;
  supportsMedia: boolean;
  /** NEW. Decoded-byte cap for one attachment; 0 when supportsMedia is false. */
  maxMediaBytes: number;
  /** NEW. Exact MIME types this rail will put on the wire. Empty when it sends none. */
  mediaMimeTypes: readonly string[];
}
```

with `bridge: { maxMediaBytes: 8 << 20, mediaMimeTypes: ["image/png","image/jpeg","application/pdf"] }`
— the bridge's numbers restated once, in the seam that exists to state per-rail facts — and
`cloud: { maxMediaBytes: 16 << 20, mediaMimeTypes: [image/jpeg, image/png, video/mp4, audio/mpeg,
audio/ogg, application/pdf, .docx, .xlsx] }` per Meta's own documented list.

Yes, this duplicates the bridge's Go constants into TypeScript. The alternative — a
`GET /v1/limits` on the bridge — is a new endpoint, a new fetch on every composer render, and a new
failure mode, for a number that has changed once. The duplication is acknowledged in a comment
pointing at `server.go`, and **B1's seam test asserts the two agree** by parsing the Go constants
(see B1 verify), so a drift fails CI rather than an operator's upload.

### 0.5 Inbound bridge media has no proxy in front of it — the 16 MB cap is safe

`services/wa-agent-bridge/README.md` documents consumer webhook URLs as
`http://127.0.0.1:4300/api/webhooks/whatsapp/bridge/sa-123` — loopback straight to the Next
standalone server. No nginx, no Cloudflare. (`crm.crestahq.com` is fronted by `cloudflared`, which
is active on this box; there is no nginx vhost for it. Cloudflare's own body limit is 100 MB, so the
composer path in B1 is fine too.)

App Router route handlers read the body as a stream via `request.text()`; there is **no** 4 MB
`bodyParser` cap (that is Pages Router) and no 1 MB cap (that is Server Actions). A ~21 MB base64
POST on the loopback bridge webhook is fine. Confirmed, not assumed.

### 0.6 `WHATSAPP_GRAPH_VERSION` already exists but is undocumented

`src/lib/comms/whatsapp/cloud-client.ts` has a private `graphVersion()` reading
`process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"`. It is **not** in `.env.example` (which lists only
`WHATSAPP_APP_SECRET` at line 226). A1b needs the same version for the media fetch.

**Recommendation:** A1b extracts `graphVersion()` into `src/lib/comms/whatsapp/graph-version.ts`,
`cloud-client.ts` imports it (its local copy deleted), and `.env.example` gains the documented
optional var. One definition, two callers.

### 0.7 Ruling 9 — Firestore rules: confirmed, no change needed

`firestore.rules` line 974: `match /whatsappMessages/{messageId}` allows member-scoped `read`,
`update` restricted to `hasOnly(['readAt'])`, and `create, delete: if false`. A nested `media` map
written by the Admin SDK bypasses rules entirely and is covered by the existing member-scoped read.
**No rules change.**

`storage.rules` **does** need one: the current file is community-only plus
`match /{allPaths=**} { allow read, write: if false; }`. The default deny already covers
`whatsapp-media/**` correctly (admin SDK bypasses rules; no client may read). A0 adds an **explicit**
`match /whatsapp-media/{allPaths=**} { allow read, write: if false; }` above the catch-all — not
because behaviour changes, but so that the one path holding customers' photos states its own rule
instead of inheriting one, and a future edit to the catch-all cannot silently open it.

### 0.8 There are TWO WhatsApp thread renderers, not one

Ruling 7 names `conversation-thread.tsx`. There is also
`src/components/contacts/contact-whatsapp-thread.tsx`, a second live renderer on the contact-profile
page subscribing to the same `contacts/{id}/whatsappMessages` collection. Rendering media in one and
not the other means the same message looks different in two places in the app.

**Recommendation:** A0 extracts one `<WhatsappMediaAttachment>` component and both renderers use it.

---

## 1. Module shape

### 1.1 The doc field (all rails, both directions)

New file `src/types/whatsapp-media.ts`:

```ts
export type WhatsappMediaKind =
  | "image" | "audio" | "video" | "document" | "sticker";

/** Present on a whatsappMessages row that carried a file. Absent on text rows —
 *  do not treat missing as an empty object. */
export interface WhatsappMedia {
  kind: WhatsappMediaKind;
  mimeType: string;
  /** As the sender named it, or a synthesised one. NEVER trusted in a header. */
  filename: string;
  sizeBytes: number;
  /** Object path inside the bucket. Not a URL — see the serving route. */
  storagePath: string;
  sha256?: string;
}

/** Why a message that HAD a file arrived without one. Mutually exclusive with `media`. */
export type WhatsappMediaDropped = "too_large" | "fetch_failed" | "unsupported_type";

/** Conversation-preview label for a caption-less media message. */
export function mediaPreviewLabel(m: WhatsappMedia): string;
//  image → "📷 Photo" · audio → "🎤 Voice note" · video → "🎬 Video"
//  sticker → "🌟 Sticker" · document → `📄 ${m.filename}`
```

`MessageDoc` in `src/types/messages.ts` gains:

```ts
  /** WhatsApp only: the file this message carried. Absent on text rows. */
  media?: WhatsappMedia | null;
  /** WhatsApp only: set instead of `media` when the file could not be stored. */
  mediaDropped?: WhatsappMediaDropped | null;
```

### 1.2 Storage writer + reader

New file `src/lib/comms/whatsapp/media-storage.ts` (server-only):

```ts
/**
 * Object path. NO filename segment — the filename lives on the doc, so a
 * hostile or non-ASCII name never reaches a bucket path or a Content-Disposition
 * header derived from one. One message = one object.
 */
export function whatsappMediaPath(a: {
  agencyId: string; subAccountId: string; contactId: string; messageDocId: string;
}): string; //  whatsapp-media/{agencyId}/{subAccountId}/{contactId}/{messageDocId}

/**
 * Write the bytes. NO firebaseStorageDownloadTokens — unlike the community
 * avatar route, these are customers' photos and voice notes (POPIA), and a
 * download token is a permanent unauthenticated public URL.
 * Returns null (logged) when the bucket env var is unset, so a deployment
 * without Storage degrades to text-only rather than losing the message.
 */
export async function putWhatsappMedia(opts: {
  path: string; bytes: Buffer; contentType: string;
}): Promise<{ ok: true } | { ok: false; reason: string }>;

/** Stream one object back. Throws only on a genuine bucket error. */
export async function openWhatsappMedia(path: string): Promise<{
  stream: NodeJS.ReadableStream; sizeBytes: number; contentType: string;
} | null>;
```

Bucket name from `process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` via
`getStorage().bucket(name)` — the same pair the avatar route uses
(`src/app/api/community/[saId]/avatar/route.ts`).

### 1.3 Serving route

`src/app/api/comms/whatsapp/media/[contactId]/[messageId]/route.ts`

```ts
export async function GET(request, ctx: { params: Promise<{contactId, messageId}> })
```

1. `requireUid(request)` → 401.
2. `requireContactAccessible(auth.uid, contactId)` → 403/404. (Both from
   `src/lib/comms/route-auth.ts`; identical to the send route.)
3. Read `contacts/{contactId}/whatsappMessages/{messageId}`; no `media` → 404.
4. **Re-derive** the storage path from the doc's `agencyId`/`subAccountId`/`contactId`/`messageId`
   and assert it equals `media.storagePath`. A stored path is data; a mismatch means the row was
   written by something that does not agree with `whatsappMediaPath` and is refused, not served.
5. `Content-Type: media.mimeType` (from the doc's own validated set, never echoed from a request).
6. `Content-Disposition`: `inline` for image/audio/video/sticker, `attachment` for document.
   Filename is **sanitised** — `filename*=UTF-8''<encodeURIComponent(basename)>` with all control
   chars, quotes, `\`, `/` and CR/LF stripped first, plus an ASCII `filename="file"` fallback.
   A raw filename in a header is a response-splitting vector and the ruling-10 requirement.
7. `Cache-Control: private, max-age=3600` — private because the object is tenant data.
8. `X-Content-Type-Options: nosniff`.

### 1.4 Cloud inbound parse

`src/lib/comms/whatsapp/cloud-payload.ts` — `CloudInbound` gains:

```ts
  /** The media descriptor Meta sent, before it has been fetched. Null for text. */
  media: CloudMediaRef | null;

export interface CloudMediaRef {
  kind: WhatsappMediaKind;
  /** Meta's media id — the handle for GET /{version}/{id}. */
  id: string;
  mimeType: string;
  filename: string;   // document.filename, else synthesised from kind+ext
  sha256: string;     // Meta's `sha256`, carried through to the doc
}
```

Parsed from `message[kind]` where `kind ∈ {image, audio, video, document, sticker}` —
each nests `{ id, mime_type, sha256, filename?, caption? }`. The existing caption branch
(`asObject(message[kind])?.caption`) stays exactly as it is; this adds a sibling read.
Still pure, still total, still never throws — that file's whole contract.

### 1.5 Cloud media fetch

New `src/lib/comms/whatsapp/cloud-media.ts` (server-only):

```ts
/**
 * Two Graph calls, each with its own 3s budget — see §0.2 for why not 20s.
 *   1. GET /{version}/{mediaId}          → { url, mime_type, file_size, sha256 }
 *   2. GET <that url> WITH the same bearer  → the bytes
 * Meta requires the token on the second call too; without it the CDN 401s.
 * Never throws. Returns a reason instead, which the caller writes as mediaDropped.
 */
export async function fetchCloudMedia(opts: {
  creds: WhatsappCloudSecret;   // from getWabaCreds — the ONE credential chokepoint
  ref: CloudMediaRef;
  maxBytes?: number;            // default 16 << 20
  fetchImpl?: typeof fetch;     // tests inject; production uses global fetch
}): Promise<
  | { ok: true; bytes: Buffer; mimeType: string; sizeBytes: number }
  | { ok: false; reason: WhatsappMediaDropped }
>;
```

`file_size` from call 1 is checked **before** call 2 runs, so an oversized file is never pulled into
memory. Meta's response is also capped mid-read in case `file_size` lies.

### 1.6 Cloud outbound media (B1)

`src/lib/comms/whatsapp/cloud-client.ts` gains:

```ts
/** POST /{phoneNumberId}/media (multipart: messaging_product, file) → { id }. */
export async function uploadCloudMedia(opts: {
  creds: WhatsappCloudSecret; filename: string; contentType: string; bytes: Buffer;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; mediaId: string } | { ok: false; error: string; providerErrorCode: string }>;
```

and `buildCloudMessageBody` gains a `media: { id, kind } | null` parameter. In **text** mode with
media it emits `{ type: kind, [kind]: { id, caption: message, ...(kind==="document" && {filename}) } }`.
In **template** mode media is refused upstream (see §0.9 / not-building).

`sendWhatsappCloud` calls `uploadCloudMedia` first, then sends. An upload failure returns
`ok:false` with `providerOutcome: "DEFINITELY_REJECTED"` — the upload strictly precedes the send, so
nothing reached the customer. This is the identical invariant `wa/media.go`'s `ErrMediaUpload`
comment documents on the bridge; it is restated here because it is what makes a retry safe.

`provider.ts`: `cloud.supportsMedia` flips `false → true` **in B1 and not before**, plus the two new
capability fields from §0.4.

`send-dispatch.ts`: the `input.attachment && !capabilities.supportsMedia` guard is unchanged and
keeps working — flipping the capability is what makes cloud reachable. The cloud branch gains
`media: input.attachment ?? null` passed through to `sendWhatsappCloud`. **Twilio stays
`supportsMedia: false`** and keeps refusing.

### 1.7 Go bridge (A3)

`wa/whatsmeow.go`:

- `onInbound` signature becomes
  `func(jid, text, msgID string, at time.Time, media *InboundMedia)`.
  `InboundMedia{ Filename, MimeType string; Data []byte; Dropped string }`.
- `handleMessage` no longer returns early on empty text **when a downloadable message is present**.
  It matches `v.Message.GetImageMessage() / GetAudioMessage() / GetVideoMessage() /
  GetDocumentMessage() / GetStickerMessage()` and takes each one's `GetCaption()` as the text
  (documents/images/videos have captions; audio and stickers do not).
- **`GetFileLength()` is checked before downloading.** Over `maxInboundMediaBytes` (16 MiB) →
  forward text-only with `Dropped: "too_large"`. This is the ruling-4 cap and it is enforced from
  the protobuf, not after pulling 60 MB into the process.
- Download via a narrow interface, mirroring the existing `mediaUploader` pattern in `wa/media.go`
  for exactly the same reason (`*whatsmeow.Client` cannot be made to fail on demand):

  ```go
  type mediaDownloader interface {
      Download(ctx context.Context, msg whatsmeow.DownloadableMessage) ([]byte, error)
  }
  ```

  Confirmed against the pinned module: `whatsmeow@v0.0.0-20260904121843-28bfe537ea6a`,
  `download.go:214` — `func (cli *Client) Download(ctx context.Context, msg DownloadableMessage) ([]byte, error)`.
  A failed download → `Dropped: "fetch_failed"`, text still forwarded.
- Filename: `DocumentMessage.GetFileName()`, else synthesised `voice-note.ogg` / `photo.jpg` / etc.
  from the mime type.

`api/webhook.go` — `Fanout.Deliver` gains the same parameter and marshals:

```go
"media": map[string]any{"filename": …, "mimeType": …, "dataBase64": base64.StdEncoding.EncodeToString(m.Data)},
// or, when dropped:
"mediaDropped": "too_large",
```

The HMAC in `signPayload` is computed over the marshalled `payload` bytes — **unchanged**, it
already covers whatever is in the body. Ruling 4 confirmed.

`main.go` — the wiring of `wa.NewClient(...)` → `fanout.Deliver` is updated for the new signature.

### 1.8 Rendering (A0)

New `src/components/conversations/whatsapp-media-attachment.tsx`:

```tsx
export function WhatsappMediaAttachment({
  contactId, messageId, media, dropped,
}: { contactId: string; messageId: string;
     media?: WhatsappMedia | null; dropped?: WhatsappMediaDropped | null });
```

- `image` / `sticker` → `<img src={src} loading="lazy" className="max-h-64 rounded-lg" />`
  wrapped in a button that opens the same URL in a new tab.
- `audio` → `<audio controls preload="none" src={src} />`
- `video` → `<video controls preload="metadata" className="max-h-64 rounded-lg" src={src} />`
- `document` / anything else → a link showing the filename and a humanised size.
- `dropped` and no `media` → one muted line: "Photo not saved (too large)" etc. An operator seeing
  nothing at all would read the thread as if the customer sent a bare caption.

`src` = `/api/comms/whatsapp/media/{contactId}/{messageId}`.

Used by **both** `conversation-thread.tsx` (inside `ChannelBubble`, above the `<p>{message.body}</p>`
at line ~400, only when `message.channel === "whatsapp"`) and
`contact-whatsapp-thread.tsx` (§0.8).

---

## 2. PR DAG

```
        A0  (foundation: types, storage, serving route, rendering, storage.rules)
        │
   ┌────┼─────────────┬──────────────────┐
   │    │             │                  │
  A1a  A1b           A2                 B1
(cloud (cloud      (bridge           (cloud outbound
 redeliv media       webhook           + composer picker
 guard)  in)         accepts media)    + supportsMedia flip)
   │      │             │
   └──────┘             │
                        ▼  (deploy order only, not a code dependency)
                       A3  (Go bridge downloads + forwards)
```

**Parallel in separate worktrees, no file overlap:**

- **A1a + A1b** touch `src/app/api/webhooks/whatsapp-cloud/`, `cloud-payload.ts`, `cloud-media.ts`.
  A1b depends on A1a (same route file) — **sequential, same worktree**, A1a first.
- **A2** touches only `src/app/api/webhooks/whatsapp/bridge/[subAccountId]/`. **Parallel with A1a/A1b.**
- **A3** touches only `services/wa-agent-bridge/**` (Go). **Parallel with everything.**
- **B1** touches `cloud-client.ts`, `provider.ts`, `send-dispatch.ts`, `conversation-send/whatsapp.ts`,
  `api/comms/whatsapp/send/route.ts`, `conversation-composer.tsx`. **Parallel with A1/A2/A3** once
  A0 is merged — zero file overlap with any of them.

One writing agent per worktree (`feedback_one_agent_per_worktree`). A1a/A1b share one worktree and
therefore one agent, run back to back.

| PR | Branch | Est. diff |
|---|---|---|
| A0 | `feat/wa-media-foundation` | ~420 |
| A1a | `fix/whatsapp-cloud-redelivery-guard` | ~120 |
| A1b | `feat/wa-media-cloud-inbound` | ~380 |
| A2 | `feat/wa-media-bridge-webhook` | ~200 |
| A3 | `feat/wa-bridge-inbound-media` | ~350 (Go) |
| B1 | `feat/wa-media-outbound` | ~480 |

---

## 3. Per-PR detail

Every PR: branch off `origin/main`, stage explicit paths (never `git add -A` — CLAUDE.md, the
2026-09-04 incident), `git log --oneline origin/main..HEAD` before opening, blind `/review`,
`pnpm ci:check` green. `gh pr merge <N> --merge --delete-branch`.

---

### PR A0 — foundation

**Adds**
- `src/types/whatsapp-media.ts` (§1.1)
- `src/lib/comms/whatsapp/media-storage.ts` (§1.2)
- `src/app/api/comms/whatsapp/media/[contactId]/[messageId]/route.ts` (§1.3)
- `src/app/api/comms/whatsapp/media/[contactId]/[messageId]/route.test.ts`
- `src/components/conversations/whatsapp-media-attachment.tsx`

**Modifies**
- `src/types/messages.ts` — `media` / `mediaDropped` on `MessageDoc`
- `storage.rules` — explicit `whatsapp-media/**` deny (§0.7)
- `src/components/conversations/conversation-thread.tsx` — render inside `ChannelBubble`
- `src/components/contacts/contact-whatsapp-thread.tsx` — same component

**Seam test, written first** (`route.test.ts`) — hits the **route handler**, not a helper:

1. No `x-user-uid` → **401**.
2. `x-user-uid` of a user with no membership in the contact's sub-account → **403**.
3. Authorised, row has no `media` → **404**.
4. Authorised, row has `media` → **200**, body is the mocked bucket bytes, `Content-Type` equals
   `media.mimeType`, `Content-Disposition` is `inline` for an image.
5. `media.kind === "document"` with `filename: 'a"b\r\nX-Evil: 1.pdf'` → `Content-Disposition`
   starts `attachment`, contains **no** CR/LF and no bare `"`.
6. A row whose stored `storagePath` does **not** match `whatsappMediaPath(...)` → **404**,
   and `openWhatsappMedia` was never called.

Mocks: `firebase-admin/storage`'s `getStorage` and `@/lib/firebase/admin`'s `getAdminDb` /
`getAdminAuth`, the pattern the existing webhook route tests already use.

**Mutations that must turn it red** (run each, confirm failure, revert):
- Delete the `requireContactAccessible` call → test 2 passes 200. **Must fail.**
- Replace the path re-derivation with `media.storagePath` verbatim → test 6 serves 200. **Must fail.**
- Drop the filename sanitiser → test 5 emits the CR/LF. **Must fail.**

**verify:**
```bash
git worktree add ../CrestaHQ-wt-wamedia-a0 -b feat/wa-media-foundation origin/main
cd ../CrestaHQ-wt-wamedia-a0 && pnpm install          # real install, never symlink node_modules
pnpm vitest run src/app/api/comms/whatsapp/media
pnpm ci:check
```

**Live proof:** no live rail yet. Seed one row by hand against the **dev** project (never
production — `.env.local` carries production keys, see `feedback_local_boot_hits_production`), open
`/sa/{id}/dashboard/conversations` for that contact, screenshot the rendered image bubble, and
screenshot a logged-out `curl` of the media URL returning 401. **Redact any real phone number
before the screenshot is attached** (`feedback_pii_in_evidence_screenshots` — this repo is a
white-label template).

**Risk:** none to any live path — nothing writes `media` yet, and the new route 404s on every
existing row.
**Rollback:** revert the PR. No data written, no schema to unwind.

---

### PR A1a — Cloud webhook redelivery guard (prerequisite, §0.2)

**Modifies** `src/app/api/webhooks/whatsapp-cloud/route.ts` only.

Port the bridge route's guard: after `contactDocs` is resolved, `get()` the wamid doc on every
matched contact, `isRedelivery = seen.some(s => s.exists)`. Gate **only**
`upsertConversationForMessage`, `writeInboundMessageActivity` and `maybeRespondWithAi`. The message
row write and the STOP/START opt-out flip run on **every** delivery — the opt-out is a POPIA
obligation and must never be swallowed as a duplicate (the bridge route's comment block states
exactly this and it applies identically here).

**Seam test** — `route.test.ts`, through `POST`:
1. Post a valid signed inbound twice with the same wamid. Assert `maybeRespondWithAi` was called
   **once** and `upsertConversationForMessage` **once**, while the row `.set` ran **twice**.
2. Post a `STOP` twice. Assert the opt-out batch committed **both** times.

**Mutation:** move the opt-out flip inside the `!isRedelivery` branch → test 2 goes red. Move the
AI call outside it → test 1 goes red. Both must fail.

**verify:** `pnpm vitest run src/app/api/webhooks/whatsapp-cloud && pnpm ci:check`

**Live proof:** Velocity is on Cloud. Send one WhatsApp to the Velocity Cloud number; confirm one
thread bump and one AI reply in `/sa/{velocity}/dashboard/conversations`. The duplicate half is
covered by the test — do not attempt to force a Meta retry against a real customer number.

**Risk:** a bug here suppresses a *legitimate* second message that reuses a wamid. Meta does not
reuse wamids, and the bridge route has run this exact logic in production since 2026-09-05.
**Rollback:** revert; behaviour returns to today's (duplicates possible, nothing lost).

---

### PR A1b — Cloud inbound media

**Adds**
- `src/lib/comms/whatsapp/graph-version.ts` (§0.6)
- `src/lib/comms/whatsapp/cloud-media.ts` (§1.5)
- `src/app/api/webhooks/whatsapp-cloud/route.media.test.ts`

**Modifies**
- `cloud-payload.ts` — `CloudMediaRef`, `CloudInbound.media` (§1.4)
- `cloud-client.ts` — delete the local `graphVersion()`, import the shared one
- `src/app/api/webhooks/whatsapp-cloud/route.ts` — fetch → store → write `media` / `mediaDropped`;
  conversation preview uses `inbound.text || mediaPreviewLabel(media)`
- `.env.example` — document `WHATSAPP_GRAPH_VERSION`
- `docs/features/whatsapp-settings.md` — one paragraph

Order in the route: resolve contacts → **fetch + store media** → write the row carrying `media` →
conversation upsert. Storing before the row write means a row never references an object that is
not there. A store failure degrades to `mediaDropped: "fetch_failed"` and the row still goes.

**Seam test** — through `POST`, with `fetch` and the bucket mocked:
1. Signed image payload with a caption → row written with
   `body === caption`, `media.kind === "image"`, `media.storagePath ===
   whatsappMediaPath(...)`, and `putWhatsappMedia` called with the mocked bytes.
2. Caption-less voice note → `body === ""`, `media.kind === "audio"`, and
   `upsertConversationForMessage` received `body: "🎤 Voice note"`.
3. Graph metadata call returns 401 → row written, `body` intact, `mediaDropped === "fetch_failed"`,
   `media` absent, **200 ack**.
4. Graph reports `file_size` of 20 MB → `mediaDropped === "too_large"` and the **bytes fetch never
   ran** (assert `fetchImpl` call count is 1).
5. Plain text payload → no `media` key on the row at all, and `fetchImpl` never called.

**Mutations:**
- Make `parseCloudInbound` drop the media branch → tests 1, 2, 4 red.
- Make the route write the row before storing, ignoring the store result → test 3 writes a `media`
  pointing at nothing; add the assertion that makes this red.
- Remove the `file_size` pre-check → test 4 red.

**verify:**
```bash
pnpm vitest run src/lib/comms/whatsapp/cloud-media src/lib/comms/whatsapp/cloud-payload \
  src/app/api/webhooks/whatsapp-cloud
pnpm ci:check
```

**Live proof (after deploy, after 17:00 SAST, with Hein's explicit approval for that deploy):**
from a phone, to the **Velocity** Cloud number: (a) a photo with a caption, (b) a voice note,
(c) a PDF. In `/sa/{velocity}/dashboard/conversations`: the photo renders inline with its caption
below, the voice note shows an `<audio>` player that plays, the PDF shows as a named link that
downloads. Inbox list preview for the voice note reads "🎤 Voice note". Screenshots redacted.

**Risks**
- Added webhook latency (≤6s worst case). Mitigated by A1a's guard, which makes a Meta retry
  harmless. **Watch `journalctl -u crestahq` for `[whatsapp-cloud]` warn lines for 24h after deploy.**
- Storage cost/growth is now unbounded. Accepted for now; retention is explicitly not built (§5).
- If `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` were unset in prod, every media message degrades to
  `mediaDropped`. It **is** set (confirmed in the problem statement); the code still degrades
  rather than throwing.

**Rollback:** revert + redeploy. Existing `media` rows keep rendering (A0 is independent); new
inbound goes back to caption-only.

---

### PR A2 — LeadStack bridge webhook accepts `media`

**Modifies** `src/app/api/webhooks/whatsapp/bridge/[subAccountId]/route.ts` only.
**Adds** `route.media.test.ts` beside it.

`BridgeInbound` gains `media?: { filename?: string; mimeType?: string; dataBase64?: string }` and
`mediaDropped?: string`. After the existing JID guards and before the row write:

- Validate **shape** (all three present and non-empty) — a half-filled media object is a bridge bug
  and must not produce an unnamed object. Invalid → treat as `mediaDropped: "fetch_failed"`.
- Validate the mime against the same allow-list the serving route will echo; reject unknown →
  `mediaDropped: "unsupported_type"`.
- `Buffer.from(dataBase64, "base64")`; over 16 MiB decoded → `mediaDropped: "too_large"`.
- `putWhatsappMedia` → `media` on the row; failure → `mediaDropped: "fetch_failed"`.
- `mediaDropped` arriving from the bridge is passed straight through.
- Preview: `body || mediaPreviewLabel(media)`.

The existing `isRedelivery` guard, the opt-out branch, the `at`-clamp and the LID/group/JID
allow-list are **untouched**.

**Seam test** — through `POST` with a correctly signed body and valid bearer:
1. Signed payload with `media` → row carries `media`, bytes went to the mocked bucket at
   `whatsappMediaPath(...)`.
2. Payload with `mediaDropped: "too_large"` and no `media` → row carries `mediaDropped`, no `media`,
   bucket never touched, **200**.
3. Payload with `media.dataBase64` decoding to 20 MB → `mediaDropped: "too_large"`, bucket never
   touched.
4. **Back-compat:** today's text-only payload → byte-identical row to what `origin/main` writes.
   (Snapshot the `.set` argument.)
5. A payload carrying `media` but an **invalid HMAC** → **403**, nothing written. (The signature
   covers the whole body including media; this proves it.)

**Mutations:** drop the 16 MiB check → test 3 red. Drop the shape validation and pass a
half-filled object through → add the assertion that makes it red. Skip `putWhatsappMedia` and write
`media` anyway → test 1 red.

**verify:** `pnpm vitest run src/app/api/webhooks/whatsapp/bridge && pnpm ci:check`

**Live proof:** none until A3 ships — **that is the point of merging and deploying A2 first.**
Prove instead that today's bridge is unaffected: after deploy, reply from a real phone to the
Blitz/Velocity bridge number with **text**, and confirm the thread row appears unchanged.

**Risk:** a regression in the shared row-write path affects a live rail carrying real customer
messages. Test 4 exists precisely to make that impossible to ship silently.
**Rollback:** revert + redeploy. The bridge (still pre-A3) sends no `media`, so nothing regresses.

---

### PR A3 — Go bridge downloads and forwards media

**Modifies**
- `services/wa-agent-bridge/wa/whatsmeow.go` — `onInbound` signature, `handleMessage`
- `services/wa-agent-bridge/wa/transport.go` — doc comment only
- `services/wa-agent-bridge/api/webhook.go` — `Deliver` signature + payload
- `services/wa-agent-bridge/main.go` — wiring
- `services/wa-agent-bridge/api/server.go` — `maxInboundMediaBytes = 16 << 20`
- `services/wa-agent-bridge/README.md` — the inbound payload contract
- existing `webhook_test.go`, `whatsmeow_test.go` — signature updates

**Adds** `services/wa-agent-bridge/wa/inbound_media_test.go`

**Seam test** (`go test ./...`), through `Fanout.Deliver` and `handleMessage`:
1. `handleMessage` on an `ImageMessage` with a caption and a stub `mediaDownloader` → `onInbound`
   receives the caption as text **and** non-nil media with the stub's bytes.
2. `handleMessage` on a caption-less `AudioMessage` → `onInbound` fires with empty text and
   `media.MimeType == "audio/ogg; codecs=opus"`. (Today it returns early — this is the regression
   the "non-text events are out of scope" line encodes.)
3. `FileLength` of 20 MiB → `onInbound` fires with `Dropped: "too_large"` and the stub downloader's
   call count is **0**.
4. Downloader returns an error → `Dropped: "fetch_failed"`, text still forwarded.
5. `Fanout.Deliver` with media → the POSTed body parses to
   `{from, text, messageId, at, media:{filename,mimeType,dataBase64}}` and the
   `LeadStack-Signature` header verifies against **that exact body**.
6. `Fanout.Deliver` with nil media → the body has **no** `media` key (today's byte-for-byte payload).
7. The replay-window, watermark, owner-filter and catch-up-cap paths are unchanged for media
   messages — extend the existing `webhook_test.go` cases with one media variant each.

**Mutations:** remove the `FileLength` pre-check → test 3 red. Re-add the
`if text == "" { return }` early return → test 2 red. Marshal `media` unconditionally → test 6 red.

**verify:**
```bash
cd services/wa-agent-bridge && go vet ./... && go test ./...
cd /home/hein/Workspace/CrestaHQ && pnpm ci:check      # TS gate must stay green
```

**Deploy order (ruling 11 — confirmed):** the LeadStack bridge route parses with `JSON.parse` into a
plain TS interface (`BridgeInbound`) with **no runtime validation**. Unknown fields are ignored at
runtime. So a bridge sending `media` to a pre-A2 LeadStack silently loses the file but keeps the
message — a degradation, not a break. **Deploy A2 first anyway**, so no media is ever lost:

1. Merge + deploy A2 (`bash scripts/deploy-velo.sh`, after hours, with explicit approval).
2. Verify text inbound still lands.
3. Merge A3, then `bash scripts/deploy-wa.sh` as `hein` — artifact-hash versioning, rolling bridge
   restarts (`project_wa_manager_deploy_script`). Go builds need `-trimpath -buildvcs=false`, which
   that script already passes.

**Live proof:** from a phone, to the **Blitz** bridge number (bridge is replies-only; send into an
open session): a photo with a caption, then a voice note. Both render in
`/sa/{blitz}/dashboard/conversations`. `journalctl -u wa-agent-bridge` shows no `media` warn lines.

**Risks**
- Memory: 16 MiB decoded + 21 MiB base64 live simultaneously per inbound. The bridge already
  accepts 12 MiB send bodies (`maxSendBodyBytes`) with the same doubling, and its `server.go`
  comment already states this exposure honestly. Inbound adds a second such peak; say so in the
  README rather than pretend otherwise. No concurrency cap exists — same acknowledged posture.
- A `handleMessage` change touches the one function every live inbound goes through. Test 7 exists
  so the replay/watermark guards are proven still to hold.

**Rollback:** `deploy-wa.sh` keeps prior binaries (it backs up binaries, **not** the db —
`project_wa_manager_deploy_script`). Roll back to the previous artifact hash; inbound returns to
text-only immediately.

---

### PR B1 — Cloud outbound media + composer file picker

**Modifies**
- `src/lib/comms/whatsapp/provider.ts` — `maxMediaBytes` + `mediaMimeTypes` on the capability
  interface, all three rails populated, `cloud.supportsMedia: true`
- `src/lib/comms/whatsapp/cloud-client.ts` — `uploadCloudMedia`, `buildCloudMessageBody` media arm
- `src/lib/comms/whatsapp/send-dispatch.ts` — pass `attachment` into the cloud branch
- `src/lib/server/conversation-send/whatsapp.ts` — store the outbound copy, write `media`, **stop
  writing `attachment`** (§0.1)
- `src/app/api/comms/whatsapp/send/route.ts` — no shape change; the per-rail caps are enforced by
  the rails, as the existing comment insists
- `src/components/conversations/conversation-composer.tsx` — file picker
- `src/components/contacts/contact-whatsapp-thread.tsx` — same picker (§0.8)

Composer: a paperclip button next to `ComposerInserts`, `<input type="file">` with `accept` built
from `capabilitiesFor(provider).mediaMimeTypes` and a client-side size check against
`maxMediaBytes`. Reads the file to base64, posts it as the existing
`attachment: {filename, contentType, dataBase64}` the send route already accepts. Shown **only**
when `capabilitiesFor(provider).supportsMedia` — so Twilio operators never see it. Disabled while
the window is closed, exactly as the textarea already is.

The outbound row's Storage copy is written **after** a successful send — a file the customer never
received must not appear in the thread as if it did.

**Seam tests** — through the route and the dispatcher:
1. `POST /api/comms/whatsapp/send` with an attachment on a **cloud** sub-account → `uploadCloudMedia`
   called, then the messages POST body is `{type:"image", image:{id, caption}}`, and the row carries
   `media` with a `storagePath` the bucket actually received.
2. Same on a **twilio** sub-account → **400**, `uploadCloudMedia` never called, nothing stored.
   (`supportsMedia: false` still holds for Twilio.)
3. `uploadCloudMedia` returns 400 → the route answers **400** with `providerErrorCode`, and the
   Storage copy was **not** written and no row exists.
4. Bridge rail with an attachment → unchanged from today (`sendWhatsappBridge` receives `media`),
   plus the row now carries `media` instead of `attachment`.
5. **Capability/Go-constant agreement:** a test that reads
   `services/wa-agent-bridge/api/server.go`, extracts `maxMediaBytes` and the
   `allowedMediaMimeTypes` keys, and asserts they equal `capabilitiesFor("bridge")`'s two fields.
   This is the guard for §0.4's deliberate duplication.

**Mutations:** flip `cloud.supportsMedia` back to `false` → test 1 red. Flip `twilio.supportsMedia`
to `true` → test 2 red. Change `maxMediaBytes` in `server.go` to `4 << 20` → test 5 red. Write the
Storage copy before the send → test 3 red.

**verify:**
```bash
pnpm vitest run src/lib/comms/whatsapp src/app/api/comms/whatsapp && pnpm ci:check
```

**Live proof:** on the **Velocity** (Cloud) sub-account, inside an open window, attach a small JPG
with a caption from `/sa/{velocity}/dashboard/conversations` → it arrives on the real handset and
the sent bubble shows the image. Then a PDF → arrives as a named document. Then attempt a 20 MB
file → the composer refuses it before upload. Screenshots redacted.

**This PR is outside the Level-3 auto-merge boundary.** It widens what reaches a real person's
phone. Green CI + an APPROVED blind review is enough to merge per
`feedback_whatsapp_send_changes_pre_approved`, but flag the widening explicitly in the PR body, and
the **deploy** still needs Hein's explicit approval for that deploy, after 17:00 SAST.

**Risks**
- An operator sends the wrong file to a customer. Irreversible. Mitigated only by the picker being
  an explicit second action and the filename showing in the composer before Send.
- Meta's media upload is a second billable/rate-limited Graph call per send.
**Rollback:** flip `cloud.supportsMedia` back to `false` — one line, and `send-dispatch.ts`'s
existing guard makes the whole path unreachable again without touching anything else. That the
rollback is one boolean is the reason the capability seam is worth using here.

---

## 4. Environment & config

| Var | Status | Action |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | already set in prod | none |
| `WHATSAPP_GRAPH_VERSION` | **exists in code, absent from `.env.example`** | A1b documents it (default `v23.0`) |
| bridge `maxInboundMediaBytes` | new Go constant, not an env var | A3 |

No new secrets. No new external service. Buyer-copy deploys (Vercel) are unaffected — Firebase
Storage is already part of the documented setup.

`firebase deploy --only storage` is required after A0 (the `storage.rules` change). Note the
repo rule is `firestore:rules,firestore:indexes` for Firestore; **Storage rules are a separate
`--only storage` target** and are easy to forget. Check open PRs before deploying rules
(`feedback_rules_deploy_check_then_deploy`) — chain nothing.

---

## 5. Explicitly NOT building

Named so a reviewer does not ask for them and a future session does not assume they exist:

- **Thumbnails / previews.** Full-size image served, browser scales it.
- **Transcoding** of any kind — no voice-note→MP3, no image recompression.
- **A retention policy.** Media lives exactly as long as the message row (ruling 2). There is no
  TTL, no lifecycle rule, no delete-on-contact-delete. **This is a POPIA gap and a storage-cost
  gap**; it is a named follow-up, not an oversight.
- **Media in templates, broadcasts, workflows, or scheduled sends.** Only the two inbound rails and
  the manual composer.
- **Twilio rail media**, inbound or outbound. `twilio.supportsMedia` stays `false`.
- **Multiple attachments per message.** One file, one message.
- **Voice-note transcription.**
- **A QStash-deferred Cloud media fetch** — see §0.2; inline with A1a's guard is the chosen design,
  QStash is the documented escalation.
- **A `/v1/limits` endpoint on the bridge** — see §0.4; the constants are duplicated and
  CI-asserted instead.
