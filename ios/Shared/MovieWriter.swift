import AVFoundation
import CoreMedia
import CoreVideo
import ImageIO
import ReplayKit
import VideoToolbox

/// Encodes ReplayKit screen video plus microphone audio into one movie file (H.264 + AAC) that
/// Photos accepts and T3 Code can attach.
///
/// - **Audio track decision.** The audio input is added only if a mic buffer arrives before, or
///   within `audioDecisionTimeout` of, the first video frame. With the mic off in the system sheet
///   the movie has no audio track at all.
/// - **Audio gaps.** If mic audio stops mid-recording (interruptions), silence in the mic's own
///   format is appended once audio lags video by `silenceAfterLag`: an AAC track has no gaps, so
///   later speech would otherwise slide earlier against the picture.
/// - **Static screens.** ReplayKit sends no frames while nothing changes; the last frame is
///   re-appended every `keepaliveAfter` seconds so the writer keeps interleaving audio (and the
///   movie lasts until the user stopped).
/// - **Fragments.** With `fragmentInterval` set, the file is a fragmented QuickTime movie: if the
///   extension is killed, what was written up to the last fragment is still a readable movie.
///
/// Buffer ownership: ReplayKit's video buffers are only valid during `processSampleBuffer`, so
/// every frame is first copied (and scaled to the output size) into a pixel buffer from this
/// writer's own small pool (`ownedFrameLimit`; a frame that finds it empty is dropped). Only those
/// copies are appended, held or re-sent; nothing of ReplayKit's outlives the callback.
/// Thread-safe: every entry point takes `lock`.
final class MovieWriter {
    struct Configuration {
        var maxLongSide: Int = 1600
        /// 700 kbps of video plus 48 kbps of voice is about 5.6 MB a minute, so an eight-minute
        /// recording stays under 50 MiB (T3 Code's attachment limit). Screens are mostly still,
        /// which H.264 keeps sharp at this rate once a picture has settled.
        var videoBitrate: Int = 700_000
        var maxFrameRate: Double = 30
        var audioSampleRate: Double = 44_100
        var audioBitrate: Int = 48_000
        /// Seconds between key frames. Key frames are the expensive ones at a low bitrate, so they
        /// are sparse; fragments (below) do not need to start on one.
        var keyFrameInterval: Double = 8
        var fileType: AVFileType = .mov
        /// Seconds between movie fragments; nil writes a plain (non-fragmented) movie.
        var fragmentInterval: Double? = 2
        /// Wall seconds after the first video frame to wait for a mic buffer before going video-only.
        var audioDecisionTimeout: Double = 4
        /// Re-append the last frame when no new frame arrived for this long (wall seconds).
        var keepaliveAfter: Double = 0.25
        /// Fill silence when mic audio is this far behind video (media seconds).
        var silenceAfterLag: Double = 0.6
        /// How often the pump checks for the above (wall seconds).
        var pumpInterval: Double = 0.05
        /// Most output-size frames alive at once (held, last frame, and those the encoder still has).
        var ownedFrameLimit: Int = 6

        /// Bytes a second the movie grows by when the encoder uses its whole budget (it uses less
        /// on a still screen), with 3% added for the container.
        var bytesPerSecond: Double { Double(videoBitrate + audioBitrate) / 8 * 1.03 }

        /// Seconds of recording that fit in `bytes` at `bytesPerSecond`.
        func secondsThatFit(in bytes: Int64) -> Double { Double(bytes) / bytesPerSecond }
    }

    enum DropReason: String, Equatable {
        case notReady, beforeSessionStart, frameRateCap, notWriting, invalidBuffer, appendFailed
        case outOfOrder, noAudioTrack, copyFailed
    }

    enum AppendResult: Equatable {
        case appended
        /// Kept while deciding whether there is mic audio; written once decided.
        case held
        case dropped(DropReason)
    }

    struct Summary: Equatable {
        var finished: Bool
        var durationSec: Double
        var width: Int
        var height: Int
        var hasAudioTrack: Bool
        var hasMicAudio: Bool
        var rotation: Int
        var videoFramesAppended: Int
        var keepaliveFrames: Int
        var videoFramesDropped: Int
        var audioBuffersAppended: Int
        var silenceBuffersAppended: Int
        var audioBuffersDropped: Int
        var frameCopiesFailed: Int = 0
        /// Loudest mic sample seen, 0...1 (0 means digital silence).
        var peakAudioLevel: Double = 0
        var error: String?
    }

