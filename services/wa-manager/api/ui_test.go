package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
)

// pngMagic is the first eight bytes of every PNG.
var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// qrPayload is what the fake bridge hands back on /v1/pair. It is a
// device-linking credential and the assertions below exist to prove it never
// reaches a page.
const qrPayload = "2@QR-PAYLOAD"

func (h *harness) doBasic(path, pass string) *httptest.ResponseRecorder {
	return h.doBasicMethod(http.MethodGet, path, pass, "")
}

// doBasicMethod is how a BROWSER reaches this service: the operator token as
// HTTP Basic, because a form POST cannot carry a bearer header.
func (h *harness) doBasicMethod(method, path, pass, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.SetBasicAuth("operator", pass)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, r)
	return rec
}

// loggedOut puts the seeded number in the state this whole fix is about: killed
// and disconnected, which is what a WhatsApp ban looks like from the bridge.
func (h *harness) loggedOut() {
	h.poll.reports["blitz"] = health.Report{Reachable: true, Connected: false, Killed: true}
}

// The card is the product surface: it must show the number's safety state, in
// one status line, not a pile of counters.
func TestNumbersPageRendersTheCard(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.do(http.MethodGet, "/", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"Connected", "Sent today", "Kill switch", "Last inbound"} {
		if !strings.Contains(body, want) {
			t.Errorf("page missing %q", want)
		}
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

// A browser cannot attach a bearer header to a navigation or an <img src>, so
// the UI accepts the same token as HTTP Basic — and refuses a wrong one with a
// challenge rather than silently rendering nothing.
func TestUIAcceptsTheOperatorTokenAsBasicAuth(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	if rec := h.doBasic("/", operatorTok); rec.Code != http.StatusOK {
		t.Fatalf("basic auth with the operator token: want 200, got %d", rec.Code)
	}
	rec := h.doBasic("/", "not-the-token")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("basic auth with a wrong token: want 401, got %d", rec.Code)
	}
	if rec.Header().Get("WWW-Authenticate") == "" {
		t.Error("a refused browser request must carry a challenge, or the operator sees a blank page")
	}
}

// The QR payload is write-grade: scanning it links a device to the number.
// HTML reaches history, proxies, view-source and screenshots far more readily
// than an image does, so the payload must never be in the markup — even while
// the bridge is actively serving one.
func TestTenantPageNeverCarriesTheQRPayloadOrAToken(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.do(http.MethodGet, "/tenants/blitz", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	for _, secret := range []string{qrPayload, operatorTok, mgrTok, appTok} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Errorf("tenant page leaked %q", secret)
		}
	}
}

// The image is the only carrier of the payload, and it is encoded into pixels
// rather than embedded as text.
func TestQRIsServedAsAnUncacheablePNG(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.do(http.MethodGet, "/tenants/blitz/qr.png", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), pngMagic) {
		t.Fatalf("response is not a PNG: %q", rec.Body.Bytes()[:min(16, rec.Body.Len())])
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Errorf("a device-linking credential must not be cached; Cache-Control = %q", got)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte(qrPayload)) {
		t.Error("the payload appears verbatim in the response rather than encoded")
	}
}

// A number that is already linked has no pairing code. Serving a stale one
// would be worse than serving nothing.
func TestQRRefusesWhenTheNumberIsNotPairing(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.bridge.body = `{"pairing":false,"connected":true}`

	rec := h.do(http.MethodGet, "/tenants/blitz/qr.png", operatorTok, "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	if bytes.HasPrefix(rec.Body.Bytes(), pngMagic) {
		t.Error("served an image for a number that has no pairing code")
	}
}

// A bridge that cannot be read must not produce a page or an image that looks
// like a successful one.
func TestQRFailsClosedWhenTheBridgeRefuses(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.bridge.status = http.StatusServiceUnavailable

	rec := h.do(http.MethodGet, "/tenants/blitz/qr.png", operatorTok, "")
	if rec.Code == http.StatusOK {
		t.Fatalf("want a failure status, got 200")
	}
	if bytes.HasPrefix(rec.Body.Bytes(), pngMagic) {
		t.Error("served an image built from a refused bridge response")
	}
}

