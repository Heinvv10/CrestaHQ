package provision

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// fakeCtl is declared HERE rather than imported from the systemd package: a
// fake in systemd/fake_test.go is visible only to that package's own tests, and
// promoting it into a shipped file so this package could import it would put a
// test double in the binary — the exact defect phase 1 had to correct.
type fakeCtl struct {
	mu                                  sync.Mutex
	enabled, started, stopped, disabled map[string]bool
	FailStart, FailStop                 bool
}

func newFakeCtl() *fakeCtl {
	return &fakeCtl{
		enabled: map[string]bool{}, started: map[string]bool{},
		stopped: map[string]bool{}, disabled: map[string]bool{},
	}
}

func (f *fakeCtl) mark(m map[string]bool, i string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m[i] = true
	return nil
}
func (f *fakeCtl) Enable(i string) error { return f.mark(f.enabled, i) }
func (f *fakeCtl) Stop(i string) error {
	f.mu.Lock()
	fail := f.FailStop
	f.mu.Unlock()
	if fail {
		return errors.New("fake: stop refused")
	}
	return f.mark(f.stopped, i)
}
func (f *fakeCtl) Disable(i string) error { return f.mark(f.disabled, i) }

// ResetFailed satisfies systemd.Controller; provisioning never calls it.
func (f *fakeCtl) ResetFailed(string) error { return nil }

// Restart satisfies systemd.Controller; provisioning never calls it.
func (f *fakeCtl) Restart(i string) error { return f.mark(f.started, i) }
func (f *fakeCtl) Start(i string) error {
	f.mu.Lock()
	fail := f.FailStart
	f.mu.Unlock()
	if fail {
		return errors.New("fake: start refused")
	}
	return f.mark(f.started, i)
}
func (f *fakeCtl) IsActive(i string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.started[i] && !f.stopped[i], nil
}
func (f *fakeCtl) did(m map[string]bool, i string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return m[i]
}
func (f *fakeCtl) Enabled(i string) bool  { return f.did(f.enabled, i) }
func (f *fakeCtl) Started(i string) bool  { return f.did(f.started, i) }
func (f *fakeCtl) Stopped(i string) bool  { return f.did(f.stopped, i) }
func (f *fakeCtl) Disabled(i string) bool { return f.did(f.disabled, i) }

func newTestProvisioner(t *testing.T) (*Provisioner, *store.Store, *fakeCtl, string) {
	t.Helper()
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sc := newFakeCtl()
	// Each call returns a DIFFERENT token, because that is what the real
	// generator does. A fixture returning a constant makes "these tokens were
	// rotated" unobservable, and any test asserting they were not rotated
	// passes whether the code rotates them or not.
	var mu sync.Mutex
	n := 0
	next := func(prefix string) func() string {
		return func() string {
			mu.Lock()
			defer mu.Unlock()
			n++
			return fmt.Sprintf("%s-%d", prefix, n)
		}
	}
	p := New(st, sc, Opts{
		Root: root, PortBase: 33100, PortCount: 20,
		AppToken:      next("app-token"),
		ManagerToken:  next("mgr-token"),
		WebhookSecret: next("hook-secret"),
		WebhookURL:    func(id string) string { return "http://127.0.0.1:8787/wa/" + id },
	})
	return p, st, sc, root
}

func TestCreateWritesAnInstanceAndStartsIt(t *testing.T) {
	p, _, sc, root := newTestProvisioner(t)

	ten, err := p.Create("t1", "Blitz Fibre")
	if err != nil {
		t.Fatal(err)
	}

	envPath := filepath.Join(root, ten.Instance, ".env")
	raw, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatalf("no .env written: %v", err)
	}
	env := string(raw)
	for _, want := range []string{
		"LISTEN_ADDR=127.0.0.1:33100",
		"DB_PATH=" + filepath.Join(root, ten.Instance, "bridge.db"),
		"SESSION_DIR=" + filepath.Join(root, ten.Instance, "session"),
		"app-token", "mgr-token",
	} {
		if !strings.Contains(env, want) {
			t.Fatalf(".env missing %q:\n%s", want, env)
		}
	}
	if !sc.Enabled(ten.Instance) || !sc.Started(ten.Instance) {
		t.Fatal("instance was written but never enabled and started")
	}
}

