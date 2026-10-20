## Desktop UI Design Rules

Stack: Electron, React, TypeScript, Tailwind CSS.

Visual direction:
- Build premium desktop software inspired by Linear (70%) and Notion (30%).
- Prefer functional, calm, minimal interfaces over flashy designs.
- Avoid generic AI-generated dashboards.

Layout:
- Use a compact sidebar (220–240px).
- Keep top toolbars around 40–48px high.
- Prefer lists, tables, split panes and subtle separators.
- Avoid excessive nesting of cards.
- Use a consistent 4px/8px spacing system.
- Keep information density moderately high.

Visual style:
- Neutral gray backgrounds, subtle 1px borders.
- One restrained accent color.
- Compact controls, refined typography, consistent icons.
- Border radius generally 6–8px.
- No gradients, glassmorphism, glow or heavy shadows.
- Use restrained animation (120–180ms).

Electron:
- Preserve native platform window controls.
- Support window dragging through designated regions.
- Ensure interactive elements are excluded from drag regions.
- Support keyboard shortcuts, focus states and context menus.
- Respect operating system light/dark preferences.

Implementation:
- Prefer reusable React components and design tokens.
- Use existing project libraries before adding dependencies.
- Maintain accessibility and responsive behavior at smaller window sizes.
- Review the interface for alignment, spacing and unnecessary decoration before finishing.

Goal: Make the product feel like a polished, professional desktop application, not a website inside an Electron window.