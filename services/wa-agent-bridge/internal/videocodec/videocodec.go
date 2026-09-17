// Package videocodec decides whether an MP4 carries codecs WhatsApp will play.
//
// WhatsApp needs H.264 video and AAC audio. A file that breaks that rule is not
// refused when it is sent: it goes out, and then fails to play on the
// recipient's phone. The common case is an iPhone's HEVC .mp4, which passes
// every MIME check there is. So the codecs are read out of the file before it
// is uploaded.
//
// They are read by walking the ISO-BMFF box tree (moov → trak → mdia → hdlr /
// minf → stbl → stsd), never by searching the bytes for "hvc1" or "avc1":
// those four bytes turn up inside compressed media in mdat often enough to
// give the wrong answer either way.
//
// This is the Go mirror of src/lib/comms/whatsapp/video-codec.ts, which the CRM
// enforces before it ever calls the bridge. The bridge keeps its own copy
// because /v1/send has callers other than the CRM. Both are tested against the
// same fixtures in src/lib/comms/whatsapp/__fixtures__/video/.
package videocodec

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// The machine codes a refusal carries, matching the TypeScript inspector.
const (
	CodeUnsupported = "video_codec_unsupported"
	CodeUnreadable  = "media_invalid"
)

// Refusal explains why a video will not be sent. Nil from Check means allowed.
type Refusal struct {
	Code    string
	Message string
}

// maxBoxes is more boxes than any real file has; reaching it means a hostile
// or broken one.
const maxBoxes = 10000

const exportHint = "Export it as H.264 MP4 and try again."

var errUnreadable = errors.New("videocodec: unreadable")

type box struct {
	typ        string
	start, end int // payload bounds, header excluded
}

type walker struct {
	b      []byte
	budget int
}

// fourcc is safe to show an operator: printable ASCII, else hex.
func fourcc(b []byte) string {
	for _, c := range b {
		if c < 0x20 || c >= 0x7f {
			return fmt.Sprintf("%x", b)
		}
	}
	return string(b)
}

// children returns the boxes inside [start, end). Any size that does not fit
// is unreadable.
func (w *walker) children(start, end int) ([]box, error) {
	var out []box
	for at := start; at < end; {
		w.budget--
		if w.budget < 0 || end-at < 8 {
			return nil, errUnreadable
		}
		size := uint64(binary.BigEndian.Uint32(w.b[at:]))
		typ := fourcc(w.b[at+4 : at+8])
		header := uint64(8)
		switch size {
		case 1:
			if end-at < 16 {
				return nil, errUnreadable
			}
			size = binary.BigEndian.Uint64(w.b[at+8:])
			header = 16
		case 0:
			size = uint64(end - at) // extends to the end of its parent
		}
		if size < header || size > uint64(end-at) {
			return nil, errUnreadable
		}
		out = append(out, box{typ, at + int(header), at + int(size)})
		at += int(size)
	}
	return out, nil
}

func hasMedia(top []box) bool {
	for _, b := range top {
		if b.typ == "mdat" && b.end > b.start {
			return true
		}
	}
	return false
}

func only(boxes []box, typ string) (box, error) {
	var found []box
	for _, b := range boxes {
		if b.typ == typ {
			found = append(found, b)
		}
	}
	if len(found) != 1 {
		return box{}, errUnreadable
	}
	return found[0], nil
}