// A tenant that fails midway must leave nothing behind — no half-written
// instance dir, and above all no consumed port. Provisioning is retried, and a
// leaked port would exhaust the range one failure at a time.
func TestFailedCreateLeavesNoTenantAndFreesThePort(t *testing.T) {
	p, st, sc, root := newTestProvisioner(t)
	sc.FailStart = true

	if _, err := p.Create("t1", "Blitz"); err == nil {
		t.Fatal("a failed start must fail the whole Create")
	}
	if _, err := st.GetTenant("t1"); err == nil {
		t.Fatal("a failed Create left a tenant row behind")
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "t1") {
			t.Fatalf("a failed Create left an instance dir: %s", e.Name())
		}
	}

	// The port must be reusable immediately.
	sc.FailStart = false
	if _, err := p.Create("t1", "Blitz"); err != nil {
		t.Fatalf("retry after a failed Create must succeed: %v", err)
	}
}

func TestDestroyRemovesTheSessionData(t *testing.T) {
	p, st, sc, root := newTestProvisioner(t)
	ten, _ := p.Create("t1", "Blitz")
	dir := filepath.Join(root, ten.Instance)

	if err := p.Destroy("t1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("a cancelled tenant's WhatsApp session must not survive on disk")
	}
	if !sc.Stopped(ten.Instance) || !sc.Disabled(ten.Instance) {
		t.Fatal("Destroy left the unit enabled")
	}
	if _, err := st.GetTenant("t1"); err == nil {
		t.Fatal("Destroy left the tenant row")
	}
}

// The manager provisions ITSELF as admin so it can read health and lift a kill
// switch after a re-pair. The app consumer is deliberately NOT admin: a
// compromised LeadStack token must not be able to allowlist a stranger or
// release the brakes. Anyone may stop sending; only an operator may resume.
func TestAppConsumerIsNotAdminButTheManagerIs(t *testing.T) {
	p, _, _, root := newTestProvisioner(t)
	ten, err := p.Create("t1", "Blitz")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, ten.Instance, ".env"))
	if err != nil {
		t.Fatal(err)
	}

	var line string
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(l, "CONSUMERS=") {
			line = strings.TrimPrefix(l, "CONSUMERS=")
		}
	}
	if line == "" {
		t.Fatalf("no CONSUMERS line:\n%s", raw)
	}

	var sawApp, sawManager bool
	for _, entry := range strings.Split(line, ",") {
		parts := strings.Split(entry, "|")
		admin := len(parts) >= 6 && parts[5] == "admin"
		switch parts[0] {
		case "app":
			sawApp = true
			if admin {
				t.Fatalf("the app consumer is admin: a stolen LeadStack token could allowlist a stranger and lift the kill switch\n%s", entry)
			}
		case "manager":
			sawManager = true
			if !admin {
				t.Fatalf("the manager consumer is not admin: it could not lift a kill switch after a re-pair\n%s", entry)
			}
		default:
			t.Fatalf("unexpected consumer %q", parts[0])
		}
	}
	if !sawApp || !sawManager {
		t.Fatalf("CONSUMERS must provision both app and manager: %s", line)
	}
}

