package systemd

// Fake is an in-memory Controller for tests that need to drive provisioning
// logic without a real systemd on the machine. It lives in a _test.go file
// deliberately: a type declared here compiles only into this package's test
// binary, so it can never ship inside the built manager binary. It is visible
// only to this package's own tests — Task 7's provisioner package declares
// its own fake against the same Controller interface, which is the correct
// Go pattern (each package fakes what it consumes), not a limitation to work
// around by promoting this type into a non-test file.
type Fake struct {
	Enabled  map[string]bool
	Active   map[string]bool
	Disabled map[string]bool

	EnableErr, StartErr, StopErr, DisableErr, IsActiveErr error
}

func NewFake() *Fake {
	return &Fake{
		Enabled:  map[string]bool{},
		Active:   map[string]bool{},
		Disabled: map[string]bool{},
	}
}

func (f *Fake) Enable(instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	if f.EnableErr != nil {
		return f.EnableErr
	}
	f.Enabled[instance] = true
	return nil
}

func (f *Fake) Start(instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	if f.StartErr != nil {
		return f.StartErr
	}
	f.Active[instance] = true
	return nil
}

func (f *Fake) Stop(instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	if f.StopErr != nil {
		return f.StopErr
	}
	f.Active[instance] = false
	return nil
}

// ResetFailed satisfies Controller. The fake has no failure state to clear;
// the provisioner never calls it, and the restart route's use of it is
// asserted against api's own fake.
func (f *Fake) ResetFailed(instance string) error { return Validate(instance) }

// Restart satisfies Controller as a stop followed by a start, which is what
// the real verb amounts to from a caller's point of view.
func (f *Fake) Restart(instance string) error {
	if err := f.Stop(instance); err != nil {
		return err
	}
	return f.Start(instance)
}

func (f *Fake) Disable(instance string) error {
	if err := Validate(instance); err != nil {
		return err
	}
	if f.DisableErr != nil {
		return f.DisableErr
	}
	f.Disabled[instance] = true
	f.Enabled[instance] = false
	return nil
}

func (f *Fake) IsActive(instance string) (bool, error) {
	if err := Validate(instance); err != nil {
		return false, err
	}
	if f.IsActiveErr != nil {
		return false, f.IsActiveErr
	}
	return f.Active[instance], nil
}

var _ Controller = (*Fake)(nil)
