---
name: Co-Sign UI Overhaul PRD
overview: A comprehensive, incrementally-implementable PRD for overhauling the Co-Sign Checkout demo from a static prototype to an Apple-tier polished product, organized from highest to lowest value with build verification at each step.
todos:
  - id: decompose
    content: "Component decomposition: break CosignDemoApp.tsx monolith into ~12 focused components"
    status: pending
  - id: inline-errors
    content: "Inline wallet action validation in-context with red messaging + subtle shake micro-interaction"
    status: completed
  - id: install-tier1
    content: "Install Tier 1 deps: motion, sonner, lucide-react"
    status: completed
  - id: sonner-toasts
    content: Replace 33 setSystemMessage calls with sonner toasts (keep banner for persistent status)
    status: completed
  - id: lucide-icons
    content: Add lucide-react icons to all buttons, badges, InfoHint, and nav elements
    status: completed
  - id: motion-buttons
    content: Add motion whileHover/whileTap press states to all buttons
    status: completed
  - id: motion-modal
    content: AnimatePresence on submit confirmation modal with spring scale/fade
    status: completed
  - id: motion-cards
    content: Replace CSS card-enter keyframe with motion.div entrance animations
    status: pending
  - id: motion-carousel
    content: AnimatePresence on onboarding carousel with directional slide
    status: completed
  - id: motion-progress
    content: Animate proposal progress bar width with spring physics
    status: completed
  - id: motion-feed
    content: Staggered whileInView entrance for activity feed items
    status: completed
  - id: motion-devconsole
    content: AnimatePresence expand/collapse on developer console
    status: completed
  - id: motion-roomlist
    content: Layout animation on room list items
    status: completed
  - id: css-polish
    content: "CSS polish: card transitions, custom scrollbar, focus rings"
    status: completed
  - id: skeletons
    content: Loading skeleton states for cart list, balances, activity feed
    status: pending
  - id: dark-mode
    content: "Dark mode with next-themes: CSS variables, Tailwind dark, toggle button"
    status: pending
  - id: mobile-drawer
    content: "Responsive confirmation: vaul drawer on mobile, modal on desktop"
    status: pending
  - id: copy-feedback
    content: Copy button animated feedback with icon swap
    status: completed
  - id: empty-states
    content: Empty state illustrations with lucide icons
    status: pending
  - id: cmd-palette
    content: Command palette (cmdk) for room nav and quick actions
    status: pending
  - id: keyboard-nav
    content: "Keyboard navigation: arrow keys for carousel and room list, Escape for modal"
    status: pending
isProject: false
---

# Co-Sign Checkout Demo -- UI Overhaul PRD

## Current State Assessment

The app is a **2,773-line single-file monolith** ([CosignDemoApp.tsx](cosign-demo/src/components/CosignDemoApp.tsx)) with:

- Solid glassmorphism CSS foundation in [globals.css](cosign-demo/src/app/globals.css) (CSS variables, backdrop-filter, glass blur)
- 33 `setSystemMessage()` calls funneling ALL feedback (success, errors, warnings) into one yellow banner
- 21 `InfoHint` tooltip instances using plain "i" text
- No animation library -- modal appears/disappears instantly, onboarding has no transitions
- No icon library -- all buttons are text-only
- No dark mode support
- No mobile-optimized patterns (bottom sheets, drawers)
- Basic CSS `card-enter` keyframe as only animation

**Stack**: Next.js 15.5, React 19, TypeScript, Tailwind CSS 3.4, no animation/icon/toast libraries.

---

## Architecture Prerequisite: Component Decomposition

Before UI enhancements, the monolith must be broken into manageable components. This unlocks all subsequent work by scoping changes and reducing risk.

**Target structure for `src/components/`:**

