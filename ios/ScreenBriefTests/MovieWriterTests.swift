import AVFoundation
import XCTest
@testable import ScreenBrief

/// `MovieWriter` and `BroadcastRecorder` with synthetic ReplayKit-shaped buffers; the movies are
/// read back with AVFoundation (and left in /tmp/sb-moviecheck/ for ffprobe on the Mac).
final class MovieWriterTests: XCTestCase {
    private func url(_ name: String) -> URL {
        let dir = URL(fileURLWithPath: "/tmp/sb-moviecheck", isDirectory: true)
        if (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil {
            return dir.appendingPathComponent(name)
        }
        return FileManager.default.temporaryDirectory.appendingPathComponent(name)
    }

    private func record(_ name: String, seconds: Double = 4, configure: (inout MovieWriter.Configuration) -> Void = { _ in },
                        feed: ((SyntheticFeeder) -> Void)? = nil, video: Bool = true, audio: Bool = true,
                        orientation: CGImagePropertyOrientation = .up, tone: Bool = true, busy: Bool = false) -> (MovieWriter.Summary, URL) {
        var config = MovieWriter.Configuration()
        configure(&config)
        let out = url(name)
        let w = MovieWriter(outputURL: out, configuration: config)
        let feeder = SyntheticFeeder(orientation: orientation, video: { w.appendVideo($0) }, audio: { w.appendAudio($0) })
        feeder.tone = tone
        feeder.busy = busy
        if let feed { feed(feeder) } else { feeder.feed(seconds: seconds, video: video, audio: audio) }
        return (w.finish(timeout: 5), out)
    }

    func testFragmentedMovieWithVideoAndAudio() async throws {
        let (summary, out) = record("av.mov")
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        XCTAssertTrue(summary.hasAudioTrack)
        XCTAssertTrue(summary.hasMicAudio)
        XCTAssertGreaterThan(summary.peakAudioLevel, 0.1, "a 440 Hz tone at 8000/32768")
        XCTAssertEqual(summary.width, 740)
        XCTAssertEqual(summary.height, 1600)

        let info = try await MovieInfo.load(out)
        print("[movie av] \(out.path) \(info) summary=\(summary)")
        XCTAssertTrue(info.isReadable)
        XCTAssertEqual(info.duration, 4, accuracy: 0.25)
        XCTAssertEqual(info.videoSize, CGSize(width: 740, height: 1600))
        XCTAssertTrue(info.hasAudioTrack)
        XCTAssertEqual(info.audioDuration, 4, accuracy: 0.3)
        XCTAssertEqual(info.videoStart, 0, accuracy: 0.05, "the movie starts at 0, not at ReplayKit's host time")
        XCTAssertGreaterThan(info.videoSampleCount, 100)
        XCTAssertTrue(info.decodedFrame)
        let tracks = try await AVURLAsset(url: out).loadTracks(withMediaType: .video)
        let codec = try await tracks[0].load(.formatDescriptions).first.map { CMFormatDescriptionGetMediaSubType($0) }
        XCTAssertEqual(codec, kCMVideoCodecType_H264)
        let bytesPerSecond = Double(BroadcastRecorder.fileSize(out)) / info.duration
        XCTAssertLessThan(bytesPerSecond * 480, 50 * 1_048_576)
    }

    /// A screen that never stops changing (noise, the worst case) must stay near the configured
    /// bitrate: the encoder is told an average, and this checks it is honoured rather than
    /// ignored. The Mac's encoder, which the simulator uses, overshoots by 15-25% on twelve
    /// seconds of noise; on the iPhone a four-minute recording of real screens came out at the
    /// configured rate (750 kbps for 748).
    func testBusyScreenStaysNearTheConfiguredBitrate() async throws {
        let (summary, out) = record("busy.mov", seconds: 12, busy: true)
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        let info = try await MovieInfo.load(out)
        XCTAssertTrue(info.decodedFrame)
        let bytes = BroadcastRecorder.fileSize(out)
        let bytesPerSecond = Double(bytes) / info.duration
        let configured = MovieWriter.Configuration().bytesPerSecond
        print("[movie busy] \(bytes) bytes in \(info.duration)s = \(Int(bytesPerSecond * 8 / 1000)) kbps (configured \(Int(configured * 8 / 1000))); 8 min = \(Int(bytesPerSecond * 480 / 1_048_576)) MiB")
        XCTAssertLessThan(bytesPerSecond, configured * 1.4)
        XCTAssertGreaterThan(bytesPerSecond, configured * 0.4, "the busy picture should use most of the budget, or this test proves nothing")
    }

    func testConfiguredRatesLeaveRoomForEightMinutes() {
        let c = MovieWriter.Configuration()
        XCTAssertGreaterThan(c.secondsThatFit(in: Recording.maxAttachmentBytes), 8 * 60 * 1.1, "eight minutes with a tenth to spare")
        XCTAssertEqual(c.bytesPerSecond, Double(c.videoBitrate + c.audioBitrate) / 8 * 1.03, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(c.keyFrameInterval, c.fragmentInterval ?? 0)
    }

    func testPlainMP4() async throws {
        let (summary, out) = record("plain.mp4", seconds: 3, configure: { $0.fileType = .mp4; $0.fragmentInterval = nil })
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        let info = try await MovieInfo.load(out)
        XCTAssertTrue(info.isReadable)
        XCTAssertTrue(info.hasAudioTrack)
        XCTAssertEqual(info.duration, 3, accuracy: 0.25)
    }

    func testMicOffMeansNoAudioTrack() async throws {
        let (summary, out) = record("video-only.mov", seconds: 3, configure: { $0.audioDecisionTimeout = 1 }, audio: false)
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        XCTAssertFalse(summary.hasAudioTrack)
        XCTAssertFalse(summary.hasMicAudio)
        let info = try await MovieInfo.load(out)
        XCTAssertTrue(info.isReadable)
        XCTAssertFalse(info.hasAudioTrack)
        XCTAssertEqual(info.duration, 3, accuracy: 0.3)
    }

    func testSilentMicReportsZeroPeak() {
        let (summary, _) = record("silent.mov", seconds: 2, tone: false)
        XCTAssertTrue(summary.hasMicAudio)
        XCTAssertEqual(summary.peakAudioLevel, 0)
    }

    func testStaticScreenAndMicGapKeepAudioInStep() async throws {
        let (summary, out) = record("gaps.mov", feed: { f in
            f.feed(seconds: 5, videoOff: 1.5...3.5, audioOff: 2.0...3.0)
        })
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        XCTAssertGreaterThan(summary.keepaliveFrames, 3, "a static screen is kept alive")
        XCTAssertGreaterThan(summary.silenceBuffersAppended, 0, "a mic gap is filled with silence")
        let info = try await MovieInfo.load(out)
        XCTAssertEqual(info.duration, 5, accuracy: 0.3)
        XCTAssertEqual(info.audioDuration, info.videoDuration, accuracy: 0.35, "audio must not slide against video")
    }

    func testLandscapeFramesGetARotation() async throws {
        let (summary, out) = record("landscape.mov", seconds: 2, orientation: .left)
        XCTAssertEqual(summary.rotation, 270)
        let info = try await MovieInfo.load(out)
        XCTAssertNotEqual(info.videoTransform, .identity)
    }

    func testFinishWithoutFramesReportsErrorAndIsIdempotent() {
        let w = MovieWriter(outputURL: url("none.mov"))
        let first = w.finish(timeout: 1)
        XCTAssertFalse(first.finished)
        XCTAssertNotNil(first.error)
        XCTAssertEqual(w.finish(timeout: 1).finished, false)
    }

    func testOutputSizeRules() {
        XCTAssertTrue(MovieWriter.outputSize(width: 1284, height: 2778, maxLongSide: 1600) == (740, 1600))
        XCTAssertTrue(MovieWriter.outputSize(width: 2778, height: 1284, maxLongSide: 1600) == (1600, 740))
        XCTAssertTrue(MovieWriter.outputSize(width: 750, height: 1334, maxLongSide: 1600) == (750, 1334))
        XCTAssertTrue(MovieWriter.outputSize(width: 1179, height: 2556, maxLongSide: 1600) == (738, 1600))
    }

    // MARK: BroadcastRecorder

    private func recorderDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rec-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testRecorderRefusesWithoutPhotosAccess() {
        let r = BroadcastRecorder(directory: recorderDirectory(),
                                  access: { .init(addOnly: .denied, readWrite: .denied) },
                                  saver: { _, _, _ in XCTFail("must not save"); return .init(localIdentifier: "", inAlbum: false) })
        var seen: [BroadcastDiagnostics] = []
        r.diagnosticsSink = { seen.append($0) }
        XCTAssertEqual(r.start(), BroadcastRecorder.cannotSaveMessage)
        XCTAssertEqual(seen.last?.phase, "failed")
        XCTAssertEqual(seen.last?.photosAddOnly, "denied")
    }

    func testRecorderSavesTheMovieAndCleansUp() async throws {
        let dir = recorderDirectory()
        var savedName: String?
        var savedInfo: MovieInfo?
        let start = Date(timeIntervalSince1970: 1_794_000_000)
        let r = BroadcastRecorder(directory: dir, startedAt: start,
                                  access: { .init(addOnly: .authorized, readWrite: .notDetermined) },
                                  saver: { url, name, _ in
                                      savedName = name
                                      let sem = DispatchSemaphore(value: 0)
                                      Task { savedInfo = try? await MovieInfo.load(url); sem.signal() }
                                      sem.wait()
                                      return .init(localIdentifier: "ABC/L0/001", inAlbum: true)
                                  })
        var last: BroadcastDiagnostics?
        r.diagnosticsSink = { last = $0 }
        XCTAssertNil(r.start())
        let feeder = SyntheticFeeder(video: { r.appendVideo($0) }, audio: { r.appendAudio($0) })
        feeder.feed(seconds: 2)
        let outcome = r.finish(timeout: 5)

        XCTAssertNil(outcome.error)
        XCTAssertEqual(outcome.saved?.localIdentifier, "ABC/L0/001")
        XCTAssertEqual(savedName, "ScreenBrief-\(RecordingID.make(for: start)).mov")
        XCTAssertEqual(savedInfo?.hasAudioTrack, true)
        XCTAssertEqual(savedInfo?.duration ?? 0, 2, accuracy: 0.3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.fileURL.path), "the extension's copy is removed once Photos has it")
        XCTAssertEqual(last?.phase, "saved")
        XCTAssertEqual(last?.inAlbum, true)
        XCTAssertGreaterThan(last?.videoFrames ?? 0, 30)
        XCTAssertTrue(last?.events.contains { $0.contains("saved to Photos") } ?? false, "\(last?.events ?? [])")
    }

    func testRecorderReportsASaveFailure() {
        let r = BroadcastRecorder(directory: recorderDirectory(), access: { .init(addOnly: .authorized, readWrite: .authorized) },
                                  saver: { _, _, _ in throw WriterError("PHPhotosErrorDomain 3302") })
        XCTAssertNil(r.start())
        let feeder = SyntheticFeeder(video: { r.appendVideo($0) }, audio: { r.appendAudio($0) })
        feeder.feed(seconds: 1)
        let outcome = r.finish()
        XCTAssertEqual(outcome.error, "Saving to Photos failed: PHPhotosErrorDomain 3302")
        XCTAssertEqual(r.currentDiagnostics.phase, "failed")
    }

    func testLeftoverMoviesAreRecovered() throws {
        let dir = recorderDirectory()
        let leftover = dir.appendingPathComponent("ScreenBrief-20261111-200000.mov")
        try Data(repeating: 1, count: 100).write(to: leftover)
        var saved: [String] = []
        let r = BroadcastRecorder(directory: dir, access: { .init(addOnly: .authorized, readWrite: .authorized) },
                                  saver: { _, name, _ in saved.append(name); return .init(localIdentifier: "x", inAlbum: true) })
        XCTAssertEqual(r.recoverLeftovers(), 1)
        XCTAssertEqual(saved, ["ScreenBrief-20261111-200000.mov"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: leftover.path))
    }
}