    let configuration: Configuration
    let outputURL: URL
    /// Wall clock in seconds; injectable for tests.
    var wallClock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

    private enum Phase { case idle, deciding, writing, finished }

    private let lock = NSLock()
    private var phase: Phase = .idle
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var heldFirst: CMSampleBuffer?
    private var heldLatest: CMSampleBuffer?
    private var decidingSince: TimeInterval = 0
    private var audioSeen = false
    private var audioFormat: CMAudioFormatDescription?

    private var sessionStart: CMTime = .invalid
    private var lastVideoPTS: CMTime = .invalid
    private var lastVideoWall: TimeInterval = 0
    private var lastVideoBuffer: CMSampleBuffer?
    /// `lastVideoBuffer` is a newer image than the last one written; the pump writes it as soon
    /// as the frame-rate cap allows, so a one-frame screen change is never lost.
    private var freshFramePending = false
    private var copyPool: CVPixelBufferPool?
    private var transferSession: VTPixelTransferSession?
    private var copyFormat: CMVideoFormatDescription?
    private var copiesFailed = 0
    private var lastAudioEnd: CMTime = .invalid
    private var lastSampleEnd: CMTime = .invalid

    private var outputWidth = 0
    private var outputHeight = 0
    private var firstOrientation: CGImagePropertyOrientation = .up
    private var videoAppended = 0
    private var keepalives = 0
    private var videoDropped = 0
    private var audioAppended = 0
    private var silenceAppended = 0
    private var audioDropped = 0
    private var peakLevel: Double = 0
    private var failure: String?
    private var pumpTimer: DispatchSourceTimer?
    private let pumpQueue = DispatchQueue(label: "screenbrief.moviewriter.pump")

    init(outputURL: URL, configuration: Configuration = Configuration()) {
        self.outputURL = outputURL
        self.configuration = configuration
    }

    deinit { pumpTimer?.cancel() }

    // MARK: Public API

    var isStarted: Bool {
        lock.lock(); defer { lock.unlock() }
        return writer != nil
    }

    var elapsedSeconds: Double {
        lock.lock(); defer { lock.unlock() }
        return elapsedLocked
    }

    @discardableResult
    func appendVideo(_ sampleBuffer: CMSampleBuffer) -> AppendResult {
        lock.lock(); defer { lock.unlock() }
        guard phase != .finished, failure == nil else { return .dropped(.notWriting) }
        guard CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetImageBuffer(sampleBuffer) != nil,
              CMSampleBufferGetPresentationTimeStamp(sampleBuffer).isValid else {
            videoDropped += 1
            return .dropped(.invalidBuffer)
        }
        let orientation = Self.orientation(of: sampleBuffer)
        // From here on only the owned copy is used; ReplayKit's buffer is not kept.
        guard let sampleBuffer = ownedCopyLocked(of: sampleBuffer) else {
            videoDropped += 1
            return .dropped(.copyFailed)
        }
        switch phase {
        case .idle:
            firstOrientation = orientation
            heldFirst = sampleBuffer
            decidingSince = wallClock()
            phase = .deciding
            startPump()
            if audioSeen { decideLocked(); return .appended }
            return .held
        case .deciding:
            heldLatest = sampleBuffer
            if audioSeen || wallClock() - decidingSince >= configuration.audioDecisionTimeout {
                decideLocked()
                return .appended
            }
            return .held
        case .writing:
            return appendVideoLocked(sampleBuffer, keepalive: false)
        case .finished:
            return .dropped(.notWriting)
        }
    }

    @discardableResult
    func appendAudio(_ sampleBuffer: CMSampleBuffer) -> AppendResult {
        lock.lock(); defer { lock.unlock() }
        guard phase != .finished, failure == nil else { return .dropped(.notWriting) }
        guard CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetPresentationTimeStamp(sampleBuffer).isValid else {
            audioDropped += 1
            return .dropped(.invalidBuffer)
        }
        audioSeen = true
        if let fmt = CMSampleBufferGetFormatDescription(sampleBuffer) { audioFormat = fmt }
        switch phase {
        case .idle:
            audioDropped += 1
            return .dropped(.beforeSessionStart)
        case .deciding:
            decideLocked()
            return appendAudioLocked(sampleBuffer)
        case .writing:
            return appendAudioLocked(sampleBuffer)
        case .finished:
            return .dropped(.notWriting)
        }
    }

