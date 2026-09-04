package api

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// Fanout records every inbound message and forwards it to each registered
// consumer's webhook.
//
// Recording happens unconditionally; forwarding does not. During the replay
// window after a reconnect, whatsmeow re-delivers recent history — recording
// it keeps reply-only accurate, but waking a consumer would have it answer a
// day's worth of old messages. That is a real incident from the sibling
// bridge, not a hypothetical.
type Fanout struct {
	consumers      []config.Consumer
	store          rails.Store
	inReplayWindow func() bool
	client         *http.Client
	wg             sync.WaitGroup
}

// NewFanout wires a Fanout. inReplayWindow is required — it decides whether
// an inbound message wakes a consumer or is recorded silently, and getting
// that wrong either resurrects a day-old conversation (nil treated as
// "never replaying") or blinds every consumer permanently (nil treated as
// "always replaying"). Neither failure mode is acceptable to default into
// silently, so a nil func panics here instead: this is caught at process
// startup, by whoever wires *wa.Client.InReplayWindow into this
// constructor, not at 2am against a live inbound.
func NewFanout(consumers []config.Consumer, st rails.Store, inReplayWindow func() bool) *Fanout {
	if inReplayWindow == nil {
		panic("api: NewFanout requires a non-nil inReplayWindow func")
	}
	return &Fanout{
		consumers:      consumers,
		store:          st,
		inReplayWindow: inReplayWindow,
		client:         &http.Client{Timeout: 10 * time.Second},
	}
}

// Deliver records one inbound message and, outside the replay window, POSTs
// it to every consumer that registered a webhook.
func (f *Fanout) Deliver(jid, text string, at time.Time) {
	if err := f.store.RecordInbound(jid, at); err != nil {
		log.Printf("WARNING inbound not recorded jid=%s err=%v", redact.JID(jid), err)
	}

	if f.inReplayWindow() {
		log.Printf("inbound during replay window jid=%s len=%s — recorded, not forwarded",
			redact.JID(jid), redact.Body(text))
		return
	}

	payload, err := json.Marshal(map[string]any{
		"from": jid,
		"text": text,
		"at":   at.UTC().Format(time.RFC3339),
	})
	if err != nil {
		log.Printf("WARNING inbound payload marshal failed jid=%s err=%v", redact.JID(jid), err)
		return
	}

	for _, c := range f.consumers {
		if c.WebhookURL == "" {
			continue
		}
		f.wg.Add(1)
		go func(c config.Consumer) {
			defer f.wg.Done()
			f.post(c, payload)
		}(c)
	}
}

// post delivers one payload to one consumer's webhook. Failures are logged,
// never returned — a dead consumer webhook must not block or fail delivery
// to the others, and the caller (Deliver) has nothing to retry against since
// the inbound has already been recorded.
func (f *Fanout) post(c config.Consumer, payload []byte) {
	req, err := http.NewRequest(http.MethodPost, c.WebhookURL, bytes.NewReader(payload))
	if err != nil {
		log.Printf("WARNING webhook request build failed consumer=%s err=%v", c.Name, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := f.client.Do(req)
	if err != nil {
		log.Printf("WARNING webhook delivery failed consumer=%s err=%v", c.Name, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("WARNING webhook consumer=%s status=%d", c.Name, resp.StatusCode)
	}
}

// Wait blocks until in-flight deliveries finish. Used by tests and by
// shutdown, so an outstanding delivery isn't abandoned mid-flight.
func (f *Fanout) Wait() { f.wg.Wait() }
