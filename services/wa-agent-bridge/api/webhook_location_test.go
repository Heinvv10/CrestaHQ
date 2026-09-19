package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/config"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/wa"
)

// locationEvent is a real whatsmeow event carrying msg from sender, as the
// socket would deliver it.
func locationEvent(sender string, at time.Time, msg *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			ID: "wamid.LOC",
			MessageSource: types.MessageSource{
				Sender: types.JID{User: sender, Server: types.DefaultUserServer},
			},
			Timestamp: at,
		},
		Message: msg,
	}
}

func pinMessage(lat, lng float64) *waE2E.Message {
	return &waE2E.Message{LocationMessage: &waE2E.LocationMessage{
		DegreesLatitude:  proto.Float64(lat),
		DegreesLongitude: proto.Float64(lng),
		Name:             proto.String("Thandi's house"),
		Address:          proto.String("12 Main Rd, Lawley"),
		URL:              proto.String("https://maps.example/p"),
	}}
}

// Socket event in, signed HTTP body out: the location rides inside the body
// the HMAC covers, and the message is forwarded even though it has no text.
func TestInboundLocationReachesTheConsumerSigned(t *testing.T) {
	srv, body, sig := captureOne(t)
	connectedAt := time.Now()
	f := NewFanout(
		[]config.Consumer{{Name: "leadstack", Token: "tok", WebhookURL: srv.URL, WebhookSecret: "whsec_test"}},
		"", store.NewMemory(), func() bool { return false }, func() time.Time { return connectedAt }, 0)
	fixed := time.Unix(1_700_000_000, 0)
	f.now = func() time.Time { return fixed }

	deliverEvent(f, locationEvent("27821234567", time.Now(), pinMessage(-26.3812, 27.8123)), nil)
	f.Wait()

	var raw []byte
	select {
	case raw = <-body:
	case <-time.After(2 * time.Second):
		t.Fatal("no webhook delivery for a location message")
	}
	mac := hmac.New(sha256.New, []byte("whsec_test"))
	mac.Write([]byte(fmt.Sprintf("%d.", fixed.Unix())))
	mac.Write(raw)
	if want := fmt.Sprintf("t=%d,v1=%s", fixed.Unix(), hex.EncodeToString(mac.Sum(nil))); <-sig != want {
		t.Fatal("signature does not cover the location body")
	}

	body <- raw
	payload := awaitBody(t, body)
	loc, ok := payload["location"].(map[string]any)
	if !ok {
		t.Fatalf("payload carries no location object: %v", payload)
	}
	if loc["latitude"] != -26.3812 || loc["longitude"] != 27.8123 {
		t.Fatalf("coordinates = %v, %v", loc["latitude"], loc["longitude"])
	}
	if loc["name"] != "Thandi's house" || loc["address"] != "12 Main Rd, Lawley" || loc["url"] != "https://maps.example/p" {
		t.Fatalf("location strings = %v", loc)
	}
	if payload["text"] != "" || payload["messageId"] != "wamid.LOC" {
		t.Fatalf("message fields = %v", payload)
	}
}

// A live location is taken at its current position; its caption is the text.
func TestLiveLocationForwardsCurrentPositionAndCaption(t *testing.T) {
	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	deliverEvent(f, locationEvent("27821234567", time.Now(), &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{
		DegreesLatitude:  proto.Float64(-33.9249),
		DegreesLongitude: proto.Float64(18.4241),
		Caption:          proto.String("on my way"),
	}}), nil)
	f.Wait()

	payload := awaitBody(t, body)
	loc, ok := payload["location"].(map[string]any)
	if !ok || loc["latitude"] != -33.9249 || loc["longitude"] != 18.4241 {
		t.Fatalf("live location = %v", payload["location"])
	}
	if _, has := loc["name"]; has {
		t.Fatalf("empty strings must be omitted, got %v", loc)
	}
	if payload["text"] != "on my way" {
		t.Fatalf("text = %v, want the live-location caption", payload["text"])
	}
}

// The existing rails apply unchanged: a stranger's location is recorded and
// not forwarded, and a replayed one older than the watermark is history.
func TestLocationObeysTheOwnerFilterAndTheReplayWatermark(t *testing.T) {
	t.Run("non-owner", func(t *testing.T) {
		srv, body, _ := captureOne(t)
		st := store.NewMemory()
		f := openFanout(srv.URL, "27821234567@s.whatsapp.net", st, false)

		deliverEvent(f, locationEvent("27829999999", time.Now(), pinMessage(-26.1, 28.0)), nil)
		f.Wait()

		if len(body) != 0 {
			t.Fatalf("a non-owner location must not be forwarded, got %d deliveries", len(body))
		}
		if ok, _ := st.HasInboundFrom("27829999999@s.whatsapp.net"); !ok {
			t.Fatal("a dropped non-owner location must still be recorded")
		}
	})
	t.Run("replayed history", func(t *testing.T) {
		srv, body, _ := captureOne(t)
		st := store.NewMemory()
		watermark := time.Now().Add(-time.Hour)
		if err := st.RecordInbound("27820000000@s.whatsapp.net", watermark); err != nil {
			t.Fatal(err)
		}
		f := openFanout(srv.URL, "", st, true)

		deliverEvent(f, locationEvent("27821234567", watermark.Add(-30*time.Minute), pinMessage(-26.1, 28.0)), nil)
		f.Wait()

		if len(body) != 0 {
			t.Fatalf("a replayed location must not wake a consumer, got %d deliveries", len(body))
		}
	})
}

// Unusable coordinates are not a location. A pin with no text is then nothing
// to forward; with a caption the text still goes, without a location key. And
// the drop is logged WITHOUT the values — they are the customer's address.
func TestUnusableCoordinatesAreDroppedAndNeverLogged(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	// Nil from ParseInbound is what handleMessage turns into "nothing to deliver".
	for _, c := range [][2]float64{{91.5, 10}, {10, -180.25}, {math.NaN(), 10}, {10, math.Inf(1)}} {
		if in := wa.ParseInbound(locationEvent("27821234567", time.Now(), pinMessage(c[0], c[1])), nil); in != nil {
			t.Fatalf("coordinates %v must not make a message, got %+v", c, in)
		}
	}

	srv, body, _ := captureOne(t)
	f := openFanout(srv.URL, "", store.NewMemory(), false)

	deliverEvent(f, locationEvent("27821234567", time.Now(), &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{
		DegreesLatitude:  proto.Float64(123.456789),
		DegreesLongitude: proto.Float64(18.4),
		Caption:          proto.String("here"),
	}}), nil)
	f.Wait()
	payload := awaitBody(t, body)
	if _, has := payload["location"]; has || payload["text"] != "here" {
		t.Fatalf("caption must survive without a location key, got %v", payload)
	}

	out := logs.String()
	if !strings.Contains(out, "unusable coordinates") {
		t.Fatalf("the drop must be logged, got %q", out)
	}
	for _, leak := range []string{"91.5", "180.25", "123.456789", "NaN", "Inf"} {
		if strings.Contains(out, leak) {
			t.Fatalf("a log line carries a coordinate (%s): %q", leak, out)
		}
	}
}
