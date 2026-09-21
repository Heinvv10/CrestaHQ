package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/provision"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

const (
	operatorTok = "op-token-hermes"
	appTok      = "app-token-that-must-never-appear"
	// hookSecret is the webhook signing key a real provision would have just
	// minted. Like appTok it must appear in exactly one response — the 201 of
	// the call that minted it — and nowhere else.
	hookSecret = "hook-secret-that-must-never-appear"
	mgrTok     = "manager-token-for-tenant"
)

// fakeProvisioner records what it was asked to do WITHOUT touching systemd or
// the filesystem. Counting calls is the point: several tests assert that a
// refused request never reached it.
type fakeProvisioner struct {
	mu       sync.Mutex
	creates  []string
	destroys []string
	tenant   store.Tenant
	// appToken and webhookSecret are what a real provisioner would have just
	// minted. They are fields rather than constants so a test can set the
	// webhook secret empty and assert the pre-signing shape.
	appToken      string
	webhookSecret string
	err           error
}

func (f *fakeProvisioner) Create(tenantID, displayName string) (provision.Created, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates = append(f.creates, tenantID)
	if f.err != nil {
		return provision.Created{}, f.err
	}
	t := f.tenant
	t.ID, t.DisplayName = tenantID, displayName
	return provision.Created{
		Tenant:        t,
		AppToken:      f.appToken,
		WebhookSecret: f.webhookSecret,
	}, nil
}

func (f *fakeProvisioner) Destroy(tenantID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.destroys = append(f.destroys, tenantID)
	return f.err
}

func (f *fakeProvisioner) calls() (creates, destroys []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.creates...), append([]string(nil), f.destroys...)
}

type fakePoller struct{ reports map[string]health.Report }

func (f *fakePoller) Snapshot(_ context.Context, tenants []store.Tenant) map[string]health.Report {
	out := map[string]health.Report{}
	for _, t := range tenants {
		if r, ok := f.reports[t.ID]; ok {
			out[t.ID] = r
		}
	}
	return out
}

type fakeUnits struct {
	mu    sync.Mutex
	verbs []string
	err   error
}

func (f *fakeUnits) Enable(i string) error  { return f.note("enable", i) }
func (f *fakeUnits) Start(i string) error   { return f.note("start", i) }
func (f *fakeUnits) Restart(i string) error { return f.note("restart", i) }
func (f *fakeUnits) Stop(i string) error    { return f.note("stop", i) }
func (f *fakeUnits) Disable(i string) error { return f.note("disable", i) }

// ResetFailed is recorded like the rest so a test can assert it happens
// between the stop and the start.
func (f *fakeUnits) ResetFailed(i string) error { return f.note("reset-failed", i) }
func (f *fakeUnits) IsActive(string) (bool, error) {
	return true, nil
}

func (f *fakeUnits) note(verb, instance string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verbs = append(f.verbs, verb+":"+instance)
	return f.err
}

func (f *fakeUnits) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.verbs...)
}

// fakeBridge stands in for a tenant's bridge. It records the Authorization
// header it was handed, so a test can prove the manager presented its OWN
// token and not the caller's.
type fakeBridge struct {
	mu     sync.Mutex
	authz  []string
	server *httptest.Server
	body   string
	status int
}

func newFakeBridge(t *testing.T) *fakeBridge {
	t.Helper()
	b := &fakeBridge{
		status: http.StatusOK,
		body:   `{"pairing":true,"connected":false,"code":"2@QR-PAYLOAD","expiresAt":"2026-09-04T10:00:00Z","extra":"must-not-be-relayed"}`,
	}
	b.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		b.authz = append(b.authz, r.Header.Get("Authorization"))
		status, body := b.status, b.body
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(b.server.Close)
	return b
}

func (b *fakeBridge) headers() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.authz...)
}

type harness struct {
	h      http.Handler
	st     *store.Store
	prov   *fakeProvisioner
	units  *fakeUnits
	bridge *fakeBridge
	// poll is the harness's health source. Held so a test can change what the
	// screen is looking at — a logged-out number renders a different page from
	// a connected one, and that difference is the point of the pairing block.
	poll *fakePoller
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithPublicOrigin(t, "")
}

