import XCTest

/// Field checks on the real iPhone beyond the basic broadcast test: the full loop into T3 Code
/// and a long recording. Each test logs its numbers as `[device-test]` lines and attaches a
/// screenshot of every step.
///
/// What these tests touch on the phone: ScreenBrief, the Home screen and Spotlight (opened and
/// closed, nothing typed), and the composer of one named T3 Code thread. They open no other app.
///
/// Run one with:
///   xcodebuild test -scheme ScreenBriefDevice -destination 'id=<device>' \
///     -only-testing:ScreenBriefUITests/DeviceFieldTests/<test>
final class DeviceFieldTests: DeviceTestCase {
    static let t3BundleID = "com.t3tools.t3code"
    /// The only thread these tests may paste into.
    static let threadTitle = "Screen and Voice Feedback Recorder"
    /// The project that thread belongs to (the start of the subtitle under its title).
    static let projectName = "phone agent context"

    let t3 = XCUIApplication(bundleIdentifier: DeviceFieldTests.t3BundleID)

    override func tearDown() {
        XCUIDevice.shared.orientation = .portrait
    }

    /// Looks only: what ScreenBrief lists and what T3 Code shows when brought to the front.
    /// Taps nothing in T3 Code.
    func testLookAtT3Code() throws {
        launchScreenBrief()
        log("debug: \(debugText())")
        shot("screenbrief")
        t3.activate()
        XCTAssertTrue(t3.wait(for: .runningForeground, timeout: 15), "T3 Code did not come to the front")
        Thread.sleep(forTimeInterval: 3)
        shot("t3code")
        log("T3 CODE TREE:\n\(t3.debugDescription)")
    }

    /// Looks only, in ScreenBrief: the last broadcast's diagnostics and the newest recording's
    /// detail screen once its transcript is ready. Records nothing and changes nothing.
    func testReportNewestRecording() throws {
        let launchedAt = Date()
        let ids = launchScreenBrief()
        log("debug: \(debugText())")
        guard let id = ids.first else { return XCTFail("No recordings listed.") }
        shot("report-list")
        app.descendants(matching: .any)["recording-\(id)"].firstMatch.tap()
        XCTAssertTrue(app.buttons["copy"].waitForExistence(timeout: 10))
        let transcript = waitForTranscript(timeout: 300)
        log(String(format: "newest %@: transcript %@, %.1f s after launch", id, transcript, Date().timeIntervalSince(launchedAt)))
        log("facts: \(app.staticTexts["recording-facts"].label)")
        log("too-large warning shown: \(app.staticTexts["too-large"].exists)")
        shot("report-detail")
        app.swipeUp()
        log("texts: \(app.staticTexts.allElementsBoundByIndex.suffix(4).map(\.label))")
        shot("report-detail-end")
    }

    // MARK: 1. Full loop

