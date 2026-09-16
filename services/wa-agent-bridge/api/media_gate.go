package api

import (
	"log"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
)

// The reasons this gate refuses a download. They travel to the consumer as
// `mediaDropped`, alongside wa's own "too_large" / "fetch_failed" /
// "shutdown". The CRM's mediaDroppedLabel falls back to a generic label for a
// string it does not know, so naming a new one here is safe — and naming it is
// the point: "the file is missing" and "the file was refused because you sent
// it to us four times already" send an operator to completely different
// places.
const (
	mediaDroppedDuplicate = "duplicate"
	mediaDroppedBudget    = "sender_media_budget"
)

// defaultInboundMediaPerSenderPerHour is how many DISTINCT files one sender
// may have downloaded in a rolling hour.
//
// The number has to clear the worst honest case comfortably: a technician
// photographing a full fibre install, or a customer sending a burst of
// pictures of a fault, is tens of files in a sitting — never hundreds. 60 is
// one a minute sustained, which no real conversation reaches and which still
// bounds one sender to 60 x 16MiB of ingress an hour instead of an unbounded
// amount. It is a cap on ABUSE, not a product limit; if a real customer ever
// trips it, raise CAP_INBOUND_MEDIA_PER_SENDER_PER_HOUR rather than removing
// the bound.
const defaultInboundMediaPerSenderPerHour = 60

// inboundMediaBudgetWindow is the rolling window the budget is spent over.
const inboundMediaBudgetWindow = time.Hour

// mediaSeenTTL is how long one file's content key is remembered. It exceeds
// the budget window on purpose: a file must not become re-downloadable at the
// moment the sender's budget refills.
const mediaSeenTTL = 2 * time.Hour

// maxMediaSeen and maxMediaSenders bound the two maps in memory. Reaching
// either takes more traffic than the per-sender budget admits, so they are a
// backstop against unbounded growth rather than a working limit — which is
// why exceeding them is logged: it means an assumption above is wrong.
const (
	maxMediaSeen    = 4096
	maxMediaSenders = 1024
)

// mediaGate decides whether ONE attachment may be downloaded, and is the only
// volume bound on inbound media.
//
// The bound it adds is on VOLUME, not on who may send. The owner filter still
// decides that; this gate never refuses a MESSAGE, only its file.
//
// Two things it stops, neither of which anything else did:
//
//   - Amplification. WhatsApp uploads a file once and every message that cites
//     it carries the same content hash. Nothing keyed on the message id can
//     see that, so one uploaded file referenced by N messages used to cost N
//     full downloads and N ~21.3MiB POSTs. Keyed on the file, it costs one.
//   - Unbounded volume outside the replay window. The catch-up cap is gated on
//     inReplayWindow, so five minutes after a connection there was no limit at
//     all on how much media one sender could make this bridge fetch.
//
// Both maps are bounded in size and in age, and neither is bounded by
// forgetting something an attacker wants forgotten — see admit and
// pruneSeenLocked.
//
// It is in-memory and resets with the process, unlike the outbound rails,
// which persist their counts precisely because a crash-loop would otherwise
// become a send-loop. The asymmetry is deliberate: nothing a sender can do
// restarts this bridge, so a restart is not a lever they hold.
type mediaGate struct {
	mu        sync.Mutex
	seen      map[string]time.Time
	spent     map[string]senderMediaSpend
	perSender int
}

// senderMediaSpend is one sender's downloads in the window that began at
// since.
type senderMediaSpend struct {
	n     int
	since time.Time
}

// newMediaGate builds the gate. A non-positive budget takes the default:
// there is deliberately no "unlimited" setting, because unlimited is the
// amplification this type exists to stop.
func newMediaGate(perSenderPerHour int) *mediaGate {
	if perSenderPerHour <= 0 {
		perSenderPerHour = defaultInboundMediaPerSenderPerHour
	}
	return &mediaGate{
		seen:      map[string]time.Time{},
		spent:     map[string]senderMediaSpend{},
		perSender: perSenderPerHour,
	}
}

// admit reports "" when this attachment may be downloaded, or the reason it
// may not. key is the file's content identity and is empty when the sender
// supplied neither a hash nor a direct path, in which case nothing can be
// deduped and the budget is the only bound left.
//
// Check AND record happen under one lock, because deliveries run one
// goroutine each: a check that released the lock before recording would let
// two messages citing the same file both pass, which is the whole bug.
func (g *mediaGate) admit(jid, key string, now time.Time) string {
	g.mu.Lock()
	defer g.mu.Unlock()

	if key != "" {
		if at, ok := g.seen[key]; ok && now.Sub(at) < mediaSeenTTL {
			return mediaDroppedDuplicate
		}
	}

	s, known := g.spent[jid]
	if !known || now.Sub(s.since) >= inboundMediaBudgetWindow {
		// Only a sender with no live entry can GROW the table, so only that
		// case has to be bounded.
		if !known && len(g.spent) >= maxMediaSenders {
			g.dropExpiredSpentLocked(now)
		}
		if !known && len(g.spent) >= maxMediaSenders {
			// Refuse rather than evict. Evicting an existing sender REFUNDS
			// their budget, which is precisely what an attacker holding many
			// numbers would be buying — and with every window opened in the
			// same burst there is no meaningful "oldest" to pick, so eviction
			// refunds an arbitrary one. Refusing is the fail-safe direction
			// and costs a file, never a message.
			log.Printf("ALERT inbound media budget table full at %d senders within one hour — "+
				"refusing new senders' files jid=%s", len(g.spent), redact.JID(jid))
			return mediaDroppedBudget
		}
		s = senderMediaSpend{since: now}
	}
	if s.n >= g.perSender {
		return mediaDroppedBudget
	}

	// Recorded only on the path that will actually download, so a refusal
	// costs the sender nothing and a duplicate costs them no budget.
	s.n++
	g.spent[jid] = s
	if key != "" {
		g.seen[key] = now
		g.pruneSeenLocked(now)
	}
	return ""
}

func (g *mediaGate) pruneSeenLocked(now time.Time) {
	if len(g.seen) <= maxMediaSeen {
		return
	}
	for k, at := range g.seen {
		if now.Sub(at) >= mediaSeenTTL {
			delete(g.seen, k)
		}
	}
	if len(g.seen) > maxMediaSeen {
		// Every entry is still live. Forget them all rather than grow without
		// limit: dedupe is an optimisation on top of the budget, never a
		// substitute for it, and the budget is unaffected by this.
		log.Printf("WARNING inbound media dedupe table full at %d live entries — cleared, dedupe restarts",
			len(g.seen))
		g.seen = make(map[string]time.Time, maxMediaSeen)
	}
}

// dropExpiredSpentLocked forgets senders whose window has rolled over. It is
// the only way an entry leaves this map: see admit for why nothing live is
// evicted.
func (g *mediaGate) dropExpiredSpentLocked(now time.Time) {
	for jid, s := range g.spent {
		if now.Sub(s.since) >= inboundMediaBudgetWindow {
			delete(g.spent, jid)
		}
	}
}