func TestUIRefusesUnknownTenant(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/tenants/ghost", "/tenants/ghost/qr.png"} {
		rec := h.do(http.MethodGet, path, operatorTok, "")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: want 404, got %d", path, rec.Code)
		}
	}
}

// THE defect. A banned number is killed and disconnected, and its bridge has no
// pairing code to give — whatsmeow re-enters GetQRChannel only on a fresh
// process start. The page used to render the <img> anyway, so the one card this
// screen exists for showed instructions to scan a broken image, with the QR
// route's 409 invisible inside the element. Design spec §2.4 makes re-pairing a
// self-service event; a dead end is the opposite of that.
func TestLoggedOutNumberIsOfferedARestartRatherThanABrokenImage(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.loggedOut()
	// The bridge for a logged-out number reports no code in flight.
	h.bridge.body = `{"pairing":false,"connected":false}`

	rec := h.do(http.MethodGet, "/tenants/blitz", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "<img") {
		t.Errorf("a number with no live code was shown an image that can only render broken\n---\n%s", body)
	}
	if !strings.Contains(body, `action="/tenants/blitz/restart"`) || !strings.Contains(body, `method="post"`) {
		t.Errorf("no way forward from a logged-out number; the operator is at a dead end\n---\n%s", body)
	}
}

// The other side of the same decision: a bridge that IS offering a code still
// gets the image and the credential warning that goes with it.
func TestNumberWithALiveCodeStillGetsTheImage(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.loggedOut() // needs pairing...
	// ...and this bridge has a code in flight (the fake's default body).

	rec := h.do(http.MethodGet, "/tenants/blitz", operatorTok, "")
	body := rec.Body.String()
	if !strings.Contains(body, `src="/tenants/blitz/qr.png"`) {
		t.Errorf("a live pairing code was not offered\n---\n%s", body)
	}
	if !strings.Contains(body, "do not forward or screenshot") {
		t.Error("the credential warning went missing from the pairing block")
	}
	if strings.Contains(body, qrPayload) {
		t.Error("the page carries the payload itself")
	}
}

// An unreachable bridge cannot be offering a code. Failing closed to the
// restart is both honest and the right move for a bridge in that state.
func TestUnreachableBridgeGetsTheRestartRatherThanAnImage(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.loggedOut()
	h.bridge.status = http.StatusServiceUnavailable

	body := h.do(http.MethodGet, "/tenants/blitz", operatorTok, "").Body.String()
	if strings.Contains(body, "<img") {
		t.Errorf("an unreachable bridge was reported as serving a pairing code\n---\n%s", body)
	}
	if !strings.Contains(body, `action="/tenants/blitz/restart"`) {
		t.Error("no restart offered for an unreachable bridge")
	}
}

// Found by a deliberate break that stayed GREEN: dropping the empty-code check
// went unnoticed. A bridge can answer pairing:true with no code — the QR
// channel opened and has not produced one yet — and handleQRPNG 409s on exactly
// that pair, so believing the flag alone puts the operator back at the broken
// image this fix exists to remove. The page and the image must agree.
func TestPairingTrueWithNoCodeIsNotALiveCode(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.loggedOut()
	h.bridge.body = `{"pairing":true,"connected":false,"code":""}`

	body := h.do(http.MethodGet, "/tenants/blitz", operatorTok, "").Body.String()
	if strings.Contains(body, "<img") {
		t.Errorf("an empty code was offered as an image; the QR route answers 409 for exactly this\n---\n%s", body)
	}
	if !strings.Contains(body, `action="/tenants/blitz/restart"`) {
		t.Error("no restart offered for a bridge with no actual code")
	}
}

// The list page must NOT ask each bridge whether it has a code. One call per
// tenant per render is the fan-out the poller's concurrency bound exists to
// prevent, and forty numbers on a 15-second meta-refresh would be a herd this
// box aims at itself.
func TestTheListPageAsksNoBridgeAnything(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.loggedOut()

	if rec := h.do(http.MethodGet, "/", operatorTok, ""); rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if got := h.bridge.headers(); len(got) != 0 {
		t.Fatalf("the list page called %d bridge(s); that fan-out is per-tenant and unbounded", len(got))
	}
}