// The webhook secret is read by FIELD POSITION on the far side, by a different
// Go module that this one cannot import, so the two can only agree by
// convention. This test pins the convention: the app entry must be exactly the
// nine fields the bridge's parseConsumer counts, with the three between the
// budget and the secret left EMPTY.
//
// Filling any of them would be worse than a wrong secret, because it would be
// silent: "admin" in field 6 hands the app the privileges the previous test
// exists to deny, and a stray digit in field 7 or 8 is a quiet-hours window
// nobody wrote down. An off-by-one here reads as a missing secret in the best
// case and as a granted privilege in the worst.
func TestTheAppConsumerCarriesTheWebhookSecretInTheFieldTheBridgeReads(t *testing.T) {
	p, _, _, root := newTestProvisioner(t)
	ten, err := p.Create("t1", "Blitz")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, ten.Instance, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	var line string
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(l, "CONSUMERS=") {
			line = strings.TrimPrefix(l, "CONSUMERS=")
		}
	}
	if line == "" {
		t.Fatalf("no CONSUMERS line:\n%s", raw)
	}

	var sawApp bool
	for _, entry := range strings.Split(line, ",") {
		parts := strings.Split(entry, "|")
		switch parts[0] {
		case "app":
			sawApp = true
			if len(parts) != 9 {
				t.Fatalf("app entry has %d fields, want exactly 9 (name|token|hook|perHour|perDay|admin|quietStart|quietEnd|webhookSecret): %s",
					len(parts), entry)
			}
			for i, name := range map[int]string{5: "admin", 6: "quietStartHour", 7: "quietEndHour"} {
				if parts[i] != "" {
					t.Fatalf("app entry field %d (%s) is %q, want empty; a value here is a privilege or a quiet window nobody asked for: %s",
						i, name, parts[i], entry)
				}
			}
			if parts[8] == "" {
				t.Fatal("the app consumer has no webhook secret: inbound would arrive unsigned")
			}
			if parts[8] == parts[1] {
				t.Fatal("the webhook secret is the app's own bearer token; one leak compromises both directions")
			}
		case "manager":
			// The manager has no webhook URL, so a secret there would be a key
			// nothing can ever use — and one more copy of a secret on disk.
			if len(parts) >= 9 && parts[8] != "" {
				t.Fatalf("the manager consumer carries a webhook secret it can never use: %s", entry)
			}
		}
	}
	if !sawApp {
		t.Fatalf("no app consumer in %s", line)
	}
}

// A generator that hands back one of the bearer tokens is not random, and the
// consequence is worse than either secret leaking alone: the webhook signing
// key and the send credential become the same string, so one disclosure
// forges inbound AND sends outbound.
//
// This exists because the guard shipped without it. Five mutations were run
// against this file when the guard was written and none of them deleted the
// guard itself — the empty-secret branch beside it was covered, which made the
// gap look covered too.
func TestAWebhookSecretEqualToABearerTokenIsRefused(t *testing.T) {
	for _, tc := range []struct{ name, collidesWith string }{
		{"collides with the app token", "app"},
		{"collides with the manager token", "manager"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _, _, _ := newTestProvisioner(t)
			// Pin the tokens so the secret generator can return one of them
			// verbatim. The fixture's default generators return a fresh value
			// per call, which can never collide — which is exactly why the
			// default fixture could not have caught this.
			p.opts.AppToken = func() string { return "tok-app" }
			p.opts.ManagerToken = func() string { return "tok-manager" }
			collision := "tok-" + tc.collidesWith
			p.opts.WebhookSecret = func() string { return collision }

			if _, err := p.Create("t1", "Blitz"); err == nil {
				t.Fatalf("Create accepted a webhook secret identical to the %s bearer token; "+
					"one disclosure would both forge inbound and send outbound", tc.collidesWith)
			}
		})
	}
}

// A nil WebhookSecret is the pre-signing shape and must keep working; a
// generator that returns nothing must NOT, because the operator asked for a
// signed tenant and would get an unsigned one without being told.
func TestAnEmptyWebhookSecretIsRefusedButNoGeneratorIsFine(t *testing.T) {
	for _, tc := range []struct {
		name    string
		gen     func() string
		wantErr bool
	}{
		{"no generator", nil, false},
		{"empty secret", func() string { return "" }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, _, _, _ := newTestProvisioner(t)
			p.opts.WebhookSecret = tc.gen
			_, err := p.Create("t1", "Blitz")
			if tc.wantErr && err == nil {
				t.Fatal("Create accepted an empty webhook secret; the tenant would take unsigned inbound while the operator believed it was signed")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("Create refused a tenant with no signing configured at all: %v", err)
			}
		})
	}
}

