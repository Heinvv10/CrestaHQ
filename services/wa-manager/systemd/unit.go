// Package systemd drives templated user units. It is an interface so the
// provisioner can be tested without a systemd on the machine — and so a test
// can never accidentally start a real unit.
package systemd

import (
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var errExit = errors.New("systemctl exited non-zero")

type Controller interface {
	Enable(instance string) error
	// ResetFailed clears a unit's failure and start-rate-limit state.
	ResetFailed(instance string) error
	// Restart bounces a unit in one verb.
	Restart(instance string) error
	Start(instance string) error
	Stop(instance string) error
	Disable(instance string) error
	IsActive(instance string) (bool, error)
}

// safeInstance is deliberately strict. The instance name is interpolated into a
// unit name and into filesystem paths the provisioner writes, so anything that
// could traverse a directory or address a different unit is refused. This is
// the manager's sharpest edge: it runs privileged-ish work on behalf of a
// caller, and the instance name is the caller's input.
var safeInstance = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

func Validate(instance string) error {
	if !safeInstance.MatchString(instance) {
		return fmt.Errorf("systemd: unsafe instance name %q", instance)
	}
	return nil
}

type systemctl struct {
	unit string
	run  func(args ...string) (string, error)
}

func New(unit string) Controller {
	return &systemctl{unit: unit, run: func(args ...string) (string, error) {
		out, err := exec.Command("systemctl", args...).CombinedOutput()
		if err != nil {
			return string(out), errExit
		}
		return string(out), nil
	}}
}

func (c *systemctl) verb(v, instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	out, err := c.run("--user", v, c.unit+"@"+instance)
	if err != nil {
		return fmt.Errorf("systemd: %s %s@%s: %s", v, c.unit, instance, strings.TrimSpace(out))
	}
	return nil
}

func (c *systemctl) Enable(i string) error  { return c.verb("enable", i) }
func (c *systemctl) Start(i string) error   { return c.verb("start", i) }
func (c *systemctl) Stop(i string) error    { return c.verb("stop", i) }
func (c *systemctl) Disable(i string) error { return c.verb("disable", i) }

// Restart bounces a unit in ONE verb.
//
// Stop-then-Start has a gap this does not: when the start half fails, the
// number is left stopped — down until a human notices, rather than briefly
// deaf — and it is left stopped too if this process is signalled between the
// two calls. systemd never brings back a unit that was stopped deliberately,
// whatever Restart= says, so nothing recovers that on its own.
//
// A failed restart leaves the unit `failed` instead, which Restart=always does
// retry — but only within StartLimitBurst. A binary that genuinely cannot start
// still ends up down after five attempts; the difference is that it got there
// having tried, and sits visibly `failed` rather than quietly `inactive`.
func (c *systemctl) Restart(i string) error { return c.verb("restart", i) }

// ResetFailed clears `failed` and, with it, the start rate limit.
//
// StartLimitBurst=5 in ten minutes counts every start — and under
// Restart=always a clean exit is one of them. Once the limit trips, systemd
// refuses a manual start until the window rolls or this runs, which would
// make the operator screen's "Restart this bridge" answer "the unit was
// stopped but did not start again" for up to ten minutes in exactly the
// situation that button exists for. It is what an operator types by hand at
// that point.
func (c *systemctl) ResetFailed(i string) error { return c.verb("reset-failed", i) }

// IsActive treats a non-zero exit as "not active" rather than an error:
// `systemctl is-active` exits 3 for an inactive unit, which is an answer, not a
// failure.
func (c *systemctl) IsActive(instance string) (bool, error) {
	if err := Validate(instance); err != nil {
		return false, err
	}
	out, _ := c.run("--user", "is-active", c.unit+"@"+instance)
	return strings.TrimSpace(out) == "active", nil
}
