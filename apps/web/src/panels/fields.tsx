/**
 * Form rows shared by the editors: a labelled row with unit and error, and a text input
 * that commits on Enter or when it loses focus and reverts on Escape. The commit
 * callback returns an error message to keep the typed text and show it, or nothing.
 */

import { useEffect, useId, useState, type ReactNode } from 'react';

export function Row({
  label,
  help,
  unit,
  error,
  htmlFor,
  children,
}: {
  label: string;
  help?: string;
  unit?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field-row${error ? ' invalid' : ''}`}>
      {htmlFor ? (
        <label htmlFor={htmlFor} title={help}>
          {label}
        </label>
      ) : (
        <span className="label" title={help}>
          {label}
        </span>
      )}
      <div className="field-control">
        {children}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {error && (
        <div className="field-error" id={htmlFor ? `${htmlFor}-err` : undefined} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function CommitInput({
  id,
  value,
  placeholder,
  onCommit,
  onError,
  numeric,
  label,
  className,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  /** Returns an error message to reject the text. */
  onCommit: (text: string) => string | undefined;
  onError?: (error: string | null) => void;
  numeric?: boolean;
  /** Accessible name when the input has no visible label. */
  label?: string;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  const report = (e: string | null) => {
    setError(e);
    onError?.(e);
  };
  return (
    <input
      id={id}
      type="text"
      className={className}
      inputMode={numeric ? 'decimal' : 'text'}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={error !== null}
      aria-describedby={error && id ? `${id}-err` : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text === value) {
          if (error) report(null);
          return;
        }
        const err = onCommit(text);
        report(err ?? null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value);
          report(null);
        }
      }}
    />
  );
}

/** A row holding one CommitInput, with the error shown under it. */
export function InputRow(props: {
  label: string;
  help?: string;
  unit?: string;
  value: string;
  placeholder?: string;
  numeric?: boolean;
  onCommit: (text: string) => string | undefined;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  return (
    <Row
      label={props.label}
      error={error}
      htmlFor={id}
      {...(props.help ? { help: props.help } : {})}
      {...(props.unit ? { unit: props.unit } : {})}
    >
      <CommitInput
        id={id}
        value={props.value}
        onCommit={props.onCommit}
        onError={setError}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.numeric ? { numeric: true } : {})}
      />
    </Row>
  );
}