// .env holds two bearer tokens. Any other user on the box reading it can send
// as this WhatsApp number.
func TestEnvIsNotReadableByOtherUsers(t *testing.T) {
	p, _, _, root := newTestProvisioner(t)
	ten, err := p.Create("t1", "Blitz")
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(root, ten.Instance, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf(".env holds bearer tokens but its mode is %v, not 0600", fi.Mode().Perm())
	}
}

// The instance name is caller-derived and is interpolated into a unit name AND
// into every path the manager writes. A name that escapes the root is remote
// code execution, not a validation nicety — so it is refused BEFORE anything
// touches the filesystem or consumes a port.
func TestHostileTenantIDNeverEscapesTheRoot(t *testing.T) {
	p, st, _, root := newTestProvisioner(t)

	ten, err := p.Create("../../etc/Cron.D/EVIL", "hostile")
	if err != nil {
		// Refusing outright is fine. Nothing may have been created.
		if _, gerr := st.GetTenant("../../etc/Cron.D/EVIL"); gerr == nil {
			t.Fatal("a refused Create left a tenant row behind")
		}
		return
	}
	// Accepted: then the name must be safe and must stay inside the root.
	if strings.ContainsAny(ten.Instance, "/.") || strings.ToLower(ten.Instance) != ten.Instance {
		t.Fatalf("instance %q was not sanitized", ten.Instance)
	}
	dir := filepath.Join(root, ten.Instance)
	if !strings.HasPrefix(filepath.Clean(dir), filepath.Clean(root)+string(os.PathSeparator)) {
		t.Fatalf("instance dir %q escaped the root %q", dir, root)
	}
	if _, err := os.Stat(filepath.Join(dir, ".env")); err != nil {
		t.Fatalf("accepted tenant has no .env inside the root: %v", err)
	}
}

// Two tenant ids can sanitize to the same instance name ("a.b" and "a-b").
// Sharing one instance dir means sharing one WhatsApp session between two
// customers, so the second must be refused and must leave nothing behind.
func TestCollidingInstanceNamesAreRefusedNotShared(t *testing.T) {
	p, st, _, root := newTestProvisioner(t)

	first, err := p.Create("a.b", "First")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Create("a-b", "Second"); err == nil {
		t.Fatalf("two tenants were given the same instance %q — they would share one WhatsApp session", first.Instance)
	}
	if _, err := st.GetTenant("a-b"); err == nil {
		t.Fatal("the refused second tenant left a row (and a consumed port) behind")
	}
	// The first tenant's instance must be untouched by the failed second.
	if _, err := os.Stat(filepath.Join(root, first.Instance, ".env")); err != nil {
		t.Fatalf("the failed second Create damaged the first tenant: %v", err)
	}
}

// The bridge refuses to boot when two consumers share a token, so a provisioner
// that emitted the same token twice would write an instance that can never
// start — and would have handed the app the manager's admin token.
func TestIdenticalTokensAreRefused(t *testing.T) {
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	p := New(st, newFakeCtl(), Opts{
		Root: root, PortBase: 33100, PortCount: 20,
		AppToken:     func() string { return "same" },
		ManagerToken: func() string { return "same" },
	})
	if _, err := p.Create("t1", "Blitz"); err == nil {
		t.Fatal("the app and manager must never share a token: that hands the app admin")
	}
	if _, err := st.GetTenant("t1"); err == nil {
		t.Fatal("a refused Create left a tenant row behind")
	}
}

// Re-provisioning a tenant that is already live would rewrite its .env with a
// FRESH pair of tokens while the bridge keeps running on the old ones — the app
// would be locked out of a number that looks healthy. AllocatePort is
// deliberately idempotent for a known tenant, so nothing below it catches this.
func TestReprovisioningALiveTenantIsRefused(t *testing.T) {
	p, st, _, root := newTestProvisioner(t)
	first, err := p.Create("t1", "Blitz")
	if err != nil {
		t.Fatal(err)
	}
	envPath := filepath.Join(root, first.Instance, ".env")
	before, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := p.Create("t1", "Blitz again"); err == nil {
		t.Fatal("re-provisioning a live tenant must be refused, not silently re-tokened")
	}
	after, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatalf("the refused Create destroyed a live tenant's .env: %v", err)
	}
	if string(before) != string(after) {
		t.Fatalf("a refused Create rewrote a live tenant's tokens:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if _, err := st.GetTenant("t1"); err != nil {
		t.Fatalf("a refused Create destroyed the live tenant row: %v", err)
	}
}

