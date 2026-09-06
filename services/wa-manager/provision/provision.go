// Package provision turns a tenant id into a running bridge instance: a port,
// a directory, an `.env` and an enabled systemd unit — or, if any of that
// fails, back into nothing at all.
//
// The "or nothing at all" half is the point. Provisioning is retried, so a
// failure that leaked its port would eat the range one attempt at a time, and a
// failure that left a half-written instance dir would leave a WhatsApp session
// directory nobody owns.
package provision

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/systemd"
)

// Opts configures a Provisioner.
//
// AppToken, ManagerToken and WebhookSecret are functions, not strings, because
// each tenant gets its OWN set: a secret shared across tenants would let a
// compromised consumer of one number send as — or forge inbound for — every
// other.
type Opts struct {
	Root                string // parent of every instance dir
	PortBase, PortCount int
	AppToken            func() string
	ManagerToken        func() string
	// WebhookSecret mints the HMAC key the bridge signs inbound webhooks with.
	// Optional: nil leaves the app consumer unsigned, which is the state of
	// every tenant provisioned before signing existed. Whether an unsigned
	// tenant is acceptable is the receiver's decision, made against its own
	// stored secret — the provisioner does not get a vote, and must not
	// invent a secret the receiver has never seen.
	WebhookSecret func() string
	WebhookURL    func(tenantID string) string // where the bridge posts inbound; optional
	QuietTZ       string                       // defaults to Africa/Johannesburg
}

type Provisioner struct {
	st   *store.Store
	sc   systemd.Controller
	opts Opts
}

// ConflictError is a refusal the provisioner ITSELF authored: this tenant, or
// the instance name it would take, is already in use.
//
// It exists so a caller can tell an authored refusal from an incidental
// failure. Create also surfaces os.MkdirAll / os.WriteFile PathErrors and raw
// systemctl stderr, and those two kinds must not be treated alike: only an
// authored refusal is safe to show verbatim (it names tenants and instances,
// never a path), and only an authored refusal is a 409. Reporting a read-only
// disk as "already exists" sends an operator hunting a duplicate tenant that
// does not exist.
type ConflictError struct{ Msg string }

func (e *ConflictError) Error() string { return e.Msg }

func New(st *store.Store, sc systemd.Controller, opts Opts) *Provisioner {
	if opts.QuietTZ == "" {
		opts.QuietTZ = "Africa/Johannesburg"
	}
	return &Provisioner{st: st, sc: sc, opts: opts}
}

// InstanceName derives a systemd-safe instance name from an opaque tenant id.
//
// It is exported because the HTTP API refuses an unusable id BEFORE dispatching
// to the provisioner, and two copies of this coercion would be free to drift
// apart — the looser copy deciding what reaches a unit name.
//
// systemd.Validate is the authority, not this function: everything below is a
// best-effort coercion, and whatever survives it is still validated before it
// reaches a path or a unit name. The instance is interpolated into both, so a
// name that could traverse a directory is remote code execution, not a
// cosmetic problem.
func InstanceName(tenantID string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToLower(tenantID) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	// Leading dashes are stripped rather than replaced: systemd's own names
	// must start alphanumeric, and padding a hostile id with a filler
	// character would invent a name the caller never asked for.
	name := strings.TrimLeft(b.String(), "-")
	if len(name) > 63 {
		name = name[:63]
	}
	if err := systemd.Validate(name); err != nil {
		return "", fmt.Errorf("provision: tenant %q yields no usable instance name: %w", tenantID, err)
	}
	return name, nil
}