// Check returns nil when data is an MP4 with exactly one H.264 (avc1/avc3)
// video track and no audio other than AAC (mp4a). It never panics on any
// input.
func Check(data []byte) *Refusal {
	video, audio, err := sampleEntries(data)
	if err != nil {
		return &Refusal{CodeUnreadable, "This video couldn't be read as an MP4. " + exportHint}
	}
	switch {
	case len(video) == 0:
		return unsupported("This file has no video WhatsApp can play. " + exportHint)
	case len(video) > 1:
		return unsupported("This video has more than one video track, which WhatsApp can't play. " + exportHint)
	}
	for _, e := range video[0] {
		switch e {
		case "avc1", "avc3":
		case "hvc1", "hev1":
			return unsupported("This video is HEVC (H.265), which WhatsApp can't play. " + exportHint)
		default:
			return unsupported(fmt.Sprintf("This video uses the %q codec, which WhatsApp can't play. %s", trim(e), exportHint))
		}
	}
	for _, e := range audio {
		if e != "mp4a" {
			return unsupported(fmt.Sprintf("This video's sound is %q, which WhatsApp can't play. Export it with AAC audio and try again.", trim(e)))
		}
	}
	return nil
}

func unsupported(msg string) *Refusal { return &Refusal{CodeUnsupported, msg} }

func trim(s string) string {
	for len(s) > 0 && s[len(s)-1] == ' ' {
		s = s[:len(s)-1]
	}
	return s
}

// sampleEntries returns each video track's sample-entry fourccs and every
// audio sample-entry fourcc.
func sampleEntries(data []byte) (video [][]string, audio []string, err error) {
	w := &walker{b: data, budget: maxBoxes}
	top, err := w.children(0, len(data))
	if err != nil {
		return nil, nil, err
	}
	moov, err := only(top, "moov")
	if err != nil {
		return nil, nil, err
	}
	// A file cut off exactly where its media begins still has a well-formed
	// moov, and nothing to play.
	if !hasMedia(top) {
		return nil, nil, errUnreadable
	}
	traks, err := w.children(moov.start, moov.end)
	if err != nil {
		return nil, nil, err
	}
	for _, trak := range traks {
		if trak.typ != "trak" {
			continue
		}
		handler, entries, err := w.track(trak)
		if err != nil {
			return nil, nil, err
		}
		switch handler {
		case "vide":
			video = append(video, entries)
		case "soun":
			audio = append(audio, entries...)
		}
		// Timecode, metadata and hint tracks (an iPhone writes some) are not
		// what WhatsApp plays, so they are not what this judges.
	}
	return video, audio, nil
}

// track returns a trak's handler type and, for vide/soun, its sample entries.
func (w *walker) track(trak box) (string, []string, error) {
	kids, err := w.children(trak.start, trak.end)
	if err != nil {
		return "", nil, err
	}
	mdia, err := only(kids, "mdia")
	if err != nil {
		return "", nil, err
	}
	mdiaKids, err := w.children(mdia.start, mdia.end)
	if err != nil {
		return "", nil, err
	}
	hdlr, err := only(mdiaKids, "hdlr")
	if err != nil {
		return "", nil, err
	}
	// version/flags (4) + pre_defined (4) + handler_type (4)
	if hdlr.end-hdlr.start < 12 {
		return "", nil, errUnreadable
	}
	handler := fourcc(w.b[hdlr.start+8 : hdlr.start+12])
	if handler != "vide" && handler != "soun" {
		return handler, nil, nil
	}
	path := []string{"minf", "stbl", "stsd"}
	cur := mdiaKids
	var stsd box
	for i, typ := range path {
		b, err := only(cur, typ)
		if err != nil {
			return "", nil, err
		}
		if i == len(path)-1 {
			stsd = b
			break
		}
		if cur, err = w.children(b.start, b.end); err != nil {
			return "", nil, err
		}
	}
	// version/flags (4) + entry_count (4), then the sample entries as boxes.
	if stsd.end-stsd.start < 8 {
		return "", nil, errUnreadable
	}
	count := binary.BigEndian.Uint32(w.b[stsd.start+4:])
	boxes, err := w.children(stsd.start+8, stsd.end)
	if err != nil {
		return "", nil, err
	}
	if count == 0 || uint64(len(boxes)) != uint64(count) {
		return "", nil, errUnreadable
	}
	entries := make([]string, len(boxes))
	for i, b := range boxes {
		entries[i] = b.typ
	}
	return handler, entries, nil
}
