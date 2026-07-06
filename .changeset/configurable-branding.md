---
"@crabd/config": minor
"@crabd/core": minor
"@crabd/action": minor
---

Make crab'd's comment branding configurable. A new `appearance` config section sets the display
name (`appearance.name`), the brand emoji prefixed to comments (`appearance.emoji` — set to `""` to
remove it), and whether the `posted by` footer is shown (`appearance.footer`). Defaults reproduce the
current look (`crab'd` / `🦀` / footer on). Status glyphs (⚠️/⏳/➡️) are unaffected, and the hidden
tracking marker is always kept so sticky comment reuse still works even with the footer off.