// newHarnessWithPublicOrigin is newHarness with config.Config.PublicOrigin
// threaded through, for the tests proving sameOrigin's proxy-configured path.
func newHarnessWithPublicOrigin(t *testing.T, publicOrigin string) *harness {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/manager.db")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	prov := &fakeProvisioner{
		tenant:        store.Tenant{Instance: "blitz", Port: 8412, State: store.StateProvisioned},
		appToken:      appTok,
		webhookSecret: hookSecret,
	}
	units := &fakeUnits{}
	bridge := newFakeBridge(t)
	poll := &fakePoller{reports: map[string]health.Report{"blitz": {Reachable: true, Connected: true, OutboundLast24h: 7}}}

	h := New(Deps{
		Store:         st,
		Provisioner:   prov,
		Poller:        poll,
		Units:         units,
		OperatorToken: operatorTok,
		PublicOrigin:  publicOrigin,
		TenantToken:   func(string) string { return mgrTok },
		BridgeBaseURL: func(store.Tenant) string { return bridge.server.URL },
	})
	return &harness{h: h, st: st, prov: prov, units: units, bridge: bridge, poll: poll}
}

// seed writes a tenant row directly, standing in for a completed provision.
func (h *harness) seed(t *testing.T, id, instance string, port int) {
	t.Helper()
	if err := h.st.CreateTenant(store.Tenant{
		ID: id, DisplayName: id, Instance: instance, Port: port, State: store.StateRunning,
	}); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

func (h *harness) do(method, path, token, body string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.h.ServeHTTP(rec, r)
	return rec
}

// route is one addressable endpoint, used by the table-driven auth test.
type route struct {
	method, path, body string
}

func allRoutes() []route {
	return []route{
		{http.MethodGet, "/api/tenants", ""},
		{http.MethodPost, "/api/tenants", `{"tenantId":"blitz","displayName":"Blitz"}`},
		{http.MethodDelete, "/api/tenants/blitz?confirm=blitz", ""},
		{http.MethodGet, "/api/tenants/blitz/pair", ""},
		{http.MethodPost, "/api/tenants/blitz/restart", ""},
		// The UI is not more public than the API it fronts.
		{http.MethodGet, "/", ""},
		{http.MethodGet, "/tenants/blitz", ""},
		{http.MethodGet, "/tenants/blitz/qr.png", ""},
		// The re-pair control bounces a customer's live number.
		{http.MethodPost, "/tenants/blitz/restart", ""},
	}
}

// There is no public route on this API. It writes .env files and starts
// systemd units, so an unauthenticated caller reaching ANY handler is remote
// code execution — health included, which is why none is exposed.
func TestEveryRouteRefusesWithoutTheOperatorToken(t *testing.T) {
	for _, rt := range allRoutes() {
		for _, tok := range []string{"", "wrong-token", operatorTok + "x", operatorTok[:len(operatorTok)-1]} {
			h := newHarness(t)
			h.seed(t, "blitz", "blitz", 8412)
			rec := h.do(rt.method, rt.path, tok, rt.body)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s with token %q: want 401, got %d body=%s",
					rt.method, rt.path, tok, rec.Code, rec.Body.String())
			}
			creates, destroys := h.prov.calls()
			if len(creates)+len(destroys) != 0 {
				t.Fatalf("%s %s: unauthenticated request reached the provisioner", rt.method, rt.path)
			}
			if len(h.units.seen()) != 0 {
				t.Fatalf("%s %s: unauthenticated request reached systemd", rt.method, rt.path)
			}
			if len(h.bridge.headers()) != 0 {
				t.Fatalf("%s %s: unauthenticated request reached the bridge", rt.method, rt.path)
			}
		}
	}
}

// A malformed or empty Authorization header is refused, not parsed leniently.
// The table above passes "" as "send no header at all"; these are headers that
// are PRESENT and unusable, which is a different code path.
func TestMalformedAuthorizationHeadersAreRefused(t *testing.T) {
	for _, raw := range []string{"Bearer ", "Bearer", "Bearer  ", "bearer ", "Basic " + operatorTok, operatorTok, ""} {
		h := newHarness(t)
		h.seed(t, "blitz", "blitz", 8412)
		req := httptest.NewRequest(http.MethodGet, "/api/tenants", nil)
		req.Header.Set("Authorization", raw)
		rec := httptest.NewRecorder()
		h.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("Authorization %q: want 401, got %d body=%s", raw, rec.Code, rec.Body.String())
		}
	}
}

func TestCreateReturnsAllocatedPort(t *testing.T) {
	h := newHarness(t)
	h.prov.tenant = store.Tenant{Instance: "acme", Port: 8477, State: store.StateProvisioned}

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme Ltd"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if got["port"] != float64(8477) {
		t.Fatalf("want the allocated port 8477 in the response, got %v", got["port"])
	}
	if got["tenantId"] != "acme" || got["instance"] != "acme" {
		t.Fatalf("response does not identify the tenant: %v", got)
	}
	creates, _ := h.prov.calls()
	if len(creates) != 1 || creates[0] != "acme" {
		t.Fatalf("provisioner calls = %v", creates)
	}
}