// Two ids that sanitise to one instance name can both clear checkInstanceFree
// concurrently: AllocatePort seeds `instance` with the OPAQUE id, so no UNIQUE
// collision exists yet. The loser only discovers it at SetTenantIdentity — by
// which point the winner may already own the directory of that name.
//
// The loser must not clean up the winner's instance. Deleting a live bridge's
// .env and session/ leaves a running process whose WhatsApp credentials are
// gone, and its Create returned success, so nothing anywhere reports a problem.
func TestALosingCreateDoesNotDeleteTheWinnersInstance(t *testing.T) {
	for round := 0; round < 40; round++ {
		p, _, _, root := newTestProvisioner(t)

		var wg sync.WaitGroup
		start := make(chan struct{})
		ids := [2]string{"a.b", "a-b"}
		var got [2]store.Tenant
		var errs [2]error

		for i := range ids {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				got[i], errs[i] = p.Create(ids[i], "concurrent")
			}(i)
		}
		close(start)
		wg.Wait()

		for i := range ids {
			if errs[i] != nil {
				continue
			}
			env := filepath.Join(root, got[i].Instance, ".env")
			if _, err := os.Stat(env); err != nil {
				t.Fatalf("round %d: winner %q survived Create but its .env was destroyed by the loser's unwind: %v",
					round, ids[i], err)
			}
		}
	}
}

