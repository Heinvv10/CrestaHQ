"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { accentOnWhite, textOnAccent } from "@/components/web-chat/contrast";
import {
  loadVoiceClient,
  type VoiceClientModule,
} from "@/components/web-chat/voice-sdk";

/**
 * Self-contained chat widget rendered inside the /embed/chat/[saId]
 * iframe. Owns:
 *
 *   - session id (UUID in localStorage, scoped per sub-account)
 *   - message history (in-memory; persisted server-side per turn)
 *   - send-message API call → /api/web-chat/message
 *   - typing indicator while the reply is in flight
 *   - postMessage out to the parent window for [open|close|resize]
 *     so the floating-bubble loader can respond
 *
 * Deliberately no shadcn imports — the chat lives inside an iframe
 * with no Tailwind variables from the host page, so we use plain CSS
 * via inline styles + a tiny <style> block. Keeps the iframe bundle
 * tight and immune to the buyer's CSS bleeding in.
 */

interface ChatWindowProps {
  subAccountId: string;
  welcomeMessage: string;
  accentColor: string;
  /** Tells the parent loader to remove/hide the iframe on close. */
  embedded: boolean;
}

type CaptureFieldId = "name" | "email" | "phone";

type LocalMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Set on the optimistic-render row that's waiting on the server reply. */
  pending?: boolean;
  /** When present on an assistant message, render an inline capture form
   *  below the bubble with these fields. Cleared once submitted/skipped. */
  formFields?: CaptureFieldId[];
};

function sessionStorageKey(saId: string): string {
  return `leadstack:webchat:session:${saId}`;
}

/** Generates a 22-char URL-safe random string. Server's session-id regex
 *  accepts 16-64 chars of `[a-zA-Z0-9_-]`, which this satisfies. */
function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function ensureSessionId(saId: string): string {
  if (typeof window === "undefined") return "";
  const key = sessionStorageKey(saId);
  let existing = window.localStorage.getItem(key);
  if (!existing) {
    existing = newSessionId();
    window.localStorage.setItem(key, existing);
  }
  return existing;
}

function validatedParentOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function postToParent(
  message: Record<string, unknown>,
  parentOrigin: string | null,
): void {
  if (typeof window === "undefined") return;
  if (window.parent === window || !parentOrigin) return;
  window.parent.postMessage(
    { source: "leadstack-webchat", ...message },
    parentOrigin,
  );
}

/** How long (ms) to wait for a human reply — on a held message that landed
 *  within configured hours — before showing the softer "we'll follow up"
 *  note. Reset each time the visitor sends another message; cleared the
 *  moment an operator reply arrives via the poll. */
const WAIT_NOTE_DELAY_MS = 3 * 60 * 1000;
/** Shown immediately when a held message lands OUTSIDE configured hours. */
const OFFLINE_NOTE =
  "We're offline right now — leave your details and we'll get back to you.";
/** Shown when no human has replied within WAIT_NOTE_DELAY_MS (within hours). */
const WAITING_NOTE = "Thanks for waiting — we'll follow up as soon as we can.";

/** Web Voice (ElevenLabs Web Voice v1) states for the mic bar. */
type VoiceStatus = "idle" | "connecting" | "listening" | "speaking";

/** Minimal surface of the ElevenLabs SDK conversation we use. The SDK is
 *  loaded with a dynamic import only when the visitor taps the mic, so typed
 *  chat never downloads it. */
type VoiceConversation = { endSession: () => Promise<void> };

type ActiveVoiceCall = {
  id: number;
  conversation: VoiceConversation | null;
  sessionToken: string | null;
  conversationId: string | null;
  connectedAttempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  claimConfirmed: boolean;
  endedSent: boolean;
  endedAfterClaimSent: boolean;
  stopped: boolean;
  seenMessages: Set<string>;
  messageSequence: number;
};

const CONNECTED_RETRY_DELAYS_MS = [5_000, 10_000, 15_000] as const;
const CONNECTED_ATTEMPT_CAP = 4;

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}