```
components/
  CosignDemoApp.tsx           (orchestrator, ~400 lines of state + glue)
  HeroHeader.tsx              (lines 2000-2057: branding, wallet connect, system banner)
  OnboardingCarousel.tsx      (lines 2059-2099: slides, dots, nav)
  CreateCartForm.tsx           (lines 2103-2139: counterparty input, asset select)
  CartList.tsx                 (lines 2141-2189: room list sidebar)
  FriendSessions.tsx          (lines 2191-2224: sessions with friends)
  CartWorkspace.tsx           (lines 2227-2505: shoppers, status, actions, proposal, activity)
  SharedWallet.tsx            (lines 2507-2655: deposit/withdraw/transfer, balances, channels)
  WalletActivity.tsx          (lines 2657-2679: recent ledger entries)
  DevConsole.tsx              (lines 2683-2768: developer debug panel)
  SubmitConfirmModal.tsx      (lines 2771-2818: confirmation dialog)
  InfoHint.tsx                (lines 240-261: extract existing)
  ui/
    Badge.tsx                  (status badge rendering)
    ProgressBar.tsx            (signature progress)
    AnimatedCard.tsx           (motion-wrapped card container)
```

**Approach**: Extract components one at a time. After each extraction, verify `npm run build` passes and the UI renders identically. State remains lifted in `CosignDemoApp.tsx` and passed via props.

---

## Phase 1: Highest-Impact Additions (Tier 1)

### 1.1 Install Core Dependencies

```bash
npm install motion sonner lucide-react
```

Verify: `npm run build` succeeds with no errors.

---

### 1.2 Toast Notification System (sonner)

**Value**: Replaces the single `systemMessage` yellow banner for transient feedback. Immediately improves UX by preventing message overwriting and giving proper success/error/warning visual distinction.

**Files to modify**:

- [layout.tsx](cosign-demo/src/app/layout.tsx): Add `<Toaster />` to body
- [CosignDemoApp.tsx](cosign-demo/src/components/CosignDemoApp.tsx): Route 33 `setSystemMessage()` calls

**Implementation rules**:

- **Keep** `systemMessage` state and the yellow banner for persistent status messages (e.g., "Connect your wallet on Sepolia to begin", "Select a shared cart to begin")
- **Route to `toast.success()`**: All success confirmations ("Proposal signed", "Room created", "Deposit added", "Channel closed", etc.)
- **Route to `toast.error()`**: All error catches (the `catch` blocks currently calling `setSystemMessage(error.message)`)
- **Route to `toast.warning()`**: Warning states ("This shared cart is only visible to invited shoppers")

**Specific call routing** (all 33 setSystemMessage calls classified):


| Keep as banner (persistent status) | Route to toast                                            |
| ---------------------------------- | --------------------------------------------------------- |
| Line 354 initial message           | Line 674 refresh error -> `toast.error`                   |
| Line 910/923 connection status     | Line 951 connect error -> `toast.error`                   |
| Line 1030 disconnect status        | Line 1073 room created -> `toast.success`                 |
| Line 995 "connect invited wallet"  | Line 1075 room error -> `toast.error`                     |
| Line 1050/1055 validation msgs     | Line 1124 proposal created -> `toast.success`             |
|                                    | Line 1278/1353/1458/1516 proposal errors -> `toast.error` |
|                                    | Line 1572 proposal signed -> `toast.success`              |
|                                    | Line 1574 sign error -> `toast.error`                     |
|                                    | Line 1702 submitted -> `toast.success`                    |
|                                    | Line 1723 submit error -> `toast.error`                   |
|                                    | Line 1755 deposit success -> `toast.success`              |
|                                    | Line 1757 deposit error -> `toast.error`                  |
|                                    | Line 1771 withdraw success -> `toast.success`             |
|                                    | Line 1773 withdraw error -> `toast.error`                 |
|                                    | Line 1795 transfer success -> `toast.success`             |
|                                    | Line 1797 transfer error -> `toast.error`                 |
|                                    | Line 1810 close success -> `toast.success`                |
|                                    | Line 1812 close error -> `toast.error`                    |
|                                    | Lines 698, 731 access warnings -> `toast.warning`         |


**Toaster configuration**: Position `top-right`, enable `richColors`, set `duration` to 4000ms. Style the toaster container to inherit the glass aesthetic via Sonner's `toastOptions.className`.

**Verify**: Build passes. Trigger a deposit/withdraw/sign action and confirm toast appears and auto-dismisses. Confirm persistent banner still shows for wallet connection status.

---

### 1.3 Icon System (lucide-react)

**Value**: Adds visual language to all interactive elements. Currently every button and badge is text-only, which is flat and hard to scan.

**Files to modify**: All extracted components (or `CosignDemoApp.tsx` if not yet decomposed)

**Icon mapping**:


