//  ScreenBriefTouches.swift
//
//  Debug-only touch marks for native iOS apps (SwiftUI or UIKit), so touches show up in a screen
//  recording and the ScreenBrief Mac detector (mac/src/touch-detect.mjs) can turn them into
//  tap / long-press / drag markers. Drop this one file into the app target.
//
//  SwiftUI:  WindowGroup { ContentView().screenBriefTouches() }
//  UIKit:    ScreenBriefTouches.install()   // e.g. in application(_:didFinishLaunchingWithOptions:)
//
//  Everything is compiled only when the DEBUG condition is set (Xcode's Debug configuration).
//  In Release `.screenBriefTouches()` returns the view unchanged and nothing else exists.
//
//  How it works: it replaces UIApplication.sendEvent(_:) with a version that calls the original
//  first and then looks at the event's touches, read-only. Every touch in the app passes through
//  there exactly once, before any gesture recogniser sees it, so sheets, alerts, popovers,
//  scroll views and touches that recognisers later cancel are all observed in full. The marks
//  are drawn in a separate UIWindow per scene, above alerts, that refuses hit-testing
//  (hitTest returns nil, user interaction disabled), so it never receives or changes touches.
//
//  What it draws (the detector depends on these exact values, see overlays/README.md):
//    - touch down: a 56 pt mark, a solid #FF00DC disc of radius 24 pt inside a 4 pt white ring.
//    - moving: a 12 pt magenta trail (dots every 6 pt) fading from 90% to 0 over 1.5 s.
//    - held still (moved <= 10 pt) for 0.5 s: a second magenta ring, radius 42..48 pt.
//    - release: full opacity until at least 250 ms after touch down, then a 250 ms linear fade
//      while shrinking to 80%.
//
//  Limits: touches handled outside the app process are not seen (the system keyboard's keys on
//  recent iOS, Control Center, notifications, the Home indicator, out-of-process pickers and
//  share sheets such as PHPicker). Content in other processes can still be drawn over by the
//  system. Taps on the same spot less than about 0.3 s apart look like one tap.

#if canImport(SwiftUI)
import SwiftUI

public extension View {
    /// Draws every touch in the app in signal magenta (DEBUG builds only; Release: no-op).
    func screenBriefTouches(_ enabled: Bool = true) -> some View {
        #if DEBUG && canImport(UIKit)
        return onAppear { if enabled { ScreenBriefTouches.install() } }
        #else
        return self
        #endif
    }
}
#endif

#if DEBUG && canImport(UIKit)
import UIKit
import ObjectiveC.runtime

@MainActor
public final class ScreenBriefTouches {
    public enum Spec {
        public static let colour = UIColor(red: 1, green: 0, blue: 220.0 / 255.0, alpha: 1) // #FF00DC
        public static let ringColour = UIColor.white
        public static let discRadius: CGFloat = 24
        public static let ringWidth: CGFloat = 4
        public static let longPressInnerRadius: CGFloat = 42
        public static let longPressOuterRadius: CGFloat = 48
        public static let longPressDelay: TimeInterval = 0.5
        public static let longPressSlop: CGFloat = 10
        public static let trailDotRadius: CGFloat = 6
        public static let trailSpacing: CGFloat = 6
        public static let trailStartOpacity: Float = 0.9
        public static let trailLife: TimeInterval = 1.5
        public static let minHold: TimeInterval = 0.25
        public static let fade: TimeInterval = 0.25
        public static let fadeScale: CGFloat = 0.8
    }

    public static let shared = ScreenBriefTouches()

    /// Starts drawing touches for the whole app. Safe to call more than once.
    public static func install() { shared.install() }

    private var installed = false
    private var overlays: [ObjectIdentifier: OverlayWindow] = [:]
    private var marks: [ObjectIdentifier: Mark] = [:]

    private init() {}

    private func install() {
        guard !installed else { return }
        installed = true
        let selector = #selector(UIApplication.sendEvent(_:))
        guard let method = class_getInstanceMethod(UIApplication.self, selector) else { return }
        typealias SendEvent = @convention(c) (UIApplication, Selector, UIEvent) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: SendEvent.self)
        let replacement: @convention(block) (UIApplication, UIEvent) -> Void = { app, event in
            original(app, selector, event)
            guard event.type == .touches else { return }
            MainActor.assumeIsolated { ScreenBriefTouches.shared.observe(event) }
        }
        method_setImplementation(method, imp_implementationWithBlock(replacement))
    }

    private func observe(_ event: UIEvent) {
        guard let touches = event.allTouches else { return }
        for touch in touches where touch.type == .direct || touch.type == .pencil {
            let key = ObjectIdentifier(touch)
            switch touch.phase {
            case .began:
                guard let window = touch.window, let overlay = overlay(for: window) else { continue }
                marks[key]?.release()
                let p = overlay.convert(touch.location(in: nil), from: window)
                marks[key] = Mark(in: overlay.canvas, at: p)
            case .moved:
                guard let mark = marks[key], let window = touch.window, let overlay = mark.overlayWindow else { continue }
                mark.move(to: overlay.convert(touch.location(in: nil), from: window))
            case .ended, .cancelled:
                marks.removeValue(forKey: key)?.release()
            default:
                break
            }
        }
    }

    private func overlay(for window: UIWindow) -> OverlayWindow? {
        if let w = window as? OverlayWindow { return w }
        guard let scene = window.windowScene else { return nil }
        let key = ObjectIdentifier(scene)
        if let w = overlays[key] { return w }
        let w = OverlayWindow(windowScene: scene)
        overlays[key] = w
        return w
    }
}

