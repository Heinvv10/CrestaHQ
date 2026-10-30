package wa

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/internal/redact"
	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

// ReplayWindow is how long after connecting the bridge records inbound without
// letting anything act on it. The sibling bridge's runbook observes that
// history replay finishes within about five minutes of a re-pair; this makes
// that observation a rule rather than advice to wait.
const ReplayWindow = 5 * time.Minute

// ErrNotConnected is returned by Send when the socket is down or the number
// has been logged out. Fail closed: nothing is queued for later delivery,
// because a queue that drains after a re-pair delivers stale messages to real
// people.
var ErrNotConnected = errors.New("wa: not connected")

// ErrLoggedOut is returned by Send once the number has been unlinked or
// flagged. It is distinct from ErrNotConnected because it is not transient:
// no amount of waiting fixes it, a human must re-pair.
var ErrLoggedOut = errors.New("wa: logged out, human re-pair required")

// Client is the real WhatsApp transport, backed by whatsmeow.
//
// It satisfies Transport. Everything above it — the queue, the rails, the API
// — is written against that interface and never sees this type, so the only
// behaviour that has to be right here is the socket lifecycle.
type Client struct {
	mu          sync.Mutex
	wac         *whatsmeow.Client
	connectedAt time.Time
	loggedOut   bool

	// uploader overrides where attachments are uploaded. Nil in production,
	// where it falls back to wac. Tests set it to reach the upload-FAILURE
	// path, which is the one that must return before anything touches the
	// socket — see mediaUploader.
	uploader mediaUploader

	// downloader overrides where inbound attachments are fetched from. Nil in
	// production, where it falls back to wac. Tests set it to reach the
	// download-FAILURE path, to bound what a hostile sender can stream into
	// this process, and to prove a refused message downloads nothing at all —
	// see MediaDownloader.
	downloader MediaDownloader

	onInbound   func(jid, text, msgID string, at time.Time, media *InboundAttachment, loc *InboundLocation)
	onLoggedOut func()

	// pairCode is the live QR payload while a pairing is in flight. It is a
	// CREDENTIAL — anyone who scans it links a device to this number — so it is
	// never logged, is dropped the moment pairing succeeds, and is not served
	// once it expires (a stale QR scans into nothing and looks like our bug).
	pairCode   string
	pairExpiry time.Time
}

var _ Transport = (*Client)(nil)

// NewClient opens (or creates) the session store under sessionDir and builds a
// client against it. Session state is persisted so a restart re-uses the
// existing pairing instead of demanding a QR scan, which matters because every
// re-pair restarts the history replay this file spends its time defending
// against.
func NewClient(
	sessionDir string,
	onInbound func(jid, text, msgID string, at time.Time, media *InboundAttachment, loc *InboundLocation),
	onLoggedOut func(),
) (*Client, error) {
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return nil, fmt.Errorf("wa: create session dir: %w", err)
	}

	// INFO, and deliberately not configurable via env.
	//
	// whatsmeow logs decrypted message payloads at Debugf. This service's
	// no-bodies-in-logs guarantee (see internal/redact) therefore holds only
	// because this logger is constructed below DEBUG. Raising this level —
	// or making it an env var somebody sets to DEBUG while chasing a bug —
	// puts customer message bodies in a plaintext log on a VPS whose logs are
	// not access-controlled, which is the exact POPIA exposure redact exists
	// to prevent. Debug whatsmeow by other means.
	logger := waLog.Stdout("wa", "INFO", true)
	// sqlite3 is go-sqlite3, the same cgo driver store/sqlite.go already
	// registers. Adding a second sqlite driver would either collide on the
	// registration name or silently open the file with different semantics.
	container, err := sqlstore.New(
		context.Background(),
		"sqlite3",
		fmt.Sprintf("file:%s/session.db?_foreign_keys=on&_busy_timeout=5000", sessionDir),
		logger,
	)
	if err != nil {
		return nil, fmt.Errorf("wa: open session store: %w", err)
	}
	device, err := container.GetFirstDevice(context.Background())
	if err != nil {
		return nil, fmt.Errorf("wa: get device: %w", err)
	}

	c := &Client{onInbound: onInbound, onLoggedOut: onLoggedOut}
	c.wac = whatsmeow.NewClient(device, logger)
	c.wac.AddEventHandler(c.handleEvent)
	return c, nil
}

// Connect pairs if needed (printing a QR to the log) and connects.
func (c *Client) Connect(ctx context.Context) error {
	if c.wac.Store.ID != nil {
		return c.wac.Connect()
	}

	// GetQRChannel must be called before Connect or the pairing events are
	// missed entirely and the caller waits forever on a channel that never
	// emits.
	qrChan, err := c.wac.GetQRChannel(ctx)
	if err != nil {
		return fmt.Errorf("wa: qr channel: %w", err)
	}
	if err := c.wac.Connect(); err != nil {
		return fmt.Errorf("wa: connect: %w", err)
	}
	go func() {
		for evt := range qrChan {
			c.handleQREvent(evt)
		}
	}()
	return nil
}

