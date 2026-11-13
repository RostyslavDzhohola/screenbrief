import AVFoundation
import CoreMedia
import CoreVideo
import ReplayKit
import XCTest
@testable import ScreenBrief

/// Feeds ReplayKit-shaped buffers in real time: portrait 1284x2778 BGRA frames at 30 fps and
/// 48 kHz mono Int16 mic PCM in 1024-frame chunks, the shapes an iPhone delivers.
final class SyntheticFeeder {
    var video: (CMSampleBuffer) -> Void
    var audio: (CMSampleBuffer) -> Void
    let orientation: CGImagePropertyOrientation
    let fps: Double = 30
    let sampleRate: Double = 48_000
    let audioChunk = 1024
    /// Silent mic (zeros) or a 440 Hz tone.
    var tone = true
    /// Every row of every frame gets a new pseudo-random grey (the same sequence every run): a
    /// picture the encoder cannot compress, so the movie grows as fast as the bitrate allows.
    var busy = false
    private var noise: UInt64 = 0x9E37_79B9_7F4A_7C15
    private(set) var clock: Double
    private var audioClock: Double
    private var frameIndex = 0
    private let pool: CVPixelBufferPool
    private let audioFormat: CMAudioFormatDescription

    init(startTime: Double = 1000, orientation: CGImagePropertyOrientation = .up,
         video: @escaping (CMSampleBuffer) -> Void, audio: @escaping (CMSampleBuffer) -> Void) {
        self.video = video
        self.audio = audio
        self.orientation = orientation
        clock = startTime
        audioClock = startTime
        var pool: CVPixelBufferPool?
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 1284,
            kCVPixelBufferHeightKey as String: 2778,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        self.pool = pool!
        var asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var fmt: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
        audioFormat = fmt!
    }

    /// Feeds `seconds` of media in real time. `videoOff`/`audioOff` are ranges (seconds from the
    /// feeder's start) where that stream sends nothing: a static screen, a mic gap.
    func feed(seconds: Double, video sendVideo: Bool = true, audio sendAudio: Bool = true,
              videoOff: ClosedRange<Double>? = nil, audioOff: ClosedRange<Double>? = nil,
              origin: Double = 1000, everySecond: ((Double) -> Void)? = nil) {
        let end = clock + seconds
        let step = 1.0 / fps
        let wallStart = Date()
        let mediaStart = clock
        var lastTick = Int(clock - origin)
        while clock < end - 1e-9 {
            let rel = clock - origin
            if sendVideo, !(videoOff?.contains(rel) ?? false) { video(makeVideo(pts: clock)) }
            if sendAudio {
                while audioClock < clock + step - 1e-9 {
                    if !(audioOff?.contains(audioClock - origin) ?? false) { audio(makeAudio(pts: audioClock)) }
                    audioClock += Double(audioChunk) / sampleRate
                }
            }
            clock += step
            if !sendAudio { audioClock = clock }
            // Stay in step with the wall clock, as a device does.
            let due = (clock - mediaStart) - Date().timeIntervalSince(wallStart)
            if due > 0 { Thread.sleep(forTimeInterval: due) }
            let tick = Int(clock - origin)
            if tick != lastTick { lastTick = tick; everySecond?(clock - origin) }
        }
    }

