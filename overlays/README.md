# ScreenBrief touch overlays

iOS doesn't show touches in screen recordings and doesn't let one app see touches in another.
So the app under test draws its own touches in a debug build. You can see the marks in the
recording, and the Mac detector (`mac/src/touch-detect.mjs`) turns them into timestamped
`tap` / `longpress` / `drag` markers. A drag that circles an area comes back with `closed: true`
and its `bbox`.

## Add it

**React Native / Expo**: copy `react-native/ScreenBriefTouches.tsx` into the app. It has no
native code and no dependencies beyond `react` and `react-native`.

```tsx
import ScreenBriefTouches from "./ScreenBriefTouches";

export default function App() {
  return <ScreenBriefTouches enabled={__DEV__}>{/* app root */}</ScreenBriefTouches>;
}
```

**SwiftUI / UIKit**: add `swiftui/ScreenBriefTouches.swift` to the app target.

```swift
WindowGroup { ContentView().screenBriefTouches() }   // SwiftUI
ScreenBriefTouches.install()                          // UIKit, e.g. in didFinishLaunching
```

The Swift file compiles only under the `DEBUG` condition (Xcode's Debug configuration). In
Release, `.screenBriefTouches()` returns the view unchanged.

## What it draws

The detector depends on these exact values. They are the same on both platforms and in the
synthetic test (`mac/test/touch-detect.test.mjs`).

| | |
|---|---|
| Colour | signal magenta `#FF00DC` (sRGB 255, 0, 220), opaque |
| Touch down | 56 pt mark: magenta disc of radius 24 pt inside a 4 pt white ring, at full opacity at once |
| Moving | 12 pt magenta trail (dots every 6 pt), fading linearly from 90 % to 0 over 1.5 s; a loop drawn round an area stays visible as a loop |
| Long press | held still (moved 10 pt or less) for 0.5 s adds a second magenta ring, radius 42 to 48 pt; it stays on if the finger then drags |
| Release | full opacity until at least 250 ms after touch down, then a 250 ms linear fade while shrinking to 80 % |
| Multi-touch | one mark per finger (React Native: up to 5) |

Why these values: nothing in ordinary app UI has this exact hue, with B/R about 0.86. Pure
magenta `#FF00FF` (1.0), Lyft-style pink `#FF00BF` (0.75), deep pink, iOS systemPink and the
purples all sit clearly outside it. The hue survives H.264 at 3 Mbps, a downscale to 60 %, and
BT.601/BT.709 mismatches. The detector also requires the right size relative to the screen
width, a round shape, the white ring, clear space around the mark and persistence over
several frames. The 250 ms minimum hold keeps even a 50 ms tap on screen for 8 or more frames
of a 30 fps recording.

## Limits

Both platforms:
- Two taps on the same spot less than about 0.3 s apart (a double tap) show as one tap.
- A mark covers about 56 pt of the UI under the finger while it is down. To read the button
  that was tapped, look at a frame just before the marker's `t`.
- Don't record from the iOS Simulator for real use. While a synthetic touch is held, the
  Simulator draws its own grey touch dot over the centre of the mark, and the detector then
  misses the start of long presses and drags. Real devices don't draw that dot.

React Native (JS-level overlay):
- It observes through the capture-phase touch events (`onTouchStartCapture` and the
  Move/End/Cancel variants), which React Native dispatches to every ancestor whoever holds
  the responder. It never claims the responder, so the app behaves exactly as before.
- It can't draw over other native windows or presented controllers: RN `<Modal>`, native
  alerts, action sheets, share sheets, the keyboard and system UI. Touches in an RN `<Modal>`
  may be reported, but the mark renders under the modal. Wrap the modal's content in another
  `<ScreenBriefTouches>` to draw inside it.
- When a native recogniser takes the touch over (a native ScrollView starting to scroll,
  react-native-gesture-handler, a native map or web view), JS gets a cancel or stops getting
  moves. The mark ends there, so a scroll shows as a short drag or a tap, not the whole path.
- It only sees touches inside its own bounds, so wrap the root.
- Native views composited above React content may hide marks.
- Changing `enabled` at runtime remounts the children. Use a constant such as `__DEV__`.
  When it is false, the children render directly: no extra view, no listeners.

Swift (UIApplication-level overlay):
- It sees every touch the app process receives, including touches on sheets, alerts and
  popovers and touches that gesture recognisers cancel. It draws above all of them from its
  own untouchable window.
- It doesn't see touches handled out of process: on recent iOS the keyboard's keys, system
  pickers and share sheets (PHPicker and the like), Control Center, notifications, the Home
  indicator.