// Destroy is Stop -> Disable -> RemoveAll -> ReleasePort, and the port going
// LAST is the load-bearing part: a port freed while its process still holds it
// is handed to the next tenant, whose bridge then cannot bind. Asserting only
// the end state cannot see the order, so this asserts what a FAILED stop
// leaves behind — the port still allocated, and the session still on disk.
func TestDestroyKeepsThePortWhenTheUnitWillNotStop(t *testing.T) {
	p, st, sc, root := newTestProvisioner(t)
	ten, err := p.Create("t1", "Blitz")
	if err != nil {
		t.Fatal(err)
	}
	sc.FailStop = true

	if err := p.Destroy("t1"); err == nil {
		t.Fatal("Destroy must fail when the unit will not stop")
	}
	if _, err := st.GetTenant("t1"); err != nil {
		t.Fatalf("the port was freed while the bridge was still running: the next tenant would fail to bind: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ten.Instance, ".env")); err != nil {
		t.Fatalf("a running bridge's .env was deleted under it: %v", err)
	}
}

// Two concurrent Creates for the SAME tenant id must leave exactly one live
// instance, and the loser must not touch it.
//
// Unserialised, both callers cleared checkInstanceFree (neither had a row yet),
// both were handed the same port by AllocatePort's deliberate same-tenant
// idempotency, and both went on to rewrite `.env` with their OWN fresh token
// pair — so the running bridge held one pair while the file held another, and
// the manager and the app were both permanently locked out of that number. If
// the loser then failed anywhere after MkdirAll, its unwind removed the
// winner's instance directory and deleted the winner's row while the winner's
// Create had already returned success.
//
// A ready barrier and many rounds, because a single round does not reliably
// contend — three phase-1 tests passed under the exact bugs they targeted for
// that reason. Worth running at GOMAXPROCS=1 as well.
func TestConcurrentCreatesForOneTenantLeaveOneLiveInstance(t *testing.T) {
	const rounds, workers = 30, 8
	for round := 0; round < rounds; round++ {
		root := t.TempDir()
		st, err := store.Open(filepath.Join(root, "mgr.db"))
		if err != nil {
			t.Fatal(err)
		}
		sc := newFakeCtl()

		// One provisioner per caller, sharing the store, the root and the
		// controller — which is what two manager processes on one box are, and
		// what makes each caller's token pair identifiable in the .env.
		provs := make([]*Provisioner, workers)
		for i := range provs {
			app, mgr := fmt.Sprintf("app-tok-%d", i), fmt.Sprintf("mgr-tok-%d", i)
			provs[i] = New(st, sc, Opts{
				Root: root, PortBase: 33100, PortCount: 20,
				AppToken:     func() string { return app },
				ManagerToken: func() string { return mgr },
			})
		}

		var ready, done sync.WaitGroup
		start := make(chan struct{})
		ready.Add(workers)
		done.Add(workers)
		got := make([]store.Tenant, workers)
		errs := make([]error, workers)
		for i := 0; i < workers; i++ {
			go func(i int) {
				defer done.Done()
				ready.Done()
				<-start
				got[i], errs[i] = provs[i].Create("acme", "Acme")
			}(i)
		}
		ready.Wait()
		close(start)
		done.Wait()

		winner := -1
		for i, err := range errs {
			if err == nil {
				if winner >= 0 {
					t.Fatalf("round %d: callers %d and %d were both told they provisioned %q",
						round, winner, i, "acme")
				}
				winner = i
				continue
			}
			// A refusal a caller can act on, not a leaked PathError or a
			// systemctl stderr: a duplicate is a 409, and only an authored
			// refusal is safe to show verbatim.
			var conflict *ConflictError
			if !errors.As(err, &conflict) {
				t.Fatalf("round %d: caller %d lost the race with a non-conflict error: %v", round, i, err)
			}
		}
		if winner < 0 {
			t.Fatalf("round %d: every concurrent Create failed; one must succeed", round)
		}

		inst := got[winner].Instance
		dir := filepath.Join(root, inst)
		env, err := os.ReadFile(filepath.Join(dir, ".env"))
		if err != nil {
			t.Fatalf("round %d: the winner's .env is gone — a loser unwound it: %v", round, err)
		}
		// The tokens in the file must be the winner's own. A loser that
		// rewrote them leaves the running bridge on one pair and the file on
		// another, and nothing reports a problem.
		if !strings.Contains(string(env), fmt.Sprintf("app-tok-%d", winner)) ||
			!strings.Contains(string(env), fmt.Sprintf("mgr-tok-%d", winner)) {
			t.Fatalf("round %d: .env does not hold winner %d's tokens:\n%s", round, winner, env)
		}
		if info, err := os.Stat(filepath.Join(dir, "session")); err != nil || !info.IsDir() {
			t.Fatalf("round %d: the winner's session dir is gone: %v", round, err)
		}
		row, err := st.GetTenant("acme")
		if err != nil {
			t.Fatalf("round %d: the winner's tenant row was deleted by a loser: %v", round, err)
		}
		if row.Port != got[winner].Port || row.Instance != inst {
			t.Fatalf("round %d: the surviving row is not the winner's: %+v vs %+v", round, row, got[winner])
		}
		// The port stays allocated: a loser's ReleasePort deletes the row.
		if _, _, err := st.AllocatePort("acme", 33100, 20); err != nil {
			t.Fatalf("round %d: the winner's port was released: %v", round, err)
		}
		if !sc.Started(inst) {
			t.Fatalf("round %d: the winner's unit was never started", round)
		}
		if sc.Stopped(inst) || sc.Disabled(inst) {
			t.Fatalf("round %d: a loser stopped or disabled the winner's live unit", round)
		}
		st.Close()
	}
}

// WriteFile's mode applies only when it CREATES the file. A leftover .env from
// a hand-rolled or half-removed install keeps whatever permissions it had, so
// two bearer tokens — either of which can send as this WhatsApp number — land
// inside a world-readable file, and nothing anywhere says so.
func TestEnvPermissionsAreTightenedOnAnExistingFile(t *testing.T) {
	p, _, _, root := newTestProvisioner(t)
	dir := filepath.Join(root, "t1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Written through the umask, so assert the starting state rather than
	// assuming it.
	if err := os.Chmod(envPath, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := p.Create("t1", "Blitz"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf(".env mode = %o, want 600: it holds two tokens that can send as this number", got)
	}
}