    private func makeVideo(pts: Double) -> CMSampleBuffer {
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        let buffer = pb!
        CVPixelBufferLockBaseAddress(buffer, [])
        let base = CVPixelBufferGetBaseAddress(buffer)!
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        memset(base, 40, bytesPerRow * height)
        let barTop = (frameIndex * 20) % (height - 100)
        memset(base + barTop * bytesPerRow, 220, bytesPerRow * 100)
        if busy {
            for row in 0..<height {
                noise = noise &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                memset(base + row * bytesPerRow, Int32(truncatingIfNeeded: noise >> 56), bytesPerRow)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        frameIndex += 1

        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
        var timing = CMSampleTimingInfo(
            duration: CMTime(seconds: 1 / fps, preferredTimescale: 600),
            presentationTimeStamp: CMTime(seconds: pts, preferredTimescale: 1_000_000_000),
            decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer, formatDescription: format!,
                                                 sampleTiming: &timing, sampleBufferOut: &sb)
        CMSetAttachment(sb!, key: RPVideoSampleOrientationKey as CFString,
                        value: NSNumber(value: orientation.rawValue), attachmentMode: kCMAttachmentMode_ShouldPropagate)
        return sb!
    }

    private func makeAudio(pts: Double) -> CMSampleBuffer {
        let byteCount = audioChunk * 2
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: byteCount, blockAllocator: nil,
                                           customBlockSource: nil, offsetToData: 0, dataLength: byteCount,
                                           flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        var samples = [Int16](repeating: 0, count: audioChunk)
        if tone {
            for i in 0..<audioChunk {
                let t = pts + Double(i) / sampleRate
                samples[i] = Int16(sin(2 * .pi * 440 * t) * 8000)
            }
        }
        samples.withUnsafeBytes { raw in
            _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: byteCount)
        }
        var sb: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block!, formatDescription: audioFormat, sampleCount: audioChunk,
            presentationTimeStamp: CMTime(value: CMTimeValue((pts * sampleRate).rounded()), timescale: 48_000),
            packetDescriptions: nil, sampleBufferOut: &sb)
        return sb!
    }
}

enum Memory {
    /// Physical footprint of this process in MB (what jetsam counts).
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}

/// What AVFoundation reads from concatenated segments.
struct MovieInfo: CustomStringConvertible {
    var isReadable = false
    var duration: Double = 0
    var hasVideoTrack = false
    var hasAudioTrack = false
    var videoSize: CGSize = .zero
    var videoTransform: CGAffineTransform = .identity
    var videoStart: Double = 0
    var videoDuration: Double = 0
    var audioStart: Double = 0
    var audioDuration: Double = 0
    var videoSampleCount = 0
    var decodedFrame = false
    /// The title in the movie's common metadata, if it has one.
    var title: String?

    var description: String {
        String(format: "readable=%@ duration=%.3f video=%@ %dx%d samples=%d vStart=%.3f vDur=%.3f audio=%@ aStart=%.3f aDur=%.3f transformIdentity=%@ decoded=%@",
               "\(isReadable)", duration, "\(hasVideoTrack)", Int(videoSize.width), Int(videoSize.height), videoSampleCount,
               videoStart, videoDuration, "\(hasAudioTrack)", audioStart, audioDuration, "\(videoTransform == .identity)", "\(decodedFrame)")
    }

    static func load(_ url: URL) async throws -> MovieInfo {
        let asset = AVURLAsset(url: url)
        var info = MovieInfo()
        let (readable, duration) = try await asset.load(.isReadable, .duration)
        info.isReadable = readable
        info.duration = duration.seconds
        let titles = AVMetadataItem.metadataItems(from: try await asset.load(.commonMetadata), filteredByIdentifier: .commonIdentifierTitle)
        info.title = try await titles.first?.load(.stringValue)
        if let v = try await asset.loadTracks(withMediaType: .video).first {
            info.hasVideoTrack = true
            let (size, transform, range) = try await v.load(.naturalSize, .preferredTransform, .timeRange)
            info.videoSize = size
            info.videoTransform = transform
            info.videoStart = range.start.seconds
            info.videoDuration = range.duration.seconds
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: v, outputSettings: nil)
            reader.add(output)
            reader.startReading()
            while let sb = output.copyNextSampleBuffer() { info.videoSampleCount += CMSampleBufferGetNumSamples(sb) }
            let gen = AVAssetImageGenerator(asset: asset)
            info.decodedFrame = (try? await gen.image(at: CMTime(seconds: 0.5, preferredTimescale: 600))) != nil
        }
        if let a = try await asset.loadTracks(withMediaType: .audio).first {
            info.hasAudioTrack = true
            let range = try await a.load(.timeRange)
            info.audioStart = range.start.seconds
            info.audioDuration = range.duration.seconds
        }
        return info
    }
}

enum SegmentFiles {
    /// Writes concatenated segments where the Mac's ffprobe can read them (the simulator shares
    /// the host file system), falling back to the test's temp directory.
    static func write(_ data: Data, name: String) throws -> URL {
        let shared = URL(fileURLWithPath: "/tmp/sb-segcheck", isDirectory: true)
        if (try? FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)) != nil {
            let url = shared.appendingPathComponent(name)
            if (try? data.write(to: url)) != nil { return url }
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }
}