// The tenant id is caller input that becomes a filesystem path and a systemd
// unit name. It is refused BEFORE the provisioner is touched.
func TestUnsafeTenantIDIsRefusedBeforeProvisioning(t *testing.T) {
	// Two kinds are refused: ids that yield NO usable instance name, and ids
	// that would only survive by being silently renamed into one.
	// "BLITZ" is deliberately absent: case is the one divergence from the
	// canonical instance name that checkTenantID now admits, because a
	// LeadStack subAccountId is mixed-case and the tenant id is interpolated
	// into the inbound webhook. TestCreateAcceptsAMixedCaseTenantID pins that.
	unsafe := []string{"", "..", "/", "----", "...", " ",
		"../../etc", "a/../b", "Blitz Fibre", "a.b", "blitz_fibre", "-blitz"}
	for _, id := range unsafe {
		h := newHarness(t)
		body, _ := json.Marshal(map[string]string{"tenantId": id, "displayName": "x"})
		rec := h.do(http.MethodPost, "/api/tenants", operatorTok, string(body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("tenant id %q: want 400, got %d body=%s", id, rec.Code, rec.Body.String())
		}
		if creates, _ := h.prov.calls(); len(creates) != 0 {
			t.Fatalf("tenant id %q reached the provisioner: %v", id, creates)
		}
	}
}

// The same refusal applies to ids arriving in the path, which reach systemd
// and the bridge rather than the provisioner.
func TestUnsafeTenantIDInPathIsRefused(t *testing.T) {
	// ".." is excluded here only because net/http normalises it out of the
	// path before any route matches; TestTraversalPathIsNotDispatched covers
	// that case separately.
	// "Blitz" is not here for the reason given in
	// TestUnsafeTenantIDIsRefusedBeforeProvisioning: mixed case is admitted.
	for _, id := range []string{"----", "Blitz_Fibre", "a.b", "..%2f..%2fetc"} {
		for _, rt := range []route{
			{http.MethodGet, "/api/tenants/" + id + "/pair", ""},
			{http.MethodPost, "/api/tenants/" + id + "/restart", ""},
			{http.MethodDelete, "/api/tenants/" + id + "?confirm=" + id, ""},
		} {
			h := newHarness(t)
			rec := h.do(rt.method, rt.path, operatorTok, rt.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s %s: want 400, got %d body=%s", rt.method, rt.path, rec.Code, rec.Body.String())
			}
			if _, destroys := h.prov.calls(); len(destroys) != 0 {
				t.Fatalf("%s %s reached Destroy", rt.method, rt.path)
			}
			if len(h.units.seen()) != 0 {
				t.Fatalf("%s %s reached systemd: %v", rt.method, rt.path, h.units.seen())
			}
			if len(h.bridge.headers()) != 0 {
				t.Fatalf("%s %s reached the bridge", rt.method, rt.path)
			}
		}
	}
}

// The relay returns the QR payload and presents the MANAGER's token to the
// bridge. The caller's operator token is never proxied through: it is the
// credential for every tenant, and a bridge is not entitled to see it.
func TestPairRelaysBridgePayloadWithTheManagerToken(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.do(http.MethodGet, "/api/tenants/blitz/pair", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["code"] != "2@QR-PAYLOAD" {
		t.Fatalf("QR payload not relayed: %v", got)
	}
	if got["pairing"] != true {
		t.Fatalf("pairing flag not relayed: %v", got)
	}
	if _, leaked := got["extra"]; leaked {
		t.Fatalf("relay passed a field through blindly: %v", got)
	}

	headers := h.bridge.headers()
	if len(headers) != 1 {
		t.Fatalf("bridge saw %d requests, want 1", len(headers))
	}
	if headers[0] != "Bearer "+mgrTok {
		t.Fatalf("bridge was presented %q, want the manager token", headers[0])
	}
	if strings.Contains(headers[0], operatorTok) {
		t.Fatal("the caller's operator token was proxied to the bridge")
	}
}

// Destroying a tenant erases a customer's WhatsApp session. Holding the token
// proves who is calling, not that they meant this tenant, so the id is named
// twice — once in the path and once as an explicit confirmation.
func TestDeleteRequiresAMatchingConfirmation(t *testing.T) {
	for _, q := range []string{"", "?confirm=", "?confirm=other", "?confirm=true"} {
		h := newHarness(t)
		h.seed(t, "blitz", "blitz", 8412)
		rec := h.do(http.MethodDelete, "/api/tenants/blitz"+q, operatorTok, "")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("query %q: want 400, got %d body=%s", q, rec.Code, rec.Body.String())
		}
		if _, destroys := h.prov.calls(); len(destroys) != 0 {
			t.Fatalf("query %q destroyed a tenant without confirmation", q)
		}
	}
}

func TestDeleteCallsDestroy(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)

	rec := h.do(http.MethodDelete, "/api/tenants/blitz?confirm=blitz", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	_, destroys := h.prov.calls()
	if len(destroys) != 1 || destroys[0] != "blitz" {
		t.Fatalf("Destroy calls = %v", destroys)
	}
}

func TestListReturnsTenantsWithHealth(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.seed(t, "velo", "velo", 8413)

	rec := h.do(http.MethodGet, "/api/tenants", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Tenants []struct {
			TenantID string `json:"tenantId"`
			Port     int    `json:"port"`
			Health   *struct {
				Reachable       bool `json:"reachable"`
				Connected       bool `json:"connected"`
				OutboundLast24h int  `json:"outboundLast24h"`
			} `json:"health"`
		} `json:"tenants"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(got.Tenants) != 2 {
		t.Fatalf("want 2 tenants, got %d", len(got.Tenants))
	}
	var blitz, velo = -1, -1
	for i, tn := range got.Tenants {
		switch tn.TenantID {
		case "blitz":
			blitz = i
		case "velo":
			velo = i
		}
	}
	if blitz < 0 || velo < 0 {
		t.Fatalf("tenants not identified: %+v", got.Tenants)
	}
	if got.Tenants[blitz].Port != 8412 {
		t.Fatalf("blitz port = %d", got.Tenants[blitz].Port)
	}
	if got.Tenants[blitz].Health == nil || !got.Tenants[blitz].Health.Connected ||
		got.Tenants[blitz].Health.OutboundLast24h != 7 {
		t.Fatalf("blitz health not reported: %+v", got.Tenants[blitz].Health)
	}
	// velo has no report. The API must say so with a null, not invent a
	// health block at all: a ZERO-VALUED block is the shape a careless
	// `reports[t.ID]` without the comma-ok would produce, and it reads as a
	// bridge answering "not connected, nothing sent" — a live incident —
	// when the truth is that nothing was asked. Asserting only that it is
	// not `reachable` would let exactly that mutation through.
	if got.Tenants[velo].Health != nil {
		t.Fatalf("velo has no poll result but got a health block: %+v", got.Tenants[velo].Health)
	}
}

func TestRestartClearsTheStartLimitThenBounces(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz-inst", 8412)

	rec := h.do(http.MethodPost, "/api/tenants/blitz/restart", operatorTok, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	// reset-failed sits between the two: a unit that tripped its start rate
	// limit refuses to start until it is cleared, and this route exists to
	// restart bridges that keep dying.
	want := []string{"reset-failed:blitz-inst", "restart:blitz-inst"}
	got := h.units.seen()
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("systemd verbs = %v, want %v", got, want)
	}
}

// A restart that could not stop the unit must not report success: the operator
// asked for a bounce and would otherwise walk away from a stuck bridge.
func TestRestartReportsFailure(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz-inst", 8412)
	h.units.err = fmt.Errorf("systemctl exited non-zero")

	rec := h.do(http.MethodPost, "/api/tenants/blitz/restart", operatorTok, "")
	if rec.Code < 500 {
		t.Fatalf("want a 5xx when the unit could not be bounced, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// No route that READS state may carry a credential. The manager holds one
// token per tenant plus its own, and an operator console rendering a response
// verbatim must not put any of them on a screen or in a log.
//
// POST /api/tenants is deliberately excluded and has its own tests below: it
// discloses the app pair it has just minted, once, and never again. Every
// other route — including the list route that re-encodes the same tenants —
// must stay silent.
func TestReadRoutesNeverCarryTokens(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	// A tenant is created first, so the list route below is re-encoding a
	// tenant whose credentials the manager has genuinely seen this run.
	h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme"}`)

	bodies := []string{
		h.do(http.MethodGet, "/api/tenants", operatorTok, "").Body.String(),
		h.do(http.MethodGet, "/api/tenants/blitz/pair", operatorTok, "").Body.String(),
		h.do(http.MethodPost, "/api/tenants/blitz/restart", operatorTok, "").Body.String(),
		h.do(http.MethodDelete, "/api/tenants/blitz?confirm=blitz", operatorTok, "").Body.String(),
	}
	// operatorTok and mgrTok ONLY.
	//
	// appTok and hookSecret used to be in this list and could not fail it. A
	// read route can only disclose what it can reach, and those two reach the
	// server as provision.Created fields — returned by the create call and
	// never persisted. store.Tenant, which every read route projects, has no
	// credential field and deliberately must not gain one (see the comment on
	// provision.Created), so no widening of tenantView could ever make them
	// appear here. Asserting their absence bought false confidence: it read as
	// a guard on the projection while being unable to go red for any change to
	// it. The projection's create-path disclosure is guarded by
	// TestCreateReturnsTheMintedAppCredentialsOnce and
	// TestCreateOmitsTheWebhookSecretWhenSigningIsOff instead.
	//
	// The two that remain are genuinely reachable: operatorTok is the token
	// this request presented, and mgrTok is the token the manager presents to
	// the bridge whose body the pair route relays.
	for _, b := range bodies {
		for _, secret := range []string{operatorTok, mgrTok} {
			if strings.Contains(b, secret) {
				t.Fatalf("response leaked a credential: %s", b)
			}
		}
	}
}

// The one authorised disclosure: the 201 hands back the pair this call minted,
// because nothing else can — the manager keeps no readable copy, and the CRM
// cannot read another service's .env. Without it there is no way to connect a
// provisioned bridge to the product at all.
func TestCreateReturnsTheMintedAppCredentialsOnce(t *testing.T) {
	h := newHarness(t)

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	if got["token"] != appTok {
		t.Fatalf("token = %v, want the freshly minted app token", got["token"])
	}
	if got["webhookSecret"] != hookSecret {
		t.Fatalf("webhookSecret = %v, want the freshly minted secret", got["webhookSecret"])
	}
	// The tenant projection must still be there — the caller needs the port to
	// address the bridge at all.
	if got["tenantId"] != "acme" || got["port"] != float64(8412) {
		t.Fatalf("201 lost the tenant projection: %v", got)
	}
}

// A manager provisioning unsigned tenants (no webhook-secret generator) must
// omit the field rather than send "". An empty string reads as "the secret is
// blank", and a receiver storing it would then verify every inbound against a
// key the bridge never had.
func TestCreateOmitsTheWebhookSecretWhenSigningIsOff(t *testing.T) {
	h := newHarness(t)
	h.prov.webhookSecret = ""

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if _, present := got["webhookSecret"]; present {
		t.Fatalf("webhookSecret must be absent, not blank: %s", rec.Body.String())
	}
}

// An unreachable bridge is an error the operator can act on, not a silent
// "not pairing" that looks like a bridge with nothing to show.
func TestPairSurfacesABridgeThatRefuses(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.bridge.status = http.StatusUnauthorized
	h.bridge.body = `{"error":"unknown token"}`

	rec := h.do(http.MethodGet, "/api/tenants/blitz/pair", operatorTok, "")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// An id that is safe but unknown is a 404, not a 500 and not a 400: the
// difference tells an operator whether they mistyped or the tenant is gone.
func TestUnknownTenantIsNotFound(t *testing.T) {
	h := newHarness(t)
	for _, rt := range []route{
		{http.MethodGet, "/api/tenants/ghost/pair", ""},
		{http.MethodPost, "/api/tenants/ghost/restart", ""},
	} {
		rec := h.do(rt.method, rt.path, operatorTok, rt.body)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s: want 404, got %d body=%s", rt.method, rt.path, rec.Code, rec.Body.String())
		}
	}
}

// A path that tries to climb out of /api/tenants must not reach a handler.
// net/http normalises it away before routing, so this asserts the OUTCOME —
// nothing was provisioned, bounced or asked of a bridge — rather than a
// status code the mux, not this package, chose.
func TestTraversalPathIsNotDispatched(t *testing.T) {
	for _, p := range []string{
		"/api/tenants/../pair",
		"/api/tenants/../../pair",
		"/api/tenants/blitz/../../tenants/blitz/pair",
	} {
		h := newHarness(t)
		h.seed(t, "blitz", "blitz", 8412)
		rec := h.do(http.MethodGet, p, operatorTok, "")
		if rec.Code == http.StatusOK {
			t.Fatalf("%s was served: %s", p, rec.Body.String())
		}
		if len(h.bridge.headers()) != 0 {
			t.Fatalf("%s reached a bridge", p)
		}
		if creates, destroys := h.prov.calls(); len(creates)+len(destroys) != 0 {
			t.Fatalf("%s reached the provisioner", p)
		}
		if len(h.units.seen()) != 0 {
			t.Fatalf("%s reached systemd", p)
		}
	}
}

// An incidental provisioning failure — a failed mkdir, a read-only disk — is
// NOT a conflict and must not be relayed.
//
// Two things go wrong when it is. The install layout reaches any token holder,
// and, worse, a permission error arrives as 409 Conflict: the operator is told
// "already exists" and goes looking for a duplicate tenant that is not there.
func TestIncidentalProvisionFailureIsNeitherDisclosedNor409(t *testing.T) {
	h := newHarness(t)
	h.prov.err = &os.PathError{
		Op:   "mkdir",
		Path: "/opt/wa-bridge/instances/acme/session",
		Err:  syscall.EACCES,
	}

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 for a failed mkdir, got %d body=%s", rec.Code, rec.Body.String())
	}
	assertNoInternals(t, rec.Body.String())
}

