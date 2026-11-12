import XCTest
@testable import ScreenBrief

final class BriefTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func recording(transcript: [TranscriptPhrase]? = nil, status: TranscriptStatus = .done, mic: Bool? = true,
                           size: Int64 = 3_000_000) -> Recording {
        Recording(id: "20261111-224105", startedAt: ISO8601.date(from: "2026-11-11T22:41:05Z")!, durationSec: 15.4,
                  device: DeviceDescription(name: "iPhone", model: "iPhone14,3", os: "iOS 27.0.1"),
                  hasMicAudio: mic, transcript: transcript, file: "20261111-224105.mov", source: "screenbrief",
                  assetId: "A/L0/001", sizeBytes: size, transcriptStatus: status)
    }

    func testBriefWithTranscript() {
        let text = Brief.text(for: recording(transcript: [
            .init(t: 3.2, text: "This button should be blue."),
            .init(t: 65, text: "And the list is too slow."),
        ]), timeZone: utc)
        XCTAssertEqual(text, """
        Phone feedback recording 20261111-224105: 15 seconds, recorded 2026-11-11 22:41 on iPhone (iPhone14,3, iOS 27.0.1).
        I recorded my iPhone screen while using my app and said what I want changed.

        Agent: get the video before doing anything else. On the Mac run:  screenbrief pull 20261111-224105
        It finds the video (attached to this thread, or copied from my iPhone when the phone is unlocked and on the same Wi-Fi as the Mac or plugged in) and prints the path of a FEEDBACK.md: what I said on a timeline next to screenshots of the screen at each moment. Read it, open the frames, then make the changes I describe.
        If it cannot get the video, do not start on the changes and do not work from the transcript alone. Tell me you need the video, ask me to attach ScreenBrief-20261111-224105 from Photos (album "ScreenBrief") to this thread, and wait. When I have attached it, run the command again.

        What I said (transcribed on the phone, may have errors; times are from the start of the video):
        [00:03] This button should be blue.
        [01:05] And the list is too slow.
        """)
    }

    func testBriefWhileTranscriptionRuns() {
        let text = Brief.text(for: recording(status: .running, mic: nil), timeZone: utc)
        XCTAssertTrue(text.hasSuffix("The phone had not finished transcribing when I copied this. screenbrief pull transcribes it on the Mac."))
        XCTAssertFalse(text.contains("What I said"))
    }

    func testBriefWhenTranscriptionFailed() {
        let text = Brief.text(for: recording(status: .failed, mic: nil), timeZone: utc)
        XCTAssertTrue(text.hasSuffix("The phone could not transcribe this recording. screenbrief pull transcribes it on the Mac."))
    }

    func testBriefWithoutVoice() {
        let text = Brief.text(for: recording(transcript: [], mic: false), timeZone: utc)
        XCTAssertTrue(text.contains("There is no voice in this recording"))
    }

    // MARK: The 50 MiB attachment limit

    func testBriefForARecordingTooLargeToAttachDoesNotAskForAnAttachment() {
        let text = Brief.text(for: recording(transcript: [.init(t: 1, text: "ok")], size: 61_300_000), timeZone: utc)
        XCTAssertTrue(text.contains("On the Mac run:  screenbrief pull 20261111-224105"))
        XCTAssertTrue(text.contains("The video is 61.3 MB, over T3 Code's 50 MB attachment limit, so it is not attached to this thread: the command copies it from my iPhone, which must be unlocked and on the same Wi-Fi as the Mac or plugged in."))
        XCTAssertTrue(text.contains("prints the path of a FEEDBACK.md"))
        XCTAssertTrue(text.contains("Tell me the Mac could not reach my iPhone, and wait"))
        XCTAssertFalse(text.contains("ask me to attach"), "it cannot be attached")
        XCTAssertTrue(text.contains("[00:01] ok"))
        XCTAssertTrue(text.unicodeScalars.allSatisfy { $0.isASCII })
    }

    func testTooLargeStartsJustAboveFiftyMebibytes() {
        XCTAssertEqual(Recording.maxAttachmentBytes, 52_428_800)
        XCTAssertFalse(recording(size: 52_428_800).isTooLargeToAttach)
        XCTAssertTrue(recording(size: 52_428_801).isTooLargeToAttach)
        XCTAssertFalse(recording(size: 0).isTooLargeToAttach, "size not known yet")
    }

    func testAttachmentAdvice() {
        let small = recording(size: 30_000_000)
        let large = recording(size: 61_300_000)
        XCTAssertNil(AttachmentAdvice.detail(for: small))
        XCTAssertNil(AttachmentAdvice.row(for: small))
        XCTAssertEqual(AttachmentAdvice.copied(for: small),
                       "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach this video there from Photos.")
        XCTAssertEqual(AttachmentAdvice.detail(for: large),
                       "Too large to attach in T3 Code: this video is 61.3 MB and the limit is 50 MB. It will only transfer on the same Wi-Fi as your Mac (or plugged in), with the phone unlocked. Copy still works.")
        XCTAssertEqual(AttachmentAdvice.row(for: large), "Too large to attach in T3 Code")
        XCTAssertEqual(AttachmentAdvice.copied(for: large),
                       "Copied. Paste it in your T3 Code thread. This video is too large to attach there: the Mac copies it from the phone on the same Wi-Fi.")
        XCTAssertEqual(AttachmentAdvice.minutesThatFit(), 8, "what the home screen promises")
    }

    func testRecordControlSaysWhenTheRecordingIsTooLarge() {
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 75), "Recording 1:15  ·  tap to stop")
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 75, fileBytes: 0), "Recording 1:15  ·  tap to stop")
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 600, fileBytes: 20_000_000), "Recording 10:00  ·  tap to stop",
                       "a still screen: ten minutes that are still small")
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 300, fileBytes: 53_000_000), "Recording 5:00  ·  too large to attach")
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 900), "Recording 15:00  ·  too large to attach",
                       "no size from the extension: estimated from the time")
    }

    // MARK: Diagnostics

    func testDiagnosticsLineHasCountersAndSize() {
        var d = BroadcastDiagnostics(recordingId: "20261112-001500", startedAt: Date(), updatedAt: Date(), phase: "saved")
        d.durationSec = 241.4
        d.videoFrames = 5210
        d.keepaliveFrames = 310
        d.videoFramesDropped = 12
        d.frameCopiesFailed = 0
        d.audioBuffers = 10400
        d.hasMicAudio = true
        d.peakMemoryMB = 17.6
        d.fileBytes = 22_400_000
        XCTAssertEqual(d.summaryLine, "saved 20261112-001500 | 241s | frames 5210 | audio 10400 | peak mem 18 MB | keepalive 310 dropped 12 copy-fail 0 silence 0 | 22.4 MB")
    }

    func testDiagnosticsFromAnOlderBuildStillDecode() throws {
        let old = """
        {"recordingId":"20261111-225720","startedAt":"2026-11-12T04:57:20.396Z","updatedAt":"2026-11-12T04:57:40.000Z","phase":"saved",
         "videoFrames":422,"keepaliveFrames":10,"audioBuffers":757,"silenceBuffers":0,"hasMicAudio":true,"peakAudioLevel":0.2,
         "durationSec":17.7,"fileBytes":3375197,"memoryMB":14,"peakMemoryMB":18,"events":[]}
        """
        let d = try JSONCoding.decoder.decode(BroadcastDiagnostics.self, from: Data(old.utf8))
        XCTAssertNil(d.videoFramesDropped)
        XCTAssertTrue(d.summaryLine.contains("dropped 0"))
    }

    func testBriefHasNoEmojiAndOnlyASCIIPunctuation() {
        let text = Brief.text(for: recording(transcript: [.init(t: 1, text: "ok")]), timeZone: utc)
        XCTAssertTrue(text.unicodeScalars.allSatisfy { $0.isASCII }, "plain text for a chat on a phone")
    }

    func testFormats() {
        XCTAssertEqual(Format.timestamp(3.9), "00:03")
        XCTAssertEqual(Format.timestamp(3725), "1:02:05")
        XCTAssertEqual(Format.spokenLength(1), "1 second")
        XCTAssertEqual(Format.spokenLength(125), "2 min 5 s")
        XCTAssertEqual(Format.spokenLength(120), "2 min")
        XCTAssertEqual(Format.duration(65.4), "1:05")
    }

    // MARK: Ids and the Mac contract

    func testRecordingIDs() {
        let date = ISO8601.date(from: "2026-11-11T22:41:05Z")!
        XCTAssertEqual(RecordingID.make(for: date, timeZone: utc), "20261111-224105")
        XCTAssertEqual(RecordingID.unique("20261111-224105", taken: ["20261111-224105", "20261111-224105-2"]), "20261111-224105-3")
        XCTAssertTrue(RecordingID.isValid("20261111-224105"))
        XCTAssertFalse(RecordingID.isValid("2026 11"))
        XCTAssertNotNil("20261111-224105-2".range(of: "^[a-z0-9][a-z0-9-]{2,63}$", options: .regularExpression), "the Mac's id pattern")
    }

    @MainActor
    func testIDFromExtensionFileName() {
        let date = ISO8601.date(from: "2026-11-11T22:41:05Z")!
        XCTAssertEqual(AppModel.recordingID(fileName: "ScreenBrief-20261111-224833.mov", created: date), "20261111-224833")
        XCTAssertEqual(AppModel.recordingID(fileName: "RPReplay_Final1731.MP4", created: date), RecordingID.make(for: date))
    }

    func testSidecarJSONHasTheContractFields() throws {
        let r = recording(transcript: [.init(t: 3.2, text: "Hi")])
        let json = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(r)) as! [String: Any]
        XCTAssertEqual(json["id"] as? String, "20261111-224105")
        XCTAssertEqual(json["startedAt"] as? String, "2026-11-11T22:41:05.000Z")
        XCTAssertEqual(json["durationSec"] as? Double, 15.4)
        XCTAssertEqual((json["device"] as? [String: String])?["model"], "iPhone14,3")
        XCTAssertEqual(json["hasMicAudio"] as? Bool, true)
        let transcript = json["transcript"] as? [[String: Any]]
        XCTAssertEqual(transcript?.first?["t"] as? Double, 3.2)
        XCTAssertEqual(transcript?.first?["text"] as? String, "Hi")
        XCTAssertNil(json["transcribeSec"], "left out until the phone has transcribed")
    }

    func testTranscriptionTimeIsKeptInTheSidecar() throws {
        var r = recording(transcript: [.init(t: 3.2, text: "Hi")])
        r.transcribeSec = 31.4
        let back = try JSONCoding.decoder.decode(Recording.self, from: JSONCoding.encoder.encode(r))
        XCTAssertEqual(back.transcribeSec, 31.4)
        XCTAssertEqual(back, r)
    }

    func testFilesRoundTripAndDelete() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        let files = RecordingFiles(documents: root.appendingPathComponent("Documents"), support: root.appendingPathComponent("Support"))
        files.prepare()
        let r = recording()
        try Data([0]).write(to: files.movie(r))
        try files.save(r)
        XCTAssertEqual(files.loadAll(), [r])
        XCTAssertEqual(files.movie(r).path, root.appendingPathComponent("Documents/Recordings/20261111-224105.mov").path)
        files.delete(r)
        XCTAssertEqual(files.loadAll(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.sidecar(r.id).path))
    }

    // MARK: Phrases

    func testPhrasesSplitOnPausesAndSentences() {
        let words: [TimedWord] = [
            .init(start: 0.5, end: 0.8, text: "This"), .init(start: 0.85, end: 1.0, text: "button"),
            .init(start: 1.05, end: 1.3, text: "is"), .init(start: 1.35, end: 1.6, text: "wrong."),
            .init(start: 1.7, end: 1.9, text: "Make"), .init(start: 1.95, end: 2.1, text: "it"), .init(start: 2.15, end: 2.4, text: "blue"),
            .init(start: 4.0, end: 4.3, text: "Next"), .init(start: 4.35, end: 4.6, text: "screen"),
        ]
        XCTAssertEqual(PhraseGrouper.group(words), [
            .init(t: 0.5, text: "This button is wrong."),
            .init(t: 1.7, text: "Make it blue"),
            .init(t: 4.0, text: "Next screen"),
        ])
    }

    /// Words as speech recognition delivers them: `gap` seconds between words, each 0.25 s long.
    private func timed(_ text: String, from start: Double, gap: Double = 0.08) -> [TimedWord] {
        var t = start
        return text.split(separator: " ").map { w in
            defer { t += 0.25 + gap }
            return TimedWord(start: t, end: t + 0.25, text: String(w))
        }
    }

    func testSentenceIsNotSplitAfterFourteenWords() {
        // On the phone this came out as "...hear me what I say and" / "what you see."
        let words = timed("Okay, right now, you should be able to hear me what I say and what you see.", from: 0.6)
            + timed("Okay, you going somewhere else.", from: 6.6)
        XCTAssertEqual(PhraseGrouper.group(words), [
            .init(t: 0.6, text: "Okay, right now, you should be able to hear me what I say and what you see."),
            .init(t: 6.6, text: "Okay, you going somewhere else."),
        ])
    }

    func testLongSentenceBreaksAtACommaOnceLong() {
        let words = timed("So the first thing is this header which looks way too big on the phone, and the second thing is the list below it.", from: 0)
        let phrases = PhraseGrouper.group(words)
        XCTAssertEqual(phrases.map(\.text), [
            "So the first thing is this header which looks way too big on the phone,",
            "and the second thing is the list below it.",
        ])
    }

    func testRunOnSpeechIsCutAtTheLongestPauseWithinTwelveSeconds() {
        // 50 words over ~16 s, no punctuation; one slightly longer gap (0.3 s) after word 20.
        var words: [TimedWord] = []
        var t = 0.0
        for i in 0..<50 {
            words.append(TimedWord(start: t, end: t + 0.25, text: "w\(i)"))
            t += 0.25 + (i == 19 ? 0.3 : 0.07)
        }
        let phrases = PhraseGrouper.group(words, maxWords: 100)
        XCTAssertEqual(phrases.first?.text.split(separator: " ").count, 20, "cut at the pause, not mid-run")
        XCTAssertEqual(phrases.map { $0.text.split(separator: " ").count }.reduce(0, +), 50)
        for (i, p) in phrases.enumerated() {
            let n = p.text.split(separator: " ").count
            let first = words.first { $0.text == p.text.split(separator: " ").first.map(String.init) }!
            let last = words.first { $0.text == p.text.split(separator: " ").last.map(String.init) }!
            XCTAssertLessThanOrEqual(last.end - first.start, 12, "phrase \(i) (\(n) words) is under 12 s")
        }
    }

    func testLongSpeechStaysUnderTheWordLimit() {
        let words = (0..<40).map { TimedWord(start: Double($0) * 0.3, end: Double($0) * 0.3 + 0.25, text: "w\($0)") }
        let phrases = PhraseGrouper.group(words)
        XCTAssertGreaterThan(phrases.count, 1)
        XCTAssertTrue(phrases.allSatisfy { $0.text.split(separator: " ").count <= 30 })
        XCTAssertEqual(phrases.map { $0.text.split(separator: " ").count }.reduce(0, +), 40)
    }

    func testOldSidecarWithMarkKeysStillLoads() throws {
        // A build with frame marking (since removed) wrote these keys.
        var json = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(recording())) as! [String: Any]
        json["marks"] = [["t": 3.2, "file": "20261111-224105-mark-01.jpg", "note": ""]]
        json["lastMarkNumber"] = 1
        let r = try JSONCoding.decoder.decode(Recording.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(r, recording())
        let resaved = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(r)) as! [String: Any]
        XCTAssertNil(resaved["marks"])
    }

    func testLeftoverMarkImagesAreDeleted() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        let files = RecordingFiles(documents: root.appendingPathComponent("Documents"), support: root.appendingPathComponent("Support"))
        files.prepare()
        let r = recording()
        try Data([0]).write(to: files.movie(r))
        try files.save(r)
        for name in ["20261111-224105-mark-01.jpg", "20261111-224105-mark-12.jpg"] {
            try Data([0]).write(to: files.recordings.appendingPathComponent(name))
        }
        files.removeLeftoverMarkImages()
        let left = try FileManager.default.contentsOfDirectory(atPath: files.recordings.path).sorted()
        XCTAssertEqual(left, ["20261111-224105.json", "20261111-224105.mov"])
    }

    func testBriefHasNoMarksBlock() {
        XCTAssertFalse(Brief.text(for: recording(transcript: [.init(t: 1, text: "ok")]), timeZone: utc).contains("Frames I marked"))
    }
}