    /// Runs the keep-alive and silence checks now (the pump timer also does this).
    func pump() {
        lock.lock(); defer { lock.unlock() }
        pumpLocked()
    }

    /// Finishes the movie, waiting at most `timeout` seconds. Safe to call more than once.
    @discardableResult
    func finish(timeout: TimeInterval = 5) -> Summary {
        lock.lock()
        pumpTimer?.cancel()
        pumpTimer = nil
        if phase == .finished {
            let s = summaryLocked(finished: writer?.status == .completed)
            lock.unlock()
            return s
        }
        if phase == .deciding { decideLocked() }
        phase = .finished
        heldFirst = nil
        heldLatest = nil
        lastVideoBuffer = nil
        guard let writer, writer.status == .writing else {
            if writer == nil, failure == nil { failure = "No video frames were received." }
            if let writer, writer.status == .failed { failure = writer.error?.localizedDescription ?? "Writer failed" }
            let s = summaryLocked(finished: false)
            lock.unlock()
            return s
        }
        videoInput?.markAsFinished()
        audioInput?.markAsFinished()
        if lastSampleEnd.isValid { writer.endSession(atSourceTime: lastSampleEnd - sessionStart) }
        lock.unlock()

        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        let timedOut = done.wait(timeout: .now() + timeout) == .timedOut
        if timedOut { writer.cancelWriting() }

        lock.lock(); defer { lock.unlock() }
        if timedOut {
            failure = "Finishing the movie timed out after \(Int(timeout))s."
        } else if writer.status != .completed {
            failure = writer.error?.localizedDescription ?? "Finishing the movie failed."
        }
        return summaryLocked(finished: !timedOut && writer.status == .completed)
    }

    func snapshot() -> Summary {
        lock.lock(); defer { lock.unlock() }
        return summaryLocked(finished: writer?.status == .completed)
    }

    // MARK: Writing (lock held)

    private var elapsedLocked: Double {
        guard sessionStart.isValid, lastSampleEnd.isValid else { return 0 }
        return max(0, (lastSampleEnd - sessionStart).seconds)
    }

    private var frameDuration: CMTime { CMTime(seconds: 1 / configuration.maxFrameRate, preferredTimescale: 600) }

    private func decideLocked() {
        guard phase == .deciding, let first = heldFirst else { return }
        let latest = heldLatest
        heldFirst = nil
        heldLatest = nil
        do {
            try startWriterLocked(first: first, withAudio: audioSeen)
        } catch {
            failure = "Could not start the recorder: \(error.localizedDescription)"
            phase = .finished
            return
        }
        phase = .writing
        _ = appendVideoLocked(first, keepalive: false)
        if let latest { _ = appendVideoLocked(latest, keepalive: false) }
    }