export function ChatWindow(props: ChatWindowProps) {
  const { subAccountId, welcomeMessage, accentColor, embedded } = props;
  // Light accents (yellow, lime, pastels) need dark text; and the accent
  // itself is darkened where it's drawn on white (the mic button).
  const onAccent = useMemo(() => textOnAccent(accentColor), [accentColor]);
  const accentInk = useMemo(() => accentOnWhite(accentColor), [accentColor]);

  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errored, setErrored] = useState(false);
  // A short status line shown when a human has the thread (AI off / paused).
  // Null most of the time — nothing on send, nothing while the bot answers.
  // Set to the "offline" line straight away when a held message lands outside
  // configured hours, or to the softer "we'll follow up" line if no operator
  // has replied within WAIT_NOTE_DELAY_MS. Cleared when the operator replies.
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [parentPageUrl, setParentPageUrl] = useState<string | null>(null);
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Delivery poll bookkeeping: server message ids we've already rendered
  // (so the poll never double-renders a reply we got inline), the createdAt
  // cursor, and a "primed" flag so the first poll seeds the seen-set from
  // history without replaying it into the UI.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const cursorRef = useRef<number>(0);
  const primedRef = useRef<boolean>(false);
  // Pending "still waiting for a human" note timer (armed on a held reply that
  // landed within hours; fires the softer note unless an operator reply — or a
  // new send — clears it first).
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Web Voice ─────────────────────────────────────────────────────────
  // The installed loader delivers this over an origin/source-checked
  // postMessage handshake. Settings preview uses a scrubbed #vt fragment.
  const [voiceToken, setVoiceToken] = useState<string | null>(null);
  const [voiceSdkReady, setVoiceSdkReady] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceMaxSeconds, setVoiceMaxSeconds] = useState(0);
  const activeVoiceCallRef = useRef<ActiveVoiceCall | null>(null);
  const nextVoiceCallIdRef = useRef(0);
  const voiceSdkRef = useRef<VoiceClientModule | null>(null);
  const voiceActive = voiceStatus !== "idle";

  const clearWaitTimer = useCallback(() => {
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  // Cancel any pending wait-note timer if the widget unmounts.
  useEffect(() => () => clearWaitTimer(), [clearWaitTimer]);

  // Boot: read or create the session id, capture the parent-page URL
  // from the widget loader's ?p= query param, seed the welcome message.
  useEffect(() => {
    const sid = ensureSessionId(subAccountId);
    setSessionId(sid);
    try {
      const qs = new URLSearchParams(window.location.search);
      const p = qs.get("p");
      const validatedOrigin = validatedParentOrigin(p);
      setParentPageUrl(p);
      setParentOrigin(validatedOrigin);

      const hash = new URLSearchParams(window.location.hash.slice(1));
      const vt = hash.get("vt");
      if (vt) {
        hash.delete("vt");
        const remainingHash = hash.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ""}`,
        );
        // Do not retain or preload from a preview token unless its bearer
        // value was first removed from the visible browser location.
        setVoiceToken(vt);
      }
    } catch {
      // No-op — parent URL is purely for server-side logging.
    }
    setMessages([{ id: "welcome", role: "assistant", text: welcomeMessage }]);
  }, [subAccountId, welcomeMessage]);

  // Evaluate the SDK as soon as the verified token arrives. Its web module
  // installs the iOS audio-unlock click listener; doing this inside the later
  // async start path is too late for the visitor's initiating gesture.
  useEffect(() => {
    voiceSdkRef.current = null;
    setVoiceSdkReady(false);
    if (!voiceToken) return;
    let cancelled = false;
    void loadVoiceClient()
      .then((sdk) => {
        if (cancelled) return;
        voiceSdkRef.current = sdk;
        setVoiceSdkReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setVoiceNote("Voice couldn't load. Please keep typing.");
      });
    return () => {
      cancelled = true;
    };
  }, [voiceToken]);

  // Auto-scroll to bottom on every message change.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Delivery poll: surface operator live-takeover replies (and approved
  // suggest-mode drafts) that arrive from the unified inbox — web chat has
  // no provider push, so the widget pulls. The first poll primes the
  // seen-set from history (no replay); later polls render only new outbound
  // messages whose id we haven't already shown from an inline response.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    async function poll() {
      // Skip while the tab is backgrounded — saves needless requests; the
      // next visible tick catches up (the cursor only moves forward).
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(
          `/api/web-chat/poll?sa=${encodeURIComponent(
            subAccountId
          )}&sessionId=${encodeURIComponent(sessionId)}&after=${cursorRef.current}`,
          { method: "GET" }
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          messages?: {
            id: string;
            body: string;
            createdAtMs: number;
            via?: "voice";
          }[];
          serverNowMs?: number;
        };
        const incoming = data.messages ?? [];
        for (const m of incoming) {
          if (m.createdAtMs > cursorRef.current)
            cursorRef.current = m.createdAtMs;
          if (seenIdsRef.current.has(m.id)) continue;
          seenIdsRef.current.add(m.id);
          // Voice turns were already shown live from the voice SDK.
          if (m.via === "voice") continue;
          // First pass just primes history; don't replay it into the UI.
          if (!primedRef.current) continue;
          // The operator's reply landed — drop any handoff note + pending
          // "still waiting" timer, then render the reply.
          setHandoffNote(null);
          clearWaitTimer();
          setMessages((prev) => [
            ...prev,
            { id: `poll-${m.id}`, role: "assistant", text: m.body },
          ]);
        }
        primedRef.current = true;
      } catch {
        // Silent — the next tick retries.
      }
    }

    // Prime immediately, then poll on an interval while the widget is mounted.
    void poll();
    const iv = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, subAccountId, clearWaitTimer]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || !sessionId) return;

      const userMsg: LocalMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setSending(true);
      setErrored(false);

      try {
        const res = await fetch("/api/web-chat/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sa: subAccountId,
            sessionId,
            message: trimmed,
            // Parent page URL (where the snippet is installed). Falls
            // back to document.referrer when the loader didn't pass ?p=.
            // window.location.href is the LAST resort — it's the iframe's
            // URL, not the parent's, but better than nothing for logs.
            pageUrl:
              parentPageUrl ||
              document.referrer ||
              (typeof window !== "undefined" ? window.location.href : null),
            referrer: document.referrer || null,
          }),
        });
        const data = (await res.json()) as {
          reply?: string | null;
          error?: string;
          formFields?: CaptureFieldId[] | null;
          messageId?: string;
          held?: boolean;
          offline?: boolean;
        };
        if (!res.ok) {
          throw new Error(data.error ?? "no reply");
        }
        // Record the reply's server id so the delivery poll won't render it
        // a second time.
        if (data.messageId) seenIdsRef.current.add(data.messageId);
        // Human is handling this thread — no bot reply, and no note on send.
        // If the server says we're outside configured hours, say so straight
        // away; otherwise stay quiet and arm a timer that gently says we'll
        // follow up if no operator replies in the next few minutes. Either
        // note is cleared the moment the operator's reply arrives via poll.
        if (data.held) {
          clearWaitTimer();
          if (data.offline) {
            setHandoffNote(OFFLINE_NOTE);
          } else {
            setHandoffNote(null);
            waitTimerRef.current = setTimeout(() => {
              setHandoffNote(WAITING_NOTE);
            }, WAIT_NOTE_DELAY_MS);
          }
          return;
        }
        if (!data.reply) {
          throw new Error(data.error ?? "no reply");
        }
        // The bot answered — drop any human-handoff note/timer from an
        // earlier turn (AI is back in control of this thread).
        clearWaitTimer();
        setHandoffNote(null);
        const replyText = data.reply;
        const formFields = data.formFields ?? null;
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: replyText,
            formFields:
              formFields && formFields.length > 0 ? formFields : undefined,
          },
        ]);
      } catch {
        setErrored(true);
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: "I had trouble reaching the server. Try again in a moment, or refresh the page.",
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [subAccountId, sessionId, sending, parentPageUrl, clearWaitTimer]
  );

  const isCurrentVoiceCall = useCallback(
    (call: ActiveVoiceCall) =>
      activeVoiceCallRef.current === call && !call.stopped,
    []
  );

  /** Send the initial `ended`, plus one settlement resend after a late claim. */
  const sendVoiceEnded = useCallback(
    (call: ActiveVoiceCall, beacon = false) => {
      if (
        (call.claimConfirmed ? call.endedAfterClaimSent : call.endedSent) ||
        !call.sessionToken ||
        !call.conversationId
      )
        return;
      const payload = JSON.stringify({
        token: call.sessionToken,
        type: "ended",
        conversationId: call.conversationId,
      });
      if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
        try {
          if (navigator.sendBeacon("/api/web-chat/voice/event", payload)) {
            call.endedSent = true;
            if (call.claimConfirmed) call.endedAfterClaimSent = true;
            return;
          }
        } catch {
          // Fall through to the keepalive request.
        }
      }
      try {
        const request = fetch("/api/web-chat/voice/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        });
        // The end is latched only once the browser accepted a beacon or the
        // keepalive request was dispatched. A synchronous fetch failure may
        // therefore be retried by a later lifecycle callback.
        call.endedSent = true;
        if (call.claimConfirmed) call.endedAfterClaimSent = true;
        void request.catch(() => {});
      } catch {
        // A later lifecycle callback may retry.
      }
    },
    []
  );

  const finishVoiceCall = useCallback(
    (
      call: ActiveVoiceCall,
      options: { beacon?: boolean; endSdk?: boolean; updateUi?: boolean } = {}
    ) => {
      if (call.stopped) {
        sendVoiceEnded(call, options.beacon);
        return;
      }
      call.stopped = true;
      // An unclaimed grant keeps its bounded connected retries alive. If an
      // in-flight/retried claim succeeds after this immediate end report, the
      // server needs one idempotent follow-up end to settle that claim.
      if (call.claimConfirmed && call.retryTimer) {
        clearTimeout(call.retryTimer);
        call.retryTimer = null;
      }
      sendVoiceEnded(call, options.beacon);
      if (activeVoiceCallRef.current === call) {
        activeVoiceCallRef.current = null;
        if (options.updateUi !== false) {
          setVoiceStatus("idle");
          setVoiceElapsed(0);
        }
      }
      if (options.endSdk && call.conversation) {
        void call.conversation.endSession().catch(() => {});
      }
    },
    [sendVoiceEnded]
  );

  /** ElevenLabs can take time to list a new conversation. Try immediately,
   *  then at roughly 5, 15 and 30 seconds, stopping as soon as it is claimed. */
  const reportVoiceConnected = useCallback(
    (call: ActiveVoiceCall) => {
      const attempt = async () => {
        if (
          (!call.stopped && !isCurrentVoiceCall(call)) ||
          !call.sessionToken ||
          !call.conversationId ||
          call.claimConfirmed ||
          call.connectedAttempts >= CONNECTED_ATTEMPT_CAP
        ) {
          return;
        }
        call.connectedAttempts += 1;
        const delay = CONNECTED_RETRY_DELAYS_MS[call.connectedAttempts - 1];
        if (
          delay !== undefined &&
          call.connectedAttempts < CONNECTED_ATTEMPT_CAP
        ) {
          // Schedule before awaiting the request so one hung response cannot
          // consume the grant's whole claim window without another attempt.
          call.retryTimer = setTimeout(() => void attempt(), delay);
        }
        let claimed = false;
        try {
          const response = await fetch("/api/web-chat/voice/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: call.sessionToken,
              type: "connected",
              conversationId: call.conversationId,
            }),
            keepalive: true,
          });
          if (response.ok) {
            const data = (await response.json()) as { claimed?: unknown };
            claimed = data.claimed === true;
          }
        } catch {
          // A later bounded attempt may still claim the call.
        }
        if (claimed) {
          call.claimConfirmed = true;
          if (call.retryTimer) {
            clearTimeout(call.retryTimer);
            call.retryTimer = null;
          }
          if (call.stopped) sendVoiceEnded(call);
        }
      };
      void attempt();
    },
    [isCurrentVoiceCall, sendVoiceEnded]
  );

  const startVoice = useCallback(async () => {
    const voiceSdk = voiceSdkRef.current;
    if (
      !voiceToken ||
      !voiceSdkReady ||
      !voiceSdk ||
      !sessionId ||
      activeVoiceCallRef.current ||
      sending
    )
      return;
    const call: ActiveVoiceCall = {
      id: ++nextVoiceCallIdRef.current,
      conversation: null,
      sessionToken: null,
      conversationId: null,
      connectedAttempts: 0,
      retryTimer: null,
      claimConfirmed: false,
      endedSent: false,
      endedAfterClaimSent: false,
      stopped: false,
      seenMessages: new Set(),
      messageSequence: 0,
    };
    activeVoiceCallRef.current = call;
    setVoiceNote(null);
    setVoiceStatus("connecting");

    // Ask for the mic FIRST, inside the click, so the browser prompt is tied
    // to the visitor's gesture and a refusal costs no voice minutes.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
    } catch {
      if (isCurrentVoiceCall(call)) {
        finishVoiceCall(call);
        setVoiceNote(
          "Microphone access was blocked. Allow it in your browser to talk, or keep typing."
        );
      }
      return;
    }

    if (!isCurrentVoiceCall(call)) return;

    try {
      const res = await fetch("/api/web-chat/voice/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sa: subAccountId,
          sessionId,
          voiceToken,
          pageUrl: parentPageUrl || document.referrer || null,
          referrer: document.referrer || null,
        }),
      });
      const data = (await res.json()) as {
        signedUrl?: string;
        token?: string;
        maxCallSeconds?: number;
        voiceEnabled?: boolean;
      };
      if (!res.ok || !data.signedUrl || !data.token) {
        if (data.voiceEnabled === false) setVoiceToken(null);
        throw new Error("voice start refused");
      }
      if (!isCurrentVoiceCall(call)) return;
      call.sessionToken = data.token;
      setVoiceMaxSeconds(data.maxCallSeconds ?? 0);

      if (!isCurrentVoiceCall(call)) return;
      const conversation = await voiceSdk.Conversation.startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
        // Reaches LeadStack's reply endpoint on every turn, binding the
        // spoken conversation to this chat session.
        customLlmExtraBody: { token: data.token },
        onConnect: ({ conversationId }) => {
          if (!isCurrentVoiceCall(call) || call.conversationId) return;
          call.conversationId = conversationId;
          setVoiceStatus("listening");
          reportVoiceConnected(call);
        },
        onModeChange: ({ mode }) => {
          if (!isCurrentVoiceCall(call)) return;
          setVoiceStatus(mode === "speaking" ? "speaking" : "listening");
        },
        onMessage: ({ message, role, event_id }) => {
          if (!isCurrentVoiceCall(call)) return;
          const text = message?.trim();
          if (!text) return;
          const rawEventId: unknown = event_id;
          const eventKey =
            typeof rawEventId === "number" && Number.isFinite(rawEventId)
              ? String(rawEventId)
              : typeof rawEventId === "string" && rawEventId.trim()
                ? rawEventId.trim()
                : null;
          if (eventKey) {
            const messageKey = `${role}:${eventKey}`;
            if (call.seenMessages.has(messageKey)) return;
            call.seenMessages.add(messageKey);
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `v-${call.id}-${++call.messageSequence}`,
              role: role === "user" ? "user" : "assistant",
              text,
            },
          ]);
        },
        onDisconnect: () => {
          finishVoiceCall(call);
        },
        onError: () => {
          if (!isCurrentVoiceCall(call)) return;
          setVoiceNote("Voice connection problem — you can keep typing.");
          finishVoiceCall(call, { endSdk: true });
        },
      });
      if (!isCurrentVoiceCall(call)) {
        void conversation.endSession().catch(() => {});
        return;
      }
      call.conversation = conversation;
    } catch {
      if (isCurrentVoiceCall(call)) {
        finishVoiceCall(call, { endSdk: true });
        setVoiceNote("Voice couldn't start. Please keep typing.");
      }
    }
  }, [
    voiceToken,
    voiceSdkReady,
    sessionId,
    sending,
    subAccountId,
    parentPageUrl,
    isCurrentVoiceCall,
    finishVoiceCall,
    reportVoiceConnected,
  ]);

  const stopVoice = useCallback(() => {
    const call = activeVoiceCallRef.current;
    if (call) finishVoiceCall(call, { endSdk: true });
  }, [finishVoiceCall]);

  // The host page may supply the in-memory widget token or ask the exact
  // iframe to close. Both messages share the verified parent channel.
  useEffect(() => {
    if (!parentOrigin || window.parent === window) return;
    function onHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const data = event.data as { source?: unknown; type?: unknown; token?: unknown };
      if (!data || data.source !== "leadstack-webchat-host") return;
      if (data.type === "voice-token" && typeof data.token === "string" && data.token) {
        setVoiceToken(data.token);
      } else if (data.type === "host-close") {
        stopVoice();
      }
    }
    window.addEventListener("message", onHostMessage);
    postToParent({ type: "ready" }, parentOrigin);
    return () => window.removeEventListener("message", onHostMessage);
  }, [parentOrigin, stopVoice]);

  // Call timer (display only — ElevenLabs enforces the real limit).
  useEffect(() => {
    if (voiceStatus === "idle" || voiceStatus === "connecting") return;
    const iv = setInterval(() => setVoiceElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [voiceStatus]);

  // Tab closed / navigated mid-call: settle the minutes via beacon, and end
  // the session if the widget unmounts.
  useEffect(() => {
    function onHide() {
      const call = activeVoiceCallRef.current;
      if (call) {
        finishVoiceCall(call, { beacon: true, endSdk: true });
      }
    }
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      const call = activeVoiceCallRef.current;
      if (call)
        finishVoiceCall(call, { beacon: true, endSdk: true, updateUi: false });
    };
  }, [finishVoiceCall]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  const handleCaptureFormDone = useCallback(
    async (
      messageId: string,
      payload:
        | { skip: true }
        | { skip?: false; name?: string; email?: string; phone?: string }
    ) => {
      if (!sessionId) return;
      // Strip the form off the originating message immediately so the
      // visitor sees it disappear regardless of network outcome.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, formFields: undefined } : m
        )
      );
      try {
        const res = await fetch("/api/web-chat/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sa: subAccountId,
            sessionId,
            pageUrl:
              parentPageUrl ||
              (typeof window !== "undefined" ? window.location.href : null),
            ...payload,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          reply?: string;
          error?: string;
          messageId?: string;
        };
        if (!res.ok || !data.reply) {
          throw new Error(data.error ?? "capture failed");
        }
        if (data.messageId) seenIdsRef.current.add(data.messageId);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: data.reply!,
          },
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setMessages((prev) => [
          ...prev,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            text: msg,
          },
        ]);
      }
    },
    [subAccountId, sessionId, parentPageUrl]
  );

  function handleClose() {
    // Closing the panel hides the iframe but keeps it alive — don't leave a
    // voice call talking in the background.
    if (voiceActive) void stopVoice();
    postToParent({ type: "close" }, parentOrigin);
  }

  const containerStyle = useMemo<React.CSSProperties>(
    () => ({
      // The iframe's own dimensions are controlled by the parent loader,
      // we just fill the available space.
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      background: "#ffffff",
      color: "#0f172a",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize: "14px",
      lineHeight: 1.45,
      overflow: "hidden",
      borderRadius: embedded ? "16px" : "0",
      boxShadow: embedded ? "0 16px 48px -12px rgba(15,23,42,0.25)" : "none",
    }),
    [embedded]
  );

  return (
    <div style={containerStyle}>
      <style>{`
        .lswc-bubble {
          max-width: 80%;
          padding: 10px 14px;
          border-radius: 16px;
          word-wrap: break-word;
          white-space: pre-wrap;
        }
        .lswc-bubble-assistant {
          background: #f1f5f9;
          color: #0f172a;
          border-bottom-left-radius: 4px;
        }
        .lswc-bubble-user {
          background: ${accentColor};
          color: ${onAccent};
          align-self: flex-end;
          border-bottom-right-radius: 4px;
        }
        .lswc-row {
          display: flex;
          margin-top: 10px;
        }
        .lswc-row-user { justify-content: flex-end; }
        .lswc-row-assistant { justify-content: flex-start; }
        @keyframes lswc-pulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
        .lswc-typing-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          margin: 0 2px;
          border-radius: 50%;
          background: #94a3b8;
          animation: lswc-pulse 1.2s infinite ease-in-out;
        }
        .lswc-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .lswc-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes lswc-voice-pulse {
          0% { box-shadow: 0 0 0 0 ${accentColor}66; }
          70% { box-shadow: 0 0 0 8px ${accentColor}00; }
          100% { box-shadow: 0 0 0 0 ${accentColor}00; }
        }
        .lswc-voice-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: ${accentColor};
          animation: lswc-voice-pulse 1.4s infinite;
          flex-shrink: 0;
        }
      `}</style>

      {/* Header */}
      <div
        style={{
          background: accentColor,
          color: onAccent,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background:
                onAccent === "#ffffff"
                  ? "rgba(255,255,255,0.2)"
                  : "rgba(15,23,42,0.08)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
            }}
            aria-hidden
          >
            💬
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Chat with us</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>
              We typically reply instantly
            </div>
          </div>
        </div>
        {embedded && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close chat"
            style={{
              background: "transparent",
              color: onAccent,
              border: 0,
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              padding: 4,
              opacity: 0.9,
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* Message scroller */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px",
          background: "#fbfbfd",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {messages.map((m) => (
          <div key={m.id}>
            <div className={`lswc-row lswc-row-${m.role}`}>
              <div className={`lswc-bubble lswc-bubble-${m.role}`}>
                {m.text}
              </div>
            </div>
            {m.role === "assistant" && m.formFields && (
              <InlineCaptureForm
                fields={m.formFields}
                accentColor={accentColor}
                onSubmit={(payload) => handleCaptureFormDone(m.id, payload)}
                onSkip={() => handleCaptureFormDone(m.id, { skip: true })}
              />
            )}
          </div>
        ))}
        {sending && (
          <div className="lswc-row lswc-row-assistant">
            <div
              className="lswc-bubble lswc-bubble-assistant"
              aria-label="Assistant is typing"
            >
              <span className="lswc-typing-dot" />
              <span className="lswc-typing-dot" />
              <span className="lswc-typing-dot" />
            </div>
          </div>
        )}
        {handoffNote && !sending && (
          <div
            style={{
              textAlign: "center",
              fontSize: 11,
              color: "#94a3b8",
              margin: "10px 4px 4px",
            }}
            role="status"
          >
            {handoffNote}
          </div>
        )}
      </div>

      {/* Web Voice status bar — only while a voice conversation is live. */}
      {voiceActive && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          <span className="lswc-voice-dot" aria-hidden />
          <span style={{ flex: 1, color: "#334155" }}>
            {voiceStatus === "connecting"
              ? "Connecting…"
              : voiceStatus === "speaking"
                ? "Speaking…"
                : "Listening — go ahead and talk"}
          </span>
          {voiceStatus !== "connecting" && (
            <span
              style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}
            >
              {formatClock(voiceElapsed)}
              {voiceMaxSeconds > 0 ? ` / ${formatClock(voiceMaxSeconds)}` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => void stopVoice()}
            aria-label="End voice chat"
            style={{
              background: "#ef4444",
              color: "white",
              border: 0,
              borderRadius: 8,
              padding: "5px 10px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            End
          </button>
        </div>
      )}
      {voiceNote && !voiceActive && (
        <div
          role="status"
          style={{
            fontSize: 11,
            color: "#64748b",
            padding: "6px 12px",
            borderTop: "1px solid #e2e8f0",
            background: "#f8fafc",
            flexShrink: 0,
          }}
        >
          {voiceNote}
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 12px",
          borderTop: "1px solid #e2e8f0",
          background: "white",
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            voiceActive
              ? "Voice chat in progress…"
              : sending
                ? "Waiting for reply…"
                : "Type a message…"
          }
          disabled={sending || !sessionId || voiceActive}
          aria-label="Type a message"
          style={{
            flex: 1,
            padding: "10px 12px",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            outline: "none",
            fontSize: 14,
            background: "white",
            color: "#0f172a",
          }}
        />
        {voiceToken && !voiceActive && (
          <button
            type="button"
            onClick={() => void startVoice()}
            disabled={sending || !sessionId || !voiceSdkReady}
            aria-label="Talk to us (voice)"
            title="Talk instead of typing"
            style={{
              background: "white",
              color: accentInk,
              border: `1px solid ${accentInk}`,
              borderRadius: 10,
              padding: "0 10px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: sending || !voiceSdkReady ? "not-allowed" : "pointer",
              opacity: sending || !voiceSdkReady ? 0.5 : 1,
            }}
          >
            <MicIcon />
          </button>
        )}
        <button
          type="submit"
          disabled={sending || !input.trim() || !sessionId || voiceActive}
          aria-label="Send"
          style={{
            background: accentColor,
            color: onAccent,
            border: 0,
            borderRadius: 10,
            padding: "0 16px",
            fontSize: 16,
            cursor: sending || !input.trim() ? "not-allowed" : "pointer",
            opacity: sending || !input.trim() ? 0.5 : 1,
          }}
        >
          ↑
        </button>
      </form>

      {errored && (
        <div
          style={{
            background: "#fef2f2",
            color: "#b91c1c",
            fontSize: 11,
            padding: "4px 12px",
            textAlign: "center",
          }}
          role="status"
        >
          Connection issue — your message may not have been delivered.
        </div>
      )}
    </div>
  );
}

/**
 * Inline capture form rendered below a bot reply when the LLM emitted
 * a [[form fields="…"]] marker. Visitor fills the requested fields and
 * clicks "Send details" — or skips. Both go to /api/web-chat/capture.
 */
function InlineCaptureForm(props: {
  fields: CaptureFieldId[];
  accentColor: string;
  onSubmit: (payload: {
    name?: string;
    email?: string;
    phone?: string;
  }) => void;
  onSkip: () => void;
}) {
  const { fields, accentColor, onSubmit, onSkip } = props;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const labelFor: Record<CaptureFieldId, string> = {
    name: "Your name",
    email: "Email address",
    phone: "Phone number",
  };
  const placeholderFor: Record<CaptureFieldId, string> = {
    name: "Jane Smith",
    email: "jane@example.com",
    phone: "+61 400 000 000",
  };
  const typeFor: Record<CaptureFieldId, string> = {
    name: "text",
    email: "email",
    phone: "tel",
  };
  const valueFor: Record<CaptureFieldId, string> = {
    name,
    email,
    phone,
  };
  const setterFor: Record<CaptureFieldId, (v: string) => void> = {
    name: setName,
    email: setEmail,
    phone: setPhone,
  };

  // Submit is enabled when at least email OR phone is filled (server
  // requires one of these — name alone isn't enough to follow up).
  const canSubmit =
    !submitting &&
    (!fields.includes("email") || email.trim().length > 0 ? true : false) &&
    (!fields.includes("phone") || phone.trim().length > 0 ? true : false) &&
    (email.trim().length > 0 || phone.trim().length > 0);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    onSubmit({
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        marginTop: 8,
        marginLeft: 0,
        marginRight: 0,
        padding: 14,
        background: "white",
        border: "1px solid #e2e8f0",
        borderRadius: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {fields.map((f) => (
        <label
          key={f}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
            {labelFor[f]}
          </span>
          <input
            type={typeFor[f]}
            value={valueFor[f]}
            onChange={(e) => setterFor[f](e.target.value)}
            placeholder={placeholderFor[f]}
            disabled={submitting}
            required={f === "email" || f === "phone"}
            style={{
              padding: "8px 10px",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              fontSize: 14,
              outline: "none",
              background: "white",
              color: "#0f172a",
            }}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            flex: 1,
            background: accentColor,
            color: textOnAccent(accentColor),
            border: 0,
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {submitting ? "Sending…" : "Send details"}
        </button>
        <button
          type="button"
          onClick={() => {
            setSubmitting(true);
            onSkip();
          }}
          disabled={submitting}
          style={{
            background: "transparent",
            color: "#64748b",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: "9px 12px",
            fontSize: 13,
            cursor: submitting ? "not-allowed" : "pointer",
          }}
        >
          Skip
        </button>
      </div>
    </form>
  );
}
