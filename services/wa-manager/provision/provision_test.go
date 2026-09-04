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
		AppToken:     next("app-token"),
		ManagerToken: next("mgr-token"),
		WebhookURL:   func(id string) string { return "http://127.0.0.1:8787/wa/" + id },
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