// A refusal the provisioner authored IS a conflict, and its sentence is the
// useful part — it names the tenant and the instance and no path.
func TestAuthoredConflictKeepsItsStatusAndSentence(t *testing.T) {
	h := newHarness(t)
	h.prov.err = &provision.ConflictError{Msg: `tenant "acme" already exists; destroy it before re-provisioning`}

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok, `{"tenantId":"acme","displayName":"Acme"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("want 409 for an authored conflict, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "already exists") {
		t.Fatalf("the conflict sentence was lost: %s", rec.Body.String())
	}
}

func TestDestroyFailureIsNotDisclosed(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz", 8412)
	h.prov.err = &os.PathError{
		Op:   "unlinkat",
		Path: "/opt/wa-bridge/instances/blitz/session",
		Err:  syscall.EACCES,
	}

	rec := h.do(http.MethodDelete, "/api/tenants/blitz?confirm=blitz", operatorTok, "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", rec.Code)
	}
	assertNoInternals(t, rec.Body.String())
}

// systemctl stderr names unit file paths on the host.
func TestRestartFailureIsNotDisclosed(t *testing.T) {
	h := newHarness(t)
	h.seed(t, "blitz", "blitz-inst", 8412)
	h.units.err = fmt.Errorf("systemd: start wa-bridge@blitz-inst: Unit /etc/systemd/system/wa-bridge@.service not loaded")

	rec := h.do(http.MethodPost, "/api/tenants/blitz/restart", operatorTok, "")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500, got %d", rec.Code)
	}
	assertNoInternals(t, rec.Body.String())
}

// assertNoInternals fails if a response body carries anything about the host:
// a filesystem path, a unit file, or a raw syscall name.
func assertNoInternals(t *testing.T, body string) {
	t.Helper()
	for _, leak := range []string{"/opt/", "/etc/", "mkdir", "unlinkat", "permission denied", ".service", "wa-bridge@"} {
		if strings.Contains(body, leak) {
			t.Fatalf("response disclosed %q: %s", leak, body)
		}
	}
}

// The operator UI shows how many contacts have escaped reply-only. This JSON
// view is the same health, read by a machine, and the two must not disagree
// about what health contains — a monitor built on this endpoint would
// otherwise be blind to a rail the human screen displays.
func TestTenantViewCarriesTheAllowlistCount(t *testing.T) {
	n := 2
	v := viewOf(store.Tenant{ID: "t1"}, &health.Report{Reachable: true, AllowlistCount: &n})
	if v.Health == nil || v.Health.AllowlistCount == nil {
		t.Fatal("the allowlist count must reach the JSON view")
	}
	if *v.Health.AllowlistCount != 2 {
		t.Fatalf("want 2, got %d", *v.Health.AllowlistCount)
	}

	// null, not 0, when the bridge could not read its own allowlist.
	blind := viewOf(store.Tenant{ID: "t1"}, &health.Report{Reachable: true, AllowlistCount: nil})
	if blind.Health.AllowlistCount != nil {
		t.Fatal("an unreadable allowlist must stay null in JSON, never become 0")
	}
}

// The rollout routes restart every WhatsApp number on this box. They must be
// gated exactly like the other privileged routes — this is the test that
// notices if the routing ever regresses to unauthenticated.
func TestTheRolloutRoutesRefuseAnUnauthenticatedCaller(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/rollout"},
		{http.MethodGet, "/api/rollout"},
	} {
		if rec := h.do(tc.method, tc.path, "", `{"version":"v2"}`); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a token = %d, want 401", tc.method, tc.path, rec.Code)
		}
		if rec := h.do(tc.method, tc.path, "not-the-operator-token", `{"version":"v2"}`); rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s with a wrong token = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
	// And nothing was queued by those attempts.
	if _, ok, err := h.st.CurrentRollout(); err != nil || ok {
		t.Fatalf("an unauthenticated caller queued a rollout (ok=%v err=%v)", ok, err)
	}
}

// A rollout with no version would make every bridge look stale forever, since
// a bridge's reported version can never equal "".
func TestARolloutWithoutAVersionIsRefused(t *testing.T) {
	h := newHarness(t)
	for _, body := range []string{`{}`, `{"version":""}`, `{"version":"   "}`} {
		rec := h.do(http.MethodPost, "/api/rollout", operatorTok, body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("POST %s = %d, want 400", body, rec.Code)
		}
	}
	if rec := h.do(http.MethodPost, "/api/rollout", operatorTok, `not json`); rec.Code != http.StatusBadRequest {
		t.Fatalf("POST of non-JSON = %d, want 400", rec.Code)
	}
	if _, ok, _ := h.st.CurrentRollout(); ok {
		t.Fatal("a refused request still queued a rollout")
	}
}

// The deploy script reads this body to decide whether it succeeded, and polls
// the GET until the state leaves pending/running. Both shapes are a contract
// with a bash script that cannot be typechecked, so they are pinned here.
func TestTheRolloutRoutesReturnTheShapeTheDeployScriptReads(t *testing.T) {
	h := newHarness(t)

	if got := decodeBody(t, h.do(http.MethodGet, "/api/rollout", operatorTok, "")); got["rollout"] != nil {
		t.Fatalf("with no rollout ever, want {\"rollout\":null}, got %v", got)
	}

	posted := decodeBody(t, h.do(http.MethodPost, "/api/rollout", operatorTok, `{"version":"v2","now":true}`))
	for _, key := range []string{"id", "version", "state", "immediate", "requested"} {
		if _, ok := posted[key]; !ok {
			t.Fatalf("POST body is missing %q: %v", key, posted)
		}
	}
	if posted["state"] != "pending" || posted["version"] != "v2" || posted["immediate"] != true {
		t.Fatalf("POST body = %v", posted)
	}
	if _, present := posted["finished"]; present {
		t.Fatalf("an unfinished rollout reported a finished time: %v", posted)
	}

	got := decodeBody(t, h.do(http.MethodGet, "/api/rollout", operatorTok, ""))
	if got["state"] != "pending" || got["version"] != "v2" {
		t.Fatalf("GET body = %v", got)
	}
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	return out
}

// A LeadStack subAccountId is a mixed-case Firestore document id, and the
// manager interpolates the tenant id verbatim into each bridge's inbound
// webhook (base + "/" + tenantID). Refusing uppercase therefore did not merely
// inconvenience an operator: it made the CRM's own webhook route unreachable,
// because no accepted id could ever spell one.
func TestCreateAcceptsAMixedCaseTenantID(t *testing.T) {
	h := newHarness(t)
	const id = "54vPI0BS1zDMcxMyMAyA"
	h.prov.tenant = store.Tenant{Instance: "54vpi0bs1zdmcxmymaya", Port: 33101, State: store.StateProvisioned}

	rec := h.do(http.MethodPost, "/api/tenants", operatorTok,
		`{"tenantId":"`+id+`","displayName":"CrestaHQ"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d body=%s", rec.Code, rec.Body.String())
	}
	creates, _ := h.prov.calls()
	if len(creates) != 1 || creates[0] != id {
		// Verbatim matters more than acceptance: a lowercased id would build a
		// webhook URL for a sub-account that does not exist, and inbound would
		// 404 forever with every component reporting healthy.
		t.Fatalf("the id must reach the provisioner unchanged, got %v", creates)
	}
}

