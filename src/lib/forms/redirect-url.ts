/**
 * Guard for `forms.settings.redirectUrl`. The public form page navigates the
 * visitor's browser to whatever this field holds
 * (`src/components/forms/public-form.tsx`), and forms are edited via direct
 * client-SDK writes — firestore.rules constrain the stored scheme, but an
 * older doc or a rules gap must not let a `javascript:`/`data:` URL run on
 * the CRM origin. Only absolute http(s) URLs are safe to navigate to.
 */
export function isSafeFormRedirectUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
