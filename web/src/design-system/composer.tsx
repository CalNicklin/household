import { useId, useRef, useState } from "react";
import { Button } from "./controls.tsx";
import { CloseIcon, MicIcon, SendIcon } from "./icons.tsx";

type RecognitionResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type RecognitionError = { error?: string };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  addEventListener(type: "result", listener: (event: RecognitionResult) => void): void;
  addEventListener(type: "error", listener: (event: RecognitionError) => void): void;
  addEventListener(type: "end", listener: () => void): void;
  start: () => void;
  stop: () => void;
};
type RecognitionCtor = new () => Recognition;

function isCtor(value: unknown): value is RecognitionCtor {
  return typeof value === "function";
}

/** The Web Speech API where the browser has it (Safari and Chrome both do, prefixed). */
function speechRecognition(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const ctor: unknown = Reflect.get(window, "SpeechRecognition") ?? Reflect.get(window, "webkitSpeechRecognition");
  return isCtor(ctor) ? ctor : null;
}

/**
 * HOU-159: what the line under the composer says when the mic can't be used. The keyboard's own
 * dictation always works in the text box, so every line points there.
 */
const MIC_LINES = {
  listening: "Listening…",
  missing: "Voice isn't available in this browser. Tap the keyboard's mic to dictate instead.",
  blocked: "The microphone is turned off for this app. Allow it in Settings, or tap the keyboard's mic.",
  unheard: "Couldn't hear that — try the keyboard's mic.",
} as const;
type MicLine = keyof typeof MIC_LINES;

/**
 * Speech error codes from the Web Speech API. `service-not-allowed` is what Safari gives when speech
 * recognition can't run at all (for instance in some home-screen apps), so it reads as "not here".
 */
function lineForError(code: string | undefined): MicLine {
  if (code === "not-allowed") return "blocked";
  if (code === "service-not-allowed") return "missing";
  return "unheard";
}

/**
 * Always present: type or talk, the same way in (MOM-8). Speech becomes text and is sent exactly
 * like typing, flagged `spoken`. HOU-159: with text in the box the button is Send; with the box
 * empty it is the mic, and the mic always says what it is doing or why it can't.
 */
export function Composer({
  placeholder,
  label = "Tell the house something",
  about,
  onClearAbout,
  onSend,
}: {
  placeholder: string;
  label?: string;
  about: string | null;
  onClearAbout: () => void;
  onSend: (text: string, spoken: boolean) => void;
}) {
  const id = useId();
  const noteId = useId();
  const [text, setText] = useState("");
  const [line, setLine] = useState<MicLine | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<Recognition | null>(null);

  const send = (value: string, spoken: boolean) => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    onSend(trimmed, spoken);
    setText("");
  };

  const giveUp = (why: MicLine) => {
    active.current = null;
    setLine(why);
    input.current?.focus();
  };

  const talk = () => {
    if (active.current !== null) {
      // Tapped again while listening: stop, quietly.
      const stopping = active.current;
      active.current = null;
      setLine(null);
      stopping.stop();
      return;
    }
    const Ctor = speechRecognition();
    if (Ctor === null) {
      giveUp("missing");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-GB";
    recognition.interimResults = false;
    recognition.continuous = false;
    let outcome: "heard" | "failed" | null = null;
    recognition.addEventListener("result", (event) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript === "") return;
      outcome = "heard";
      send(transcript, true);
    });
    recognition.addEventListener("error", (event) => {
      outcome = "failed";
      giveUp(lineForError(event.error));
    });
    recognition.addEventListener("end", () => {
      if (active.current !== recognition) return;
      active.current = null;
      if (outcome === "heard") setLine(null);
      // Ended with nothing heard and no error: say so rather than doing nothing.
      else if (outcome === null) giveUp("unheard");
    });
    active.current = recognition;
    setLine("listening");
    try {
      recognition.start();
    } catch {
      giveUp("unheard");
    }
  };

  const listening = line === "listening";
  const hasText = text.trim() !== "";

  return (
    <form
      className="ds-composer-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        send(text, false);
      }}
    >
      <div className={listening ? "ds-composer ds-composer--listening" : "ds-composer"}>
        <label htmlFor={id} className="ds-visually-hidden">
          {label}
        </label>
        {about === null ? null : (
          <span className="ds-composer__about">
            About: {about}
            <Button variant="link" label="Stop talking about this" onClick={onClearAbout}>
              <CloseIcon size={14} tone="suggestion" />
            </Button>
          </span>
        )}
        <input
          ref={input}
          id={id}
          className="ds-composer__input"
          type="text"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            if (line !== null && line !== "listening") setLine(null);
          }}
          enterKeyHint="send"
          autoComplete="off"
          aria-describedby={line === null ? undefined : noteId}
        />
        {hasText ? (
          <Button variant="ink" type="submit" label="Send">
            <SendIcon size={22} tone="ink" />
          </Button>
        ) : (
          <Button variant="ink" label={listening ? "Stop listening" : "Talk"} onClick={talk}>
            <MicIcon size={22} tone="ink" />
          </Button>
        )}
      </div>
      <p id={noteId} className={line === null ? "ds-visually-hidden" : "ds-composer__note"} aria-live="polite">
        {line === null ? "" : MIC_LINES[line]}
      </p>
    </form>
  );
}