// Widening the alphabet to admit uppercase must not widen it to anything that
// changes shape on the way to a path, a unit name or a URL.
func TestCreateStillRefusesUnsafeTenantIDs(t *testing.T) {
	for _, id := range []string{
		"../../etc",     // traversal
		"Blitz Fibre",   // a space: coerced to a name nobody typed
		"a.b",           // a separator that collapses onto another id
		"a_b",           // ditto
		"-acme",         // systemd names start alphanumeric
		"",              // no id at all
		"acme/../other", // a slash would split the webhook path
		"acme?x=1",      // a query string smuggled into the webhook URL
		"acme#frag",
		"acmé", // non-ASCII coerces to a dash
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // 71 chars: silently truncated
	} {
		h := newHarness(t)
		rec := h.do(http.MethodPost, "/api/tenants", operatorTok,
			`{"tenantId":`+mustJSONString(id)+`,"displayName":"x"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("tenant id %q: want 400, got %d body=%s", id, rec.Code, rec.Body.String())
		}
		if creates, _ := h.prov.calls(); len(creates) != 0 {
			t.Fatalf("tenant id %q reached the provisioner: %v", id, creates)
		}
	}
}

func mustJSONString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// The whole point of admitting case is that the id survives verbatim: it is a
// case-sensitive primary key (store/sqlite.go, no COLLATE NOCASE) and it is
// interpolated into the bridge's inbound webhook. Every route above reached
// through the create handler, which ignores checkTenantID's returned id — so
// a checkTenantID that normalised what it returned would break every PATH
// route in production while leaving the rest of this suite green.
//
// These routes bind that. Each one resolves the id against the store, so a
// lowercased return value 404s instead of acting.
func TestPathRoutesResolveAMixedCaseTenantVerbatim(t *testing.T) {
	const id = "54vPI0BS1zDMcxMyMAyA"
	const instance = "54vpi0bs1zdmcxmymaya"

	t.Run("pair relays to the bridge", func(t *testing.T) {
		h := newHarness(t)
		h.seed(t, id, instance, 33101)
		rec := h.do(http.MethodGet, "/api/tenants/"+id+"/pair", operatorTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		if len(h.bridge.headers()) != 1 {
			t.Fatalf("the request never reached the bridge: %v", h.bridge.headers())
		}
	})

	t.Run("restart acts on the lowercased instance", func(t *testing.T) {
		h := newHarness(t)
		h.seed(t, id, instance, 33101)
		rec := h.do(http.MethodPost, "/api/tenants/"+id+"/restart", operatorTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		// The unit name is the ONE place the id is allowed to differ, and it
		// must differ in exactly one way: lowercased, nothing else renamed.
		if seen := h.units.seen(); len(seen) == 0 || !strings.Contains(strings.Join(seen, ","), instance) {
			t.Fatalf("systemd was not asked to restart %q: %v", instance, seen)
		}
		// Not merely "found the tenant": the id reported back to the operator
		// must be the one they supplied, byte for byte. This also catches a
		// refactor that keeps the lookup working but echoes a coerced id.
		if got := decodeBody(t, rec)["tenantId"]; got != id {
			t.Fatalf("the response renames the tenant: want %q, got %v", id, got)
		}
	})

	t.Run("delete matches the confirm parameter verbatim", func(t *testing.T) {
		h := newHarness(t)
		h.seed(t, id, instance, 33101)
		rec := h.do(http.MethodDelete, "/api/tenants/"+id+"?confirm="+id, operatorTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		_, destroys := h.prov.calls()
		if len(destroys) != 1 || destroys[0] != id {
			t.Fatalf("Destroy must receive the id unchanged, got %v", destroys)
		}
	})

	t.Run("the operator screen renders the tenant", func(t *testing.T) {
		h := newHarness(t)
		h.seed(t, id, instance, 33101)
		rec := h.do(http.MethodGet, "/tenants/"+id, operatorTok, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), id) {
			t.Fatalf("the screen does not name the tenant it claims to show:\n%s", rec.Body.String())
		}
	})
}

// Two POSTs whose ids sanitise to one instance name, through the REAL
// provisioner. One is created; the other is a duplicate tenant, and a duplicate
// tenant is a 409 naming the conflict. It used to be a 500 — "could not
// provision this tenant" — because the loser of the instance-name race came
// back as a raw sqlite error, and before that as a bogus "no free port" from a
// range that was almost entirely empty.
func TestConcurrentCreatesForOneInstanceNameYieldA409(t *testing.T) {
	for round := 0; round < 20; round++ {
		root := t.TempDir()
		st, err := store.Open(root + "/manager.db")
		if err != nil {
			t.Fatal(err)
		}
		units := &fakeUnits{}
		prov := provision.New(st, units, provision.Opts{
			Root: root, PortBase: 33100, PortCount: 20,
			AppToken:     func() string { return "app-" + fmt.Sprint(round) },
			ManagerToken: func() string { return "mgr-" + fmt.Sprint(round) },
		})
		h := &harness{h: New(Deps{
			Store: st, Provisioner: prov, Poller: &fakePoller{}, Units: units,
			OperatorToken: operatorTok,
			TenantToken:   func(string) string { return mgrTok },
			BridgeBaseURL: func(store.Tenant) string { return "http://127.0.0.1:1" },
		}), st: st}

		// The API only admits ids it would not rename, so two admissible ids
		// collide on one instance name exactly when they differ in CASE — the
		// mixed-case Firestore sub-account id pasted once and retyped in lower
		// case later, which is how this was reached in the first place.
		ids := [2]string{"Ab-Cd", "ab-cd"}
		var codes [2]int
		var bodies [2]string
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range ids {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				rec := h.do(http.MethodPost, "/api/tenants", operatorTok,
					fmt.Sprintf(`{"tenantId":%q,"displayName":"Race"}`, ids[i]))
				codes[i], bodies[i] = rec.Code, rec.Body.String()
			}(i)
		}
		close(start)
		wg.Wait()
		st.Close()

		created, conflicted := 0, 0
		for i := range ids {
			switch codes[i] {
			case http.StatusCreated:
				created++
			case http.StatusConflict:
				conflicted++
				if !strings.Contains(bodies[i], "ab-cd") {
					t.Fatalf("round %d: the 409 must name the contested instance: %s", round, bodies[i])
				}
			default:
				t.Fatalf("round %d: a duplicate tenant must be 409, got %d: %s", round, codes[i], bodies[i])
			}
		}
		if created != 1 || conflicted != 1 {
			t.Fatalf("round %d: want one 201 and one 409, got %d and %d", round, created, conflicted)
		}
	}
}
