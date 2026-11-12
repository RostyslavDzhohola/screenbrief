import AVFoundation
import XCTest
@testable import ScreenBrief

/// `MovieSplitter` on movies recorded by `MovieWriter` from synthetic ReplayKit-shaped buffers.
/// The parts are read back with AVFoundation; one case leaves its source and parts in
/// /tmp/sb-partscheck/ for the Mac's ffprobe and `screenbrief pull` to join.
final class MovieSplitterTests: XCTestCase {
    private static let id = "20261112-101500"
    private static var recorded: [String: URL] = [:]

    /// A recording with a key frame every second, so there are places to cut. Made once per name.
    private func source(_ name: String, seconds: Double = 10, orientation: CGImagePropertyOrientation = .up,
                        configure: (inout MovieWriter.Configuration) -> Void = { _ in }) -> URL {
        if let made = Self.recorded[name] { return made }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("split-\(UUID().uuidString)-\(name)")
        var config = MovieWriter.Configuration()
        config.keyFrameInterval = 1
        config.title = "ScreenBrief-\(Self.id)"
        configure(&config)
        let writer = MovieWriter(outputURL: url, configuration: config)
        let feeder = SyntheticFeeder(orientation: orientation, video: { writer.appendVideo($0) }, audio: { writer.appendAudio($0) })
        feeder.feed(seconds: seconds)
        let summary = writer.finish(timeout: 30)
        XCTAssertTrue(summary.finished, "error: \(summary.error ?? "-")")
        Self.recorded[name] = url
        return url
    }