| Element                   | Icon                       | Context            |
| ------------------------- | -------------------------- | ------------------ |
| Connect Wallet button     | `Wallet`                   | Hero header        |
| Disconnect button         | `LogOut`                   | Hero header        |
| Create Shared Cart button | `ShoppingCart` + `Plus`    | Cart creation form |
| Start Shared Checkout     | `PlayCircle`               | Cart actions       |
| Add Funds To Checkout     | `ArrowDownToLine`          | Cart actions       |
| Propose Purchase          | `Receipt`                  | Cart actions       |
| Finish Checkout           | `CheckCircle2`             | Cart actions       |
| Copy (invite URL)         | `Copy` -> `Check` on click | Share invite       |
| Open (invite URL)         | `ExternalLink`             | Share invite       |
| Agree (sign proposal)     | `PenLine`                  | Proposal actions   |
| Review & Apply            | `Send`                     | Proposal actions   |
| InfoHint "i" trigger      | `Info` (from lucide)       | All 21 instances   |
| Back (onboarding)         | `ChevronLeft`              | Carousel nav       |
| Next (onboarding)         | `ChevronRight`             | Carousel nav       |
| Dev Console Show/Hide     | `Terminal` / `ChevronDown` | Dev console toggle |
| Add Funds (wallet)        | `Plus`                     | Shared wallet      |
| Withdraw To Wallet        | `ArrowUpFromLine`          | Shared wallet      |
| Close Shared Wallet       | `XCircle`                  | Shared wallet      |
| Transfer                  | `ArrowRightLeft`           | Send to friend     |
| Activity event type       | `Activity`                 | Activity feed      |
| Badge-open                | `CircleDot`                | Status badges      |
| Wallet Balances           | `Coins`                    | Balance panel      |
| Wallet Connections        | `Link`                     | Channel panel      |


**Implementation**: Import icons individually for tree-shaking (`import { Wallet } from 'lucide-react'`). Place icons inline in buttons with `size={16}` and `className="mr-1.5"` for consistent spacing.

**Verify**: Build passes. Visual scan of all buttons confirms icons render at correct size. No layout shifts.

---

### 1.4 Micro-Interactions and Transitions (motion)

**Value**: The single highest-impact visual upgrade. Every state transition currently feels jarring.

**Files to modify**: All component files

**Priority animation targets (implement in this order)**:

#### 1.4a -- Button Press States (global)

Apply to ALL `.btn-primary` and `.btn-secondary` buttons:

```tsx
<motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} transition={{ type: "spring", stiffness: 400, damping: 17 }}>
```

This single change covers ~25 buttons and gives the "Apple press" feel. Replace `<button>` with `<motion.button>` throughout.

**Verify**: Click any button, confirm subtle scale animation.

#### 1.4b -- Submit Confirmation Modal

Wrap the existing modal (lines 2771-2818) in `AnimatePresence`:

- Overlay: `initial={{ opacity: 0 }}` -> `animate={{ opacity: 1 }}` -> `exit={{ opacity: 0 }}`
- Card: `initial={{ opacity: 0, scale: 0.95, y: 20 }}` -> `animate={{ opacity: 1, scale: 1, y: 0 }}` -> `exit={{ opacity: 0, scale: 0.95, y: 20 }}`, spring transition `damping: 25, stiffness: 300`

**Verify**: Open "Review & Apply" modal, confirm spring entrance. Click overlay to dismiss, confirm smooth exit.

#### 1.4c -- Card Mount Animations

Replace the CSS `card-enter` keyframe with `motion.section`/`motion.div` on all `.card` elements:

```tsx
<motion.section className="card ..." initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}>
```

Remove the `@keyframes card-enter` and `animation: card-enter` from `globals.css`.

**Verify**: Navigate to a room, confirm cards animate in smoothly.

#### 1.4d -- Onboarding Carousel Slide Transitions

Wrap slide content in `AnimatePresence mode="wait"` with directional slide:

```tsx
<AnimatePresence mode="wait">
  <motion.div key={onboardingIndex} initial={{ opacity: 0, x: direction > 0 ? 40 : -40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: direction > 0 ? -40 : 40 }} transition={{ type: "spring", damping: 25, stiffness: 250 }}>
```

**Verify**: Click Next/Back on carousel, confirm smooth directional slide.

