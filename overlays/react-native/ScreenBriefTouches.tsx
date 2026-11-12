/**
 * ScreenBriefTouches: debug-only touch marks for React Native / Expo apps.
 *
 *   import ScreenBriefTouches from "./ScreenBriefTouches";
 *   export default function App() {
 *     return <ScreenBriefTouches enabled={__DEV__}>{...your app...}</ScreenBriefTouches>;
 *   }
 *
 * Draws every touch in signal magenta so it shows up in an iPhone screen recording, where the
 * ScreenBrief Mac detector (mac/src/touch-detect.mjs) turns the marks into timestamped
 * tap / long-press / drag markers. Single file, no native code, only `react` and `react-native`.
 *
 * What it draws (the detector depends on these exact values, see overlays/README.md):
 *   - touch down: a 56 pt mark, a solid #FF00DC disc of radius 24 pt inside a 4 pt white ring,
 *     shown at full opacity immediately.
 *   - moving: a 12 pt magenta trail (dots every 6 pt) that fades from 90% to 0 over 1.5 s.
 *   - held still (moved <= 10 pt) for 0.5 s: a second magenta ring, radius 42..48 pt.
 *   - release: the mark stays at full opacity until at least 250 ms after touch down, then
 *     fades out linearly over 250 ms while shrinking to 80%.
 *
 * How it observes touches without stealing them
 * ---------------------------------------------
 * The wrapper View listens with the capture-phase touch event props (onTouchStartCapture,
 * onTouchMoveCapture, onTouchEndCapture, onTouchCancelCapture). In React Native these are plain
 * bubbling events (topTouchStart/Move/End/Cancel in the View config's `bubblingEventTypes`),
 * dispatched to the touched view and to every ancestor, capture phase first, for every touch,
 * whoever is the responder. They are separate from the gesture responder system: the handlers
 * here never return true from any `*ShouldSetResponder*` callback, never call
 * stopPropagation/preventDefault, and keep no responder state, so Pressables, ScrollViews,
 * TextInputs and gesture libraries underneath negotiate exactly as before. The marks live in a
 * `pointerEvents="none"` layer, so hit testing passes straight through them. All animation runs
 * on the native driver from a fixed pool of views, so touches cause no React re-render.
 *
 * What a JS-level overlay cannot see or draw over (use the SwiftUI/UIKit overlay in a native
 * app, or accept these gaps):
 *   - Anything in another native window or presented controller: React Native <Modal>, native
 *     alerts / action sheets / share sheets, the keyboard, system UI. Touches inside an RN <Modal>
 *     may still be reported to this component, but the marks render underneath the modal and are
 *     not visible in the recording. Wrap the Modal's content in another <ScreenBriefTouches> to
 *     draw inside it.
 *   - Touches that a native gesture recogniser takes over. When a native ScrollView starts
 *     scrolling, or react-native-gesture-handler / a native component claims the touch, React
 *     Native sends touchcancel (or stops sending moves) to JS. The mark then ends at that point:
 *     a scroll shows as a short drag or a tap, not the whole finger path.
 *   - Touches outside this component's bounds (wrap the root so it fills the screen).
 *   - Native views drawn above React content (some video players, maps, web views on iOS) may
 *     cover the marks.
 *   - Taps on the same spot less than about 0.3 s apart (double taps) look like one tap.
 *   - Setting `enabled` remounts the children when it changes; use a constant like __DEV__.
 *   - When `enabled` is false the component renders its children directly: no wrapper view,
 *     no hooks, no listeners.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { GestureResponderEvent, LayoutChangeEvent, NativeTouchEvent, StyleProp, ViewStyle } from "react-native";

export const SCREENBRIEF_TOUCH_SPEC = {
  colour: "#FF00DC",
  ringColour: "#FFFFFF",
  discRadius: 24, // pt, magenta part
  ringWidth: 4, // pt, white ring outside the disc (mark is 56 pt across)
  longPressInnerRadius: 42,
  longPressOuterRadius: 48, // pt, the second ring
  longPressDelayMs: 500,
  longPressSlop: 10, // pt
  trailDotRadius: 6, // pt (12 pt wide trail)
  trailSpacing: 6, // pt between dots
  trailStartOpacity: 0.9,
  trailLifeMs: 1500,
  minHoldMs: 250, // a mark stays fully visible at least this long after touch down
  fadeMs: 250,
  fadeScale: 0.8,
} as const;

const S = SCREENBRIEF_TOUCH_SPEC;
const MAX_TOUCHES = 5;
const TRAIL_POOL = 200;
const STALE_MS = 15000; // release a mark if its touch has produced no event for this long

type Props = {
  /** Draw touches. Pass __DEV__ (or a constant) so release builds pay nothing. Default true. */
  enabled?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export default function ScreenBriefTouches({ enabled = true, children, style }: Props) {
  if (!enabled) return <>{children}</>;
  return <Observer style={style}>{children}</Observer>;
}

