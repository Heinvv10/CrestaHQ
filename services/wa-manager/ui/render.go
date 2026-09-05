// Package ui renders the operator's numbers screen.
//
// The screen has one job: make safety VISIBLE. Roughly forty competing
// WhatsApp apps compete on convenience; none competes on the number
// surviving, which is what this product's rails are for. So every field on a
// card is a safety field, and the card is deliberately unlike the
// competitors': theirs renders one state three contradictory ways ("Standby /
// [Not Connected] / Ready to launch") alongside two vanity counters, and a
// user cannot tell what state they are in. This one renders exactly ONE status
// line, and shows the real number rather than a label.
//
// Rendering is pure: it takes a tenant row and a health report and returns
// HTML. Nothing here fetches, and — load-bearing — nothing here ever sees the
// pairing QR payload. The QR is a device-linking credential and is served as a
// PNG from a separate authenticated route, because HTML lands in browser
// history, proxies, screenshots and bug reports far more readily than an image
// does.
package ui

import (
	"embed"
	"fmt"
	"html/template"
	"io"
	"strings"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

//go:embed templates/numbers.html
var templateFS embed.FS

// statusMarker is the one element that carries a card's state. It is a
// constant so a test can assert there is exactly one of it per card: "how many
// status lines does this card have" is the specific defect being guarded
// against, and counting a hardcoded string in a test would not survive a
// rename of the class.
const statusMarker = `<p class="status"`

// Bar geometry. Ten cells is what the design doc's mock shows.
const (
	barWidth = 10
	barFull  = '▓'
	barEmpty = '░'
)

// Tone drives colour only. It is derived from the same precedence as Status so
// the two can never disagree — a green dot above a "Logged out" line is
// exactly the contradiction this screen exists to avoid.
type Tone string

const (
	ToneOK      Tone = "ok"
	ToneWarn    Tone = "warn"
	ToneBad     Tone = "bad"
	ToneUnknown Tone = "unknown"
)

// Card is one number, ready to render. Every string is already final: the
// template does no formatting, so what a test asserts on BuildCard is exactly
// what an operator reads.
type Card struct {
	TenantID string

	// Title is the number's identity: the real phone number once paired, and
	// before that the operator's label (or the opaque id, if they never gave
	// one). Paired says which, so the card can add "not paired" rather than
	// letting a label pass for a number. It is deliberately ONE field —
	// carrying both and letting the template choose is how a screen ends up
	// showing an identity in one place and a different one in another.
	Title  string
	Paired bool

	Status string
	Tone   Tone

	SentToday   string // "18 / 150", or "18 / —" when the cap is unknown
	Bar         string // empty when there is nothing truthful to draw
	LastInbound string // "6 min ago", "never", or "unknown"
	KillSwitch  string

	// ReplyOnly names the rail that keeps the number alive, and how many
	// contacts have escaped it. Reply-only has no toggle in this design — the
	// allowlist is its only override — so the line states the rail is on and
	// spends its width on the number that actually varies.
	ReplyOnly string

	// NeedsPairing offers the re-pair route inline. A disconnected number is
	// the one card an operator has to act on.
	NeedsPairing bool

	// QRLive says a pairing code EXISTS right now, and is set only on the
	// single-number page, by the caller that asked the bridge.
	//
	// NeedsPairing alone is not that fact, and the difference is the whole
	// point. whatsmeow re-enters GetQRChannel only on a fresh process start, so
	// a number that logged out — a ban, the state this screen exists for — has
	// no code until its bridge is restarted. Rendering the <img> off
	// NeedsPairing showed those operators a broken image under copy telling
	// them to scan it, with no way forward: the QR route's 409 is text, and
	// text is invisible inside an <img>. False here means the page says what
	// happened and offers the restart instead of promising a code that does
	// not exist.
	//
	// It is a BOOLEAN, never the payload. The QR is a device-linking
	// credential and nothing in this package has ever seen one; see the package
	// comment.
	QRLive bool

	Problems []string
}

// Page is the whole screen.
type Page struct {
	Cards []Card

	// Tenant is set on the single-number page, which additionally offers the
	// QR and the event history behind the number's death.
	Tenant  *Card
	Events  []EventLine
	Refresh int // seconds; 0 disables the meta refresh

	// Notice is a page-level banner for a fact about the PAGE rather than
	// about any one number — today, that the health sweep hit its deadline
	// and some cards were never checked. A safety screen that quietly omits
	// numbers, or renders unchecked ones as dead, is worse than one that
	// admits it is incomplete.
	Notice string
}

// EventLine is one row of a tenant's history — the "why did this die" record.
type EventLine struct {
	When   string
	Kind   string
	Detail string
}

// BuildCard projects a tenant row and its latest health poll into a card.
//
// r is nil when the poller could not see the bridge at all. That is NOT the
// same as a bridge reporting zeroes, and the two must never render alike: one
// is "I cannot see this number", the other is "this number is idle". Failing
// closed here means an unseen number reads as unknown, never as healthy.
func BuildCard(t store.Tenant, r *health.Report) Card {
	label := t.DisplayName
	if label == "" {
		// A tenant provisioned without a label still needs something to be
		// called. The opaque id is the only other durable name it has, and a
		// blank card is unidentifiable in exactly the moment — an incident —
		// this screen exists for.
		label = t.ID
	}
	c := Card{TenantID: t.ID, Paired: t.Phone != ""}
	if c.Paired {
		c.Title = t.Phone
	} else {
		c.Title = label
	}

	// Checked BEFORE the unreachable branch: an incomplete report has
	// Reachable false too, and it must not be read as a dead bridge.
	if r != nil && r.Incomplete {
		c.Status, c.Tone = "Not checked — the health sweep ran out of time", ToneUnknown
		c.SentToday, c.LastInbound, c.KillSwitch, c.ReplyOnly = "unknown", "unknown", "unknown", "unknown"
		return c
	}
	if r == nil || !r.Reachable {
		c.Status, c.Tone = "Unreachable — the manager cannot see this bridge", ToneBad
		c.SentToday, c.LastInbound, c.KillSwitch = "unknown", "unknown", "unknown"
		// Not "on": a bridge we cannot see tells us nothing about its rails,
		// and a safety claim about an unobserved number is worse than no claim.
		c.ReplyOnly = "unknown"
		if r != nil && r.Err != "" {
			c.Problems = []string{r.Err}
		}
		return c
	}

	c.Status, c.Tone, c.NeedsPairing = statusOf(t, r)
	c.SentToday, c.Bar = volume(r.OutboundLast24h, r.DailyCap)
	c.LastInbound = humanizeAge(r.LastInboundAgeSeconds)
	c.KillSwitch = killState(r.Killed)
	c.ReplyOnly = replyOnlyState(r.AllowlistCount)
	c.Problems = r.Problems
	return c
}

// statusOf collapses the report to ONE line, worst-first.
//
// The ordering is the whole point. Killed-and-disconnected is a logged-out
// number — banned or unlinked — and is the only state the operator must act on
// personally, so it outranks the plain disconnect it would otherwise hide
// inside.
func statusOf(t store.Tenant, r *health.Report) (string, Tone, bool) {
	switch {
	case r.Killed && !r.Connected:
		return "Logged out — this number must be paired again", ToneBad, true
	case r.Killed:
		return "Sending halted — the kill switch is tripped", ToneBad, false
	case !r.Connected && t.Phone == "":
		return "Not paired — scan the code to link this number", ToneWarn, true
	case !r.Connected:
		return "Disconnected — not sending or receiving", ToneBad, true
	case r.Degraded:
		return "Degraded — connected, but something is wrong", ToneWarn, false
	default:
		return "Connected", ToneOK, false
	}
}

// volume renders 24h outbound against the cap.
//
// A cap of zero means the bridge did not report one, not that the number may
// send nothing. Rendering "18 / 0" would read as a breached cap and would also
// divide by zero drawing the bar, so an unknown cap gets an em dash and no bar
// at all: a bar with no denominator is a picture of a number we do not have.
func volume(sent, cap int) (string, string) {
	if cap <= 0 {
		return fmt.Sprintf("%d / —", sent), ""
	}
	// Past the cap the bar saturates rather than overflowing: the status line
	// and the numerator carry the breach, and a bar longer than its track
	// would just break the layout. The clamp is deliberately the ONLY thing
	// holding the width — an earlier version drew the bar with a loop bounded
	// by barWidth, which meant deleting the clamp changed nothing and no test
	// could see it go.
	filled := sent * barWidth / cap
	if filled > barWidth {
		filled = barWidth
	}
	if filled < 0 { // a bridge reporting a negative count is broken, not empty
		filled = 0
	}
	bar := strings.Repeat(string(barFull), filled) +
		strings.Repeat(string(barEmpty), barWidth-filled)
	return fmt.Sprintf("%d / %d", sent, cap), bar
}

// humanizeAge renders how long ago the number last heard from a human.
//
// nil means nobody ever has. That is a real, distinct state — a freshly paired
// number — and rendering it as an age (0 seconds, or worse a 1970 date) would
// tell an operator watching for silence exactly the wrong thing.
func humanizeAge(sec *int) string {
	if sec == nil {
		return "never"
	}
	s := *sec
	switch {
	case s < 60: // negative too: a clock skew is not a message from the future
		return "just now"
	case s < 3600:
		return fmt.Sprintf("%d min ago", s/60)
	case s < 86400:
		return fmt.Sprintf("%d hr ago", s/3600)
	default:
		return fmt.Sprintf("%d days ago", s/86400)
	}
}

// replyOnlyState renders the reply-only rail and its only override.
//
// Reply-only is always on in this design; the allowlist is the sole way out of
// it, so the count is the part worth a line. nil means the bridge could not
// read its own allowlist — a rail gone blind — and that must NOT collapse into
// "nobody allowlisted". The two are opposite facts: one says the rail is
// intact, the other says we cannot tell. Rendering them alike would make this
// line a decoration, which on this screen is worse than omitting it.
func replyOnlyState(count *int) string {
	switch {
	case count == nil:
		return "on · allowlist unreadable"
	case *count <= 0:
		// Negative is a broken bridge, not a negative allowlist. It reads as
		// empty rather than inventing "-1 contacts allowlisted"; the degraded
		// status line carries the fact that the bridge is wrong.
		return "on · nobody allowlisted"
	case *count == 1:
		return "on · 1 contact allowlisted"
	default:
		return fmt.Sprintf("on · %d contacts allowlisted", *count)
	}
}

// killState names the two states in words that cannot be confused for each
// other. "armed" is the safe one — the rail is in place and has not fired;
// tripped means sending has already stopped.
func killState(killed bool) string {
	if killed {
		return "tripped — sending halted"
	}
	return "armed"
}

var tpl = template.Must(template.ParseFS(templateFS, "templates/numbers.html"))

// Render writes the page. html/template escapes every field, which matters
// because display names are operator-supplied and problems come off a bridge.
func Render(w io.Writer, p Page) error {
	return tpl.ExecuteTemplate(w, "numbers.html", p)
}
