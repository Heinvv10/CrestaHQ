# SP15 — mutation log for the Playwright specs (2026-09-11)

Each spec was run green, then the production line it exists to protect was
broken with `sed`, the PR's standalone build rebuilt, the spec run again (red
assertion pasted verbatim), the file restored with `git checkout -- <file>`
(`git status` clean), and the spec run green again in the final full run.
Local run on 127.0.0.1:3100 with the ci.yml e2e job's env (fake providers
fenced to the fixture agency; never crm.crestahq.com).

## 1. `wa-settings-header.spec.ts` — the badge must be Meta's LIVE answer

Mutation (`src/app/api/sub-accounts/[id]/whatsapp/status/route.ts`):
```
<       phone,
>       phone: { ...phone, qualityRating: meta?.quality?.rating ?? "UNKNOWN" },
```
Red (`header shows the live number, name, connection and quality; the badge follows Meta`):
```
Error: expect(locator).toHaveAttribute(expected) failed
Locator:  getByTestId('wa-quality-badge')
Expected: "GREEN"
Received: "UNKNOWN"
  14 × locator resolved to <span data-rating="UNKNOWN" data-testid="wa-quality-badge" …>Quality: Unknown</span>
```
3 other tests in the spec stayed green (they do not depend on the live rating).

## 2. `wa-settings-profile.spec.ts` — the photo route must sniff the bytes

Mutation (`src/app/api/sub-accounts/[id]/whatsapp/profile/photo/route.ts`):
```
<   const mime = sniffPhotoMime(bytes);
>   const mime = sniffPhotoMime(bytes) ?? "image/png";
```
Red (`a PNG uploads through the seam once; a renamed .txt is refused by its bytes`):
```
Error: expect(received).toBe(expected) // Object.is equality
Expected: 400
Received: 200
> 113 |   expect(refused.status).toBe(400);
```

## 3. `wa-settings-links.spec.ts` — DELETE must act on the code in the path

Mutation (`src/app/api/sub-accounts/[id]/whatsapp/message-links/[code]/route.ts`):
```
<     await provider.deleteMessageLink(code);
>     await provider.deleteMessageLink("e2eIgnoredX");
```
Red (`create → copy → QR → delete, each counted once at Meta`):
```
Error: expect(locator).toBeVisible() failed
Locator: getByText('Link deleted')
Expected: visible
Error: element(s) not found
> 77 |   await expect(page.getByText("Link deleted")).toBeVisible({ timeout: 30_000 });
```
(The fake 404s the unknown code, the page toasts the error, the row survives.)

## 4. `wa-quality-alert.spec.ts` — a drop from GREEN must alert

Mutation (`src/lib/comms/whatsapp/settings/quality-sweep.ts`):
```
<   if (prev.rating === "GREEN" && BAD.has(rating)) return { reading, alert: "drop" };
>   if (prev.rating === "GREEN" && BAD.has(rating)) return { reading, alert: null };
```
Red (`first reading stores; drop alerts once; recovery resolves quietly; a new drop alerts again`):
```
Error: expect(received).toMatchObject(expected)
-   "alerted": 1,
+   "alerted": 0,
> 30 |   expect(await runQualityCron(request)).toMatchObject({ alerted: 1, recovered: 0 });
```

## What the first green-before-mutation run caught (not a mutation — real defects)

The very first run of the four specs (before any mutation) found two
defects the 2241 unit tests had not:

- `/api/cron/whatsapp-quality` was missing from the middleware's public-path
  list: an unsigned POST answered 200 (a 307 to `/login`, followed) instead
  of 401 — QStash would have been redirected too, and the hourly poll would
  never have run. Fixed in `src/middleware.ts` (+ `middleware.test.ts`).
- In fake mode a sub-account WITHOUT a Cloud number still got a fake provider
  (the 409 came only from the Graph credential read), so the SECONDARY
  fixture answered 200 with the default scenario. `route-support.ts` now
  answers 409 `not_connected` when `whatsappCloudMeta.phoneNumberId` is
  absent, in both modes (+ unit test).
