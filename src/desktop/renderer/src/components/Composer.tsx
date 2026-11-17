import { useLayoutEffect, useRef, useState } from 'react';

const MAX_HEIGHT = 240;

interface ComposerProps {
  placeholder: string;
  label: string;
  onSend(text: string): Promise<void>;
  testId?: string;
}

/** A message box: Enter sends, Shift+Enter starts a new line. */
export function Composer({ placeholder, label, onSend, testId }: ComposerProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // Grow with the text (borders included) up to a limit, and only then scroll.
    element.style.height = 'auto';
    const wanted = element.scrollHeight + element.offsetHeight - element.clientHeight;
    element.style.height = `${Math.min(wanted, MAX_HEIGHT)}px`;
    element.style.overflowY = wanted > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(message);
      setText('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  return (
    <form
      className="composer"
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {error && <p className="composer-error" role="alert">{error}</p>}
      <div className="composer-row">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="primary" disabled={sending || !text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}