    /// Records about 15 seconds across a few screens, stops, opens the new recording, taps Copy,
    /// then pastes the brief into the T3 Code thread named `threadTitle` and sends it. Pastes
    /// nothing unless that thread is the one open.
    func testFullLoopIntoT3Code() throws {
        let before = launchScreenBrief()
        shot("launched")
        guard let startedAt = startBroadcast() else { return }

        // About 15 seconds across a few screens: ScreenBrief's list, a recording's detail screen,
        // the Home screen pages and Spotlight.
        shot("recording-screenbrief")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 1)
        app.swipeDown()
        if let last = before.last {
            app.descendants(matching: .any)["recording-\(last)"].firstMatch.tap()
            _ = app.buttons["copy"].waitForExistence(timeout: 5)
            Thread.sleep(forTimeInterval: 1.5)
            shot("recording-detail")
            app.navigationBars.buttons.firstMatch.tap()
        }
        browseHomeScreen()
        shot("recording-home")
        let remaining = 15 - Date().timeIntervalSince(startedAt)
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }

        guard let stoppedAt = stopBroadcast() else { return }
        log("recorded for \(String(format: "%.1f", stoppedAt.timeIntervalSince(startedAt))) s (start tap to stop tap)")
        app.activate()
        guard let id = waitForNewRecording(notIn: before, timeout: 45) else {
            shot("no-new-recording")
            return XCTFail("No new recording was listed. Debug: \(debugText())")
        }
        log("NEW RECORDING \(id), listed \(String(format: "%.1f", Date().timeIntervalSince(stoppedAt))) s after stop")
        log("after: \(debugText())")
        shot("list")

        app.descendants(matching: .any)["recording-\(id)"].firstMatch.tap()
        let copy = app.buttons["copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        log("transcript: \(waitForTranscript(timeout: 60)), \(String(format: "%.1f", Date().timeIntervalSince(stoppedAt))) s after stop")
        log("facts: \(app.staticTexts["recording-facts"].label)")
        shot("detail")
        copy.tap()
        XCTAssertTrue(app.staticTexts["copied"].waitForExistence(timeout: 3))
        shot("copied")

        try pasteBriefIntoThread(recordingID: id)
    }

    // MARK: T3 Code

    /// Why the open T3 Code screen is not the thread `threadTitle`, or nil when it is: exactly one
    /// navigation bar, named after the thread and showing its title, in this project, with a
    /// composer below.
    private func whyNotOnTheThread() -> String? {
        let bars = t3.navigationBars.allElementsBoundByIndex.filter(\.exists)
        let names = bars.map(\.identifier)
        guard bars.count == 1, names[0] == Self.threadTitle else { return "navigation bars: \(names)" }
        let texts = bars[0].staticTexts.allElementsBoundByIndex.map(\.label)
        guard texts.contains(Self.threadTitle) else { return "title text missing in the bar: \(texts)" }
        guard texts.contains(where: { $0.hasPrefix(Self.projectName) }) else { return "another project: \(texts)" }
        guard composer().exists else { return "no composer" }
        return nil
    }

    private func composer() -> XCUIElement { t3.textViews.firstMatch }

    private func stillHoldsBrief(_ id: String) -> Bool {
        ((composer().value as? String) ?? "").contains("Phone feedback recording \(id)")
    }

    /// Buttons level with the composer or below its top edge (attachment, model, dictation, send).
    private func composerButtons() -> [XCUIElement] {
        let top = composer().frame.minY - 12
        return t3.buttons.allElementsBoundByIndex.filter { $0.exists && $0.frame.minY >= top && !$0.label.isEmpty }
    }

    private func pasteBriefIntoThread(recordingID id: String) throws {
        t3.activate()
        XCTAssertTrue(t3.wait(for: .runningForeground, timeout: 15), "T3 Code did not come to the front")
        Thread.sleep(forTimeInterval: 2)
        shot("t3-opened")

        if let why = whyNotOnTheThread() {
            // Not on the thread: go to it only if exactly one hittable thing carries its title.
            log("T3 Code is not on the thread (\(why))")
            let matches = t3.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", Self.threadTitle))
                .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
            log("\(matches.count) hittable element(s) titled '\(Self.threadTitle)'")
            guard matches.count == 1 else {
                shot("t3-wrong-screen")
                log("T3 CODE TREE:\n\(t3.debugDescription)")
                return XCTFail("T3 Code is not showing '\(Self.threadTitle)' (\(why)) and it cannot be reached unambiguously. Nothing was pasted.")
            }
            matches[0].tap()
            Thread.sleep(forTimeInterval: 2.5)
            shot("t3-after-navigation")
        }
        if let why = whyNotOnTheThread() {
            shot("t3-wrong-thread")
            log("T3 CODE TREE:\n\(t3.debugDescription)")
            return XCTFail("The open T3 Code screen is not the thread '\(Self.threadTitle)': \(why). Nothing was pasted.")
        }
        log("thread confirmed: '\(Self.threadTitle)' in \(Self.projectName)")
        let draft = (composer().value as? String) ?? ""
        guard draft.isEmpty || draft == "Ask anything" else {
            shot("t3-draft-present")
            return XCTFail("The composer already holds a draft (\(draft.count) chars); not touching it. Nothing was pasted.")
        }

        composer().tap()
        Thread.sleep(forTimeInterval: 1)
        func pasteItem() -> XCUIElement? {
            [t3.menuItems["Paste"], t3.buttons["Paste"], t3.staticTexts["Paste"]].first { $0.exists && $0.isHittable }
        }
        if pasteItem() == nil { composer().tap(); Thread.sleep(forTimeInterval: 1) }
        if pasteItem() == nil { composer().press(forDuration: 1.1); Thread.sleep(forTimeInterval: 1) }
        guard let paste = pasteItem() else {
            shot("t3-no-paste-menu")
            log("T3 CODE TREE:\n\(t3.debugDescription)")
            return XCTFail("No Paste item in the composer's menu. Nothing was pasted.")
        }
        shot("t3-paste-menu")
        paste.tap()
        acceptAlerts(for: 1.5) // "Allow Paste", if iOS asks
        Thread.sleep(forTimeInterval: 1)
        let typed = (composer().value as? String) ?? ""
        log("composer after paste (\(typed.count) chars): \(typed.prefix(160))")
        shot("t3-pasted")
        guard typed.contains("Phone feedback recording \(id)"), typed.contains("screenbrief pull \(id)") else {
            return XCTFail("The composer does not hold the brief for \(id) after pasting. Nothing was sent.")
        }
        if let why = whyNotOnTheThread() {
            return XCTFail("No longer on the thread before sending (\(why)). The brief is in the composer; nothing was sent.")
        }

        // Send. With no agent running the control is a button named "Send" (or "Queue" while the
        // Mac is reconnecting). While an agent is working it is an element named "Choose how to
        // send this message": a tap sends the user's default way, a long press offers the choice.
        // Queue ("run after the current turn") is chosen there so the running agent is not
        // interrupted; a plain tap is the fallback when no menu opens.
        let buttons = composerButtons()
        log("composer buttons: \(buttons.map { "\($0.label)\($0.isEnabled ? "" : " (disabled)")" })")
        let chooser = t3.descendants(matching: .any).matching(NSPredicate(format: "label == 'Choose how to send this message'")).firstMatch
        if let send = buttons.first(where: { ["Send", "Queue"].contains($0.label) && $0.isEnabled && $0.isHittable }) {
            log("tapping '\(send.label)'")
            send.tap()
        } else if chooser.exists, chooser.isHittable {
            chooser.press(forDuration: 1.0)
            let queue = t3.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Queue'")).firstMatch
            if queue.waitForExistence(timeout: 3), queue.isHittable {
                shot("t3-send-menu")
                log("send menu: \(t3.collectionViews.buttons.allElementsBoundByIndex.map(\.label)); choosing '\(queue.label)'")
                queue.tap()
            } else if stillHoldsBrief(id) {
                shot("t3-no-send-menu")
                log("no send menu after a long press; tapping the send control")
                if !chooser.isHittable { t3.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap() }
                chooser.tap()
            }
        } else {
            shot("t3-no-send")
            log("T3 CODE TREE:\n\(t3.debugDescription)")
            return XCTFail("No send control found. The brief is in the composer; nothing was sent.")
        }
        Thread.sleep(forTimeInterval: 2.5)
        shot("t3-sent")
        let after = (composer().value as? String) ?? ""
        guard !stillHoldsBrief(id) else {
            return XCTFail("NOT SENT: the brief for \(id) is still in the composer of '\(Self.threadTitle)'.")
        }
        log("SENT brief for \(id) into '\(Self.threadTitle)'; composer now holds \(after.count) chars")
        log("composer buttons after sending: \(composerButtons().map(\.label))")
    }

    // MARK: 2. Long recording

    /// Records `SB_RECORD_SECONDS` (default 240) while the screen keeps changing: ScreenBrief's
    /// list and detail screens scrolled, the Home screen pages, Spotlight. Then reports how long
    /// listing and transcribing took and what the extension counted.
    /// Run with TEST_RUNNER_SB_RECORD_SECONDS=240.
    func testLongRecording() throws {
        let seconds = Double(ProcessInfo.processInfo.environment["SB_RECORD_SECONDS"] ?? "") ?? 240
        let before = launchScreenBrief()
        guard let startedAt = startBroadcast() else { return }
        func elapsed() -> Double { Date().timeIntervalSince(startedAt) }
        func timeLeft() -> Double { seconds - elapsed() }

        var round = 0
        while timeLeft() > 25 {
            round += 1
            // ScreenBrief: the live counters (memory, frames, size so far), then the list.
            app.activate()
            Thread.sleep(forTimeInterval: 1.5)
            log(String(format: "at %.0f s: %@", elapsed(), debugText()))
            if round % 3 == 1 { shot(String(format: "long-screenbrief-%03.0fs", elapsed())) }
            app.swipeUp(); Thread.sleep(forTimeInterval: 0.8)
            app.swipeDown(); Thread.sleep(forTimeInterval: 0.8)
            guard timeLeft() > 25 else { break }

            // A recording's detail screen (nothing is played or changed), scrolled, and back.
            if !before.isEmpty {
                let id = before[round % before.count]
                let row = app.descendants(matching: .any)["recording-\(id)"].firstMatch
                if row.waitForExistence(timeout: 3) {
                    row.tap()
                    if app.buttons["copy"].waitForExistence(timeout: 5) {
                        Thread.sleep(forTimeInterval: 1)
                        app.swipeUp(); Thread.sleep(forTimeInterval: 1)
                        app.swipeDown(); Thread.sleep(forTimeInterval: 1)
                        if round == 1 { shot("long-detail-during") }
                        app.navigationBars.buttons.firstMatch.tap()
                        Thread.sleep(forTimeInterval: 1)
                    }
                }
            }
            guard timeLeft() > 25 else { break }

            // Home screen pages and Spotlight.
            browseHomeScreen()
            if round == 1 { shot("long-home") }
        }
        // The last seconds: the Home screen with the phone turned to landscape and back, to see
        // what ReplayKit delivers when the orientation changes mid-recording.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1)
        log(String(format: "device turned to landscape at %.1f s", elapsed()))
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 3)
        shot("long-home-landscape")
        XCUIDevice.shared.orientation = .portrait
        log(String(format: "device back to portrait at %.1f s", elapsed()))
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        Thread.sleep(forTimeInterval: max(0, timeLeft()))
        log(String(format: "before stop, at %.0f s: %@", elapsed(), debugText()))

        guard let stoppedAt = stopBroadcast() else { return }
        log(String(format: "recorded for %.1f s (start tap to stop tap), %d rounds", stoppedAt.timeIntervalSince(startedAt), round))
        app.activate()
        guard let id = waitForNewRecording(notIn: before, timeout: 120) else {
            shot("no-new-recording")
            return XCTFail("No new recording was listed within 120 s. Debug: \(debugText())")
        }
        log(String(format: "NEW RECORDING %@, listed %.1f s after stop", id, Date().timeIntervalSince(stoppedAt)))
        shot("long-list")
        app.descendants(matching: .any)["recording-\(id)"].firstMatch.tap()
        XCTAssertTrue(app.buttons["copy"].waitForExistence(timeout: 10))
        let transcript = waitForTranscript(timeout: 300)
        log(String(format: "transcript: %@, %.1f s after stop", transcript, Date().timeIntervalSince(stoppedAt)))
        log("facts: \(app.staticTexts["recording-facts"].label)")
        log("too-large warning shown: \(app.staticTexts["too-large"].exists)")
        shot("long-detail")
        app.navigationBars.buttons.firstMatch.tap()
        log("after: \(debugText())")
        app.swipeUp()
        shot("long-debug")
    }
}