// handleQREvent applies one item off the QR channel. Split out from the
// Connect goroutine so it can be driven directly by a test — whatsmeow's
// QRChannelItem is a plain exported struct with no interface indirection, so
// a test can construct one and call this without a live or fake connection.
func (c *Client) handleQREvent(evt whatsmeow.QRChannelItem) {
	switch evt.Event {
	case "code":
		c.setPairingCode(evt.Code, time.Now().Add(evt.Timeout))
		log.Printf("wa: scan this QR to pair (expires in %s)", evt.Timeout)
	case "success":
		c.clearPairingCode()
		log.Printf("wa: paired successfully")
	default:
		c.clearPairingCode()
		log.Printf("wa: pairing ended: %s", evt.Event)
	}
}

func (c *Client) setPairingCode(code string, expiresAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pairCode, c.pairExpiry = code, expiresAt
}

func (c *Client) clearPairingCode() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pairCode, c.pairExpiry = "", time.Time{}
}

// PairingCode returns the live QR payload, if one is in flight and unexpired.
func (c *Client) PairingCode() (string, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pairCode == "" || time.Now().After(c.pairExpiry) {
		return "", time.Time{}, false
	}
	return c.pairCode, c.pairExpiry, true
}

// Disconnect closes the socket. Safe to call more than once.
func (c *Client) Disconnect() {
	if c.wac != nil {
		c.wac.Disconnect()
	}
}

func (c *Client) handleEvent(evt any) {
	switch v := evt.(type) {
	case *events.Connected:
		c.mu.Lock()
		c.connectedAt = time.Now()
		c.loggedOut = false
		c.mu.Unlock()
		// Deliberately does NOT claim outbound is suppressed — nothing here
		// suppresses it. This client only reports the window; acting on it is
		// the caller's job, and a log line asserting a safety behaviour the
		// service does not have would be read as evidence during an incident.
		log.Printf("wa: connected; replay window open for %s", ReplayWindow)

	case *events.Disconnected:
		// Transient. whatsmeow reconnects on its own; clearing connectedAt
		// means Send fails closed in the gap, and the next Connected event
		// restarts the replay window — which is correct, because a reconnect
		// replays history again.
		c.mu.Lock()
		c.connectedAt = time.Time{}
		c.mu.Unlock()
		log.Printf("wa: disconnected; outbound refused until reconnect")

	case *events.LoggedOut:
		c.handleLoggedOut()

	case *events.Message:
		c.handleMessage(v)
	}
}

func (c *Client) handleMessage(v *events.Message) {
	// ParseInbound does the whole decision, and downloads NOTHING: the
	// attachment arrives as a thunk the fanout calls only after its rails have
	// admitted the message. Keeping the download off this goroutine is not an
	// optimisation — see fetchInboundMedia and the POPIA note below.
	in := ParseInbound(v, c.mediaDownloader())
	if in == nil || c.onInbound == nil {
		return
	}
	// v.Info.ID is WhatsApp's own message id, carried on Inbound. Forwarding
	// it lets a consumer dedupe a redelivery on the id rather than on the
	// body. quotedMessageId (which of OUR messages this is a reply to) is a
	// different lookup into ContextInfo and stays phase-2 work.
	c.onInbound(in.JID, in.Text, in.MsgID, in.At, in.Media, in.Location)
}

// mediaDownloader is where inbound attachments come from: the test override if
// one is set, otherwise the live whatsmeow client.
//
// Returning a nil interface when there is no client is deliberate — callers
// degrade to a dropped file rather than panicking on a message that is
// otherwise perfectly deliverable.
func (c *Client) mediaDownloader() MediaDownloader {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.downloader != nil {
		return c.downloader
	}
	if c.wac != nil {
		return c.wac
	}
	return nil
}

// senderAddress picks the address a consumer can actually reply to.
//
// WhatsApp addresses many senders by LID, and for those Info.Sender is
// "<lid>@lid" while Info.SenderAlt carries "<msisdn>@s.whatsapp.net". A
// consumer takes the JID's user part as the contact's phone number and
// rebuilds "<user>@s.whatsapp.net" to reply, so forwarding the LID mints a
// phone number nobody dialled: the reply is delivered to whoever genuinely
// owns that number, or to nobody. That is a wrong recipient, not a formatting
// blemish, which is why this prefers the phone address wherever one exists.
//
// It never invents one. With no alternative the sender passes through
// unchanged — the caller is better served by an address it may not understand
// than by a dropped message from a real customer.
func senderAddress(src types.MessageSource) string {
	if src.Sender.Server == types.HiddenUserServer &&
		src.SenderAlt.Server == types.DefaultUserServer &&
		src.SenderAlt.User != "" {
		return src.SenderAlt.String()
	}
	return src.Sender.String()
}

