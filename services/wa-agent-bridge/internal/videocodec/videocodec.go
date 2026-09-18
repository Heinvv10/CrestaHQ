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
//
// KNOWN LIMITS. The rule is the sample-entry fourcc (avc1/avc3 video, mp4a
// audio) plus, for mp4a, the esds objectTypeIndication (AAC only). It does NOT
// read the avcC profile, so H.264 High 4:2:2 or High 10 passes and may still
// not play. It does NOT check that an avc1 entry really holds avcC rather than
// hvcC, so an HEVC stream deliberately relabelled avc1 passes. A fragmented
// MP4 with more than maxBoxes top-level boxes (one per frame) is refused as
// unreadable; phones do not produce those. OTI 0x40 means "MPEG-4 Audio",
// not strictly AAC: a hand-built esds with OTI 0x40 whose DecoderSpecificInfo
// names a non-AAC audioObjectType (e.g. 34, MP3-on-MP4, or 42, USAC) passes.
// ffmpeg never writes that; it uses 0x69/0x6B for MP3.
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
// is unreadable — except, at the top level only, fewer than 8 trailing bytes
// after the last box, which some writers leave as padding.
func (w *walker) children(start, end int) ([]box, error) {
	return w.walk(start, end, false)
}

func (w *walker) walk(start, end int, topLevel bool) ([]box, error) {
	var out []box
	for at := start; at < end; {
		if topLevel && end-at < 8 {
			break
		}
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

// hasType reports whether any box in boxes has type typ.
func hasType(boxes []box, typ string) bool {
	for _, b := range boxes {
		if b.typ == typ {
			return true
		}
	}
	return false
}

// aacOTI are the esds objectTypeIndication values that are AAC: MPEG-4, then
// MPEG-2 Main/LC/SSR. 0x69 and 0x6B are MPEG-2 and MPEG-1 Layer 3 (MP3),
// which ride in the same mp4a entry.
var aacOTI = map[byte]bool{0x40: true, 0x66: true, 0x67: true, 0x68: true}

func isMP3OTI(oti byte) bool { return oti == 0x69 || oti == 0x6b }

func audioMessage(what string) string {
	return "This video's sound is " + what + ", which WhatsApp can't play. Export it with AAC audio and try again."
}

// Check returns nil when data is an MP4 with exactly one H.264 (avc1/avc3)
// video track and no audio other than AAC (mp4a). It never panics on any
// input.
func Check(data []byte) *Refusal {
	w := &walker{b: data, budget: maxBoxes}
	video, audio, err := w.sampleEntries()
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
	// Every audio track, not only the first: WhatsApp may pick any of them.
	for _, e := range audio {
		if e.typ != "mp4a" {
			return unsupported(audioMessage(fmt.Sprintf("%q", trim(e.typ))))
		}
		// mp4a is only the container for an MPEG-4 audio stream; MP3 uses it
		// too. The esds objectTypeIndication is what says AAC.
		oti, ok := w.objectTypeIndication(e)
		switch {
		case !ok:
			// video_codec_unsupported, not media_invalid: the file itself
			// parsed, and what is missing is proof the sound is AAC. The
			// operator's fix is the same as for any wrong audio — re-export
			// with AAC — and calling the whole file unreadable would send
			// them looking for corruption.
			return unsupported("This video's sound couldn't be confirmed as AAC, which is all WhatsApp plays. Export it with AAC audio and try again.")
		case isMP3OTI(oti):
			return unsupported(audioMessage("MP3"))
		case !aacOTI[oti]:
			return unsupported(audioMessage(fmt.Sprintf("not AAC (object type 0x%02x)", oti)))
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
// audio sample entry.
func (w *walker) sampleEntries() (video [][]string, audio []box, err error) {
	top, err := w.walk(0, len(w.b), true)
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
			fourccs := make([]string, len(entries))
			for i, e := range entries {
				fourccs[i] = e.typ
			}
			video = append(video, fourccs)
		case "soun":
			audio = append(audio, entries...)
		}
		// Timecode, metadata and hint tracks (an iPhone writes some) are not
		// what WhatsApp plays, so they are not what this judges.
	}
	return video, audio, nil
}

// track returns a trak's handler type and, for vide/soun, its sample entries.
func (w *walker) track(trak box) (string, []box, error) {
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
	return handler, boxes, nil
}

// objectTypeIndication reads the OTI from an mp4a entry's esds. ok is false
// when there is no esds or it cannot be parsed; it never panics.
func (w *walker) objectTypeIndication(mp4a box) (byte, bool) {
	// SampleEntry (8) + AudioSampleEntry fields (20); QuickTime sound
	// description version 1 adds 16 bytes, version 2 adds 36.
	if mp4a.end-mp4a.start < 28 {
		return 0, false
	}
	var fields int
	switch binary.BigEndian.Uint16(w.b[mp4a.start+8:]) {
	case 0:
		fields = 28
	case 1:
		fields = 44
	case 2:
		fields = 64
	default:
		return 0, false
	}
	if mp4a.end-mp4a.start < fields {
		return 0, false
	}
	kids, err := w.children(mp4a.start+fields, mp4a.end)
	if err != nil {
		return 0, false
	}
	var esds box
	if hasType(kids, "esds") {
		// One esds or refuse. Falling back to `wave` when there are two would
		// let a direct esds holding MP3 be outvoted by a nested AAC one, and
		// the TS inspector does not do that (video-codec.ts: it reads `wave`
		// only when no esds exists), so the rails would disagree.
		if esds, err = only(kids, "esds"); err != nil {
			return 0, false
		}
	} else {
		// QuickTime-style files nest esds inside a `wave` box.
		wave, werr := only(kids, "wave")
		if werr != nil {
			return 0, false
		}
		if kids, err = w.children(wave.start, wave.end); err != nil {
			return 0, false
		}
		if esds, err = only(kids, "esds"); err != nil {
			return 0, false
		}
	}

	// FullBox version/flags (4), then ES_Descriptor.
	tag, start, end, ok := w.descriptor(esds.start+4, esds.end)
	if !ok || tag != 0x03 || end-start < 3 {
		return 0, false
	}
	flags := w.b[start+2]
	at := start + 3 // ES_ID (2) + flags (1)
	if flags&0x80 != 0 {
		at += 2 // dependsOn_ES_ID
	}
	if flags&0x40 != 0 {
		if at >= end {
			return 0, false
		}
		at += 1 + int(w.b[at]) // URLlength + URLstring
	}
	if flags&0x20 != 0 {
		at += 2 // OCR_ES_Id
	}
	// The nested descriptors; DecoderConfigDescriptor is the one wanted.
	for steps := 0; at < end && steps < 16; steps++ {
		t, s, e, ok := w.descriptor(at, end)
		if !ok {
			return 0, false
		}
		if t == 0x04 {
			if e > s {
				return w.b[s], true
			}
			return 0, false
		}
		at = e
	}
	return 0, false
}

// descriptor reads one MPEG-4 descriptor at `at` within `limit`: its tag and
// payload bounds. The size is expandable: 1–4 bytes, high bit set means another
// byte follows.
func (w *walker) descriptor(at, limit int) (tag byte, start, end int, ok bool) {
	if limit-at < 2 {
		return 0, 0, 0, false
	}
	tag = w.b[at]
	size := 0
	i := at + 1
	for n := 0; ; n++ {
		if n == 4 || i >= limit {
			return 0, 0, 0, false
		}
		b := w.b[i]
		i++
		size = size<<7 | int(b&0x7f)
		if b&0x80 == 0 {
			break
		}
	}
	if size > limit-i {
		return 0, 0, 0, false
	}
	return tag, i, i + size, true
}