// renderEnv builds the bridge's entire configuration.
//
// Note the asymmetry in CONSUMERS: the manager provisions ITSELF as an admin
// consumer, so it can read health and lift a kill switch after a re-pair, while
// the app consumer is not admin. A stolen LeadStack token therefore cannot
// allowlist a stranger or release the brakes — the same rule phase 1 settled
// on for the bridge, that anyone may stop sending and only an operator may
// resume.
//
// The app entry carries the webhook signing secret in field 9, which forces
// the three empty fields before it: privilege, quietStartHour, quietEndHour.
// They are written empty rather than filled in with the defaults they already
// have, so this line keeps saying "the app consumer is not an admin and
// inherits the deployment quiet window" instead of pinning those values here,
// where a later change to the defaults would silently stop reaching every
// tenant provisioned after today.
//
// Only the app consumer is signed. The manager's entry has no webhook URL at
// all — it never receives inbound — so a secret there would be a key nothing
// can use.
func (p *Provisioner) renderEnv(tenantID, instance string, port int, appTok, mgrTok, hookSecret string) string {
	dir := p.instanceDir(instance)
	var hook string
	if p.opts.WebhookURL != nil {
		hook = p.opts.WebhookURL(tenantID)
	}
	return strings.Join([]string{
		fmt.Sprintf("LISTEN_ADDR=127.0.0.1:%d", port),
		"DB_PATH=" + filepath.Join(dir, "bridge.db"),
		"SESSION_DIR=" + filepath.Join(dir, "session"),
		"QUIET_TZ=" + p.opts.QuietTZ,
		fmt.Sprintf("CONSUMERS=app|%s|%s|100|500||||%s,manager|%s|||500|admin",
			appTok, hook, hookSecret, mgrTok),
		"",
	}, "\n")
}

func (p *Provisioner) instanceDir(instance string) string {
	return filepath.Join(p.opts.Root, instance)
}

