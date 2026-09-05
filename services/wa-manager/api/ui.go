package api

import (
	"bytes"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/health"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-manager/ui"
	qrcode "github.com/skip2/go-qrcode"
)

// refreshSeconds drives the page's <meta refresh>. Long enough that forty
// tenants are not polled into a self-inflicted load problem, short enough that
// an operator watching a re-pair does not think the screen has frozen.
const refreshSeconds = 15

// qrPixels is the rendered QR edge length. Large enough to scan off a laptop
// screen at arm's length; a WhatsApp pairing payload needs the density.
const qrPixels = 512

// maxEventRows bounds the history on a tenant page — enough to see what
// preceded a death, not so much that the page becomes a log viewer.
const maxEventRows = 25

// authedUI admits the operator token from a BROWSER.
//
// A browser cannot attach a bearer header to a plain navigation or to an
// <img src>, and the QR must be an image (see below). So the UI additionally
// accepts HTTP Basic, where the password is the same operator token and the
// username is ignored — one credential, two carriers, no session store, no
// login form, no JavaScript. The 401 carries WWW-Authenticate so the browser
// prompts once and then attaches the credential to the page AND to the image
// it pulls.
//
// The API routes deliberately do NOT accept Basic: a JSON client that gets a
// browser auth prompt has been handed a worse error than a 401 body.
func (s *server) authedUI(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			if _, pass, basicOK := r.BasicAuth(); basicOK {
				token, ok = pass, true
			}
		}
		if !ok || !s.tokenOK(token) {
			// Never log the presented token: a rejected one is often a
			// mistyped real one.
			log.Printf("ui auth rejected path=%s", r.URL.Path)
			w.Header().Set("WWW-Authenticate", `Basic realm="wa-manager", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// noStore marks a response the browser must not keep. Every UI response is one:
// the pages carry customers' phone numbers and the PNG IS a device-linking
// credential, so a cached copy on a shared machine outlives the pairing window
// it was issued for.
func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (s *server) handleUIIndex(w http.ResponseWriter, r *http.Request) {
	tenants, err := s.deps.Store.ListTenants()
	if err != nil {
		log.Printf("ui list failed err=%v", err)
		http.Error(w, "could not list numbers", http.StatusInternalServerError)
		return
	}
	var reports map[string]health.Report
	if s.deps.Poller != nil {
		reports = s.deps.Poller.Snapshot(r.Context(), tenants)
	}

	page := ui.Page{Refresh: refreshSeconds, Cards: make([]ui.Card, 0, len(tenants))}
	for _, t := range tenants {
		page.Cards = append(page.Cards, ui.BuildCard(t, reportFor(reports, t.ID)))
	}
	renderUI(w, page)
}

func (s *server) handleUITenant(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	t, err := s.deps.Store.GetTenant(id)
	if err != nil {
		http.Error(w, "no such number", http.StatusNotFound)
		return
	}

	var reports map[string]health.Report
	if s.deps.Poller != nil {
		reports = s.deps.Poller.Snapshot(r.Context(), []store.Tenant{t})
	}
	card := ui.BuildCard(t, reportFor(reports, t.ID))
	// Whether a code EXISTS is decided here, on the server, and only on this
	// page. The card says the number needs pairing; only the bridge knows
	// whether one is in flight, and a logged-out bridge has none until it is
	// restarted. Deciding it here is what keeps the page from promising a code
	// it cannot produce — and it is deliberately NOT done on the list page,
	// where one bridge call per tenant would be the fan-out the poller's
	// concurrency bound exists to prevent.
	if card.NeedsPairing {
		card.QRLive = s.hasLivePairingCode(r, id, t)
	}

	page := ui.Page{Refresh: refreshSeconds, Tenant: &card}
	// History is context, not the operation: a failure to read it must not
	// cost the operator the status they came for.
	if events, err := s.deps.Store.ListEvents(id, maxEventRows); err != nil {
		log.Printf("ui events failed tenant=%s err=%v", id, err)
	} else {
		for _, e := range events {
			page.Events = append(page.Events, ui.EventLine{
				When:   e.At.UTC().Format(time.RFC3339),
				Kind:   e.Kind,
				Detail: e.Detail,
			})
		}
	}
	renderUI(w, page)
}

// handleQRPNG renders one tenant's live pairing code as an image.
//
// The payload is NEVER placed in the HTML. It is a write-grade credential —
// scanning it links a device to the number with every permission the number
// has — and HTML lands in browser history, proxies, view-source, copy-paste
// and bug reports far more readily than an image does. Rendering server-side
// also means no QR library ships to the browser and no payload crosses in a
// JSON body the page could stash.
//
// It fails closed in both directions: a bridge that is already connected has
// no code to give, and returning a stale one would be worse than an error.
func (s *server) handleQRPNG(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	t, err := s.deps.Store.GetTenant(id)
	if err != nil {
		http.Error(w, "no such number", http.StatusNotFound)
		return
	}

	body, failure := s.bridgePair(r, id, t)
	if failure != nil {
		// The failure body can name a bridge status; it never carries the
		// payload. Render it as text, not as a broken image.
		noStore(w)
		http.Error(w, "could not read the pairing code from this bridge", failure.status)
		return
	}
	if !body.Pairing || body.Code == "" {
		noStore(w)
		http.Error(w, "this number is not waiting to be paired", http.StatusConflict)
		return
	}

	png, err := qrcode.Encode(body.Code, qrcode.Medium, qrPixels)
	if err != nil {
		// The encode error can quote what it was given, and what it was given
		// is the credential.
		log.Printf("qr encode failed tenant=%s", id)
		noStore(w)
		http.Error(w, "could not render the pairing code", http.StatusInternalServerError)
		return
	}
	noStore(w)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := w.Write(png); err != nil {
		log.Printf("qr write failed tenant=%s", id)
	}
}

// hasLivePairingCode reports whether this tenant's bridge is offering a pairing
// code right now.
//
// It reuses the same relay handleQRPNG uses, so the page and the image cannot
// disagree about whether there is a code — the failure this fixes was exactly
// that disagreement, rendered as a broken <img>.
//
// It returns only a BOOLEAN. The payload is a device-linking credential and
// must never reach the HTML; see handleQRPNG. An unreachable or refusing bridge
// is false — the page then offers the restart, which is the right move for a
// bridge in that state anyway.
func (s *server) hasLivePairingCode(r *http.Request, id string, t store.Tenant) bool {
	body, failure := s.bridgePair(r, id, t)
	if failure != nil {
		return false
	}
	return body.Pairing && body.Code != ""
}

// handleUIRestart is the re-pair control on the single-number page.
//
// It exists rather than pointing the form at POST /api/tenants/{id}/restart
// because that route admits ONLY a bearer token, and a browser form cannot
// attach one. Same operation, same helper, the carrier the browser has.
//
// POST, never GET: a GET would let a link prefetcher or a crawler bounce a
// customer's live number. sameOrigin is the other half of that — a form on
// someone else's page would otherwise ride the browser's stored Basic
// credential to the same effect.
func (s *server) handleUIRestart(w http.ResponseWriter, r *http.Request) {
	id, ok := tenantIDFromPath(w, r)
	if !ok {
		return
	}
	if !sameOrigin(r) {
		noStore(w)
		http.Error(w, "cross-site restart refused", http.StatusForbidden)
		return
	}
	t, err := s.deps.Store.GetTenant(id)
	if err != nil {
		http.Error(w, "no such number", http.StatusNotFound)
		return
	}
	if problem := s.restartUnit(id, t); problem != "" {
		noStore(w)
		http.Error(w, problem, http.StatusInternalServerError)
		return
	}
	// See-other, so the browser follows with a GET and a reload cannot bounce
	// the number a second time.
	noStore(w)
	http.Redirect(w, r, "/tenants/"+id, http.StatusSeeOther)
}

// sameOrigin refuses a state-changing browser request that came from another
// site.
//
// Browsers send Origin on every POST, so an absent one is a non-browser caller
// holding the operator token — curl, the runbook — and is admitted. A PRESENT
// one that is not this host is a cross-site form, and the only thing it could
// be doing is spending someone's live WhatsApp number.
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

func reportFor(reports map[string]health.Report, id string) *health.Report {
	if got, ok := reports[id]; ok {
		return &got
	}
	return nil
}

// renderUI buffers the page before writing it. A template that fails halfway
// would otherwise emit a 200 carrying half a screen — a card whose status line
// rendered but whose kill state did not is precisely the misleading view this
// screen exists to prevent.
func renderUI(w http.ResponseWriter, page ui.Page) {
	var buf bytes.Buffer
	if err := ui.Render(&buf, page); err != nil {
		log.Printf("ui render failed err=%v", err)
		http.Error(w, "could not render the page", http.StatusInternalServerError)
		return
	}
	noStore(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if _, err := w.Write(buf.Bytes()); err != nil {
		log.Printf("ui write failed err=%v", err)
	}
}
