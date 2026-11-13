import AVFoundation
import CoreMedia

/// Cuts a movie that is too large to attach into parts that each fit, without re-encoding: the
/// compressed samples are copied as they are, every part starts on a video key frame, and its
/// timestamps start at zero. The Mac's `screenbrief pull` joins the parts in order (ffmpeg's
/// concat demuxer, stream copy), so played back to back they are the original.
///
/// The number of parts is in each part's title ("ScreenBrief-<id>-part<k>of<n>"), so the cuts are
/// planned from an index of the movie before the first part is written.
enum MovieSplitter {
    struct Part: Equatable, Sendable {
        var url: URL
        /// Seconds from the start of the recording to the start of this part.
        var offsetSec: Double
        var bytes: Int64
    }

    /// Splits `movie` into parts inside `directory`; injectable for tests.
    typealias Work = @Sendable (_ movie: URL, _ id: String, _ directory: URL) async throws -> [Part]
    /// Saves one part to Photos; injectable for tests.
    typealias Save = @Sendable (_ part: URL, _ fileName: String, _ creationDate: Date) throws -> RecordingAlbum.SaveResult

    /// What a part is planned to weigh: a tenth under the limit, so an encoder burst cannot push
    /// one over.
    static let targetBytes: Int64 = 45 * 1_048_576
    /// The Mac reads at most two digits of <k> and <n>.
    static let maxParts = 99
    /// Bytes the container spends on a sample besides its data (size, time and offset tables).
    static let tableBytesPerSample: Int64 = 24
    /// The parts' lengths must add up to the movie's within this many seconds.
    static let durationTolerance = 0.5

    static let timedOutNote = "Splitting timed out."

    /// Seconds one split may take before the app gives up on it and moves on.
    static func deadline(forDuration seconds: Double) -> TimeInterval { max(300, 2 * seconds) }

    /// The parts of `movie`, written to `directory` as "ScreenBrief-<id>-part<k>of<n>.mov", in
    /// order. Empty (and nothing written) when the movie is within `maxBytes`. Every part is
    /// checked against `maxBytes` after it is written; if one is over, the movie is cut finer
    /// and written again. Throws, leaving nothing in `directory`, when it cannot be done.
    static func split(movie: URL, id: String, into directory: URL,
                      targetBytes: Int64 = MovieSplitter.targetBytes,
                      maxBytes: Int64 = Recording.maxAttachmentBytes) async throws -> [Part] {
        guard BroadcastRecorder.fileSize(movie) > maxBytes else { return [] }
        var done = false
        defer { if !done { try? FileManager.default.removeItem(at: directory) } }

        let asset = AVURLAsset(url: movie)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw WriterError("The video has no picture track.")
        }
        var tracks: [Track] = []
        for track in [video] + (try await asset.loadTracks(withMediaType: .audio)) {
            let (formats, transform, timeScale, segments) = try await track.load(.formatDescriptions, .preferredTransform, .naturalTimeScale, .segments)
            // One stretch of media, placed once on the movie's timeline: anything edited
            // further is not cut (it stays a recording that is too large to attach).
            let media = segments.filter { !$0.isEmpty }
            guard media.count <= 1 else { throw WriterError("This kind of video cannot be cut into parts.") }
            let lead = media.first.map { $0.timeMapping.source.start - $0.timeMapping.target.start } ?? .zero
            tracks.append(Track(track: track, format: formats.first, transform: transform, timeScale: timeScale, lead: lead))
        }
        let whole = try await asset.load(.duration).seconds
        let groups = try index(asset, tracks)