    private func scratch() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("parts-\(UUID().uuidString)", isDirectory: true)
    }

    /// What a track holds, read as stored (nothing decoded).
    private struct Stored {
        var samples = 0
        var bytes = 0
        var firstTime = Double.nan
        var firstIsKeyFrame = false
        var codec: FourCharCode = 0
    }

    private func stored(_ url: URL, _ type: AVMediaType) async throws -> Stored {
        let asset = AVURLAsset(url: url)
        var s = Stored()
        guard let track = try await asset.loadTracks(withMediaType: type).first else { return s }
        s.codec = try await track.load(.formatDescriptions).first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        while let sb = output.copyNextSampleBuffer() {
            let n = CMSampleBufferGetNumSamples(sb)
            guard n > 0 else { continue }
            if s.samples == 0 {
                s.firstTime = CMSampleBufferGetPresentationTimeStamp(sb).seconds
                s.firstIsKeyFrame = MovieSplitter.isKeyFrame(sb)
            }
            s.samples += n
            s.bytes += CMSampleBufferGetTotalSampleSize(sb)
        }
        XCTAssertEqual(reader.status, .completed, "\(String(describing: reader.error))")
        return s
    }

    /// Decodes the whole track from its first sample on: video frames, or PCM frames of sound.
    private func decoded(_ url: URL, _ type: AVMediaType) async throws -> Int {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: type)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = type == .video
            ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
            : [AVFormatIDKey: kAudioFormatLinearPCM]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var count = 0
        while let sb = output.copyNextSampleBuffer() {
            if type == .video { count += CMSampleBufferGetImageBuffer(sb) != nil ? 1 : 0 } else { count += CMSampleBufferGetNumSamples(sb) }
        }
        XCTAssertEqual(reader.status, .completed, "\(url.lastPathComponent): \(String(describing: reader.error))")
        return count
    }

    private func assertSame(_ a: CGAffineTransform, _ b: CGAffineTransform, _ message: String, line: UInt = #line) {
        for (x, y) in zip([a.a, a.b, a.c, a.d, a.tx, a.ty], [b.a, b.b, b.c, b.d, b.tx, b.ty]) {
            XCTAssertEqual(x, y, accuracy: 0.001, message, line: line)
        }
    }

    /// Everything the Mac relies on: the parts fit, each stands on its own from a key frame at
    /// zero, carries its title, and together they are the original, sample for sample.
    private func check(_ parts: [MovieSplitter.Part], of source: URL, limit: Int64, line: UInt = #line) async throws {
        let whole = try await MovieInfo.load(source)
        let wholeVideo = try await stored(source, .video)
        let wholeAudio = try await stored(source, .audio)
        let n = parts.count
        var duration = 0.0
        var video = Stored()
        var audio = Stored()
        for (i, part) in parts.enumerated() {
            let title = "ScreenBrief-\(Self.id)-part\(i + 1)of\(n)"
            XCTAssertEqual(part.url.lastPathComponent, "\(title).mov", line: line)
            XCTAssertEqual(part.bytes, BroadcastRecorder.fileSize(part.url), line: line)
            XCTAssertGreaterThan(part.bytes, 0, line: line)
            XCTAssertLessThanOrEqual(part.bytes, limit, "\(title) is over the limit", line: line)

            let info = try await MovieInfo.load(part.url)
            XCTAssertTrue(info.isReadable, line: line)
            XCTAssertEqual(info.title, title, line: line)
            let quickTime = try await AVURLAsset(url: part.url).loadMetadata(for: .quickTimeMetadata)
            let quickTimeTitle = try await AVMetadataItem.metadataItems(from: quickTime, filteredByIdentifier: .quickTimeMetadataTitle).first?.load(.stringValue)
            XCTAssertEqual(quickTimeTitle, title, "what ffprobe lists as the title", line: line)
            XCTAssertEqual(info.videoSize, whole.videoSize, line: line)
            assertSame(info.videoTransform, whole.videoTransform, "\(title): transform", line: line)
            XCTAssertEqual(info.videoStart, 0, accuracy: 0.001, line: line)
            XCTAssertEqual(part.offsetSec, duration, accuracy: 0.05, "\(title) starts where the one before ended", line: line)

            let v = try await stored(part.url, .video)
            XCTAssertTrue(v.firstIsKeyFrame, "\(title) starts on a key frame", line: line)
            XCTAssertEqual(v.firstTime, 0, accuracy: 0.001, "\(title): its own timestamps from zero", line: line)
            XCTAssertEqual(v.codec, wholeVideo.codec, line: line)
            let frames = try await decoded(part.url, .video)
            XCTAssertEqual(frames, v.samples, "\(title): every frame decodes", line: line)

            XCTAssertTrue(info.hasAudioTrack, "\(title) has sound", line: line)
            let a = try await stored(part.url, .audio)
            XCTAssertGreaterThan(a.samples, 0, line: line)
            XCTAssertEqual(a.codec, wholeAudio.codec, line: line)
            XCTAssertEqual(info.audioDuration, info.duration, accuracy: 0.1, "\(title): sound all the way through", line: line)
            let pcm = try await decoded(part.url, .audio)
            XCTAssertGreaterThan(pcm, 0, "\(title): the sound decodes", line: line)

            print("[split] \(title): \(part.bytes) bytes, \(info) videoSamples=\(v.samples) audioSamples=\(a.samples)")
            duration += info.duration
            video.samples += v.samples
            video.bytes += v.bytes
            audio.samples += a.samples
            audio.bytes += a.bytes
        }
        print("[split] \(n) parts: \(duration)s of \(whole.duration)s; video \(video.samples)/\(wholeVideo.samples) samples, audio \(audio.samples)/\(wholeAudio.samples)")
        XCTAssertEqual(duration, whole.duration, accuracy: 0.1, "the parts are as long as the original", line: line)
        XCTAssertEqual(video.samples, wholeVideo.samples, "no frame lost or repeated", line: line)
        XCTAssertEqual(video.bytes, wholeVideo.bytes, "the frames are the original's, not re-encoded", line: line)
        XCTAssertEqual(audio.samples, wholeAudio.samples, "no sound packet lost or repeated", line: line)
        XCTAssertEqual(audio.bytes, wholeAudio.bytes, line: line)
    }

    private func names(in directory: URL) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
    }

    /// The source and its parts where the Mac can read them (the simulator shares its files).
    private func leaveForTheMac(source: URL, parts: [MovieSplitter.Part]) throws {
        let fm = FileManager.default
        let dir = URL(fileURLWithPath: "/tmp/sb-partscheck", isDirectory: true)
        try? fm.removeItem(at: dir)
        try fm.createDirectory(at: dir.appendingPathComponent("parts"), withIntermediateDirectories: true)
        try fm.copyItem(at: source, to: dir.appendingPathComponent("source.mov"))
        for part in parts {
            try fm.copyItem(at: part.url, to: dir.appendingPathComponent("parts/\(part.url.lastPathComponent)"))
        }
        try Data(Self.id.utf8).write(to: dir.appendingPathComponent("id.txt"))
    }

    func testSplitsARecordingIntoPartsThatFit() async throws {
        let movie = source("portrait.mov")
        let size = BroadcastRecorder.fileSize(movie)
        let limit = size * 2 / 5
        let directory = scratch()
        let parts = try await MovieSplitter.split(movie: movie, id: Self.id, into: directory, targetBytes: size / 4, maxBytes: limit)
        print("[split] portrait: \(size) bytes into \(parts.count) parts, limit \(limit)")
        XCTAssertGreaterThanOrEqual(parts.count, 3)
        try await check(parts, of: movie, limit: limit)
        XCTAssertEqual(names(in: directory), Set(parts.map { $0.url.lastPathComponent }), "nothing but the parts")
        try leaveForTheMac(source: movie, parts: parts)
    }

    func testLandscapeRecordingKeepsItsRotationInEveryPart() async throws {
        let movie = source("landscape.mov", orientation: .left)
        let whole = try await MovieInfo.load(movie)
        XCTAssertNotEqual(whole.videoTransform, .identity, "the source is stamped landscape")
        let size = BroadcastRecorder.fileSize(movie)
        let parts = try await MovieSplitter.split(movie: movie, id: Self.id, into: scratch(), targetBytes: size / 4, maxBytes: size * 2 / 5)
        XCTAssertGreaterThanOrEqual(parts.count, 3)
        try await check(parts, of: movie, limit: size * 2 / 5)
    }

    /// A plain (not fragmented) MP4, the container iOS's own screen recorder writes.
    func testPlainMP4IsSplitIntoQuickTimeParts() async throws {
        let movie = source("plain.mp4", seconds: 6, configure: { $0.fileType = .mp4; $0.fragmentInterval = nil })
        let size = BroadcastRecorder.fileSize(movie)
        let parts = try await MovieSplitter.split(movie: movie, id: Self.id, into: scratch(), targetBytes: size / 4, maxBytes: size / 2)
        XCTAssertGreaterThanOrEqual(parts.count, 3)
        try await check(parts, of: movie, limit: size / 2)
    }

    /// The plan aims at 60% of the movie a part, which the limit (40%) does not allow: the parts
    /// written first are over it, so the movie is cut finer until every part fits.
    func testPartsOverTheLimitAreCutFiner() async throws {
        let movie = source("portrait.mov")
        let size = BroadcastRecorder.fileSize(movie)
        let limit = size * 2 / 5
        let directory = scratch()
        let parts = try await MovieSplitter.split(movie: movie, id: Self.id, into: directory, targetBytes: size * 3 / 5, maxBytes: limit)
        XCTAssertGreaterThanOrEqual(parts.count, 3, "two parts of 60% and 40% would not fit")
        try await check(parts, of: movie, limit: limit)
        XCTAssertEqual(names(in: directory), Set(parts.map { $0.url.lastPathComponent }), "the parts that were over are gone")
    }

    func testRecordingUnderTheLimitIsNotSplit() async throws {
        let movie = source("portrait.mov")
        let directory = scratch()
        let parts = try await MovieSplitter.split(movie: movie, id: Self.id, into: directory, targetBytes: 1000,
                                                  maxBytes: BroadcastRecorder.fileSize(movie))
        XCTAssertEqual(parts, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path), "nothing is written")
    }

    /// One key frame cannot be cut: it fails and leaves nothing behind.
    func testMovieThatCannotBeCutSmallEnoughFails() async throws {
        let movie = source("portrait.mov")
        let directory = scratch()
        do {
            _ = try await MovieSplitter.split(movie: movie, id: Self.id, into: directory, targetBytes: 2000, maxBytes: 2000)
            XCTFail("no part of a movie fits in 2 kB")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The video could not be cut into parts of at most 2 KB.")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    /// A split that is cancelled writes no (further) part and leaves nothing behind.
    func testCancelledSplitThrowsAndLeavesNothingBehind() async throws {
        let movie = source("portrait.mov")
        let size = BroadcastRecorder.fileSize(movie)
        let directory = scratch()
        let task = Task { () -> [MovieSplitter.Part] in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await MovieSplitter.split(movie: movie, id: Self.id, into: directory, targetBytes: size / 4, maxBytes: size * 2 / 5)
        }
        do {
            let parts = try await task.value
            XCTFail("a cancelled split must not return \(parts.count) parts")
        } catch {
            print("[split] cancelled: \(type(of: error)) \(error)")
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testPartsArePlannedByFillingEachToTheTarget() {
        XCTAssertEqual(MovieSplitter.partStarts(groupBytes: [10, 10, 10, 10, 10], targetBytes: 25), [0, 2, 4])
        XCTAssertEqual(MovieSplitter.partStarts(groupBytes: [10, 10, 10, 10], targetBytes: 20), [0, 2], "exactly the target still fits")
        XCTAssertEqual(MovieSplitter.partStarts(groupBytes: [10, 40, 10, 10], targetBytes: 25), [0, 1, 2], "a group over the target is a part of its own")
        XCTAssertEqual(MovieSplitter.partStarts(groupBytes: [10, 10], targetBytes: 100), [0], "it all fits in one")
        XCTAssertEqual(MovieSplitter.partStarts(groupBytes: [], targetBytes: 100), [])
        XCTAssertEqual(MovieSplitter.targetBytes, 45 * 1_048_576)
        XCTAssertLessThan(MovieSplitter.targetBytes, Recording.maxAttachmentBytes)
    }
}