/** One of today's exchanges, ready to show: what you said, and the house's side of it. */
export type ExchangeLine = {
  id: string;
  /** Null when message retention is off and the words were never kept (PRV-5). */
  said: string | null;
  /** Null when the house had nothing to say back. */
  house: { heading: string; title: string | null; detail: string } | null;
};

/**
 * HOU-159: today's conversation with the house, right above the composer on every screen. The last
 * few exchanges, oldest first; the newest answer is the big one where you are looking (HOU-149).
 * Collapsed, it is one quiet link. Planner-made, so the suggestion green throughout.
 */
export function Conversation({ exchanges, total, open, onOpen, onClose }: { exchanges: readonly ExchangeLine[]; total: number; open: boolean; onOpen: () => void; onClose: () => void }) {
  if (!open || exchanges.length === 0) {
    if (total === 0) return null;
    return (
      <button type="button" className="ds-conversation__toggle" aria-expanded={false} onClick={onOpen}>
        Today with the house · {total}
      </button>
    );
  }
  const earlier = exchanges.slice(0, -1);
  const latest = exchanges.at(-1);
  return (
    <section className="ds-conversation" aria-label="Today with the house">
      {earlier.length === 0 ? null : (
        <div className="ds-conversation__scroll">
          <ol className="ds-conversation__earlier">
            {earlier.map((e) => (
              <li key={e.id} className="ds-conversation__exchange">
                {e.said === null ? null : <Said text={e.said} />}
                {e.house === null ? null : <p className="ds-conversation__house">{e.house.title === null ? e.house.detail : `${e.house.title}. ${e.house.detail}`}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {latest === undefined ? null : (
        <>
          {latest.said === null ? null : <Said text={latest.said} />}
          {latest.house === null ? null : <Answer heading={latest.house.heading} title={latest.house.title} detail={latest.house.detail} onDismiss={onClose} />}
        </>
      )}
    </section>
  );
}

function Said({ text }: { text: string }) {
  return (
    <p className="ds-conversation__said">
      <span className="ds-visually-hidden">You said: </span>“{text}”
    </p>
  );
}

/**
 * The house's answer, right above the composer where you are looking (MOM-2, HOU-149). A `what_now`
 * answer is the one thing in big type and its reason under it; anything else is one plain line.
 * Planner-made, so green, with a no-guilt dismiss (`onDismiss` null leaves it out).
 */
function Answer({ heading, title, detail, onDismiss }: { heading: string; title: string | null; detail: string; onDismiss: (() => void) | null }) {
  return (
    <section className="ds-answer" role="status" aria-live="polite" aria-label="The house's answer">
      <div className="ds-answer__head">
        <span className="ds-answer__eyebrow">{heading}</span>
        {onDismiss === null ? null : (
          <Button variant="link" label="Hide this answer" onClick={onDismiss}>
            <CloseIcon size={18} tone="suggestion" />
          </Button>
        )}
      </div>
      {title === null ? null : <p className="ds-answer__title">{title}</p>}
      {detail === "" ? null : <p className={title === null ? "ds-answer__text" : "ds-answer__why"}>{detail}</p>}
    </section>
  );
}
