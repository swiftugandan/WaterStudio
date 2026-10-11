import { useApp } from '../app/context.tsx';

export function MessagesPanel() {
  const { state } = useApp();
  return (
    <div className="panel messages" role="log" aria-live="polite" aria-label="Messages">
      {state.messages.length === 0 && <p className="muted">No messages.</p>}
      <ul>
        {state.messages
          .slice()
          .reverse()
          .map((m, i) => (
            <li key={`${m.time}-${i}`} className={m.level}>
              <time>{new Date(m.time).toLocaleTimeString()}</time> {m.text}
            </li>
          ))}
      </ul>
    </div>
  );
}