// The control an operator actually clicks: Basic auth from a browser, a real
// POST, and it must bounce the unit and send them back to the page.
func TestTheRestartFormBouncesTheUnitAndRedirectsBack(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("want 303 so a reload cannot bounce the number twice, got %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Location"); got != "/tenants/blitz" {
		t.Errorf("Location = %q, want the number's page", got)
	}
	if got := h.units.seen(); len(got) != 2 || got[0] != "stop:blitz" || got[1] != "start:blitz" {
		t.Fatalf("the form did not bounce the unit: %v", got)
	}
}

// GET must not do it. A link prefetcher or a crawler following the page would
// otherwise bounce a customer's live number.
func TestTheRestartControlIsPOSTOnly(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodGet, "/tenants/blitz/restart", operatorTok, "")
	if rec.Code == http.StatusSeeOther || rec.Code == http.StatusOK {
		t.Fatalf("GET reached the restart, status %d", rec.Code)
	}
	if got := h.units.seen(); len(got) != 0 {
		t.Fatalf("a GET bounced the unit: %v", got)
	}
}

// The browser attaches its stored Basic credential to a cross-site form POST
// too, so the token alone does not make this control safe. A form on someone
// else's page must not spend a customer's number.
func TestTheRestartFormRefusesACrossSitePost(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "https://evil.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 for a cross-site restart, got %d", rec.Code)
	}
	if got := h.units.seen(); len(got) != 0 {
		t.Fatalf("a cross-site form bounced the unit: %v", got)
	}
}

// The operator UI must refuse to be framed.
//
// It is Basic-authenticated, so a browser that has seen it once attaches the
// credential to every later request — including one made from a frame on
// someone else's page. The re-pair form is a single button that bounces a live
// customer's WhatsApp number, which is exactly the kind of control a
// transparent frame is built to steal a click for. sameOrigin cannot catch it:
// a framed document is same-origin with itself.
//
// Every UI response, including the ones that refuse the caller — a framed 401
// still renders the browser's own auth prompt inside the attacker's page.
func TestEveryUIResponseRefusesToBeFramed(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	for _, tc := range []struct {
		name string
		rec  *httptest.ResponseRecorder
	}{
		{"list page", h.doBasic("/", operatorTok)},
		{"tenant page", h.doBasic("/tenants/blitz", operatorTok)},
		{"qr png", h.doBasic("/tenants/blitz/qr.png", operatorTok)},
		{"unknown tenant", h.doBasic("/tenants/nope", operatorTok)},
		{"rejected credential", h.doBasic("/", "wrong-token")},
		{"restart form", h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "")},
	} {
		if got := tc.rec.Header().Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("%s: X-Frame-Options = %q, want DENY", tc.name, got)
		}
		csp := tc.rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("%s: Content-Security-Policy = %q, want frame-ancestors 'none'", tc.name, csp)
		}
	}
}

// A real browser sends Origin on every same-origin POST too, and the suite
// only ever exercised the header being ABSENT (a curl or the runbook) or
// hostile. The case an operator actually produces — clicking the button on the
// page — was never covered, so a sameOrigin that rejected every present Origin
// would have stayed green while the one control this screen exists for was
// dead for every browser.
func TestTheRestartFormAdmitsAPresentSameOriginHeader(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	// httptest.NewRequest builds requests for example.com, which is the Host
	// the browser would echo back in Origin.
	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "http://example.com")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("a same-origin browser POST was refused: %d %s", rec.Code, rec.Body.String())
	}
	if got := h.units.seen(); len(got) != 2 || got[0] != "stop:blitz" || got[1] != "start:blitz" {
		t.Fatalf("the same-origin form did not bounce the unit: %v", got)
	}
}

// Behind a reverse proxy that rewrites Host to the upstream address, r.Host
// never matches the browser's real Origin — that is exactly what PUBLIC_ORIGIN
// is for. A configured origin matching the browser's Origin must be admitted
// even though it does not match r.Host (httptest.NewRequest's default,
// "example.com").
func TestTheRestartFormAdmitsAConfiguredPublicOrigin(t *testing.T) {
	h := newHarnessWithPublicOrigin(t, "https://wa.example.com")
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "https://wa.example.com")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("a request matching the configured PUBLIC_ORIGIN was refused: %d %s", rec.Code, rec.Body.String())
	}
	if got := h.units.seen(); len(got) != 2 || got[0] != "stop:blitz" || got[1] != "start:blitz" {
		t.Fatalf("the configured-origin form did not bounce the unit: %v", got)
	}
}