    private func appendVideoLocked(_ sampleBuffer: CMSampleBuffer, keepalive: Bool) -> AppendResult {
        guard let writer, let videoInput, writer.status == .writing else {
            if let writer, writer.status == .failed { failure = writer.error?.localizedDescription ?? "Writer failed" }
            videoDropped += 1
            return .dropped(.notWriting)
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if lastVideoPTS.isValid {
            if pts <= lastVideoPTS {
                if !keepalive { rememberFreshLocked(sampleBuffer) }
                videoDropped += 1
                return .dropped(.outOfOrder)
            }
            if !keepalive, (pts - lastVideoPTS).seconds < 1.0 / configuration.maxFrameRate - 0.002 {
                rememberFreshLocked(sampleBuffer)
                videoDropped += 1
                return .dropped(.frameRateCap)
            }
        }
        guard videoInput.isReadyForMoreMediaData else {
            if !keepalive { rememberFreshLocked(sampleBuffer) }
            videoDropped += 1
            return .dropped(.notReady)
        }
        guard let output = rebased(sampleBuffer) else { videoDropped += 1; return .dropped(.invalidBuffer) }
        guard videoInput.append(output) else {
            videoDropped += 1
            if writer.status == .failed { failure = writer.error?.localizedDescription ?? "Writer failed" }
            return .dropped(.appendFailed)
        }
        if keepalive { keepalives += 1 } else { videoAppended += 1 }
        lastVideoPTS = pts
        lastVideoWall = wallClock()
        lastVideoBuffer = sampleBuffer
        freshFramePending = false
        let end = pts + frameDuration
        if !lastSampleEnd.isValid || end > lastSampleEnd { lastSampleEnd = end }
        return .appended
    }

    /// The frame copied (and scaled to the output size) into a pixel buffer from this writer's own
    /// pool, with the same timing. Nil when the pool is at its cap or the copy fails.
    private func ownedCopyLocked(of sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let source = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        if copyPool == nil {
            let size = Self.outputSize(width: CVPixelBufferGetWidth(source), height: CVPixelBufferGetHeight(source),
                                       maxLongSide: configuration.maxLongSide)
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                kCVPixelBufferWidthKey as String: size.width,
                kCVPixelBufferHeightKey as String: size.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
            copyPool = pool
            var session: VTPixelTransferSession?
            VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session)
            transferSession = session
        }
        guard let copyPool, let transferSession else { copiesFailed += 1; return nil }
        var destination: CVPixelBuffer?
        let cap = [kCVPixelBufferPoolAllocationThresholdKey as String: configuration.ownedFrameLimit] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(nil, copyPool, cap, &destination) == kCVReturnSuccess,
              let destination,
              VTPixelTransferSessionTransferImage(transferSession, from: source, to: destination) == noErr else {
            copiesFailed += 1
            return nil
        }
        if copyFormat == nil {
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: destination, formatDescriptionOut: &copyFormat)
        }
        guard let copyFormat else { copiesFailed += 1; return nil }
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sampleBuffer),
                                        presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                                        decodeTimeStamp: .invalid)
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: destination, formatDescription: copyFormat,
                                                       sampleTiming: &timing, sampleBufferOut: &out) == noErr else {
            copiesFailed += 1
            return nil
        }
        return out
    }

    private func rememberFreshLocked(_ sampleBuffer: CMSampleBuffer) {
        lastVideoBuffer = sampleBuffer
        freshFramePending = true
    }

    private func appendAudioLocked(_ sampleBuffer: CMSampleBuffer) -> AppendResult {
        guard let writer, writer.status == .writing else { audioDropped += 1; return .dropped(.notWriting) }
        guard let audioInput else { audioDropped += 1; return .dropped(.noAudioTrack) }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if pts < sessionStart { audioDropped += 1; return .dropped(.beforeSessionStart) }
        // Overlaps silence already filled in (late buffer after a gap): drop it.
        if lastAudioEnd.isValid, (lastAudioEnd - pts).seconds > 0.005 { audioDropped += 1; return .dropped(.outOfOrder) }
        // A hole before this buffer (mic started late, or resumed after a gap): fill it first.
        if lastAudioEnd.isValid, (pts - lastAudioEnd).seconds > 0.03, let format = audioFormat {
            fillSilenceLocked(from: lastAudioEnd, to: pts, format: format)
        }
        guard audioInput.isReadyForMoreMediaData else { audioDropped += 1; return .dropped(.notReady) }
        guard let output = rebased(sampleBuffer) else { audioDropped += 1; return .dropped(.invalidBuffer) }
        guard audioInput.append(output) else {
            audioDropped += 1
            if writer.status == .failed { failure = writer.error?.localizedDescription ?? "Writer failed" }
            return .dropped(.appendFailed)
        }
        audioAppended += 1
        peakLevel = max(peakLevel, Self.peakLevel(of: sampleBuffer))
        noteAudioEnd(pts: pts, sampleBuffer: sampleBuffer)
        return .appended
    }

    private func noteAudioEnd(pts: CMTime, sampleBuffer: CMSampleBuffer) {
        let duration = CMSampleBufferGetDuration(sampleBuffer)
        let end = duration.isValid ? pts + duration : pts
        lastAudioEnd = end
        if !lastSampleEnd.isValid || end > lastSampleEnd { lastSampleEnd = end }
    }

    private func startPump() {
        guard pumpTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: pumpQueue)
        timer.schedule(deadline: .now() + configuration.pumpInterval, repeating: configuration.pumpInterval)
        timer.setEventHandler { [weak self] in self?.pump() }
        timer.resume()
        pumpTimer = timer
    }

    private func pumpLocked() {
        let now = wallClock()
        if phase == .deciding, now - decidingSince >= configuration.audioDecisionTimeout {
            decideLocked()
        }
        guard phase == .writing, lastVideoPTS.isValid else { return }
        // Media "now", extrapolated from the last video frame.
        let mediaNow = lastVideoPTS + CMTime(seconds: max(0, now - lastVideoWall), preferredTimescale: 600)

        let sinceLast = now - lastVideoWall
        let due = sinceLast >= configuration.keepaliveAfter
            || (freshFramePending && sinceLast >= 1.0 / configuration.maxFrameRate)
        if due, let last = lastVideoBuffer,
           let copy = Self.retimed(last, pts: mediaNow, duration: frameDuration) {
            _ = appendVideoLocked(copy, keepalive: true)
        }

        if audioInput != nil, let format = audioFormat {
            let target = mediaNow - CMTime(seconds: 0.3, preferredTimescale: 600)
            let from = lastAudioEnd.isValid ? lastAudioEnd : sessionStart
            if (target - from).seconds > configuration.silenceAfterLag {
                fillSilenceLocked(from: from, to: target, format: format)
            }
        }
    }

    private func fillSilenceLocked(from start: CMTime, to end: CMTime, format: CMAudioFormatDescription) {
        guard let audioInput, let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return }
        let asbd = asbdPtr.pointee
        guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBytesPerFrame > 0, asbd.mSampleRate > 0 else { return }
        let rate = asbd.mSampleRate
        var cursor = start
        while cursor < end, audioInput.isReadyForMoreMediaData {
            let remaining = Int(((end - cursor).seconds * rate).rounded(.down))
            let frames = min(4096, remaining)
            guard frames > 0 else { break }
            guard let buffer = Self.silence(frames: frames, asbd: asbd, format: format,
                                            pts: CMTime(value: CMTimeValue((cursor.seconds * rate).rounded()), timescale: CMTimeScale(rate))) else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
            guard let output = rebased(buffer), audioInput.append(output) else { return }
            silenceAppended += 1
            noteAudioEnd(pts: pts, sampleBuffer: buffer)
            cursor = lastAudioEnd
        }
    }

    private func startWriterLocked(first: CMSampleBuffer, withAudio: Bool) throws {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(first) else { throw WriterError("No image in the first frame") }
        let pts = CMSampleBufferGetPresentationTimeStamp(first)
        outputWidth = CVPixelBufferGetWidth(pixelBuffer)
        outputHeight = CVPixelBufferGetHeight(pixelBuffer)

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: configuration.fileType)
        if let interval = configuration.fragmentInterval {
            writer.movieFragmentInterval = CMTime(seconds: interval, preferredTimescale: 600)
        }

        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outputWidth,
            AVVideoHeightKey: outputHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: configuration.videoBitrate,
                AVVideoExpectedSourceFrameRateKey: Int(configuration.maxFrameRate),
                AVVideoMaxKeyFrameIntervalDurationKey: configuration.keyFrameInterval,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        // Display upright in Photos and players (ReplayKit stamps landscape frames with a rotation).
        let degrees = Self.rotation(for: firstOrientation)
        if degrees != 0 { video.transform = CGAffineTransform(rotationAngle: CGFloat(degrees) * .pi / 180) }
        guard writer.canAdd(video) else { throw WriterError("Cannot add video input") }
        writer.add(video)

        var audio: AVAssetWriterInput?
        if withAudio {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 1,
                AVSampleRateKey: configuration.audioSampleRate,
                AVEncoderBitRateKey: configuration.audioBitrate,
            ])
            a.expectsMediaDataInRealTime = true
            guard writer.canAdd(a) else { throw WriterError("Cannot add audio input") }
            writer.add(a)
            audio = a
        }

        guard writer.startWriting() else { throw writer.error ?? WriterError("startWriting failed") }
        // The movie starts at 0: ReplayKit stamps buffers with host time (uptime, possibly days).
        writer.startSession(atSourceTime: .zero)
        sessionStart = pts
        lastAudioEnd = pts
        self.writer = writer
        videoInput = video
        audioInput = audio
    }

    /// The buffer with its timing shifted so the session starts at 0.
    private func rebased(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard sessionStart.isValid else { return nil }
        return Self.shifted(sampleBuffer, by: sessionStart)
    }

    private func summaryLocked(finished: Bool) -> Summary {
        Summary(
            finished: finished,
            durationSec: elapsedLocked,
            width: outputWidth,
            height: outputHeight,
            hasAudioTrack: audioInput != nil,
            hasMicAudio: audioAppended > 0,
            rotation: Self.rotation(for: firstOrientation),
            videoFramesAppended: videoAppended,
            keepaliveFrames: keepalives,
            videoFramesDropped: videoDropped,
            audioBuffersAppended: audioAppended,
            silenceBuffersAppended: silenceAppended,
            audioBuffersDropped: audioDropped,
            frameCopiesFailed: copiesFailed,
            peakAudioLevel: peakLevel,
            error: failure
        )
    }

    // MARK: Pure helpers

    /// Longer side at most `maxLongSide`, aspect kept, both sides even, never upscaled.
    static func outputSize(width: Int, height: Int, maxLongSide: Int) -> (width: Int, height: Int) {
        let longSide = max(width, height)
        let scale = longSide > maxLongSide ? Double(maxLongSide) / Double(longSide) : 1
        func even(_ v: Double) -> Int { max(2, Int((v / 2).rounded()) * 2) }
        var w = even(Double(width) * scale)
        var h = even(Double(height) * scale)
        if w > maxLongSide { w = maxLongSide - maxLongSide % 2 }
        if h > maxLongSide { h = maxLongSide - maxLongSide % 2 }
        return (w, h)
    }

    /// Degrees clockwise the stored picture must be turned to display upright (EXIF semantics of
    /// `RPVideoSampleOrientationKey`). Mirrored variants are treated as their unmirrored rotation.
    static func rotation(for orientation: CGImagePropertyOrientation) -> Int {
        switch orientation {
        case .up, .upMirrored: return 0
        case .right, .rightMirrored: return 90
        case .down, .downMirrored: return 180
        case .left, .leftMirrored: return 270
        @unknown default: return 0
        }
    }

    static func orientation(of sampleBuffer: CMSampleBuffer) -> CGImagePropertyOrientation {
        guard let value = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
              let o = CGImagePropertyOrientation(rawValue: value.uint32Value) else { return .up }
        return o
    }

    /// Peak absolute sample of 16-bit or float linear PCM, 0...1; 0 for anything else.
    static func peakLevel(of sampleBuffer: CMSampleBuffer) -> Double {
        guard let fmt = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return 0 }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length,
                                          dataPointerOut: &pointer) == noErr, let pointer else { return 0 }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        var peak: Double = 0
        if isFloat, asbd.mBitsPerChannel == 32 {
            pointer.withMemoryRebound(to: Float.self, capacity: length / 4) { p in
                for i in stride(from: 0, to: length / 4, by: 4) { peak = max(peak, Double(abs(p[i]))) }
            }
        } else if asbd.mBitsPerChannel == 16 {
            let bigEndian = asbd.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
            pointer.withMemoryRebound(to: Int16.self, capacity: length / 2) { p in
                for i in stride(from: 0, to: length / 2, by: 4) {
                    let v = bigEndian ? Int16(bigEndian: p[i]) : Int16(littleEndian: p[i])
                    peak = max(peak, Double(abs(Int(v))) / 32768)
                }
            }
        }
        return min(1, peak)
    }

    /// A copy with every timestamp moved back by `offset` (sample data is shared, not copied).
    static func shifted(_ sampleBuffer: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(sampleBuffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr,
              count > 0 else { return nil }
        var timings = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(sampleBuffer, entryCount: count, arrayToFill: &timings, entriesNeededOut: &count) == noErr else { return nil }
        for i in timings.indices {
            if timings[i].presentationTimeStamp.isValid { timings[i].presentationTimeStamp = timings[i].presentationTimeStamp - offset }
            if timings[i].decodeTimeStamp.isValid { timings[i].decodeTimeStamp = timings[i].decodeTimeStamp - offset }
        }
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sampleBuffer, sampleTimingEntryCount: count,
                                                           sampleTimingArray: &timings, sampleBufferOut: &out)
        return status == noErr ? out : nil
    }

    /// The same image with new timing (keep-alive frames).
    static func retimed(_ sampleBuffer: CMSampleBuffer, pts: CMTime, duration: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sampleBuffer,
                                                           sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                                           sampleBufferOut: &out)
        return status == noErr ? out : nil
    }

    /// Zeroed linear PCM in the given (mic) format.
    static func silence(frames: Int, asbd: AudioStreamBasicDescription, format: CMAudioFormatDescription, pts: CMTime) -> CMSampleBuffer? {
        let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let planes = nonInterleaved ? max(1, Int(asbd.mChannelsPerFrame)) : 1
        let byteCount = frames * Int(asbd.mBytesPerFrame) * planes
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: byteCount, blockAllocator: nil,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: byteCount,
                                                 flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block else { return nil }
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: byteCount)
        var out: CMSampleBuffer?
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
            presentationTimeStamp: pts, packetDescriptions: nil, sampleBufferOut: &out) == noErr else { return nil }
        return out
    }
}

struct WriterError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
