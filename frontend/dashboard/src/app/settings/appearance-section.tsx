"use client";

import ThemeCustomizer from "@/components/theme/theme-customizer";
import { useThemeOptional } from "@/components/theme/theme-provider";
import { accentOf, backgroundOf } from "@/lib/theme";
import { Card, ReadOnly } from "./settings-ui";

// Appearance & Theme: the SAME customizer as the header's palette button, on the same state, so a choice made in one place is what the other shows.
// The theme is the administrator's own (saved to their account, not the organization's): it never changes what another administrator sees.
export default function AppearanceSection() {
  const theme = useThemeOptional();
  if (!theme) return null;
  const background = backgroundOf(theme.saved.background), accent = accentOf(theme.saved.accent);
  return (
    <Card id="appearance" title="Appearance & Theme" description="Choose the background and the accent color of your portal. The choice is saved to your own account, follows you to every device, and never changes what another administrator sees.">
      <dl className="mb-6 grid gap-3 sm:grid-cols-2">
        <ReadOnly label="Current background" value={`${background.name} ${background.hex}`} />
        <ReadOnly label="Current accent" value={`${accent.name} ${accent.hex}`} />
      </dl>
      <ThemeCustomizer variant="inline" />
    </Card>
  );
}
