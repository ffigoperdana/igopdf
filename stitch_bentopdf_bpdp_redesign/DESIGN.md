---
name: BentoPDF Official
colors:
  surface: '#f8faf4'
  surface-dim: '#d9dbd5'
  surface-bright: '#f8faf4'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4ee'
  surface-container: '#edefe9'
  surface-container-high: '#e7e9e3'
  surface-container-highest: '#e1e3dd'
  on-surface: '#191c19'
  on-surface-variant: '#414941'
  inverse-surface: '#2e312d'
  inverse-on-surface: '#eff1eb'
  outline: '#717970'
  outline-variant: '#c0c9be'
  surface-tint: '#336941'
  primary: '#003e1b'
  on-primary: '#ffffff'
  primary-container: '#1f5630'
  on-primary-container: '#90ca99'
  inverse-primary: '#9ad4a3'
  secondary: '#944a00'
  on-secondary: '#ffffff'
  secondary-container: '#fc8f34'
  on-secondary-container: '#663100'
  tertiary: '#5b222f'
  on-tertiary: '#ffffff'
  tertiary-container: '#773845'
  on-tertiary-container: '#f9a5b3'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#b5f1be'
  primary-fixed-dim: '#9ad4a3'
  on-primary-fixed: '#00210b'
  on-primary-fixed-variant: '#19512b'
  secondary-fixed: '#ffdcc5'
  secondary-fixed-dim: '#ffb783'
  on-secondary-fixed: '#301400'
  on-secondary-fixed-variant: '#713700'
  tertiary-fixed: '#ffd9de'
  tertiary-fixed-dim: '#ffb2be'
  on-tertiary-fixed: '#3a0816'
  on-tertiary-fixed-variant: '#713340'
  background: '#f8faf4'
  on-background: '#191c19'
  surface-variant: '#e1e3dd'
  deep-forest: '#1F5630'
  vibrant-palm: '#E67E22'
  ink-slate: '#111827'
  paper-white: '#FFFFFF'
  surface-gray: '#F9FAFB'
typography:
  headline-xl:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: '800'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Public Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Public Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
  headline-md:
    fontFamily: Public Sans
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  body-lg:
    fontFamily: Public Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Public Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-bold:
    fontFamily: Public Sans
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 20px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Public Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  container-max: 1280px
  gutter: 1.5rem
  margin-mobile: 1rem
  stack-sm: 0.5rem
  stack-md: 1.5rem
  stack-lg: 4rem
---

## Brand & Style

This design system blends **Corporate Modernism** with a **High-Contrast** functional aesthetic. Designed for BentoPDF, it balances the authoritative presence of a government-affiliated institution with the efficiency of a high-performance document tool. 

The personality is reliable, structured, and institutional. It uses deep, forest greens to convey stability and vibrant oranges to signal action and interactivity. The visual language is defined by clarity, generous vertical rhythm, and a rigid adherence to hierarchy, ensuring that complex data and document management tasks feel manageable and secure.

## Colors

The palette is anchored by **Deep Forest** (#1F5630), used for primary branding, navigation backgrounds, and structural footers to establish trust. **Vibrant Palm** (#E67E22) is the primary action color, reserved for high-priority calls to action, buttons, and highlighting key statistics to drive user engagement.

Neutral tones rely on **Ink Slate** (#111827) for high-legibility text and **Paper White** (#FFFFFF) for clean, breathable backgrounds. A secondary neutral, **Surface Gray** (#F9FAFB), is utilized for background sectioning to maintain visual organization without introducing clutter.

## Typography

This design system utilizes **Public Sans** across all levels to maintain a clean, institutional, and highly readable feel. It is a neutral, typeface that scales perfectly from dense data tables to large marketing headlines.

Headlines use heavy weights (700-800) to command attention against the deep primary colors. Labels are frequently set in uppercase with increased letter-spacing to denote categories and section headers, mimicking the authoritative style of official documentation.

## Layout & Spacing

The layout follows a **Fixed Grid** model for desktop, centered within a 1280px container, utilizing a 12-column structure. Spacing is strictly governed by an 8px base unit to ensure alignment across complex components.

Vertical rhythm is prioritized, with large "Stack" increments used to separate major content blocks, creating the "Bento" effect of distinct, contained information modules. Mobile layouts collapse to a single column with reduced horizontal margins (16px) while maintaining vertical padding to ensure touch-targets remain accessible.

## Elevation & Depth

To maintain a professional and clean appearance, the design system avoids heavy shadows. Instead, it uses **Tonal Layers** and **Low-Contrast Outlines** to create hierarchy.

- **Level 0 (Base):** Paper White or Surface Gray backgrounds.
- **Level 1 (Cards):** Defined by a subtle 1px border (#E5E7EB) or a slight tonal shift to white when on a gray background.
- **Level 2 (Interactive):** Elements like dropdowns or active cards use a soft, ultra-diffused shadow (0px 4px 20px rgba(0,0,0,0.05)) to suggest lift without looking dated.
- **Inverted Depth:** Large sections (Hero, Footer) use solid Deep Forest backgrounds to anchor the page, creating a sense of "immersion" rather than elevation.

## Shapes

The shape language is **Soft (0.25rem)**. This subtle rounding provides a modern touch to the otherwise rigid corporate structure, making the interface feel accessible but disciplined. 

Larger components like containers or hero sections may utilize `rounded-lg` (0.5rem) to soften large blocks of color, while buttons and input fields stay strictly within the base `rounded` (0.25rem) to maintain a crisp, professional edge.

## Components

### Buttons
- **Primary:** Solid Vibrant Palm with white text. High-contrast, no shadow.
- **Secondary:** Solid Deep Forest with white text. Used for secondary navigation or sub-actions.
- **Outline:** 1.5px border in Deep Forest or White (on dark backgrounds). Clear and lightweight.

### Cards
Cards are the core of the "Bento" layout. They should feature generous internal padding (24px - 32px), a 1px neutral border, and be utilized to group related statistics, document previews, or news snippets.

### Input Fields
Inputs should be clean with 1px gray borders, turning to Deep Forest on focus. Use Label-Bold typography above the fields for clear identification.

### Navigation
The navigation bar is either transparent (over Hero images) or Deep Forest. Links should be white with a Vibrant Palm bottom-border underline (3px) on hover or active state to maintain the brand's signature accent style.

### Lists & Data
Lists should use alternating background rows (Surface Gray and Paper White) or thin horizontal dividers to ensure legibility in data-heavy PDF management views.