// Create provisions one tenant, or leaves the system exactly as it found it.
//
// Order matters: everything that can be refused without side effects is
// checked BEFORE a port is allocated or a directory is written, so the common
// rejection costs nothing and needs no unwind.
func (p *Provisioner) Create(tenantID, displayName string) (store.Tenant, error) {
	instance, err := InstanceName(tenantID)
	if err != nil {
		return store.Tenant{}, err
	}
	appTok, mgrTok := p.opts.AppToken(), p.opts.ManagerToken()
	if appTok == "" || mgrTok == "" {
		return store.Tenant{}, errors.New("provision: both the app and manager tokens are required")
	}
	// The bridge refuses to boot on a duplicate token, so this would produce an
	// instance that can never start — after handing the app the manager's
	// admin privileges.
	if appTok == mgrTok {
		return store.Tenant{}, errors.New("provision: the app and manager tokens must differ; sharing one would give the app admin")
	}
	// A nil WebhookSecret is the pre-signing shape and stays legal. A non-nil
	// one returning "" is not: something asked for a secret and got nothing,
	// and provisioning a tenant whose inbound is silently unsigned — when the
	// operator believes it is signed — is the failure this refusal exists for.
	var hookSecret string
	if p.opts.WebhookSecret != nil {
		if hookSecret = p.opts.WebhookSecret(); hookSecret == "" {
			return store.Tenant{}, errors.New("provision: the webhook secret generator returned an empty secret; inbound would be unsigned")
		}
		// Same reasoning as the app/manager token check above, one step
		// further: a secret equal to either bearer token means the generator
		// is not random, and one leak would compromise both directions.
		if hookSecret == appTok || hookSecret == mgrTok {
			return store.Tenant{}, errors.New("provision: the webhook secret matches a bearer token; the generator is not producing independent secrets")
		}
	}
	if err := p.checkInstanceFree(tenantID, instance); err != nil {
		return store.Tenant{}, err
	}

	// AllocatePort's INSERT is the mutual-exclusion point for THIS tenant id,
	// not checkInstanceFree. That pre-check is a pure TOCTOU: two concurrent
	// Creates for one id both find no row and both pass it. Only the INSERT
	// discriminates, because id is the PRIMARY KEY — exactly one of them sees
	// inserted=true.
	port, inserted, err := p.st.AllocatePort(tenantID, p.opts.PortBase, p.opts.PortCount)
	if err != nil {
		return store.Tenant{}, err
	}
	if !inserted {
		// Someone else owns this row: a concurrent Create for the same id, or
		// a tenant that appeared between checkInstanceFree and here. Refuse,
		// and return BEFORE the unwind closure exists — unwinding here would
		// tear down the winner's instance directory, stop its unit and delete
		// its row while its own Create reported success. That is the defect
		// this branch exists for, and it is why nothing below may run.
		return store.Tenant{}, &ConflictError{
			Msg: fmt.Sprintf("tenant %q is already being provisioned or already exists; "+
				"destroy it before re-provisioning", tenantID),
		}
	}

	// From here on the tenant owns a port AND owns its row, so every exit
	// unwinds — every path below touches only what this call created.
	enabled, dirCreated := false, false
	fail := func(err error) (store.Tenant, error) {
		return store.Tenant{}, errors.Join(err, p.unwind(tenantID, instance, enabled, dirCreated))
	}

	// SetTenantIdentity is the mutual-exclusion point for two DIFFERENT ids
	// that sanitise to one instance name. Both clear checkInstanceFree, and
	// both insert their own row — AllocatePort seeds `instance` with a
	// "pending:" placeholder that can collide with nothing, so no UNIQUE
	// collision exists yet — and only this UPDATE decides which of them owns
	// the name. It excludes nothing for two callers sharing one id: for a
	// single id this UPDATE succeeds every time, which is why the INSERT
	// above, not this line, is what serialises them. Everything after this is
	// exclusive on the NAME; the directory flag is only set below for that
	// reason.
	//
	// Losing that race is an AUTHORED refusal, not an incident: the tenant is a
	// duplicate of one that already exists. Relabelling it as a ConflictError
	// is what makes the API answer 409 instead of a 500 blaming the disk. The
	// unwind still runs, and at this point enabled and dirCreated are both
	// false, so it releases only THIS call's own row — it never touches the
	// winner's directory or unit.
	if err := p.st.SetTenantIdentity(tenantID, displayName, instance); err != nil {
		if errors.Is(err, store.ErrInstanceTaken) {
			return fail(&ConflictError{
				Msg: fmt.Sprintf("tenant %q would take instance %q, already held by another tenant",
					tenantID, instance),
			})
		}
		return fail(err)
	}
	dir := p.instanceDir(instance)
	if err := os.MkdirAll(filepath.Join(dir, "session"), 0o700); err != nil {
		return fail(err)
	}
	dirCreated = true
	// 0600: this file holds two bearer tokens, either of which can send as this
	// WhatsApp number.
	//
	// The Chmod is not redundant. WriteFile's mode applies only when it
	// CREATES the file; a leftover .env from a hand-rolled or half-removed
	// install keeps whatever permissions it had, so the tokens land inside a
	// world-readable file and nothing says so.
	env := p.renderEnv(tenantID, instance, port, appTok, mgrTok, hookSecret)
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte(env), 0o600); err != nil {
		return fail(err)
	}
	if err := os.Chmod(envPath, 0o600); err != nil {
		return fail(err)
	}
	if err := p.sc.Enable(instance); err != nil {
		return fail(err)
	}
	enabled = true
	if err := p.sc.Start(instance); err != nil {
		return fail(err)
	}
	if err := p.st.SetTenantState(tenantID, store.StateProvisioned, ""); err != nil {
		return fail(err)
	}
	// The event log is a support record, not part of the transaction: losing a
	// line must not undo a working instance.
	_ = p.st.AppendEvent(tenantID, "provisioned", fmt.Sprintf("instance=%s port=%d", instance, port))

	return p.st.GetTenant(tenantID)
}