#### 1.4e -- Proposal Progress Bar

Animate the width of the yellow progress bar:

```tsx
<motion.div className="h-full bg-yellow-brand" animate={{ width: `${signatureProgress}%` }} transition={{ type: "spring", stiffness: 100, damping: 20 }} />
```

**Verify**: Sign a proposal, confirm progress bar fills smoothly.

#### 1.4f -- Activity Feed Staggered Entrance

Wrap each event item in `motion.div` with `whileInView` and staggered delay:

```tsx
<motion.div initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.05 }}>
```

**Verify**: Scroll the activity feed, confirm items appear with stagger.

#### 1.4g -- Developer Console Expand/Collapse

Use `AnimatePresence` + `motion.div` with height animation for the dev console toggle:

```tsx
<AnimatePresence>
  {devOpen && (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }}>
```

**Verify**: Toggle dev console, confirm smooth expand/collapse.

#### 1.4h -- Room List Item Layout Animation

Add `layout` prop to room list buttons for smooth reordering when rooms change status:

```tsx
<motion.button layout key={room.id} transition={{ layout: { duration: 0.2 } }}>
```

**Verify**: Change a room status, confirm smooth position transition.

---

## Phase 2: High-Impact Enhancements (Tier 2)

### 2.1 Dark Mode (next-themes)

```bash
npm install next-themes
```

**Files to modify**:

- [layout.tsx](cosign-demo/src/app/layout.tsx): Wrap with `ThemeProvider`, add `suppressHydrationWarning` to `<html>`
- [globals.css](cosign-demo/src/app/globals.css): Add `[data-theme='dark']` or `.dark` variants for all CSS custom properties
- [tailwind.config.ts](cosign-demo/tailwind.config.ts): Add `darkMode: 'class'`
- `HeroHeader.tsx` (or CosignDemoApp): Add theme toggle button (Sun/Moon icons from lucide)

**Dark mode CSS variable mapping**:

```css
.dark {
  --yellow-brand: #fcd000;
  --ink: #f5f5f5;
  --paper: #0a0a0a;
  --muted-ink: #e0e0e0;
  --line: #2a2a2a;
  --glass-white: rgba(30, 30, 30, 0.56);
  --glass-border: rgba(60, 60, 60, 0.62);
  --glass-shadow: 0 20px 44px rgba(0, 0, 0, 0.4);
}
```

Update `body` background gradient for dark mode. Update all hardcoded `bg-white`, `text-black`, `border-neutral-200`, etc. with Tailwind dark variants.

**Verify**: Toggle dark mode. All glass cards, buttons, inputs, badges, and modals must remain legible and visually coherent. No white-on-white or black-on-black text.

---

### 2.2 Mobile Drawer for Confirmation (vaul)

```bash
npm install vaul
```

**Value**: The submit confirmation modal is a centered overlay that works poorly on mobile. A bottom-sheet drawer is the native mobile pattern.

**Implementation**: Create a responsive wrapper component that renders `vaul` `Drawer` on mobile (`< md` breakpoint) and the existing `motion`-animated modal on desktop. Use `window.matchMedia` or a Tailwind `useMediaQuery` hook.

**Files**: New `SubmitConfirmModal.tsx` (or modify extracted modal component)

**Verify**: Resize browser to mobile width. Confirm bottom sheet appears with drag-to-dismiss. Resize to desktop, confirm centered modal appears.

---

### 2.3 CSS Polish (No Package Needed)

**Value**: Small CSS refinements that compound into premium feel.

**Add to globals.css**:

```css
.card {
  transition: backdrop-filter 200ms ease, box-shadow 200ms ease;
  will-change: backdrop-filter;
}
```

**Add glassmorphic scrollbar styling**:

```css
.overflow-y-auto::-webkit-scrollbar { width: 6px; }
.overflow-y-auto::-webkit-scrollbar-track { background: transparent; }
.overflow-y-auto::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 3px; }
.overflow-y-auto::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.25); }
```

**Refine focus states**: Replace default browser focus rings with soft glowing focus:

```css
:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(252, 208, 0, 0.4); border-radius: inherit; }
```

**Verify**: Build passes. Scroll through activity feed to see custom scrollbar. Tab through interactive elements to see focus rings.

---

### 2.4 Loading Skeleton States

