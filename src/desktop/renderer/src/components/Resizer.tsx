import { useRef } from 'react';

interface ResizerProps {
  label: string;
  /** The width of the pane it resizes. */
  value: number;
  /** Which way dragging makes the pane wider. */
  grows: 'left' | 'right';
  onChange(value: number): void;
  /** Double-click: back to the default width. */
  onReset(): void;
}

/** A handle between two panes: drag it, or focus it and use the arrow keys. */
export function Resizer({ label, value, grows, onChange, onReset }: ResizerProps) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const sign = grows === 'right' ? 1 : -1;
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, start: value };
        document.body.classList.add('resizing');
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onChange(drag.current.start + sign * (event.clientX - drag.current.x));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        document.body.classList.remove('resizing');
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === 'ArrowLeft') onChange(value - sign * step);
        else if (event.key === 'ArrowRight') onChange(value + sign * step);
        else return;
        event.preventDefault();
      }}
    />
  );
}
