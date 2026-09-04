package rails

import "testing"

func TestRefuseCarriesCodeAndReason(t *testing.T) {
	d := Refuse(RefusedReplyOnly, "no inbound history")
	if d.Allow {
		t.Fatal("Refuse must not allow")
	}
	if d.RefusedBy != RefusedReplyOnly {
		t.Fatalf("want %q, got %q", RefusedReplyOnly, d.RefusedBy)
	}
	if d.Reason != "no inbound history" {
		t.Fatalf("reason lost: %q", d.Reason)
	}
}

func TestAllowHasNoRefusalCode(t *testing.T) {
	d := Allow()
	if !d.Allow {
		t.Fatal("Allow must allow")
	}
	if d.RefusedBy != "" {
		t.Fatalf("allowed decision carried a refusal code: %q", d.RefusedBy)
	}
}

func TestDuplicateIsDistinguishableFromRefusal(t *testing.T) {
	// A duplicate is distinguishable because DuplicateOf is set.
	dup := Duplicate("msg-123")
	if !(!dup.Allow && dup.DuplicateOf == "msg-123" && dup.RefusedBy == "") {
		t.Fatalf("Duplicate failed: Allow=%v, DuplicateOf=%q, RefusedBy=%q",
			dup.Allow, dup.DuplicateOf, dup.RefusedBy)
	}
	// A refusal has Allow=false but DuplicateOf is empty.
	ref := Refuse(RefusedPerContactCap, "cap exceeded")
	if !(!ref.Allow && ref.DuplicateOf == "" && ref.RefusedBy != "") {
		t.Fatalf("Refusal failed: Allow=%v, DuplicateOf=%q, RefusedBy=%q",
			ref.Allow, ref.DuplicateOf, ref.RefusedBy)
	}
}