/// Transparent, untouchable window above everything else in its scene.
private final class OverlayWindow: UIWindow {
    let canvas = UIView()

    override init(windowScene: UIWindowScene) {
        super.init(windowScene: windowScene)
        // Above alerts (2000) and status-bar level windows; below nothing the app owns.
        windowLevel = UIWindow.Level(rawValue: 10_000_100)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        canvas.frame = bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        canvas.backgroundColor = .clear
        canvas.isUserInteractionEnabled = false
        addSubview(canvas)
        isHidden = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { false }
    override var canBecomeKey: Bool { false }
}

@MainActor
private final class Mark {
    typealias S = ScreenBriefTouches.Spec
    private let canvas: UIView
    private let container = CALayer()
    private let ring = CALayer()
    private let start: CGPoint
    private var lastDot: CGPoint
    private var moved = false
    private let downAt = CACurrentMediaTime()
    private var longPress: DispatchWorkItem?

    var overlayWindow: UIWindow? { canvas.window }

    init(in canvas: UIView, at p: CGPoint) {
        self.canvas = canvas
        start = p
        lastDot = p
        let slot = S.longPressOuterRadius * 2
        let disc = (S.discRadius + S.ringWidth) * 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.bounds = CGRect(x: 0, y: 0, width: slot, height: slot)
        container.position = p
        ring.frame = container.bounds
        ring.cornerRadius = slot / 2
        ring.borderWidth = S.longPressOuterRadius - S.longPressInnerRadius
        ring.borderColor = S.colour.cgColor
        ring.opacity = 0
        let d = CALayer()
        d.frame = CGRect(x: (slot - disc) / 2, y: (slot - disc) / 2, width: disc, height: disc)
        d.cornerRadius = disc / 2
        d.backgroundColor = S.colour.cgColor
        d.borderWidth = S.ringWidth
        d.borderColor = S.ringColour.cgColor
        container.addSublayer(ring)
        container.addSublayer(d)
        canvas.layer.addSublayer(container)
        CATransaction.commit()

        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.moved else { return }
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                self.ring.opacity = 1
                CATransaction.commit()
            }
        }
        longPress = work
        DispatchQueue.main.asyncAfter(deadline: .now() + S.longPressDelay, execute: work)
    }

    func move(to p: CGPoint) {
        if !moved, hypot(p.x - start.x, p.y - start.y) > S.longPressSlop {
            moved = true
            longPress?.cancel()
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container.position = p
        var d = hypot(p.x - lastDot.x, p.y - lastDot.y)
        while d >= S.trailSpacing {
            lastDot.x += (p.x - lastDot.x) / d * S.trailSpacing
            lastDot.y += (p.y - lastDot.y) / d * S.trailSpacing
            addDot(at: lastDot)
            d = hypot(p.x - lastDot.x, p.y - lastDot.y)
        }
        CATransaction.commit()
    }

    private func addDot(at p: CGPoint) {
        let r = S.trailDotRadius
        let dot = CALayer()
        dot.bounds = CGRect(x: 0, y: 0, width: r * 2, height: r * 2)
        dot.position = p
        dot.cornerRadius = r
        dot.backgroundColor = S.colour.cgColor
        dot.opacity = 0
        // trail sits under all marks
        canvas.layer.insertSublayer(dot, at: 0)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = S.trailStartOpacity
        fade.toValue = 0
        fade.duration = S.trailLife
        fade.timingFunction = CAMediaTimingFunction(name: .linear)
        dot.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + S.trailLife + 0.05) { dot.removeFromSuperlayer() }
    }

    func release() {
        longPress?.cancel()
        let hold = max(0, S.minHold - (CACurrentMediaTime() - downAt))
        let layer = container
        let begin = layer.convertTime(CACurrentMediaTime(), from: nil) + hold
        let opacity = CABasicAnimation(keyPath: "opacity")
        opacity.fromValue = 1
        opacity.toValue = 0
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1
        scale.toValue = S.fadeScale
        for a in [opacity, scale] {
            a.beginTime = begin
            a.duration = S.fade
            a.fillMode = .backwards
            a.timingFunction = CAMediaTimingFunction(name: .linear)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.opacity = 0
        layer.setAffineTransform(CGAffineTransform(scaleX: S.fadeScale, y: S.fadeScale))
        layer.add(opacity, forKey: "fadeOut")
        layer.add(scale, forKey: "shrink")
        CATransaction.commit()
        DispatchQueue.main.asyncAfter(deadline: .now() + hold + S.fade + 0.05) { layer.removeFromSuperlayer() }
    }
}
#endif