// checkInstanceFree refuses a tenant whose instance name is already taken.
//
// Two different opaque ids can sanitise to the same name ("a.b" and "a-b"), and
// two tenants sharing an instance would share one WhatsApp session and one
// database. The UNIQUE constraint on tenants.instance catches this too; the
// point of checking first is that a caller gets a sentence naming the conflict
// instead of a constraint violation, and that nothing is allocated to unwind.
func (p *Provisioner) checkInstanceFree(tenantID, instance string) error {
	if _, err := p.st.GetTenant(tenantID); err == nil {
		return &ConflictError{Msg: fmt.Sprintf("tenant %q already exists; destroy it before re-provisioning", tenantID)}
	}
	existing, err := p.st.ListTenants()
	if err != nil {
		return err
	}
	for _, t := range existing {
		if t.Instance == instance {
			return &ConflictError{Msg: fmt.Sprintf("tenant %q would take instance %q, already held by tenant %q",
				tenantID, instance, t.ID)}
		}
	}
	return nil
}

// unwind returns the tenant to not existing. The port is released LAST, for the
// same reason Destroy releases it last.
// unwind must never touch a path this call did not make. A caller that lost the
// race for an instance name shares that name with the WINNER, so removing the
// directory would delete a live bridge's .env and session/ — leaving a running
// process with no WhatsApp credentials and a Create that returned success, so
// nothing anywhere reports a problem. dirCreated is only true once this call
// has passed SetTenantIdentity and therefore owns the name.
func (p *Provisioner) unwind(tenantID, instance string, enabled, dirCreated bool) error {
	var errs []error
	if enabled {
		if err := p.sc.Stop(instance); err != nil {
			errs = append(errs, err)
		}
		if err := p.sc.Disable(instance); err != nil {
			errs = append(errs, err)
		}
	}
	if dirCreated {
		if err := os.RemoveAll(p.instanceDir(instance)); err != nil {
			errs = append(errs, err)
		}
	}
	if err := p.st.ReleasePort(tenantID); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Destroy removes a tenant entirely: the unit, its files, its session and its
// port. A cancelled customer's WhatsApp session must not survive on disk.
//
// The order is Stop → Disable → RemoveAll → ReleasePort, and each step aborts
// on failure rather than pressing on. Releasing a port whose process is still
// bound hands it to the next tenant, whose bridge then cannot bind; removing
// the files under a unit still enabled leaves something that restarts at boot
// pointing at a directory that no longer exists. Leaving the tenant visibly
// half-destroyed is recoverable — an operator can retry. Half-destroying it
// invisibly is not.
func (p *Provisioner) Destroy(tenantID string) error {
	ten, err := p.st.GetTenant(tenantID)
	if err != nil {
		return err
	}
	// A row whose instance is not a usable instance name never got past
	// AllocatePort's INSERT, which seeds the column with
	// store.PendingInstance(id); the unit is enabled and the directory created
	// only after SetTenantIdentity rewrites it. So there is nothing in systemd
	// to stop and nothing on disk to remove — and every verb below would refuse
	// the name, leaving the row untouchable and its port held forever. Dropping
	// the row IS the teardown for that state.
	//
	// The "pending:" seed is what makes that reliable. Seeding the raw tenant id
	// meant an id that happened to be a valid instance name PASSED Validate, so
	// this function fell through and tried to Stop, Disable and RemoveAll a unit
	// and a directory that were never created. A "pending:" seed always fails
	// Validate, so a row still carrying it is simply dropped.
	//
	// Reachable only if the manager dies abruptly inside the few statements
	// between those two writes. A graceful shutdown or an ordinary failure
	// unwinds and deletes the row already.
	if err := systemd.Validate(ten.Instance); err != nil {
		return p.st.ReleasePort(tenantID)
	}
	if err := p.sc.Stop(ten.Instance); err != nil {
		return fmt.Errorf("provision: destroy %q: %w", tenantID, err)
	}
	if err := p.sc.Disable(ten.Instance); err != nil {
		return fmt.Errorf("provision: destroy %q: %w", tenantID, err)
	}
	if err := os.RemoveAll(p.instanceDir(ten.Instance)); err != nil {
		return fmt.Errorf("provision: destroy %q: %w", tenantID, err)
	}
	if err := p.st.ReleasePort(tenantID); err != nil {
		return fmt.Errorf("provision: destroy %q: %w", tenantID, err)
	}
	return nil
}