// handleLoggedOut marks the client dead immediately.
//
// It deliberately does NOT reconnect. A LoggedOut event means the number was
// flagged or manually unlinked; retrying in a loop turns a soft flag into a
// harder block. It also does not queue: a queue that drains after a re-pair
// delivers stale messages to customers.
func (c *Client) handleLoggedOut() {
	c.mu.Lock()
	c.loggedOut = true
	c.connectedAt = time.Time{}
	cb := c.onLoggedOut
	wac := c.wac
	c.mu.Unlock()

	log.Printf("wa: ALERT LoggedOut — outbound stopped, human re-pair required")

	if wac != nil {
		// Off this goroutine because Disconnect must not run inside an event
		// handler. Note we do NOT also set wac.EnableAutoReconnect = false:
		// that field is a plain bool read unsynchronised by whatsmeow's
		// keepalive goroutine, so writing it here is a data race, and it buys
		// nothing. whatsmeow already guarantees no reconnect after a logout
		// twice over — both LoggedOut dispatch sites call expectDisconnect()
		// first, and autoReconnect returns on that; and Store.Delete() nils
		// Store.ID, which autoReconnect also bails on.
		go wac.Disconnect()
	}
	if cb != nil {
		cb()
	}
}

func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loggedOut {
		return false
	}
	return !c.connectedAt.IsZero()
}

// Number is the phone number this session is linked to, digits only, empty
// until the device is paired. whatsmeow writes the JID into the session store
// at pairing and it survives a restart, so this is also the answer after a
// reconnect that needed no re-pair.
//
// It is the number's OWN identity, not a customer's: the manager renders it so
// an operator can tell which of forty numbers a card is about. Everything that
// carries it is authenticated (see api.handleHealth).
func (c *Client) Number() string {
	c.mu.Lock()
	wac := c.wac
	c.mu.Unlock()
	if wac == nil || wac.Store == nil || wac.Store.ID == nil {
		return ""
	}
	return wac.Store.ID.User
}

// ConnectedAt is the moment the current connection was established, or the
// zero time when there is none. The fanout uses it as the key that tells it a
// new connection has begun and its watermark needs re-reading.
func (c *Client) ConnectedAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connectedAt
}

// InReplayWindow reports whether the socket is still inside the post-connect
// period during which whatsmeow replays recent history. Callers record what
// arrives during it but must not act on it.
func (c *Client) InReplayWindow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connectedAt.IsZero() {
		return false
	}
	return time.Since(c.connectedAt) < ReplayWindow
}

// upload puts one attachment on WhatsApp's media servers. Every failure it can
// return — including its own deadline — is wrapped in ErrMediaUpload, because
// every one of them happens before SendMessage and is therefore definitive.
func (c *Client) upload(ctx context.Context, media *rails.Media) (whatsmeow.UploadResponse, error) {
	c.mu.Lock()
	up := c.uploader
	if up == nil && c.wac != nil {
		up = c.wac
	}
	c.mu.Unlock()
	if up == nil {
		return whatsmeow.UploadResponse{}, fmt.Errorf("%w: no client", ErrMediaUpload)
	}

	budget := mediaUploadBudget(ctx)
	if budget <= 0 {
		// Not enough of the send budget left to start. Refusing here rather
		// than starting an upload that cannot finish keeps the failure
		// DEFINITIVE and keeps the upload's deadline strictly inside the
		// send's — see mediaUploadBudget.
		return whatsmeow.UploadResponse{}, fmt.Errorf(
			"%w: no time left in the send budget", ErrMediaUpload)
	}
	uploadCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	resp, err := up.Upload(uploadCtx, media.Data, uploadKindFor(media.MimeType))
	if err != nil {
		// The mime type and the byte count, never the bytes and never the
		// filename — a filename is customer data on this rail.
		return whatsmeow.UploadResponse{}, fmt.Errorf("%w (%s, %d bytes): %w",
			ErrMediaUpload, media.MimeType, len(media.Data), err)
	}
	return resp, nil
}

func (c *Client) Send(ctx context.Context, jid, text string, media *rails.Media) (string, error) {
	c.mu.Lock()
	loggedOut := c.loggedOut
	connected := !loggedOut && !c.connectedAt.IsZero()
	c.mu.Unlock()

	if loggedOut {
		return "", ErrLoggedOut
	}
	if !connected {
		return "", ErrNotConnected
	}

	target, err := types.ParseJID(jid)
	if err != nil {
		return "", fmt.Errorf("wa: bad jid %s: %w", redact.JID(jid), err)
	}

	msg := &waE2E.Message{Conversation: proto.String(text)}
	if media != nil {
		// Uploaded before SendMessage rather than alongside it, and a failure
		// here returns BEFORE anything reaches the socket. That makes an upload
		// failure a DEFINITIVE rejection one layer up — api.handleSendError
		// releases the reservation and the cap slot — which is correct only
		// because no message was dispatched. Do not move this after the send.
		//
		// The upload runs on its OWN deadline, deliberately shorter than the
		// send context's (see mediaUploadBudget). Without that, a slow upload
		// would exhaust the queue's send timeout instead, and the caller would
		// be told "ambiguous" — reservation left to expire, cap slot spent
		// forever — about a message that provably never left this process.
		up, upErr := c.upload(ctx, media)
		if upErr != nil {
			return "", upErr
		}
		msg = mediaMessage(up, text, media)
	}

	resp, err := c.wac.SendMessage(ctx, target, msg)
	if err != nil {
		return "", err
	}
	return resp.ID, nil
}
