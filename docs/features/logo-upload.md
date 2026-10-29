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
4. `GET /api/brand/logo/{agency|sa}/{id}` is public (middleware pattern, exactly those two scopes and one id), because email clients fetch it with no session. It serves `Content-Type` from the stored mime only (PNG or WebP, anything else 404s), with `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and `Content-Security-Policy: default-src 'none'; sandbox`. The cache is immutable for a year only when `?v` matches the stored version; any other request gets five minutes. A bad id, unknown scope, missing doc or failed read is a 404. Before its one Firestore read the route applies a per-client limit of 300 requests a minute (`lib/brand/logo-rate-limit.ts`, keyed on `clientIpFrom`, its own in-memory buckets); over it, 429 with `Retry-After` and no read.
5. **Remove** (`DELETE` on the same upload route) first clears `logoUrl`, but only when it is exactly this tenant's own uploaded logo (same origin as `NEXT_PUBLIC_APP_URL`, same serving path); a pasted URL or another tenant's logo is left alone. Then it deletes the stored logo, so a failure in between leaves an orphaned blob, never a `logoUrl` that 404s.

## Known gaps

- **Remove does not unpublish copies already served.** The current version's URL is served `public, max-age=31536000, s-maxage=31536000, immutable`, so any CDN, browser or email client (including image proxies such as Gmail's) that fetched it may keep showing the old logo for up to a year. Emails already sent keep embedding that URL too: after Remove it 404s for anyone who hasn't cached it, but the cached copies are not purged. To replace a logo everywhere new, upload a new one (new `?v=`); content already sent cannot be recalled.
- Quote/invoice PDFs and the prospect report's OG image embed only PNG or JPEG logos (`lib/branding/logo-data-uri.ts`), so a logo the browser stored as WebP (only when the PNG is over 400 KB) shows there as no logo.
- No agent tool: both upload routes are `human-only` in `scripts/agent-coverage.json`.
