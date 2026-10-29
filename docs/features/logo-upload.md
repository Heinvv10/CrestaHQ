# Logo upload

*Part of the [feature index](README.md). Ported from upstream LeadStack 1.0.54 (unit K1).*

**Status: NOT runtime-verified.** Unit and route tests pass and `e2e/specs/logo-upload.spec.ts` exists, but neither the spec nor the live walk (upload on #1000, see it in a booking confirmation email) has run yet.

The agency Branding card (Agency → Settings) and the sub-account Branding card (Settings → Admin) each have **Upload logo** next to the existing Logo URL field. Pasting a URL still works.

## Flow

1. The browser resizes the picked file (PNG, JPG, WebP or SVG, up to 5 MB) on a canvas to at most 512 px on the long edge and re-encodes it as PNG, or WebP when the PNG is too heavy (`lib/brand/render-logo-client.ts`). SVG never leaves the browser as SVG.
2. `POST /api/agency/logo` (agency owner, own agency from claims) or `POST /api/sub-accounts/[id]/logo` (sub-account admin or the parent agency's owner) re-validates the bytes with `validateLogo` (`lib/brand/logo-server.ts`):
   - the body is capped at 600 KB before it is parsed;
   - the mime is `image/png` or `image/webp` only, and the data is strict base64;
   - the bytes are at most 400 KB decoded;
   - a PNG must start with IHDR, end with IEND and have nothing after it;
   - a WebP's RIFF length must cover exactly the file, and its first chunk must be VP8, VP8L or VP8X with a valid signature;
   - both edges are at most 1024 px.
3. The route stores the logo as base64 in `agencies/{id}/brandAssets/logo` or `subAccounts/{id}/private/brandLogo` (both server-only, see [firestore-collections.md](../architecture/firestore-collections.md)), then sets `logoUrl` to `${NEXT_PUBLIC_APP_URL}/api/brand/logo/{agency|sa}/{id}?v={upload ms}`. The upload is refused with 503 when `NEXT_PUBLIC_APP_URL` is unset. The URL is never built from the request origin, which under the standalone server is the bind address.
4. `GET /api/brand/logo/{agency|sa}/{id}` is public (middleware pattern, exactly those two scopes and one id), because email clients fetch it with no session. It serves `Content-Type` from the stored mime only (PNG or WebP, anything else 404s), with `X-Content-Type-Options: nosniff` and `Content-Disposition: inline`. The cache is immutable for a year only when `?v` matches the stored version; any other request gets five minutes. A bad id, unknown scope, missing doc or failed read is a 404.
5. **Remove** (`DELETE` on the same upload route) deletes the stored logo and clears `logoUrl` only when it points at an uploaded logo. A pasted URL is left alone.

## Known gaps

- Quote/invoice PDFs and the prospect report's OG image embed only PNG or JPEG logos (`lib/branding/logo-data-uri.ts`), so a logo the browser stored as WebP (only when the PNG is over 400 KB) shows there as no logo.
- No agent tool: both upload routes are `human-only` in `scripts/agent-coverage.json`.
