package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// pngMagic is the first eight bytes of every PNG.
var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// qrPayload is what the fake bridge hands back on /v1/pair. It is a
// device-linking credential and the assertions below exist to prove it never
// reaches a page.
const qrPayload = "2@QR-PAYLOAD"

func (h *harness) doBasic(path, pass string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.SetBasicAuth("operator", pass)
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, r)
	return rec
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
