// Settings → Keyboard: every shortcut, from the same list the app binds.
import { Keys } from "@/components/shortcuts";
import { Page, Section } from "@/components/settings/parts";
import { COMPOSER_KEYS, SHORTCUTS } from "@/lib/shortcuts";

export function KeyboardSettings() {
  const sections = [
    { title: "Anywhere", about: "With the modifier, these work even while you type.", rows: Object.values(SHORTCUTS) },
    { title: "In the message box", rows: COMPOSER_KEYS },
  ];
  return (
    <Page>
      {sections.map((s) => (
        <Section key={s.title} title={s.title} about={s.about}>
          <ul className="flex flex-col divide-y rounded-lg border">
            {s.rows.map((r) => (
              <li key={r.label + r.keys.join()} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                <span>{r.label}</span>
                <Keys keys={r.keys} />
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </Page>
  );
}