**Value**: Currently when data is loading, the UI shows "No X yet" messages which are indistinguishable from genuinely empty state. Skeleton loaders clearly communicate loading.

**Implementation**: Create a `Skeleton` component using Tailwind (`animate-pulse bg-neutral-200 dark:bg-neutral-700 rounded`). Apply to:

- Cart list while rooms are loading
- Activity feed while events are loading
- Wallet balances while core data is loading
- Friend sessions while sessions are loading

Use the existing `busy` state and `!walletAddress` checks to determine when to show skeletons vs empty states.

**Verify**: Connect wallet, confirm skeleton shimmer appears briefly before data loads.

---

## Phase 3: Polish and Power Features (Tier 3)

### 3.1 Command Palette (cmdk)

```bash
npm install cmdk
```

**Value**: Power users can quickly navigate rooms, trigger actions, and search proposals without clicking through the sidebar.

**Actions to expose**:

- Switch between rooms (`/rooms`)
- Trigger "Start Checkout", "Add Funds", "Propose Purchase", "Finish Checkout"
- Toggle dev console
- Copy invite link
- Disconnect wallet

**Trigger**: Keyboard shortcut Cmd+K (Mac) / Ctrl+K (Windows). Add a small search icon button in the header.

**Verify**: Press Cmd+K, type a room ID fragment, confirm it filters and navigates on select.

---

### 3.2 Copy Button Feedback

**Value**: The "Copy" button for invite URLs has no feedback. Add a state transition where the button text/icon changes from `Copy` to `Copied!` with a checkmark icon for 2 seconds.

**Implementation**:

```tsx
const [copied, setCopied] = useState(false);
const handleCopy = () => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); };
```

Use `AnimatePresence` to cross-fade between Copy and Copied states.

**Verify**: Click Copy, confirm icon changes to checkmark and text changes to "Copied!" for 2 seconds.

---

### 3.3 Empty State Illustrations

**Value**: "No shared carts yet", "No events yet", "No balances" are bare text. Add simple inline SVG illustrations or lucide icon compositions for each empty state to make the app feel complete even when empty.

**Implementation**: For each empty state, add a centered icon (e.g., `ShoppingCart` for no carts, `Activity` for no events) with 48px size, muted color, and the text below it.

**Verify**: Disconnect wallet, confirm empty states show illustrative icons.

---

### 3.4 Keyboard Navigation Enhancements

**Value**: The onboarding carousel and room list should be keyboard navigable.

**Implementation**:

- Arrow left/right for onboarding carousel slides
- Arrow up/down for room list navigation
- Enter to select room
- Escape to close modal

**Verify**: Tab to carousel, use arrow keys. Tab to room list, use arrow keys + Enter.

---

## Packages NOT Recommended (with rationale)

- `**@mawtech/glass-ui`**: 172 weekly downloads. The app's existing hand-rolled glassmorphism CSS is already solid and more maintainable. Adopting a low-adoption library introduces dependency risk for marginal visual gain.
- `**@gracefullight/liquid-glass`**: 22 weekly downloads, v0.1.0 (alpha). Requires React 19.1.0+ specifically. Too risky for a production demo.
- `**tailwindcss-animate**`: Redundant when `motion` (framer-motion) is installed. CSS utility animations are inferior to spring physics.

---

## Implementation Order and Build Verification Checklist

Each step is independently deployable. After each, run:

1. `npm run build` -- must pass with zero errors
2. `npm run dev` -- visual verification in browser
3. User manually tests the specific feature changed

**Recommended execution order**:

1. Component decomposition (prerequisite, reduces risk for everything after)
2. Install `motion` + `sonner` + `lucide-react`
3. Sonner toast system (biggest UX win, smallest code change)
4. Lucide icons on all buttons and hints
5. Button press states (motion, global impact)
6. Modal animation (motion, high visibility)
7. Card mount animations + remove CSS keyframe
8. Onboarding carousel transitions
9. Progress bar animation
10. Activity feed stagger
11. Dev console expand/collapse
12. Room list layout animation
13. CSS polish (scrollbars, focus, transitions)
14. Loading skeletons
15. Dark mode (next-themes)
16. Mobile drawer (vaul)
17. Copy button feedback
18. Empty state illustrations
19. Command palette (cmdk)
20. Keyboard navigation
