import { useTheme } from "../../lib/useTheme";

// Note binding, editing and native persistence arrive with V4. A standalone
// entry opened without a bound note must not invent content or claim a save.
export function StickyApp() {
  useTheme();
  return (
    <main className="sticky-surface" aria-label="Sticky note">
      <h1 className="type-heading">No note selected</h1>
      <p className="type-body text-secondary">Open a note from Nabbit to keep it here.</p>
    </main>
  );
}
