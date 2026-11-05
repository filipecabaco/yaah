// The number on a docked permission button; the button's name stays the option's own words.
export function KeyCap({ n }: { n: number | string }) {
  return (
    <kbd aria-hidden className="mr-1 rounded border border-current/30 px-1 font-mono text-2xs opacity-80">
      {n}
    </kbd>
  );
}
