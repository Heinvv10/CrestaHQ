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
