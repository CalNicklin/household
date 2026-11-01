import { useId, useRef, useState } from "react";
import { Button } from "./controls.tsx";
import { CloseIcon, MicIcon } from "./icons.tsx";

type RecognitionResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  addEventListener(type: "result", listener: (event: RecognitionResult) => void): void;
  addEventListener(type: "end" | "error", listener: () => void): void;
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
 * Always present: type or talk, the same way in (MOM-8). Speech becomes text and is sent exactly
 * like typing, flagged `spoken`.
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
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const send = (value: string, spoken: boolean) => {
    const trimmed = value.trim();
    if (trimmed === "") return;
    onSend(trimmed, spoken);
    setText("");
  };

  const talk = () => {
    const Ctor = speechRecognition();
    if (Ctor === null) {
      // No speech API: the keyboard's own dictation works in the text box.
      input.current?.focus();
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-GB";
    recognition.interimResults = false;
    recognition.addEventListener("result", (event) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ");
      send(transcript, true);
    });
    recognition.addEventListener("end", () => setListening(false));
    recognition.addEventListener("error", () => setListening(false));
    setListening(true);
    recognition.start();
  };

  return (
    <form
      className="ds-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send(text, false);
      }}
    >
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
      <input ref={input} id={id} className="ds-composer__input" type="text" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} enterKeyHint="send" autoComplete="off" />
      <Button variant="ink" label={listening ? "Listening" : "Talk"} onClick={talk}>
        <MicIcon size={22} tone="ink" />
      </Button>
    </form>
  );
}

/**
 * The house's answer, right above the composer where you are looking (MOM-2, HOU-149). A `what_now`
 * answer is the one thing in big type and its reason under it; anything else is one plain line.
 * Planner-made, so green, with a no-guilt dismiss. `onDismiss` null while the house is still thinking.
 */
export function Answer({ heading, title, detail, onDismiss }: { heading: string; title: string | null; detail: string; onDismiss: (() => void) | null }) {
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
