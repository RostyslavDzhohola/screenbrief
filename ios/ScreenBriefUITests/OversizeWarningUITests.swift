import XCTest

/// Simulator only: what the app shows for a recording over T3 Code's 50 MiB attachment limit.
/// A real one takes ten minutes to record, so the test expects a seeded recording in the app's
/// `Documents/Recordings/`: `20261101-000000.mov` (any small movie) and `20261101-000000.json`
/// with `"sizeBytes": 64000000`. Skipped when that recording is not listed.
///
/// Run: xcodebuild test -scheme ScreenBriefDevice -destination 'platform=iOS Simulator,name=ScreenBrief Test' \
///   -only-testing:ScreenBriefUITests/OversizeWarningUITests
final class OversizeWarningUITests: DeviceTestCase {
    static let seededID = "20261101-000000"

    func testWarningForARecordingOverTheLimit() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Simulator only: it needs a seeded recording.")
        #else
        app.launch()
        acceptAlerts(for: 4)
        let row = app.descendants(matching: .any)["recording-\(Self.seededID)"].firstMatch
        guard row.waitForExistence(timeout: 8) else {
            throw XCTSkip("No seeded recording \(Self.seededID) in the app's Documents/Recordings.")
        }
        XCTAssertTrue(app.staticTexts["Too large to attach in T3 Code"].exists, "the list flags it")
        shot("oversize-list")
        row.tap()
        let warning = app.staticTexts["too-large"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5), "the detail screen says it plainly")
        XCTAssertEqual(warning.label, "Too large to attach in T3 Code: this video is 64 MB and the limit is 50 MB. It will only transfer on the same Wi-Fi as your Mac (or plugged in), with the phone unlocked. Copy still works.")
        shot("oversize-detail")
        app.buttons["copy"].tap()
        let copied = app.staticTexts["copied"]
        XCTAssertTrue(copied.waitForExistence(timeout: 3))
        XCTAssertEqual(copied.label, "Copied. Paste it in your T3 Code thread. This video is too large to attach there: the Mac copies it from the phone on the same Wi-Fi.")
        app.swipeUp()
        shot("oversize-copied")
        #endif
    }
}
