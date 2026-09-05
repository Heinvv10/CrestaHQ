package ui

import (
	"bytes"
	"html"
	"strings"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

// secrets that must never reach a rendered page. The QR payload is the one
// that matters most: it is a device-linking credential, and HTML lands in
// browser history, proxies, screenshots and bug reports far more readily than
// an image does. The tokens are here because the same page is rendered by a
// process holding all of them.
var secrets = []string{
	"2@QR-PAYLOAD-LINKS-A-DEVICE",
	"op-token-hermes",
	"app-token-that-must-never-appear",
	"manager-token-for-tenant",
}

func ptr(n int) *int { return &n }

func pairedTenant() store.Tenant {
	return store.Tenant{
		ID: "blitz", DisplayName: "Blitz Fibre", Instance: "blitz", Port: 9101,
		State: store.StateRunning, Phone: "+27 82 123 4567",
	}
}

func healthyReport() health.Report {
	return health.Report{
		Reachable: true, Connected: true,
		OutboundLast24h: 18, DailyCap: 150,
		LastInboundAgeSeconds: ptr(360),
	}
}

func renderPage(t *testing.T, p Page) string {
	t.Helper()
	var sb strings.Builder
	if err := Render(&sb, p); err != nil {
		t.Fatalf("Render: %v", err)
	}
	out := sb.String()
	for _, s := range secrets {
		if strings.Contains(out, s) {
			t.Fatalf("rendered page leaked a secret %q", s)
		}
	}
	return out
}

func renderOne(t *testing.T, tn store.Tenant, r *health.Report) string {
	t.Helper()
	return renderPage(t, Page{Cards: []Card{BuildCard(tn, r)}})
}

// mustContain asserts on what an operator READS. html/template escapes "+" to
// "&#43;", so a raw substring check would miss a phone number that renders
// perfectly in a browser; unescaping first keeps the assertions about the
// screen rather than about the escaper.
func mustContain(t *testing.T, out string, want ...string) {
	t.Helper()
	out = html.UnescapeString(out)
	for _, w := range want {
		if !strings.Contains(out, w) {
			t.Errorf("rendered page missing %q\n---\n%s", w, out)
		}
	}
}

func mustNotContain(t *testing.T, out string, unwanted ...string) {
	t.Helper()
	out = html.UnescapeString(out)
	for _, w := range unwanted {
		if strings.Contains(out, w) {
			t.Errorf("rendered page unexpectedly contains %q\n---\n%s", w, out)
		}
	}
}

// A healthy card shows the real number, every safety field, and ONE status.
func TestConnectedCardShowsNumberAndSafetyFields(t *testing.T) {
	r := healthyReport()
	out := renderOne(t, pairedTenant(), &r)

	mustContain(t, out,
		"+27 82 123 4567", // the real number, not the label
		"Connected",
		"18 / 150", // volume against the cap
		"6 min ago",
		"armed",
	)
	// The label is not the identity of a paired number.
	mustNotContain(t, out, "not paired")

	if n := strings.Count(out, statusMarker); n != 1 {
		t.Errorf("want exactly one status line, got %d", n)
	}
}

// Before pairing there is no number to show, so the label plus an explicit
// "not paired" is the honest identity.
func TestUnpairedCardShowsLabelAndNotPaired(t *testing.T) {
	tn := pairedTenant()
	tn.Phone, tn.State = "", store.StateProvisioned
	r := health.Report{Reachable: true, Connected: false, DailyCap: 150}
	out := renderOne(t, tn, &r)

	mustContain(t, out, "Blitz Fibre", "not paired")
	if n := strings.Count(out, statusMarker); n != 1 {
		t.Errorf("want exactly one status line, got %d", n)
	}
}

// A tenant provisioned without a label must still be identifiable — a blank
// card is useless in the incident this screen exists for.
func TestUnlabelledTenantFallsBackToItsID(t *testing.T) {
	tn := pairedTenant()
	tn.Phone, tn.DisplayName = "", ""
	r := health.Report{Reachable: true}

	// Asserted on the card, not on the page: the tenant id also appears in
	// the card's own link, so a substring check on the HTML would pass even
	// with an empty title.
	if got := BuildCard(tn, &r).Title; got != tn.ID {
		t.Errorf("title = %q, want the tenant id %q", got, tn.ID)
	}
	mustContain(t, renderOne(t, tn, &r), "not paired")
}

// nil lastInboundAgeSeconds means nobody has ever messaged this number. A
// fresh bridge is not one that last heard from someone at the epoch.
func TestNilLastInboundRendersNever(t *testing.T) {
	r := healthyReport()
	r.LastInboundAgeSeconds = nil
	out := renderOne(t, pairedTenant(), &r)

	mustContain(t, out, "never")
	mustNotContain(t, out, "0 sec ago", "just now", "56 years")
}

// Killed and disconnected is a number that has been logged out — the one
// state the operator must act on, so it is the state the single line reports.
func TestLoggedOutCardSaysSoAndShowsKillTripped(t *testing.T) {
	r := healthyReport()
	r.Connected, r.Killed = false, true
	out := renderOne(t, pairedTenant(), &r)

	mustContain(t, out, "Logged out", "tripped")
	mustNotContain(t, out, ">armed<", "Connected<")
	if n := strings.Count(out, statusMarker); n != 1 {
		t.Errorf("want exactly one status line, got %d", n)
	}
}

// A bridge the manager cannot see must not be rendered as a healthy one, and
// must not invent counters it never observed.
func TestUnreachableCardReportsUnknownRatherThanZero(t *testing.T) {
	out := renderOne(t, pairedTenant(), nil)

	mustContain(t, out, "Unreachable", "unknown")
	mustNotContain(t, out, "0 / 0", "armed", "just now")
}

// A report the poller marked unreachable is NOT the same as a nil one — the
// poller produces it whenever a bridge failed at the transport level — and it
// must render as unknown rather than as an idle, healthy number.
func TestUnreachableReportRendersUnknownNotIdle(t *testing.T) {
	r := health.Report{Reachable: false, Err: "unreachable: request failed"}
	out := renderOne(t, pairedTenant(), &r)

	mustContain(t, out, "Unreachable", "unknown")
	mustNotContain(t, out, "armed", "just now", "Connected<")
}

// A bridge that answered but reported no cap must not divide by zero or claim
// a cap of nothing.
func TestUnknownCapRendersDashNotZero(t *testing.T) {
	r := healthyReport()
	r.DailyCap = 0
	out := renderOne(t, pairedTenant(), &r)

	mustContain(t, out, "18 / —")
	mustNotContain(t, out, "18 / 0")
}

// The kill switch is the last rail between a mistake and a dead number; its
// two states must never read alike.
func TestKillStatesAreDistinct(t *testing.T) {
	armed := healthyReport()
	live := healthyReport()
	live.Killed = true

	if BuildCard(pairedTenant(), &armed).KillSwitch == BuildCard(pairedTenant(), &live).KillSwitch {
		t.Fatal("armed and tripped kill switches render identically")
	}
}

// A display name is operator-supplied text and reaches the page as data.
func TestDisplayNameIsEscaped(t *testing.T) {
	tn := pairedTenant()
	tn.Phone = ""
	tn.DisplayName = `<script>alert(1)</script>`
	r := health.Report{Reachable: true}
	out := renderOne(t, tn, &r)

	// Deliberately a RAW check: the point is that the markup on the wire is
	// inert, which unescaping the page first would hide.
	if strings.Contains(out, "<script>alert(1)</script>") {
		t.Error("display name reached the page as markup, not as data")
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Errorf("display name was not escaped\n---\n%s", out)
	}
}

// The volume bar is a safety signal, so it must saturate rather than overflow
// when a number has already run past its cap.
func TestVolumeBarClampsOverCap(t *testing.T) {
	r := healthyReport()
	r.OutboundLast24h, r.DailyCap = 900, 150
	c := BuildCard(pairedTenant(), &r)

	if got := len([]rune(c.Bar)); got != barWidth {
		t.Fatalf("bar width = %d, want %d", got, barWidth)
	}
	if strings.ContainsRune(c.Bar, barEmpty) {
		t.Errorf("a number past its cap must render a full bar, got %q", c.Bar)
	}

	// And a negative count from a broken bridge must not render a negative bar.
	// -5/150 truncates to 0; only a magnitude past the cap actually goes negative.
	r.OutboundLast24h = -900
	if got := len([]rune(BuildCard(pairedTenant(), &r).Bar)); got != barWidth {
		t.Fatalf("bar width on a negative count = %d, want %d", got, barWidth)
	}
}

// pairingCard is a number that needs a code: unpaired and disconnected.
func pairingCard(t *testing.T) Card {
	t.Helper()
	tn := pairedTenant()
	tn.Phone, tn.State = "", store.StateProvisioned
	r := health.Report{Reachable: true, Connected: false}
	card := BuildCard(tn, &r)
	if !card.NeedsPairing {
		t.Fatal("an unpaired, disconnected number must offer pairing")
	}
	return card
}

// A number with a code in flight offers it inline — as an IMAGE from a separate
// route. The payload itself never reaches this package, which is the structural
// reason it cannot reach the page.
func TestPairingPageLinksTheQRImageRatherThanEmbeddingAPayload(t *testing.T) {
	card := pairingCard(t)
	card.QRLive = true
	out := renderPage(t, Page{Tenant: &card})

	mustContain(t, out, `src="/tenants/blitz/qr.png"`)
	if strings.Contains(out, "<script") {
		t.Error("the page must render without shipping script to the browser")
	}
}

// The card this screen exists for. A banned or logged-out number needs a code
// and has none: whatsmeow re-enters GetQRChannel only on a fresh process start,
// so its bridge will not issue one until it restarts. Rendering the <img>
// anyway showed the operator instructions to scan a broken image — the QR
// route answers 409 with text, and text is invisible inside an <img> — with
// nothing to do next.
//
// So: no image, and the restart offered as a real POST. A GET would let a link
// prefetcher or a crawler bounce a customer's live number.
func TestPairingPageWithNoLiveCodeOffersARestartInsteadOfABrokenImage(t *testing.T) {
	card := pairingCard(t)
	card.QRLive = false
	out := renderPage(t, Page{Tenant: &card})

	if strings.Contains(out, "<img") {
		t.Errorf("a number with no live code must not be shown an image; it renders broken\n---\n%s", out)
	}
	if strings.Contains(out, "Scan this in WhatsApp") {
		t.Error("the page tells the operator to scan a code that does not exist")
	}
	mustContain(t, out,
		`method="post"`,
		`action="/tenants/blitz/restart"`,
		"Restart this bridge",
	)
}

// A connected number gets neither block. The QR link on a live number would be
// an invitation to link a stranger's device to it.
func TestConnectedPageOffersNeitherAQRNorARestart(t *testing.T) {
	r := healthyReport()
	card := BuildCard(pairedTenant(), &r)
	if card.NeedsPairing {
		t.Fatal("a connected number does not need pairing")
	}
	out := renderPage(t, Page{Tenant: &card})

	if strings.Contains(out, "<img") || strings.Contains(out, "qr.png") {
		t.Error("a connected number was offered a pairing code")
	}
	if strings.Contains(out, "/restart") {
		t.Error("a connected number was offered a restart it does not need")
	}
}

func intPtr(n int) *int { return &n }

// Reply-only is the rail that keeps a number alive, and this screen's whole
// job is showing real safety state. The line names the rail AND how many
// contacts have escaped it, because an allowlisted JID has nothing but the
// global daily cap left in front of it.
func TestReplyOnlyLineReportsTheAllowlistCount(t *testing.T) {
	r := &health.Report{Reachable: true, Connected: true, AllowlistCount: intPtr(2)}
	got := BuildCard(store.Tenant{ID: "t1", Phone: "+27821112222"}, r).ReplyOnly
	if got != "on · 2 contacts allowlisted" {
		t.Fatalf("want the count beside the rail, got %q", got)
	}
}

// One is not "1 contacts". An operator reads this line during an incident.
func TestReplyOnlyLineIsSingularForOne(t *testing.T) {
	r := &health.Report{Reachable: true, Connected: true, AllowlistCount: intPtr(1)}
	got := BuildCard(store.Tenant{ID: "t1", Phone: "+27821112222"}, r).ReplyOnly
	if got != "on · 1 contact allowlisted" {
		t.Fatalf("want a singular contact, got %q", got)
	}
}

// The healthy, boring case: nobody has escaped. It must read as a fact, not as
// an absence.
func TestReplyOnlyLineReportsAnEmptyAllowlist(t *testing.T) {
	r := &health.Report{Reachable: true, Connected: true, AllowlistCount: intPtr(0)}
	got := BuildCard(store.Tenant{ID: "t1", Phone: "+27821112222"}, r).ReplyOnly
	if got != "on · nobody allowlisted" {
		t.Fatalf("want an explicit empty allowlist, got %q", got)
	}
}

// The defect this whole line exists to avoid: a decorative safety claim. A
// bridge that could not read its own allowlist sends no count, and the card
// must say so rather than reassuring the operator with a zero.
func TestReplyOnlyLineDoesNotClaimAnUnknownAllowlistIsEmpty(t *testing.T) {
	r := &health.Report{Reachable: true, Connected: true, AllowlistCount: nil}
	got := BuildCard(store.Tenant{ID: "t1", Phone: "+27821112222"}, r).ReplyOnly
	if got == "on · nobody allowlisted" || got == "on · 0 contacts allowlisted" {
		t.Fatalf("an unreadable allowlist rendered as an empty one: %q", got)
	}
	if got != "on · allowlist unreadable" {
		t.Fatalf("want an explicit unreadable allowlist, got %q", got)
	}
}

// An unreachable bridge tells us nothing about its rails. Claiming reply-only
// is "on" for a number we cannot see is precisely the decorative safety claim
// this card refuses to make.
func TestUnreachableCardMakesNoReplyOnlyClaim(t *testing.T) {
	got := BuildCard(store.Tenant{ID: "t1"}, nil).ReplyOnly
	if got != "unknown" {
		t.Fatalf("an unseen bridge must not claim its rails; got %q", got)
	}
}

// The line has to reach the operator, not just the struct. A field built and
// never rendered is the failure mode a previous task in this project shipped.
func TestReplyOnlyLineIsRendered(t *testing.T) {
	r := &health.Report{Reachable: true, Connected: true, AllowlistCount: intPtr(2)}
	var buf bytes.Buffer
	page := Page{Cards: []Card{BuildCard(store.Tenant{ID: "t1", Phone: "+27821112222"}, r)}}
	if err := Render(&buf, page); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "on · 2 contacts allowlisted") {
		t.Fatalf("the reply-only line never reached the page:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), "Reply-only") {
		t.Fatalf("the reply-only line has no label:\n%s", buf.String())
	}
}
