import XCTest

/// Shared plumbing for the tests that drive the real iPhone: the apps involved, logging and
/// screenshots into the result bundle, finding system-hosted controls, and starting and stopping a
/// broadcast through the system sheet.
class DeviceTestCase: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.rostyslav.screenbrief")
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() {
        continueAfterFailure = false
    }

    var recordingRows: XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'recording-'"))
    }

    /// Ids of the recordings listed, newest first.
    func listedIDs() -> [String] {
        recordingRows.allElementsBoundByIndex.map(\.identifier).filter { !$0.isEmpty }
            .map { $0.replacingOccurrences(of: "recording-", with: "") }
    }

    func log(_ text: String) {
        print("[device-test] \(text)")
        let a = XCTAttachment(string: text)
        a.name = "log"
        a.lifetime = .keepAlways
        add(a)
    }

    func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The Debug disclosure's text (the last broadcast's diagnostics). The disclosure sits below
    /// the list, so this scrolls down to it, opens it if needed, and scrolls back to the top.
    func debugText() -> String {
        let e = app.descendants(matching: .any)["debug-diagnostics"]
        let toggle = app.buttons["Debug"]
        var scrolled = 0
        while !e.exists, scrolled < 4 {
            if toggle.exists, toggle.isHittable { toggle.tap(); _ = e.waitForExistence(timeout: 2); break }
            app.swipeUp()
            scrolled += 1
        }
        let text = e.exists ? e.label : "<debug-diagnostics missing>"
        for _ in 0..<scrolled { app.swipeDown() }
        return text
    }

    /// Uses the Home screen for a few seconds: two pages, then Spotlight opened and closed.
    /// Opens no app and types nothing.
    func browseHomeScreen() {
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1.5)
        springboard.swipeLeft()
        Thread.sleep(forTimeInterval: 1.5)
        springboard.swipeRight()
        Thread.sleep(forTimeInterval: 1.2)
        let from = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        from.press(forDuration: 0.05, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)))
        Thread.sleep(forTimeInterval: 2)
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 1)
    }

    func visibleAlert() -> XCUIElement? {
        for host in [springboard, app] where host.alerts.firstMatch.exists { return host.alerts.firstMatch }
        return nil
    }

    /// First hittable element whose label contains one of `texts`, in SpringBoard (the broadcast
    /// sheet is hosted by the system) or in the app.
    func find(_ texts: [String], timeout: TimeInterval) -> XCUIElement? {
        let predicate = NSCompoundPredicate(orPredicateWithSubpredicates: texts.map { NSPredicate(format: "label CONTAINS[c] %@", $0) })
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for host in [springboard, app] {
                for type in [XCUIElement.ElementType.button, .cell, .staticText, .other] {
                    let e = host.descendants(matching: type).matching(predicate).firstMatch
                    if e.exists, e.isHittable { return e }
                }
            }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < deadline
        return nil
    }

    /// Accepts permission prompts shown by the system (Photos full access, speech recognition).
    func acceptAlerts(for duration: TimeInterval) {
        let deadline = Date().addingTimeInterval(duration)
        let labels = ["Allow Full Access", "Allow Paste", "Allow", "OK", "Allow While Using App", "Continue"]
        repeat {
            for host in [springboard, app] {
                let alert = host.alerts.firstMatch
                guard alert.exists else { continue }
                shot("alert")
                log("alert: \(alert.label) | \(alert.staticTexts.allElementsBoundByIndex.map(\.label)) | buttons \(alert.buttons.allElementsBoundByIndex.map(\.label))")
                for label in labels where alert.buttons[label].exists {
                    alert.buttons[label].tap()
                    break
                }
            }
            Thread.sleep(forTimeInterval: 0.4)
        } while Date() < deadline
    }

    // MARK: Broadcast

    /// Launches ScreenBrief and returns the ids listed before anything is recorded.
    @discardableResult
    func launchScreenBrief() -> [String] {
        app.launch()
        acceptAlerts(for: 3)
        _ = recordingRows.firstMatch.waitForExistence(timeout: 8)
        let ids = listedIDs()
        log("recordings before: \(ids)")
        return ids
    }

    /// Taps Start recording, turns the microphone on in the system sheet, starts sharing and
    /// dismisses the sheet. Returns when the broadcast was started (nil, with a failure recorded,
    /// if the sheet never appeared).
    func startBroadcast() -> Date? {
        let record = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Start recording'")).firstMatch
        guard record.waitForExistence(timeout: 10) else {
            shot("no-record-button")
            XCTFail("No record button.\n\(app.debugDescription)")
            return nil
        }
        record.tap()
        guard let start = find(["Start Sharing", "Start Broadcast"], timeout: 10) else {
            shot("no-broadcast-sheet")
            XCTFail("Broadcast sheet not found.\nSPRINGBOARD:\n\(springboard.debugDescription)")
            return nil
        }
        if let mic = find(["Microphone"], timeout: 2) {
            let state = "\(mic.label) \(mic.value as? String ?? "")"
            log("microphone control: \(state)")
            if state.localizedCaseInsensitiveContains("off") {
                mic.tap()
                acceptAlerts(for: 2)
            }
        } else {
            log("no microphone control found")
        }
        shot("sheet-before-start")
        start.tap()
        let startedAt = Date()
        Thread.sleep(forTimeInterval: 4)
        acceptAlerts(for: 0.1)
        if let alert = visibleAlert() {
            shot("alert-after-start")
            log("alert after start: \(alert.label) | \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        }
        // The sheet stays up after the countdown: tap outside it.
        if find(["Stop Sharing", "Stop Broadcast"], timeout: 0.5) != nil {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        return startedAt
    }

    /// Brings ScreenBrief to the front and stops the broadcast from its own control. Returns when
    /// Stop Sharing was tapped (nil, with a failure recorded, if it could not be found).
    func stopBroadcast() -> Date? {
        app.activate()
        let control = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Recording'")).firstMatch
        guard control.waitForExistence(timeout: 8) else {
            shot("no-recording-control")
            XCTFail("ScreenBrief does not show the recording control: the broadcast is not running. Debug: \(debugText())")
            return nil
        }
        log("control while recording: \(control.label)")
        shot("recording-app")
        control.tap()
        guard let stop = find(["Stop Sharing", "Stop Broadcast"], timeout: 8) else {
            shot("no-stop")
            XCTFail("Stop Sharing not found.\nSPRINGBOARD:\n\(springboard.debugDescription)")
            return nil
        }
        stop.tap()
        let stoppedAt = Date()
        Thread.sleep(forTimeInterval: 1)
        // The sheet stays up after stopping (now offering Start Sharing) and swallows the next
        // tap: dismiss it by tapping outside.
        if find(["Start Sharing", "Stop Sharing", "Start Broadcast", "Stop Broadcast"], timeout: 1) != nil {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
            Thread.sleep(forTimeInterval: 0.8)
        }
        acceptAlerts(for: 1)
        if let alert = visibleAlert() { log("alert after stop: \(alert.label)"); shot("alert-after-stop") }
        return stoppedAt
    }

    /// Waits until a recording that is not in `before` is listed, and returns its id.
    func waitForNewRecording(notIn before: [String], timeout: TimeInterval) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            // Newer than everything listed before (ids sort by time), not merely unseen: the
            // list is lazy, so an old row can show up for the first time after scrolling.
            if let id = listedIDs().first(where: { !before.contains($0) && $0 > (before.max() ?? "") }) { return id }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return nil
    }

    /// On the detail screen: waits until the transcript is no longer pending or running. Returns
    /// what the screen says about it.
    func waitForTranscript(timeout: TimeInterval) -> String {
        let status = app.staticTexts["transcript-status"]
        let phrase = app.descendants(matching: .any)["phrase-0"]
        let noVoice = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'No voice'")).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if phrase.exists { return "phrases shown" }
            if noVoice.exists { return "no voice" }
            if status.exists, !status.label.contains("ranscrib") { return status.label }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < deadline
        return "still: \(status.exists ? status.label : "unknown") after \(Int(timeout))s"
    }
}
