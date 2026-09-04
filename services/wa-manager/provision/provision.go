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
// AppToken and ManagerToken are functions, not strings, because each tenant
// gets its OWN pair: a token shared across tenants would let a compromised
// consumer of one number send as every other.
type Opts struct {
	Root                string // parent of every instance dir
	PortBase, PortCount int
	AppToken            func() string
	ManagerToken        func() string
	WebhookURL          func(tenantID string) string // where the bridge posts inbound; optional
	QuietTZ             string                       // defaults to Africa/Johannesburg
}

type Provisioner struct {
	st   *store.Store
	sc   systemd.Controller
	opts Opts
}

func New(st *store.Store, sc systemd.Controller, opts Opts) *Provisioner {
	if opts.QuietTZ == "" {
		opts.QuietTZ = "Africa/Johannesburg"
	}
	return &Provisioner{st: st, sc: sc, opts: opts}
}

// instanceName derives a systemd-safe instance name from an opaque tenant id.
//
// systemd.Validate is the authority, not this function: everything below is a
// best-effort coercion, and whatever survives it is still validated before it
// reaches a path or a unit name. The instance is interpolated into both, so a
// name that could traverse a directory is remote code execution, not a
// cosmetic problem.
func instanceName(tenantID string) (string, error) {
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
func (p *Provisioner) renderEnv(tenantID, instance string, port int, appTok, mgrTok string) string {
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
		fmt.Sprintf("CONSUMERS=app|%s|%s|100|500,manager|%s|||500|admin", appTok, hook, mgrTok),
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
	instance, err := instanceName(tenantID)
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
	if err := p.checkInstanceFree(tenantID, instance); err != nil {
		return store.Tenant{}, err
	}

	port, err := p.st.AllocatePort(tenantID, p.opts.PortBase, p.opts.PortCount)
	if err != nil {
		return store.Tenant{}, err
	}

	// From here on the tenant owns a port, so every exit unwinds.
	enabled, dirCreated := false, false
	fail := func(err error) (store.Tenant, error) {
		return store.Tenant{}, errors.Join(err, p.unwind(tenantID, instance, enabled, dirCreated))
	}

	// SetTenantIdentity is the mutual-exclusion point, not checkInstanceFree.
	// Two ids that sanitise to one name can both clear that pre-check
	// concurrently — AllocatePort seeds `instance` with the OPAQUE id, so no
	// UNIQUE collision exists yet — and only this UPDATE decides which of them
	// owns the name. Everything after it is exclusive; everything before it is
	// not, which is why the directory flag is only set below.
	if err := p.st.SetTenantIdentity(tenantID, displayName, instance); err != nil {
		return fail(err)
	}
	dir := p.instanceDir(instance)
	if err := os.MkdirAll(filepath.Join(dir, "session"), 0o700); err != nil {
		return fail(err)
	}
	dirCreated = true
	// 0600: this file holds two bearer tokens, either of which can send as this
	// WhatsApp number.
	env := p.renderEnv(tenantID, instance, port, appTok, mgrTok)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
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
		return fmt.Errorf("provision: tenant %q already exists; destroy it before re-provisioning", tenantID)
	}
	existing, err := p.st.ListTenants()
	if err != nil {
		return err
	}
	for _, t := range existing {
		if t.Instance == instance {
			return fmt.Errorf("provision: tenant %q would take instance %q, already held by tenant %q",
				tenantID, instance, t.ID)
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