type OverlayHandle = {
  down(id: string, x: number, y: number): void;
  move(id: string, x: number, y: number): void;
  up(id: string): void;
  sync(liveIds: Set<string>): void;
};

function Observer({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const overlay = useRef<OverlayHandle>(null);
  const root = useRef<React.ComponentRef<typeof View>>(null);
  const origin = useRef({ x: 0, y: 0 });

  // pageX/pageY are relative to the React root view; the marks are positioned relative to this
  // wrapper, so subtract the wrapper's own offset (normally 0,0 when it wraps the app root).
  const onLayout = useCallback((_e: LayoutChangeEvent) => {
    root.current?.measureInWindow((x: number, y: number) => {
      if (Number.isFinite(x) && Number.isFinite(y)) origin.current = { x, y };
    });
  }, []);

  const each = (e: GestureResponderEvent, fn: (id: string, x: number, y: number) => void) => {
    const ne = e.nativeEvent;
    const list: ReadonlyArray<NativeTouchEvent> = ne.changedTouches && ne.changedTouches.length ? ne.changedTouches : [ne];
    for (const t of list) fn(String(t.identifier), t.pageX - origin.current.x, t.pageY - origin.current.y);
  };
  const live = (e: GestureResponderEvent) => new Set((e.nativeEvent.touches ?? []).map((t) => String(t.identifier)));

  const onStart = useCallback((e: GestureResponderEvent) => {
    overlay.current?.sync(live(e));
    each(e, (id, x, y) => overlay.current?.down(id, x, y));
  }, []);
  const onMove = useCallback((e: GestureResponderEvent) => {
    each(e, (id, x, y) => overlay.current?.move(id, x, y));
  }, []);
  const onEnd = useCallback((e: GestureResponderEvent) => {
    each(e, (id) => overlay.current?.up(id));
  }, []);

  // Capture-phase touch events. React Native's View config has dispatched all four for years
  // (BaseViewConfig `bubblingEventTypes`: topTouchStart -> onTouchStart / onTouchStartCapture,
  // ...), but type definitions before RN 0.80 only declare onTouchEndCapture, hence the spread.
  const capture = useMemo<Record<string, (e: GestureResponderEvent) => void>>(() => ({
    onTouchStartCapture: onStart,
    onTouchMoveCapture: onMove,
    onTouchEndCapture: onEnd,
    onTouchCancelCapture: onEnd,
  }), [onStart, onMove, onEnd]);

  return (
    <View ref={root} collapsable={false} style={[styles.fill, style]} onLayout={onLayout} {...capture}>
      {children}
      <Overlay ref={overlay} />
    </View>
  );
}

type Slot = {
  x: Animated.Value; y: Animated.Value; opacity: Animated.Value; scale: Animated.Value; lp: Animated.Value;
  id: string | null; // touch identifier while down
  busyUntil: number; // ms timestamp until which the slot is fading
  downAt: number; sx: number; sy: number; lx: number; ly: number; moved: boolean;
  lpTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  anim: Animated.CompositeAnimation | null;
};
type Dot = { x: Animated.Value; y: Animated.Value; opacity: Animated.Value };

const native = { useNativeDriver: true, isInteraction: false } as const;

const Overlay = React.memo(forwardRef<OverlayHandle>(function Overlay(_props, ref) {
  const slots = useMemo<Slot[]>(() => Array.from({ length: MAX_TOUCHES }, () => ({
    x: new Animated.Value(-1000), y: new Animated.Value(-1000), opacity: new Animated.Value(0),
    scale: new Animated.Value(1), lp: new Animated.Value(0),
    id: null, busyUntil: 0, downAt: 0, sx: 0, sy: 0, lx: 0, ly: 0, moved: false, lpTimer: null, staleTimer: null, anim: null,
  })), []);
  const dots = useMemo<Dot[]>(() => Array.from({ length: TRAIL_POOL }, () => ({
    x: new Animated.Value(-1000), y: new Animated.Value(-1000), opacity: new Animated.Value(0),
  })), []);
  const nextDot = useRef(0);

  const api = useMemo<OverlayHandle>(() => {
    const find = (id: string) => slots.find((s) => s.id === id);
    const clearTimers = (s: Slot) => {
      if (s.lpTimer) clearTimeout(s.lpTimer);
      if (s.staleTimer) clearTimeout(s.staleTimer);
      s.lpTimer = s.staleTimer = null;
    };
    const touchStale = (s: Slot) => {
      if (s.staleTimer) clearTimeout(s.staleTimer);
      const id = s.id;
      s.staleTimer = setTimeout(() => { if (id !== null && s.id === id) release(s); }, STALE_MS);
    };
    const dot = (x: number, y: number) => {
      const d = dots[nextDot.current];
      nextDot.current = (nextDot.current + 1) % dots.length;
      d.opacity.stopAnimation();
      d.x.setValue(x);
      d.y.setValue(y);
      d.opacity.setValue(S.trailStartOpacity);
      Animated.timing(d.opacity, { toValue: 0, duration: S.trailLifeMs, easing: Easing.linear, ...native }).start();
    };
    const release = (s: Slot) => {
      clearTimers(s);
      s.id = null;
      const hold = Math.max(0, S.minHoldMs - (Date.now() - s.downAt));
      s.busyUntil = Date.now() + hold + S.fadeMs;
      const cfg = { duration: S.fadeMs, delay: hold, easing: Easing.linear, ...native };
      s.anim = Animated.parallel([
        Animated.timing(s.opacity, { toValue: 0, ...cfg }),
        Animated.timing(s.scale, { toValue: S.fadeScale, ...cfg }),
      ]);
      s.anim.start();
    };
    return {
      down(id, x, y) {
        const old = find(id);
        if (old) release(old);
        const now = Date.now();
        let s = slots.find((c) => c.id === null && c.busyUntil <= now);
        if (!s) s = slots.filter((c) => c.id === null).sort((a, b) => a.busyUntil - b.busyUntil)[0];
        if (!s) return; // more than MAX_TOUCHES fingers
        s.anim?.stop();
        clearTimers(s);
        Object.assign(s, { id, downAt: now, sx: x, sy: y, lx: x, ly: y, moved: false, busyUntil: Infinity });
        s.x.setValue(x);
        s.y.setValue(y);
        s.scale.setValue(1);
        s.lp.setValue(0);
        s.opacity.setValue(1);
        s.lpTimer = setTimeout(() => { if (s && s.id === id && !s.moved) s.lp.setValue(1); }, S.longPressDelayMs);
        touchStale(s);
      },
      move(id, x, y) {
        const s = find(id);
        if (!s) { this.down(id, x, y); return; }
        if (!s.moved && Math.hypot(x - s.sx, y - s.sy) > S.longPressSlop) {
          s.moved = true;
          if (s.lpTimer) { clearTimeout(s.lpTimer); s.lpTimer = null; }
        }
        s.x.setValue(x);
        s.y.setValue(y);
        let d = Math.hypot(x - s.lx, y - s.ly);
        while (d >= S.trailSpacing) {
          s.lx += ((x - s.lx) / d) * S.trailSpacing;
          s.ly += ((y - s.ly) / d) * S.trailSpacing;
          dot(s.lx, s.ly);
          d = Math.hypot(x - s.lx, y - s.ly);
        }
        touchStale(s);
      },
      up(id) {
        const s = find(id);
        if (s) release(s);
      },
      sync(liveIds) {
        // A touch whose end we never saw (e.g. it ended inside a native modal) is released when
        // the next touch starts and it is no longer among the active touches.
        for (const s of slots) if (s.id !== null && !liveIds.has(s.id)) release(s);
      },
    };
  }, [slots, dots]);

  useImperativeHandle(ref, () => api, [api]);
  useEffect(() => () => { for (const s of slots) { if (s.lpTimer) clearTimeout(s.lpTimer); if (s.staleTimer) clearTimeout(s.staleTimer); } }, [slots]);

  return (
    <View pointerEvents="none" style={styles.overlay}>
      {dots.map((d, i) => (
        <Animated.View key={`d${i}`} style={[styles.dot, { opacity: d.opacity, transform: [{ translateX: d.x }, { translateY: d.y }] }]} />
      ))}
      {slots.map((s, i) => (
        <Animated.View key={`s${i}`} style={[styles.slot, { opacity: s.opacity, transform: [{ translateX: s.x }, { translateY: s.y }, { scale: s.scale }] }]}>
          <Animated.View style={[styles.lpRing, { opacity: s.lp }]} />
          <View style={styles.disc} />
        </Animated.View>
      ))}
    </View>
  );
}));

const SLOT = S.longPressOuterRadius * 2; // 96
const DISC = (S.discRadius + S.ringWidth) * 2; // 56

const styles = StyleSheet.create({
  fill: { flex: 1 },
  overlay: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 2147483647, elevation: 2147483647, overflow: "visible" },
  dot: {
    position: "absolute", left: -S.trailDotRadius, top: -S.trailDotRadius,
    width: S.trailDotRadius * 2, height: S.trailDotRadius * 2, borderRadius: S.trailDotRadius,
    backgroundColor: S.colour,
  },
  slot: {
    position: "absolute", left: -SLOT / 2, top: -SLOT / 2, width: SLOT, height: SLOT,
    alignItems: "center", justifyContent: "center",
  },
  lpRing: {
    position: "absolute", left: 0, top: 0, width: SLOT, height: SLOT, borderRadius: SLOT / 2,
    borderWidth: S.longPressOuterRadius - S.longPressInnerRadius, borderColor: S.colour,
  },
  disc: {
    width: DISC, height: DISC, borderRadius: DISC / 2,
    backgroundColor: S.colour, borderWidth: S.ringWidth, borderColor: S.ringColour,
  },
});