// PUBLIC_ORIGIN widens what is admitted; it must never widen it to "anything".
// A cross-site origin is still refused even when a public origin is
// configured for a different, legitimate proxy address.
func TestTheRestartFormStillRefusesACrossSiteOriginWithPublicOriginConfigured(t *testing.T) {
	h := newHarnessWithPublicOrigin(t, "https://wa.example.com")
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "https://evil.example")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 for a cross-site restart even with PUBLIC_ORIGIN configured, got %d", rec.Code)
	}
	if got := h.units.seen(); len(got) != 0 {
		t.Fatalf("a cross-site form bounced the unit: %v", got)
	}
}

// An absent Origin (curl, the runbook) must stay admitted regardless of
// PUBLIC_ORIGIN — this fix must not tighten that existing behaviour.
func TestTheRestartFormStillAdmitsAnAbsentOriginWithPublicOriginConfigured(t *testing.T) {
	h := newHarnessWithPublicOrigin(t, "https://wa.example.com")
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "")
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("an absent Origin must still be admitted, got %d %s", rec.Code, rec.Body.String())
	}
}

// With nothing configured, today's r.Host behaviour is unchanged: a same-site
// Origin is admitted and a cross-site one refused, exactly as before this fix.
func TestSameOriginBehaviourUnchangedWithNoPublicOriginConfigured(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	same := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "http://example.com")
	if same.Code != http.StatusSeeOther {
		t.Fatalf("same-origin (r.Host) must still be admitted, got %d", same.Code)
	}
	cross := h.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, "https://evil.example")
	if cross.Code != http.StatusForbidden {
		t.Fatalf("cross-site must still be refused, got %d", cross.Code)
	}
}

// The two restart routes exist because a browser form cannot carry a bearer
// header, and they must not come to mean two different things — an operator
// reaching for the JSON route during an incident and the button on the page
// must get the same bounce and the same support record.
//
// Their RESPONSES differ deliberately and always will: the API answers JSON so
// a script can read it, the form answers 303 so a reload cannot bounce the
// number twice. What has to match is the effect.
func TestBothRestartRoutesDoTheSameThing(t *testing.T) {
	viaAPI := newHarness(t)
	viaAPI.seed(t, "blitz", "blitz", 8412)
	if rec := viaAPI.do(http.MethodPost, "/api/tenants/blitz/restart", operatorTok, ""); rec.Code != http.StatusOK {
		t.Fatalf("api restart: %d %s", rec.Code, rec.Body.String())
	}

	viaUI := newHarness(t)
	viaUI.seed(t, "blitz", "blitz", 8412)
	if rec := viaUI.doBasicMethod(http.MethodPost, "/tenants/blitz/restart", operatorTok, ""); rec.Code != http.StatusSeeOther {
		t.Fatalf("ui restart: %d %s", rec.Code, rec.Body.String())
	}

	apiVerbs, uiVerbs := viaAPI.units.seen(), viaUI.units.seen()
	if len(apiVerbs) != 2 || strings.Join(apiVerbs, ",") != strings.Join(uiVerbs, ",") {
		t.Fatalf("the two restart routes drove the unit differently: api=%v ui=%v", apiVerbs, uiVerbs)
	}

	apiEvents, err := viaAPI.st.ListEvents("blitz", 10)
	if err != nil {
		t.Fatal(err)
	}
	uiEvents, err := viaUI.st.ListEvents("blitz", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(apiEvents) != 1 || len(uiEvents) != len(apiEvents) ||
		apiEvents[0].Kind != uiEvents[0].Kind || apiEvents[0].Detail != uiEvents[0].Detail {
		t.Fatalf("the two restart routes left different support records: api=%+v ui=%+v", apiEvents, uiEvents)
	}
}
