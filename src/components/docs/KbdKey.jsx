/**
 * KbdKey — inline keyboard shortcut badge.
 * Usage: <KbdKey>S</KbdKey>  or  <KbdKey>⌘ + K</KbdKey>
 */
export function KbdKey({ children }) {
  return (
    <kbd className="inline-flex items-center font-mono text-[11px] bg-ink-100 text-ink-700 border border-ink-300 rounded px-1.5 py-0.5">
      {children}
    </kbd>
  );
}
