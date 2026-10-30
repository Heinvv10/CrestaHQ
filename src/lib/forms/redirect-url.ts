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

const SAME_ORIGIN_PROBE = "https://same-origin.invalid";

/**
 * Forms (not bookings) also accept a same-origin relative path such as
 * "/thanks". Anything a browser could read as protocol-relative or
 * cross-origin is refused: "//host", "/\host", a backslash anywhere, and any
 * control or whitespace character (browsers strip tab/newline, so "/\t/host"
 * becomes "//host"). Absolute values keep the http(s)-only rule.
 */
export function isSafeFormRedirectTarget(raw: string): boolean {
  if (!raw) return false;
  if (!raw.startsWith("/")) return isSafeFormRedirectUrl(raw);
  if (raw.startsWith("//")) return false;
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return false;
  try {
    return new URL(raw, SAME_ORIGIN_PROBE).origin === SAME_ORIGIN_PROBE;
  } catch {
    return false;
  }
}