        var target = min(targetBytes, maxBytes)
        var tried: [Int] = []
        while target > 0 {
            let starts = partStarts(groupBytes: groups.map(\.bytes), targetBytes: target)
            target = target * 85 / 100
            // At least two parts, and not a plan that was already over the limit.
            guard starts.count >= 2, starts != tried else { continue }
            guard starts.count <= maxParts else { break }
            tried = starts
            let parts = try await write(asset, tracks, cuts: starts.dropFirst().map { groups[$0].start }, id: id, into: directory)
            guard parts.allSatisfy({ $0.bytes <= maxBytes }) else { continue }
            var total = 0.0
            for part in parts { total += try await AVURLAsset(url: part.url).load(.duration).seconds }
            guard abs(total - whole) <= durationTolerance else {
                throw WriterError("The parts do not add up to the video's length.")
            }
            done = true
            return parts
        }
        throw WriterError("The video could not be cut into parts of at most \(Format.bytes(maxBytes)).")
    }

    // MARK: Planning

    /// A video key frame and everything up to the next one: the smallest piece a part can be.
    struct Group: Equatable {
        var start: CMTime
        var bytes: Int64
    }

    /// Where each part starts, as indexes into the groups: a part takes groups until the next one
    /// would take it past `targetBytes`. A single group larger than that is a part of its own.
    static func partStarts(groupBytes: [Int64], targetBytes: Int64) -> [Int] {
        var starts: [Int] = []
        var filled: Int64 = 0
        for (i, bytes) in groupBytes.enumerated() {
            if starts.isEmpty || filled + bytes > targetBytes {
                starts.append(i)
                filled = 0
            }
            filled += bytes
        }
        return starts
    }

    /// The movie as groups, each with the bytes every track spends in it. Each track is read
    /// through once, on its own reader so that none waits on another; nothing is decoded.
    private static func index(_ asset: AVAsset, _ tracks: [Track]) throws -> [Group] {
        var groups: [Group] = []
        for (i, track) in tracks.enumerated() {
            let reader = try AVAssetReader(asset: asset)
            let output = passthrough(track)
            reader.add(output)
            guard reader.startReading() else { throw reader.error ?? WriterError("The video could not be read.") }
            var g = 0
            while let sample = try next(output, track) {
                // Cancelled (the recording was deleted, or its deadline passed): stop reading.
                try Task.checkCancellation()
                let time = CMSampleBufferGetPresentationTimeStamp(sample)
                let bytes = Int64(CMSampleBufferGetTotalSampleSize(sample))
                    + Int64(CMSampleBufferGetNumSamples(sample)) * tableBytesPerSample
                if i == 0 {
                    if groups.isEmpty || isKeyFrame(sample) { groups.append(Group(start: time, bytes: 0)) }
                    groups[groups.count - 1].bytes += bytes
                } else {
                    // Sound counts toward the group it starts in.
                    while g + 1 < groups.count, groups[g + 1].start <= time { g += 1 }
                    groups[g].bytes += bytes
                }
            }
            guard reader.status == .completed, !groups.isEmpty else {
                throw reader.error ?? WriterError("The video could not be read.")
            }
        }
        return groups
    }

    // MARK: Writing

    private struct Track {
        var track: AVAssetTrack
        var format: CMFormatDescription?
        var transform: CGAffineTransform
        var timeScale: CMTimeScale
        /// How far the track's own clock runs ahead of the movie's. The reader stamps samples
        /// on the track's clock, where sound starts with the encoder's lead-in (about 48 ms of
        /// AAC that is not played), so its samples are that much later than they are heard.
        var lead: CMTime
        var isSound: Bool { track.mediaType == .audio }
    }

    /// Writes one part up to each cut and one from the last cut to the end, in a single pass over
    /// the movie. Each sample is written with its part's start taken off its time.
    private static func write(_ asset: AVAsset, _ tracks: [Track], cuts: [CMTime], id: String,
                              into directory: URL) async throws -> [Part] {
        try? FileManager.default.removeItem(at: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let reader = try AVAssetReader(asset: asset)
        let outputs = tracks.map(passthrough)
        outputs.forEach(reader.add)
        guard reader.startReading() else { throw reader.error ?? WriterError("The video could not be read.") }
        // Each track's next sample.
        var waiting = try zip(outputs, tracks).map(next)
        let ends = cuts + [.positiveInfinity]
        var parts: [Part] = []
        var start = CMTime.zero

        for (k, end) in ends.enumerated() {
            // Cancelled (the recording was deleted, or its deadline passed): no further part.
            try Task.checkCancellation()
            let title = RecordingAlbum.partTitle(id: id, part: k + 1, of: ends.count)
            let url = directory.appendingPathComponent("\(title).mov")
            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            // Fine enough to place sound to the sample (the default, 1/600 s, is not).
            writer.movieTimeScale = tracks.map(\.timeScale).max() ?? 0
            writer.metadata = MovieWriter.titleMetadata(title, fileType: .mov)
            let inputs = tracks.map { track -> AVAssetWriterInput in
                // No output settings: the samples are written as they are.
                let input = AVAssetWriterInput(mediaType: track.track.mediaType, outputSettings: nil, sourceFormatHint: track.format)
                input.expectsMediaDataInRealTime = false
                if track.track.mediaType == .video {
                    input.transform = track.transform
                    input.mediaTimeScale = track.timeScale
                }
                return input
            }
            for input in inputs {
                guard writer.canAdd(input) else { throw WriterError("This kind of video cannot be cut into parts.") }
                writer.add(input)
            }
            guard writer.startWriting() else { throw writer.error ?? WriterError("A part could not be written.") }
            writer.startSession(atSourceTime: .zero)

            var open = Set(inputs.indices)
            var idle = 0
            while true {
                try Task.checkCancellation()
                // A track with nothing more for this part is finished now, so the writer does
                // not hold the others back waiting for it.
                for i in open where waiting[i].map({ leading($0, before: end, sound: tracks[i].isSound) == 0 }) ?? true {
                    inputs[i].markAsFinished()
                    open.remove(i)
                }
                if open.isEmpty { break }
                // The writer says which tracks it wants more of (it keeps them interleaved); of
                // those, the earliest sample goes in. When it wants none, it is busy storing:
                // wait, but give up after half a minute rather than wait forever.
                guard let i = open.filter({ inputs[$0].isReadyForMoreMediaData }).min(by: { time(waiting[$0]) < time(waiting[$1]) }),
                      let sample = waiting[i] else {
                    guard writer.status == .writing, idle < 15_000 else { throw writer.error ?? WriterError("Writing a part stalled.") }
                    try await Task.sleep(nanoseconds: 2_000_000)
                    idle += 1
                    continue
                }
                idle = 0
                let (head, tail) = divide(sample, after: leading(sample, before: end, sound: tracks[i].isSound))
                waiting[i] = try tail ?? next(outputs[i], tracks[i])
                guard let head, let shifted = MovieWriter.shifted(head, by: start) else { throw WriterError("A part could not be written.") }
                // The packet of sound that lay across the cut opens this part: it is stored
                // whole and played from the part's start on.
                let early = CMTime.zero - CMSampleBufferGetPresentationTimeStamp(shifted)
                if tracks[i].isSound, early > .zero, CMGetAttachment(shifted, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart, attachmentModeOut: nil) == nil {
                    CMSetAttachment(shifted, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart,
                                    value: CMTimeCopyAsDictionary(early, allocator: nil), attachmentMode: kCMAttachmentMode_ShouldPropagate)
                }
                guard inputs[i].append(shifted) else { throw writer.error ?? WriterError("A part could not be written.") }
            }
            // The part lasts exactly to the cut, so the next one follows it without a gap.
            if end.isNumeric { writer.endSession(atSourceTime: end - start) }
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? WriterError("A part could not be written.") }
            parts.append(Part(url: url, offsetSec: start.seconds, bytes: BroadcastRecorder.fileSize(url)))
            start = end
        }
        guard reader.status == .completed else { throw reader.error ?? WriterError("The video could not be read.") }
        return parts
    }

    private static func time(_ sample: CMSampleBuffer?) -> CMTime {
        sample.map(CMSampleBufferGetPresentationTimeStamp) ?? .positiveInfinity
    }

    private static func passthrough(_ track: Track) -> AVAssetReaderTrackOutput {
        // No output settings: the samples come out as they are stored.
        let output = AVAssetReaderTrackOutput(track: track.track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        return output
    }

    /// The track's next buffer that holds samples, timed on the movie's clock; nil at its end.
    private static func next(_ output: AVAssetReaderTrackOutput, _ track: Track) throws -> CMSampleBuffer? {
        while let sample = autoreleasepool(invoking: { output.copyNextSampleBuffer() }) {
            guard CMSampleBufferGetNumSamples(sample) > 0, CMSampleBufferGetPresentationTimeStamp(sample).isValid else { continue }
            if track.lead == .zero { return sample }
            guard let moved = MovieWriter.shifted(sample, by: track.lead) else { throw WriterError("The video could not be read.") }
            return moved
        }
        return nil
    }

    static func isKeyFrame(_ sample: CMSampleBuffer) -> Bool {
        guard let all = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
              let first = all.first else { return true }
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    /// How many of the buffer's samples, from its first, belong before a cut at `time`. A frame
    /// does when it starts before the cut. A packet of sound does when it ends by the cut, so a
    /// part's sound never outlasts its picture: ffmpeg places each part after the full length of
    /// the one before, and sound running past the cut would push every later part back.
    static func leading(_ sample: CMSampleBuffer, before time: CMTime, sound: Bool) -> Int {
        let count = CMSampleBufferGetNumSamples(sample)
        var n = 0
        var timing = CMSampleTimingInfo()
        while n < count, CMSampleBufferGetSampleTimingInfo(sample, at: n, timingInfoOut: &timing) == noErr,
              sound && timing.duration.isValid ? timing.presentationTimeStamp + timing.duration <= time : timing.presentationTimeStamp < time {
            n += 1
        }
        return n
    }

    /// The buffer's first `n` samples, and the rest. Sound comes in buffers of several packets,
    /// and a cut can fall inside one.
    static func divide(_ sample: CMSampleBuffer, after n: Int) -> (head: CMSampleBuffer?, tail: CMSampleBuffer?) {
        let count = CMSampleBufferGetNumSamples(sample)
        if n <= 0 { return (nil, sample) }
        var head: CMSampleBuffer?
        var tail: CMSampleBuffer?
        guard n < count,
              CMSampleBufferCopySampleBufferForRange(allocator: nil, sampleBuffer: sample, sampleRange: CFRange(location: 0, length: n),
                                                     sampleBufferOut: &head) == noErr,
              CMSampleBufferCopySampleBufferForRange(allocator: nil, sampleBuffer: sample, sampleRange: CFRange(location: n, length: count - n),
                                                     sampleBufferOut: &tail) == noErr else {
            // All of it belongs before the cut (or it cannot be divided): it stays whole.
            return (sample, nil)
        }
        // What the movie trims off the buffer's start or end belongs to that end only.
        if let head { CMRemoveAttachment(head, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd) }
        if let tail { CMRemoveAttachment(tail, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart) }
        return (head, tail)
    }
}
