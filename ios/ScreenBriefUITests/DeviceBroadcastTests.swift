import XCTest

/// Drives a real broadcast on a physical iPhone: launches the app, accepts its permission
/// prompts, starts the system broadcast with the microphone on, navigates a couple of screens
/// while it records, stops it from the app's control, and checks the recording shows up in the
/// app. ReplayKit broadcasts do not run in the simulator, so this is the automated proof of the
/// recorder. Screenshots of every step are attached to the result bundle.
///
/// Run: TEST_RUNNER_SB_RECORD_SECONDS=15 xcodebuild test -scheme ScreenBriefDevice -destination 'id=<device>'
final class DeviceBroadcastTests: DeviceTestCase {
    private var before: String?

    func testRecordOnDevice() throws {
        let env = ProcessInfo.processInfo.environment
        let seconds = Double(env["SB_RECORD_SECONDS"] ?? "") ?? 15

        app.launch()
        acceptAlerts(for: 4)
        shot("launched")
        log("before: \(debugText())")
        let existing = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'recording-'"))
        _ = existing.firstMatch.waitForExistence(timeout: 8)
        before = existing.firstMatch.exists ? existing.firstMatch.identifier.replacingOccurrences(of: "recording-", with: "") : nil
        log("newest before: \(before ?? "none")")

        let record = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Start recording'")).firstMatch
        XCTAssertTrue(record.waitForExistence(timeout: 10), "No record button.\n\(app.debugDescription)")
        record.tap()

        guard let start = find(["Start Sharing", "Start Broadcast"], timeout: 10) else {
            shot("no-broadcast-sheet")
            return XCTFail("Broadcast sheet not found.\nSPRINGBOARD:\n\(springboard.debugDescription)")
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

        // Whatever the sheet does after Start: screenshots at 1, 4 and 7 s show it.
        for t in [1.0, 4.0] {
            Thread.sleep(forTimeInterval: max(0, t - Date().timeIntervalSince(startedAt)))
            acceptAlerts(for: 0.1)
            shot(String(format: "after-start-%.0fs", t))
        }
        if let alert = visibleAlert() {
            shot("alert")
            log("alert after start: \(alert.label) | \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        }
        // Dismiss the sheet if it is still up (tap outside it), then use the app and Home screen.
        if find(["Stop Sharing", "Stop Broadcast"], timeout: 0.5) != nil {
            log("sheet still shown after start (Stop visible)")
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        log("during: \(debugText())")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 2)
        springboard.swipeLeft()
        Thread.sleep(forTimeInterval: 2)
        shot("recording-home")
        springboard.swipeRight()
        app.activate()
        let remaining = seconds - Date().timeIntervalSince(startedAt)
        if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        shot("recording-app")

        // Stop from the app's own control, which shows the recording state now.
        let recordingControl = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Recording'")).firstMatch
        if recordingControl.waitForExistence(timeout: 3) {
            log("control while recording: \(recordingControl.label)")
            recordingControl.tap()
        } else {
            log("control does not show the recording state")
            record.tap()
        }
        guard let stop = find(["Stop Sharing", "Stop Broadcast"], timeout: 8) else {
            shot("no-stop")
            log("no Stop Broadcast. app: \(debugText())")
            return XCTFail("Stop Broadcast not found.\nSPRINGBOARD:\n\(springboard.debugDescription)")
        }
        shot("sheet-stop")
        stop.tap()
        Thread.sleep(forTimeInterval: 1)
        if find(["Stop Sharing", "Stop Broadcast"], timeout: 0.5) != nil {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        // The extension finishes the movie and saves it to Photos.
        Thread.sleep(forTimeInterval: 6)
        acceptAlerts(for: 1)
        if let alert = visibleAlert() { log("alert after stop: \(alert.label)"); shot("alert-after-stop") }
        app.activate()
        shot("after-stop")
        log("after: \(debugText())")

        // The new recording appears at the top of the list (copied from Photos into the app).
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'recording-'"))
        let newest = rows.firstMatch
        let newestId = expectNewRecording(rows: rows, timeout: 20)
        log("newest row: \(newestId ?? "none")")
        guard let newestId else {
            shot("no-row")
            return XCTFail("No recording in the list.\n\(app.debugDescription)")
        }
        XCTAssertTrue(newestId > (before ?? ""), "newest row \(newestId) is not newer than the last recording before (\(before ?? "-"))")
        shot("list")
        newest.tap()
        let copy = app.buttons["copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        // Give the on-device transcription a moment, then record what it says.
        let status = app.staticTexts["transcript-status"]
        let deadline = Date().addingTimeInterval(25)
        while Date() < deadline, status.exists, status.label.contains("ranscrib") { Thread.sleep(forTimeInterval: 1) }
        log("transcript state: \(status.exists ? status.label : "phrases shown")")
        shot("detail")
        copy.tap()
        XCTAssertTrue(app.staticTexts["copied"].waitForExistence(timeout: 3))
        shot("copied")
        log("detail texts: \(app.staticTexts.allElementsBoundByIndex.prefix(30).map(\.label))")
    }

    /// Short check, no broadcast and no changes: open the newest recording, tap Copy, read the
    /// confirmation line.
    /// Run: xcodebuild test -scheme ScreenBriefDevice -destination 'id=<device>' \
    ///   -only-testing:ScreenBriefUITests/DeviceBroadcastTests/testCopyBriefOnDevice
    func testCopyBriefOnDevice() throws {
        app.launch()
        acceptAlerts(for: 1)
        let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'recording-'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "No recordings.\n\(app.debugDescription)")
        log("newest: \(rows.firstMatch.identifier)")
        shot("list")
        rows.firstMatch.tap()
        let copy = app.buttons["copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["mark-moment"].exists)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Mark'")).count, 0, "no Mark button")
        shot("detail")
        copy.tap()
        let copied = app.staticTexts["copied"]
        XCTAssertTrue(copied.waitForExistence(timeout: 3))
        XCTAssertEqual(copied.label, "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach this video there from Photos.")
        app.swipeUp()
        shot("copied")
        log("detail texts: \(app.staticTexts.allElementsBoundByIndex.prefix(30).map(\.label))")
    }

    private func expectNewRecording(rows: XCUIElementQuery, timeout: TimeInterval) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let ids = rows.allElementsBoundByIndex.map(\.identifier).filter { !$0.isEmpty }
            if let first = ids.first, first.replacingOccurrences(of: "recording-", with: "") > (before ?? "") {
                return first.replacingOccurrences(of: "recording-", with: "")
            }
            Thread.sleep(forTimeInterval: 1)
        } while Date() < deadline
        return rows.firstMatch.exists ? rows.firstMatch.identifier.replacingOccurrences(of: "recording-", with: "") : nil
    }
}
