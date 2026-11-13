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
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 300, fileBytes: 53_000_000), "Recording 5:00  ·  will be split to attach")
        XCTAssertEqual(AttachmentAdvice.recordingTitle(elapsed: 900), "Recording 15:00  ·  will be split to attach",
                       "no size from the extension: estimated from the time")
    }

    // MARK: Parts of a recording too large to attach

    private func large(_ status: PartsStatus?, parts: Int? = nil, note: String? = nil) -> Recording {
        var r = recording(transcript: [.init(t: 1, text: "ok")], size: 61_300_000)
        r.partsStatus = status
        r.partCount = parts
        r.partsNote = note
        return r
    }

    func testBriefForARecordingAttachedAsParts() {
        let text = Brief.text(for: large(.done, parts: 3), timeZone: utc)
        XCTAssertEqual(text, """
        Phone feedback recording 20261111-224105: 15 seconds, recorded 2026-11-11 22:41 on iPhone (iPhone14,3, iOS 27.0.1).
        I recorded my iPhone screen while using my app and said what I want changed.

        Agent: get the video before doing anything else. On the Mac run:  screenbrief pull 20261111-224105
        The video is 61.3 MB, over T3 Code's 50 MB attachment limit, so it is attached to this thread as 3 parts (ScreenBrief-20261111-224105-part1of3 to part3of3). The command joins the parts (or copies the whole video from my iPhone when the phone is unlocked and on the same Wi-Fi as the Mac or plugged in) and prints the path of a FEEDBACK.md: what I said on a timeline next to screenshots of the screen at each moment. Read it, open the frames, then make the changes I describe.
        If it cannot get the video, do not start on the changes and do not work from the transcript alone. Tell me what the command said is missing, ask me to attach all 3 parts from Photos (album "ScreenBrief") to this thread, and wait. When I have attached them, run the command again.

        What I said (transcribed on the phone, may have errors; times are from the start of the video):
        [00:01] ok
        """)
        XCTAssertTrue(text.unicodeScalars.allSatisfy { $0.isASCII })
    }

    /// Until the parts are in Photos (and for a recording from before there were parts), the
    /// brief says what it said before: the video is not attached.
    func testBriefKeepsItsWordingUntilThePartsAreDone() {
        let before = Brief.text(for: large(nil), timeZone: utc)
        XCTAssertTrue(before.contains("so it is not attached to this thread: the command copies it from my iPhone"))
        XCTAssertTrue(before.contains("Tell me the Mac could not reach my iPhone, and wait"))
        for r in [large(.pending), large(.running), large(.failed, note: "Photos is full"), large(.done), large(.done, parts: 1)] {
            XCTAssertEqual(Brief.text(for: r, timeZone: utc), before, "\(String(describing: r.partsStatus))")
        }
        // Parts are only ever for a recording over the limit.
        var small = recording(transcript: [.init(t: 1, text: "ok")])
        let plain = Brief.text(for: small, timeZone: utc)
        small.partsStatus = .done
        small.partCount = 3
        XCTAssertEqual(Brief.text(for: small, timeZone: utc), plain)
    }

    func testAttachmentAdviceForParts() {
        let done = large(.done, parts: 3)
        XCTAssertEqual(AttachmentAdvice.row(for: done), "Attach as 3 parts")
        XCTAssertEqual(AttachmentAdvice.detail(for: done),
                       "Too large to attach in one file (61.3 MB; T3 Code's limit is 50 MB). It is saved in Photos as 3 parts: attach all 3 with the pasted text.")
        XCTAssertEqual(AttachmentAdvice.copied(for: done),
                       "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach all 3 parts of this video from Photos.")

        for preparing in [large(.pending), large(.running)] {
            XCTAssertEqual(AttachmentAdvice.row(for: preparing), "Splitting into parts to attach…")
            XCTAssertEqual(AttachmentAdvice.detail(for: preparing), "Too large to attach in one file. Splitting it into parts…")
            XCTAssertEqual(AttachmentAdvice.copied(for: preparing), AttachmentAdvice.copied(for: large(nil)))
        }

        let failed = large(.failed, note: "Photos is full")
        XCTAssertEqual(AttachmentAdvice.row(for: failed), "Too large to attach in T3 Code")
        XCTAssertEqual(AttachmentAdvice.detail(for: failed), AttachmentAdvice.detail(for: large(nil)))
        XCTAssertEqual(AttachmentAdvice.copied(for: failed), AttachmentAdvice.copied(for: large(nil)))
    }

    func testPartsStateIsKeptInTheSidecar() throws {
        let r = large(.done, parts: 3)
        let back = try JSONCoding.decoder.decode(Recording.self, from: JSONCoding.encoder.encode(r))
        XCTAssertEqual(back, r)
        XCTAssertEqual(back.attachableParts, 3)
        let failed = large(.failed, note: "Photos is full")
        XCTAssertEqual(try JSONCoding.decoder.decode(Recording.self, from: JSONCoding.encoder.encode(failed)), failed)
        let json = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(recording())) as! [String: Any]
        XCTAssertNil(json["partsStatus"], "left out for a recording that fits")
        XCTAssertNil(json["partCount"])
    }

    func testSidecarWrittenBeforePartsStillDecodes() throws {
        // A too-large recording as a build without parts saved it.
        let old = """
        {"assetId":"A/L0/001","device":{"model":"iPhone14,3","name":"iPhone","os":"iOS 27.0.1"},"durationSec":612.4,
         "file":"20261111-224105.mov","hasMicAudio":true,"id":"20261111-224105","peakAudioLevel":0.31,"sizeBytes":61300000,
         "source":"screenbrief","startedAt":"2026-11-11T22:41:05.000Z","transcribeSec":31.4,
         "transcript":[{"t":1,"text":"ok"}],"transcriptNote":"on-device (speech, took 31 seconds)","transcriptStatus":"done"}
        """
        let r = try JSONCoding.decoder.decode(Recording.self, from: Data(old.utf8))
        XCTAssertEqual(r.sizeBytes, 61_300_000)
        XCTAssertNil(r.partsStatus)
        XCTAssertNil(r.partCount)
        XCTAssertNil(r.partsNote)
        XCTAssertNil(r.partsAttempts)
        XCTAssertTrue(r.needsParts, "its parts are made at the next launch")
        XCTAssertTrue(r.resumesParts)
        XCTAssertFalse(r.isSplitting)
        XCTAssertEqual(AttachmentAdvice.row(for: r), "Too large to attach in T3 Code")
    }

    @MainActor
    func testPartFileNamesAreNotRecordings() {
        XCTAssertEqual(RecordingAlbum.partTitle(id: "20261111-224833", part: 2, of: 3), "ScreenBrief-20261111-224833-part2of3")
        for name in ["ScreenBrief-20261111-224833-part1of3.mov", "ScreenBrief-20261111-224833-part12of12.mov",
                     "ScreenBrief-20261111-224833-2-part2of2.mov", "screenbrief-20261111-224833-PART1OF3.MOV",
                     RecordingAlbum.partTitle(id: "20261111-224833", part: 99, of: 99) + ".mov"] {
            XCTAssertTrue(RecordingAlbum.isPart(fileName: name), name)
        }
        for name in ["ScreenBrief-20261111-224833.mov", "ScreenBrief-20261111-224833-2.mov", "RPReplay_Final1731.MP4",
                     "ScreenBrief-20261111-224833-part1.mov", "ScreenBrief-20261111-224833-partial.mov",
                     "IMG_0412-part1of3.mov", ""] {
            XCTAssertFalse(RecordingAlbum.isPart(fileName: name), name)
        }
        // A part's name is a well-formed id after the prefix, so it must be refused by name.
        let date = ISO8601.date(from: "2026-11-11T22:41:05Z")!
        XCTAssertEqual(AppModel.recordingID(fileName: "ScreenBrief-20261111-224833-part1of3.mov", created: date), RecordingID.make(for: date))
        XCTAssertEqual(AppModel.recordingID(fileName: "ScreenBrief-20261111-224833.mov", created: date), "20261111-224833")
        XCTAssertEqual(AppModel.recordingID(fileName: "ScreenBrief-20261111-224833-2.mov", created: date), "20261111-224833-2")
    }

    /// A list other tasks add to.
    private final class Log: @unchecked Sendable {
        private let lock = NSLock()
        private var _lines: [String] = []
        var lines: [String] { lock.lock(); defer { lock.unlock() }; return _lines }
        func add(_ line: String) { lock.lock(); _lines.append(line); lock.unlock() }
    }

    @MainActor
    private func wait(upTo seconds: Double = 30, until done: () -> Bool) async throws {
        let began = Date()
        while !done(), Date().timeIntervalSince(began) < seconds {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// A splitter that writes three small files named as parts, eight minutes apart.
    private static func threeParts(_ id: String, _ directory: URL) throws -> [MovieSplitter.Part] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return try (1...3).map { k in
            let url = directory.appendingPathComponent(RecordingAlbum.partTitle(id: id, part: k, of: 3) + ".mov")
            try Data([UInt8(k)]).write(to: url)
            return MovieSplitter.Part(url: url, offsetSec: Double(k - 1) * 480, bytes: 1)
        }
    }

    private func tooLargeOnDisk(_ files: RecordingFiles, id: String = "20261111-224105", duration: Double = 1300) throws -> Recording {
        var r = pendingRecording(id, duration: duration)
        r.sizeBytes = 161_300_000
        try Data([0]).write(to: files.movie(r))
        try files.save(r)
        return r
    }

    /// At launch a too-large recording goes pending, running, done, with its parts saved in
    /// order; transcription does not wait for it, and it is not split a second time.
    @MainActor
    func testTooLargeRecordingIsSplitAndSavedAsParts() async throws {
        let files = scratchFiles()
        let r = try tooLargeOnDisk(files)
        let probe = Probe()
        let saved = Log()
        let model = AppModel(files: files, transcribe: { _, _ in
            Transcriber.Result(phrases: [.init(t: 1, text: "ok")], engine: "stub", noVoice: false, peakLevel: 0.5)
        }, split: { movie, id, directory in
            probe.start(movie.lastPathComponent)
            while !probe.released { try? await Task.sleep(nanoseconds: 10_000_000) }
            return try Self.threeParts(id, directory)
        }, savePart: { url, name, date in
            let onDisk = FileManager.default.fileExists(atPath: url.path) && url.lastPathComponent == name
            saved.add("\(name) \(ISO8601.string(from: date))\(onDisk ? "" : " (no file)")")
            return .init(localIdentifier: name, inAlbum: true)
        })
        defer { probe.release() }
        func now() -> Recording? { model.recordings.first { $0.id == r.id } }

        model.loadSaved()
        XCTAssertNil(now()?.partsStatus)
        model.resumeUnfinished()
        XCTAssertEqual(now()?.partsStatus, .pending)
        XCTAssertEqual(now().flatMap(AttachmentAdvice.row), "Splitting into parts to attach…")

        try await wait { now()?.partsStatus == .running && now()?.transcriptStatus == .done && !probe.started.isEmpty }
        XCTAssertEqual(now()?.partsStatus, .running)
        XCTAssertEqual(now()?.transcriptStatus, .done, "transcription does not wait for the parts")
        XCTAssertEqual(probe.started, ["20261111-224105.mov"])
        XCTAssertEqual(files.loadAll().first?.partsStatus, .running)
        XCTAssertNil(now()?.attachableParts)

        probe.release()
        try await wait { now()?.partsStatus == .done }
        XCTAssertEqual(now()?.partsStatus, .done)
        XCTAssertEqual(now()?.partCount, 3)
        XCTAssertNil(now()?.partsNote)
        XCTAssertEqual(saved.lines, [
            "ScreenBrief-20261111-224105-part1of3.mov 2026-11-11T22:41:05.000Z",
            "ScreenBrief-20261111-224105-part2of3.mov 2026-11-11T22:49:05.000Z",
            "ScreenBrief-20261111-224105-part3of3.mov 2026-11-11T22:57:05.000Z",
        ], "each part under its own name, dated by its place in the recording")
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.parts.appendingPathComponent(r.id).path), "the part files are gone once Photos has them")
        XCTAssertEqual(try names(in: files), ["20261111-224105.json", "20261111-224105.mov"], "no part ever sits among the recordings")
        XCTAssertEqual(now().flatMap(AttachmentAdvice.row), "Attach as 3 parts")
        XCTAssertTrue(now().map { Brief.text(for: $0) }?.contains("attached to this thread as 3 parts (ScreenBrief-20261111-224105-part1of3 to part3of3)") ?? false)
        XCTAssertEqual(files.loadAll().first?.attachableParts, 3)

        // Done is done: neither asking again nor the next launch splits it again.
        model.enqueueSplit(r.id)
        model.resumeUnfinished()
        let relaunched = AppModel(files: files, split: { _, _, _ in probe.start("again"); return [] })
        relaunched.loadSaved()
        relaunched.resumeUnfinished()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(probe.started, ["20261111-224105.mov"])
        XCTAssertEqual(saved.lines.count, 3)
        XCTAssertEqual(relaunched.recordings.first?.partsStatus, .done)
    }

    /// Photos refuses the second part: the recording is marked failed with the reason, the part
    /// files are removed, and it reads and copies as a too-large recording did before. The next
    /// launch tries again.
    @MainActor
    func testFailedSaveLeavesTheRecordingUsable() async throws {
        let files = scratchFiles()
        let r = try tooLargeOnDisk(files)
        let saved = Log()
        let model = AppModel(files: files, transcribe: { _, _ in
            Transcriber.Result(phrases: [.init(t: 1, text: "ok")], engine: "stub", noVoice: false, peakLevel: 0.5)
        }, split: { _, id, directory in try Self.threeParts(id, directory) }, savePart: { _, name, _ in
            saved.add(name)
            if saved.lines.count == 2 { throw WriterError("Photos is full") }
            return .init(localIdentifier: name, inAlbum: true)
        })
        func now() -> Recording? { model.recordings.first { $0.id == r.id } }
        model.loadSaved()
        model.resumeUnfinished()
        try await wait { now()?.partsStatus == .failed && now()?.transcriptStatus == .done }

        let failed = try XCTUnwrap(now())
        XCTAssertEqual(failed.partsStatus, .failed)
        XCTAssertEqual(failed.partsNote, "Photos is full")
        XCTAssertNil(failed.partCount)
        XCTAssertNil(failed.attachableParts)
        XCTAssertEqual(saved.lines.count, 2, "it stops at the part that failed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.parts.appendingPathComponent(r.id).path), "the part files are removed")
        XCTAssertEqual(try names(in: files), ["20261111-224105.json", "20261111-224105.mov"])
        XCTAssertEqual(files.loadAll().first?.partsStatus, .failed)

        var asBefore = failed
        asBefore.partsStatus = nil
        asBefore.partsNote = nil
        XCTAssertEqual(Brief.text(for: failed), Brief.text(for: asBefore), "Copy gives the brief of a recording that cannot be attached")
        XCTAssertTrue(Brief.text(for: failed).contains("so it is not attached to this thread"))
        XCTAssertTrue(Brief.text(for: failed).contains("[00:01] ok"))
        XCTAssertEqual(AttachmentAdvice.row(for: failed), "Too large to attach in T3 Code")
        XCTAssertEqual(AttachmentAdvice.detail(for: failed), AttachmentAdvice.detail(for: asBefore))

        let relaunched = AppModel(files: files, split: { _, id, directory in try Self.threeParts(id, directory) },
                                  savePart: { _, name, _ in .init(localIdentifier: name, inAlbum: true) })
        relaunched.loadSaved()
        relaunched.resumeUnfinished()
        try await wait { relaunched.recordings.first?.partsStatus == .done }
        XCTAssertEqual(relaunched.recordings.first?.attachableParts, 3)
    }

    /// A splitter that fails (or makes no parts) ends the same way, and one that fits is left alone.
    @MainActor
    func testSplitterFailureAndRecordingsThatFit() async throws {
        let files = scratchFiles()
        let r = try tooLargeOnDisk(files)
        var small = pendingRecording("20261111-230000")
        small.sizeBytes = 30_000_000
        try Data([0]).write(to: files.movie(small))
        try files.save(small)
        let asked = Log()
        let model = AppModel(files: files, split: { movie, _, _ in asked.add(movie.lastPathComponent); return [] },
                             savePart: { _, name, _ in XCTFail("nothing to save"); return .init(localIdentifier: name, inAlbum: true) })
        model.loadSaved()
        model.enqueueSplit(small.id)
        model.enqueueSplit(r.id)
        model.enqueueSplit(r.id)
        try await wait { model.recordings.first { $0.id == r.id }?.partsStatus == .failed }
        XCTAssertEqual(asked.lines, ["20261111-224105.mov"], "only the too-large one, once")
        XCTAssertEqual(model.recordings.first { $0.id == r.id }?.partsNote, "The video was not split into parts.")
        XCTAssertNil(model.recordings.first { $0.id == small.id }?.partsStatus)
    }

    // MARK: Splits that fail, are deleted, or hang

    private static let transcribed: Transcriber.Work = { _, _ in
        Transcriber.Result(phrases: [.init(t: 1, text: "ok")], engine: "stub", noVoice: false, peakLevel: 0.5)
    }

    /// A failed split is started again at launch only while it has been tried fewer than three
    /// times; one that was waiting or under way when the app went is always started again.
    func testOnlyAFailedSplitRunsOutOfAttempts() throws {
        XCTAssertEqual(Recording.maxPartsAttempts, 3)
        func resumes(_ status: PartsStatus?, attempts: Int?, parts: Int? = nil) -> Bool {
            var r = large(status, parts: parts)
            r.partsAttempts = attempts
            return r.resumesParts
        }
        XCTAssertTrue(resumes(.failed, attempts: nil), "failed in a build that did not count")
        XCTAssertTrue(resumes(.failed, attempts: 1))
        XCTAssertTrue(resumes(.failed, attempts: 2))
        XCTAssertFalse(resumes(.failed, attempts: 3))
        XCTAssertFalse(resumes(.failed, attempts: 4))
        for status in [PartsStatus.pending, .running] {
            XCTAssertTrue(resumes(status, attempts: 3), "\(status)")
            XCTAssertTrue(resumes(status, attempts: 9), "\(status)")
        }
        XCTAssertTrue(resumes(nil, attempts: nil))
        XCTAssertFalse(resumes(.done, attempts: 1, parts: 3))

        var counted = large(.failed, note: "Photos is full")
        counted.partsAttempts = 3
        XCTAssertEqual(try JSONCoding.decoder.decode(Recording.self, from: JSONCoding.encoder.encode(counted)), counted)
        let json = try JSONSerialization.jsonObject(with: JSONCoding.encoder.encode(recording())) as! [String: Any]
        XCTAssertNil(json["partsAttempts"], "left out for a recording that was never split")
    }

    /// A recording that can never be split is tried at three launches, then left as it is: failed,
    /// with its reason, reading as a recording too large to attach.
    @MainActor
    func testSplitThatAlwaysFailsIsLeftAloneAfterThreeLaunches() async throws {
        let files = scratchFiles()
        let r = try tooLargeOnDisk(files)
        let asked = Log()
        func launch() -> AppModel {
            let model = AppModel(files: files, transcribe: Self.transcribed, split: { movie, _, _ in
                asked.add(movie.lastPathComponent)
                throw WriterError("This kind of video cannot be cut into parts.")
            }, savePart: { _, name, _ in XCTFail("nothing to save"); return .init(localIdentifier: name, inAlbum: true) })
            model.loadSaved()
            model.resumeUnfinished()
            return model
        }
        for attempt in 1...3 {
            let model = launch()
            XCTAssertEqual(model.recordings.first?.partsStatus, .pending, "launch \(attempt) tries")
            try await wait { model.recordings.first?.partsStatus == .failed }
            XCTAssertEqual(model.recordings.first?.partsStatus, .failed)
            XCTAssertEqual(asked.lines.count, attempt)
            XCTAssertEqual(model.recordings.first?.partsAttempts, attempt)
            XCTAssertEqual(files.loadAll().first?.partsAttempts, attempt, "the count is kept for the next launch")
        }
        for _ in 4...5 {
            let model = launch()
            XCTAssertEqual(model.recordings.first?.partsStatus, .failed, "not queued again")
            try await Task.sleep(nanoseconds: 300_000_000)
            XCTAssertEqual(asked.lines.count, 3, "no fourth attempt")
            let left = try XCTUnwrap(model.recordings.first)
            XCTAssertEqual(left.id, r.id)
            XCTAssertEqual(left.partsStatus, .failed)
            XCTAssertEqual(left.partsNote, "This kind of video cannot be cut into parts.")
            XCTAssertEqual(left.partsAttempts, 3)
            XCTAssertEqual(AttachmentAdvice.row(for: left), "Too large to attach in T3 Code")
            var asBefore = left
            asBefore.partsStatus = nil
            asBefore.partsNote = nil
            XCTAssertEqual(AttachmentAdvice.detail(for: left), AttachmentAdvice.detail(for: asBefore))
            XCTAssertEqual(Brief.text(for: left), Brief.text(for: asBefore))
            XCTAssertEqual(files.loadAll().first, left)
        }
    }

    /// One failure does not count against a recording: the next launch splits it.
    @MainActor
    func testSplitThatFailsOnceThenSucceedsEndsDone() async throws {
        let files = scratchFiles()
        _ = try tooLargeOnDisk(files)
        let asked = Log()
        func launch() -> AppModel {
            let model = AppModel(files: files, transcribe: Self.transcribed, split: { movie, id, directory in
                asked.add(movie.lastPathComponent)
                if asked.lines.count == 1 { throw WriterError("Writing a part stalled.") }
                return try Self.threeParts(id, directory)
            }, savePart: { _, name, _ in .init(localIdentifier: name, inAlbum: true) })
            model.loadSaved()
            model.resumeUnfinished()
            return model
        }
        let first = launch()
        try await wait { first.recordings.first?.partsStatus == .failed }
        XCTAssertEqual(first.recordings.first?.partsNote, "Writing a part stalled.")
        XCTAssertEqual(first.recordings.first?.partsAttempts, 1)

        let second = launch()
        try await wait { second.recordings.first?.partsStatus == .done }
        XCTAssertEqual(second.recordings.first?.partsStatus, .done)
        XCTAssertEqual(second.recordings.first?.attachableParts, 3)
        XCTAssertNil(second.recordings.first?.partsNote)
        XCTAssertEqual(second.recordings.first?.partsAttempts, 2)
        XCTAssertEqual(asked.lines.count, 2)

        let third = launch()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(asked.lines.count, 2, "done is done")
        XCTAssertEqual(third.recordings.first?.partsStatus, .done)
    }

    /// Deleting a recording while its parts are going into Photos stops the split: no further
    /// part of it is saved, nothing brings the recording back, and the next one is split.
    @MainActor
    func testDeletingARecordingStopsItsSplit() async throws {
        let files = scratchFiles()
        let deleted = try tooLargeOnDisk(files, id: "20261111-224105")
        let next = try tooLargeOnDisk(files, id: "20261111-230000")
        let probe = Probe()
        let saved = Log()
        let model = AppModel(files: files, transcribe: Self.transcribed, split: { movie, id, directory in
            probe.start(movie.lastPathComponent)
            return try Self.threeParts(id, directory)
        }, savePart: { _, name, _ in
            saved.add(name)
            // The first part is on its way into Photos when the recording is deleted.
            if saved.lines.count == 1 { while !probe.released { Thread.sleep(forTimeInterval: 0.01) } }
            return .init(localIdentifier: name, inAlbum: true)
        })
        defer { probe.release() }
        model.loadSaved()
        model.enqueueSplit(deleted.id)
        model.enqueueSplit(next.id)
        try await wait { saved.lines.count == 1 }
        XCTAssertEqual(saved.lines, ["ScreenBrief-20261111-224105-part1of3.mov"])
        XCTAssertEqual(model.recordings.first { $0.id == deleted.id }?.partsStatus, .running)
        XCTAssertEqual(model.recordings.first { $0.id == next.id }?.partsStatus, .pending)

        model.delete(try XCTUnwrap(model.recordings.first { $0.id == deleted.id }))
        XCTAssertEqual(model.recordings.map(\.id), [next.id])
        probe.release()

        try await wait { model.recordings.first?.partsStatus == .done }
        XCTAssertEqual(saved.lines, [
            "ScreenBrief-20261111-224105-part1of3.mov",
            "ScreenBrief-20261111-230000-part1of3.mov",
            "ScreenBrief-20261111-230000-part2of3.mov",
            "ScreenBrief-20261111-230000-part3of3.mov",
        ], "no part of the deleted recording after the delete; the queue went on to the next")
        XCTAssertEqual(probe.started, ["20261111-224105.mov", "20261111-230000.mov"])
        XCTAssertEqual(model.recordings.map(\.id), [next.id], "the deleted recording does not come back")
        XCTAssertEqual(model.recordings.first?.attachableParts, 3)
        XCTAssertEqual(try names(in: files), ["20261111-230000.json", "20261111-230000.mov"], "nor does its sidecar")
        XCTAssertEqual(files.loadAll().map(\.id), [next.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.parts.appendingPathComponent(deleted.id).path), "its part files are removed")
        XCTAssertTrue(files.dismissed().contains(deleted.assetId))

        // Nor does a part of it arrive later.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(saved.lines.count, 4)
    }

    func testSplitDeadlineIsTwiceTheLengthAndAtLeastFiveMinutes() {
        XCTAssertEqual(MovieSplitter.deadline(forDuration: 0), 300)
        XCTAssertEqual(MovieSplitter.deadline(forDuration: 150), 300)
        XCTAssertEqual(MovieSplitter.deadline(forDuration: 151), 302)
        XCTAssertEqual(MovieSplitter.deadline(forDuration: 1300), 2600)
    }

    /// A split that never returns (and ignores cancellation) is marked failed once its deadline
    /// passes, and the recording queued behind it is still split.
    @MainActor
    func testStalledSplitFailsAndTheNextRecordingIsStillSplit() async throws {
        let files = scratchFiles()
        let stalled = try tooLargeOnDisk(files, id: "20261111-224105", duration: 1300)
        let next = try tooLargeOnDisk(files, id: "20261111-230000", duration: 900)
        let probe = Probe()
        let saved = Log()
        var deadlinesAskedFor: [Double] = []
        let model = AppModel(files: files, transcribe: Self.transcribed, split: { movie, id, directory in
            probe.start(movie.lastPathComponent)
            if id == "20261111-224105" {
                while !probe.released {
                    if Task.isCancelled { probe.sawCancel() }
                    try? await Task.sleep(nanoseconds: 10_000_000)
                }
            }
            return try Self.threeParts(id, directory)
        }, savePart: { _, name, _ in
            saved.add(name)
            return .init(localIdentifier: name, inAlbum: true)
        }, splitDeadline: { duration in
            deadlinesAskedFor.append(duration)
            return duration == 1300 ? 0.3 : 60
        })
        defer { probe.release() }
        func now(_ id: String) -> Recording? { model.recordings.first { $0.id == id } }
        model.loadSaved()
        model.enqueueSplit(stalled.id)
        model.enqueueSplit(next.id)
        try await wait { now(next.id)?.partsStatus == .done }

        XCTAssertEqual(probe.started, ["20261111-224105.mov", "20261111-230000.mov"], "one at a time, in order")
        XCTAssertEqual(deadlinesAskedFor, [1300, 900], "the deadline is asked for with the recording's length")
        XCTAssertEqual(now(stalled.id)?.partsStatus, .failed)
        XCTAssertEqual(now(stalled.id)?.partsNote, "Splitting timed out.")
        XCTAssertNil(now(stalled.id)?.attachableParts)
        XCTAssertEqual(now(stalled.id).flatMap(AttachmentAdvice.row), "Too large to attach in T3 Code")
        XCTAssertEqual(now(next.id)?.partsStatus, .done)
        XCTAssertEqual(now(next.id)?.attachableParts, 3)
        XCTAssertEqual(saved.lines, [
            "ScreenBrief-20261111-230000-part1of3.mov",
            "ScreenBrief-20261111-230000-part2of3.mov",
            "ScreenBrief-20261111-230000-part3of3.mov",
        ])
        XCTAssertEqual(files.loadAll().first { $0.id == stalled.id }?.partsStatus, .failed)
        for _ in 0..<100 where !probe.cancelled { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(probe.cancelled, "the stalled split was told to stop")

        // Parts that arrive after the deadline are neither saved nor counted.
        probe.release()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(saved.lines.count, 3)
        XCTAssertEqual(now(stalled.id)?.partsStatus, .failed)
        XCTAssertEqual(now(stalled.id)?.partsNote, "Splitting timed out.")
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.parts.appendingPathComponent(stalled.id).path))
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

    // MARK: Copies out of Photos

    private func scratchFiles() -> RecordingFiles {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("files-\(UUID().uuidString)")
        let files = RecordingFiles(documents: root.appendingPathComponent("Documents"), support: root.appendingPathComponent("Support"),
                                   parts: root.appendingPathComponent("Caches/Parts"))
        files.prepare()
        return files
    }

    private func names(in files: RecordingFiles) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: files.recordings.path).sorted()
    }

    /// While a movie is being copied, the folder holds no file the Mac would take for a recording.
    func testACopyInProgressIsNotVisibleAsAMovie() async throws {
        let files = scratchFiles()
        let movie = files.recordings.appendingPathComponent("20261111-224105.mov")
        var during: [String] = []
        try await RecordingFiles.writeThenMove(to: movie) { partial in
            try Data([1, 2, 3]).write(to: partial)
            during = try self.names(in: files)
        }
        XCTAssertEqual(during, ["20261111-224105.mov.part"])
        for name in during {
            XCTAssertNil(name.range(of: "\\.(mp4|mov|m4v|json)$", options: [.regularExpression, .caseInsensitive]), name)
        }
        XCTAssertEqual(try names(in: files), ["20261111-224105.mov"])
        XCTAssertEqual(try Data(contentsOf: movie), Data([1, 2, 3]))
    }

    func testAFailedCopyLeavesNothingBehind() async throws {
        let files = scratchFiles()
        let movie = files.recordings.appendingPathComponent("20261111-224105.mov")
        do {
            try await RecordingFiles.writeThenMove(to: movie) { partial in
                try Data([1, 2, 3]).write(to: partial)
                throw Transcriber.Failure(message: "iCloud download failed")
            }
            XCTFail("the error must reach the caller")
        } catch {
            XCTAssertEqual(error.localizedDescription, "iCloud download failed")
        }
        XCTAssertEqual(try names(in: files), [])
    }

    func testACopyReplacesAnEarlierFileAndAnEarlierPartial() async throws {
        let files = scratchFiles()
        let movie = files.recordings.appendingPathComponent("20261111-224105.mov")
        try Data([9]).write(to: movie)
        try Data([9, 9]).write(to: movie.appendingPathExtension("part"))
        try await RecordingFiles.writeThenMove(to: movie) { try Data([1, 2, 3]).write(to: $0) }
        XCTAssertEqual(try names(in: files), ["20261111-224105.mov"])
        XCTAssertEqual(try Data(contentsOf: movie), Data([1, 2, 3]))
    }

    func testStalePartialCopiesAreDeleted() throws {
        let files = scratchFiles()
        let r = recording()
        try Data([0]).write(to: files.movie(r))
        try files.save(r)
        for name in ["20261111-224105.mov.part", "20261110-101010.mp4.part"] {
            try Data([0]).write(to: files.recordings.appendingPathComponent(name))
        }
        files.removeStalePartials()
        XCTAssertEqual(try names(in: files), ["20261111-224105.json", "20261111-224105.mov"])
    }

    @MainActor
    func testLaunchClearsStalePartialCopies() throws {
        let files = scratchFiles()
        let r = recording()
        try Data([0]).write(to: files.movie(r))
        try files.save(r)
        try Data([0]).write(to: files.recordings.appendingPathComponent("20261110-101010.mov.part"))
        let model = AppModel(files: files)
        model.loadSaved()
        XCTAssertEqual(try names(in: files), ["20261111-224105.json", "20261111-224105.mov"])
        XCTAssertEqual(model.recordings, [r])
    }

    // MARK: Transcription deadline

    func testTranscriptionDeadlineIsThreeTimesTheLengthAndAtLeastTwoMinutes() {
        XCTAssertEqual(Transcriber.deadline(forDuration: 0), 120)
        XCTAssertEqual(Transcriber.deadline(forDuration: 40), 120)
        XCTAssertEqual(Transcriber.deadline(forDuration: 41), 123)
        XCTAssertEqual(Transcriber.deadline(forDuration: 480), 1440)
    }

    func testDeadlineReturnsTheResultOfWorkThatFinishesInTime() async throws {
        let value = try await Deadline.run(seconds: 5) { 7 }
        XCTAssertEqual(value, 7)
        do {
            _ = try await Deadline.run(seconds: 5) { () -> Int in throw Transcriber.Failure(message: "no") }
            XCTFail("the work's error must reach the caller")
        } catch {
            XCTAssertEqual(error.localizedDescription, "no")
        }
    }

    /// What a stubbed transcription saw, shared with the test across tasks.
    private final class Probe: @unchecked Sendable {
        private let lock = NSLock()
        private var _started: [String] = []
        private var _cancelled = false
        private var _release = false
        var started: [String] { lock.lock(); defer { lock.unlock() }; return _started }
        var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return _cancelled }
        var released: Bool { lock.lock(); defer { lock.unlock() }; return _release }
        func start(_ name: String) { lock.lock(); _started.append(name); lock.unlock() }
        func sawCancel() { lock.lock(); _cancelled = true; lock.unlock() }
        func release() { lock.lock(); _release = true; lock.unlock() }
    }

    func testDeadlineCancelsWorkThatRunsOverAndDoesNotWaitForIt() async throws {
        let probe = Probe()
        let began = Date()
        do {
            // Work that notices the cancellation and still refuses to stop.
            _ = try await Deadline.run(seconds: 0.2) { () -> Int in
                while !probe.released {
                    if Task.isCancelled { probe.sawCancel() }
                    try? await Task.sleep(nanoseconds: 10_000_000)
                }
                return 1
            }
            XCTFail("must time out")
        } catch {
            XCTAssertTrue(error is Deadline.TimedOut, "\(error)")
        }
        XCTAssertLessThan(Date().timeIntervalSince(began), 3)
        for _ in 0..<100 where !probe.cancelled { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(probe.cancelled, "the work is told to stop")
        probe.release()
    }

    private func pendingRecording(_ id: String, duration: Double = 15.4) -> Recording {
        Recording(id: id, startedAt: ISO8601.date(from: "2026-11-11T22:41:05Z")!, durationSec: duration,
                  device: DeviceDescription(name: "iPhone", model: "iPhone14,3", os: "iOS 27.0.1"),
                  hasMicAudio: nil, transcript: nil, file: "\(id).mov", source: "screenbrief",
                  assetId: "A/L0/\(id)", sizeBytes: 1, transcriptStatus: .pending)
    }

    /// A transcription that never completes (and ignores cancellation) is marked failed once its
    /// deadline passes, and the recording queued behind it is still transcribed.
    @MainActor
    func testStalledTranscriptionFailsAndTheNextRecordingIsStillTranscribed() async throws {
        let files = scratchFiles()
        let stalled = pendingRecording("20261111-224105")
        let next = pendingRecording("20261111-224300")
        for r in [stalled, next] {
            try Data([0]).write(to: files.movie(r))
            try files.save(r)
        }
        let probe = Probe()
        var deadlinesAskedFor: [Double] = []
        let model = AppModel(files: files, transcribe: { movie, _ in
            let name = movie.lastPathComponent
            probe.start(name)
            if name == "20261111-224105.mov" {
                while !probe.released {
                    if Task.isCancelled { probe.sawCancel() }
                    try? await Task.sleep(nanoseconds: 10_000_000)
                }
            }
            return Transcriber.Result(phrases: [.init(t: 1, text: "Make this button blue.")], engine: "stub", noVoice: false, peakLevel: 0.5)
        }, transcriptionDeadline: { duration in
            deadlinesAskedFor.append(duration)
            return 0.3
        })
        defer { probe.release() }
        model.loadSaved()
        XCTAssertEqual(model.recordings.map(\.id), [next.id, stalled.id])
        model.enqueueTranscription(stalled.id)
        model.enqueueTranscription(next.id)

        func status(_ id: String) -> TranscriptStatus? { model.recordings.first { $0.id == id }?.transcriptStatus }
        let began = Date()
        while status(next.id) != .done, Date().timeIntervalSince(began) < 10 {
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        XCTAssertEqual(probe.started, ["20261111-224105.mov", "20261111-224300.mov"], "one at a time, in order")
        XCTAssertEqual(deadlinesAskedFor, [15.4, 15.4], "the deadline is asked for with the recording's length")
        let failed = try XCTUnwrap(model.recordings.first { $0.id == stalled.id })
        XCTAssertEqual(failed.transcriptStatus, .failed)
        XCTAssertEqual(failed.transcriptNote, "Transcription timed out on the phone. screenbrief pull transcribes it on the Mac.")
        XCTAssertNil(failed.transcript)
        let done = try XCTUnwrap(model.recordings.first { $0.id == next.id })
        XCTAssertEqual(done.transcriptStatus, .done)
        XCTAssertEqual(done.transcript, [.init(t: 1, text: "Make this button blue.")])
        XCTAssertTrue(probe.cancelled, "the stalled work was cancelled")
        // What the Mac reads says the same.
        XCTAssertEqual(files.loadAll().first { $0.id == stalled.id }?.transcriptStatus, .failed)

        // A result that arrives after the deadline is not applied.
        probe.release()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(status(stalled.id), .failed)
    }

    func testBriefHasNoMarksBlock() {
        XCTAssertFalse(Brief.text(for: recording(transcript: [.init(t: 1, text: "ok")]), timeZone: utc).contains("Frames I marked"))
    }
}
