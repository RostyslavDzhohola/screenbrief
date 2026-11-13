import Foundation

/// One phrase of the transcript: seconds from the start of the video, and what was said.
struct TranscriptPhrase: Codable, Equatable, Hashable {
    var t: Double
    var text: String
}

enum TranscriptStatus: String, Codable, Equatable {
    case pending, running, done, failed, unavailable
}

/// Where a recording over the attachment limit is on its way to being parts in Photos.
enum PartsStatus: String, Codable, Equatable {
    case pending, running, done, failed
}

/// The parts of a recording that an unfinished split has already saved to Photos.
struct PartsInPhotos: Codable, Equatable, Hashable {
    /// How many parts that split made. A split into another number cuts elsewhere, so these
    /// parts are not parts of it.
    var of: Int
    /// Which of them are in Photos, counted from 1.
    var parts: [Int]
    /// The Photos identifier of each saved part, by its number: the user may delete a part from
    /// Photos between attempts, and a part that is gone has to be saved again.
    var assets: [String: String]?

    init(of: Int, parts: [Int], assets: [String: String]? = nil) {
        self.of = of
        self.parts = parts
        self.assets = assets
    }
}

/// A recording the app keeps. Stored as `Documents/Recordings/<id>.json` next to the movie
/// `<id>.mov|mp4`; the Mac's `screenbrief pull` reads both. The first six fields are the contract
/// with the Mac; the rest are the app's own bookkeeping.
struct Recording: Codable, Equatable, Identifiable, Hashable {
    var id: String
    var startedAt: Date
    var durationSec: Double
    var device: DeviceDescription
    /// Nil until checked; false for no audio track or digital silence.
    var hasMicAudio: Bool?
    var transcript: [TranscriptPhrase]?

    /// The movie's file name inside `Documents/Recordings/`.
    var file: String
    /// "screenbrief" (made with the ScreenBrief broadcast) or "screen-recorder" (iOS's own).
    var source: String
    /// The Photos asset it was copied from.
    var assetId: String
    var sizeBytes: Int64
    var transcriptStatus: TranscriptStatus
    /// Why there is no transcript (failure or unavailability), if so.
    var transcriptNote: String?
    /// Loudest audio sample, 0...1.
    var peakAudioLevel: Double?
    /// How long the on-device transcription took, in seconds.
    var transcribeSec: Double?
    /// Set once the recording is over the attachment limit: the state of its parts in Photos.
    var partsStatus: PartsStatus?
    /// How many parts were saved to Photos (when `partsStatus` is done).
    var partCount: Int?
    /// Why the parts could not be made, if so.
    var partsNote: String?
    /// How many times splitting it into parts was started.
    var partsAttempts: Int?
    /// The parts a split that did not finish got into Photos, so the next attempt does not save
    /// them a second time. Nil once all the parts are there.
    var partsInPhotos: PartsInPhotos?

    /// The largest file T3 Code attaches to a thread (50 MiB).
    static let maxAttachmentBytes: Int64 = 50 * 1_048_576

    /// Too large to attach in T3 Code as one file.
    var isTooLargeToAttach: Bool { sizeBytes > Recording.maxAttachmentBytes }

    /// The number of parts it can be attached as: set once a too-large recording's parts are all
    /// in Photos.
    var attachableParts: Int? {
        guard isTooLargeToAttach, partsStatus == .done, let partCount, partCount >= 2 else { return nil }
        return partCount
    }

    /// Too large, and its parts are waiting to be made or being made.
    var isSplitting: Bool { isTooLargeToAttach && (partsStatus == .pending || partsStatus == .running) }

    /// Too large, with no finished parts: they are made after import and at launch.
    var needsParts: Bool { isTooLargeToAttach && attachableParts == nil }

    /// A split that failed is started again at launch this many times in all, then left alone.
    static let maxPartsAttempts = 3

    /// Its parts are made at launch: not once splitting it has failed `maxPartsAttempts` times.
    var resumesParts: Bool {
        needsParts && (partsStatus != .failed || (partsAttempts ?? 0) < Recording.maxPartsAttempts)
    }

    /// Too large, and the last split failed: the user can ask for another.
    var partsFailed: Bool { needsParts && partsStatus == .failed }

    var transcriptPreview: String? {
        guard let transcript, !transcript.isEmpty else { return nil }
        return transcript.map(\.text).joined(separator: " ")
    }

    /// The recording has no usable voice (no audio track or digital silence).
    var hasNoVoice: Bool { hasMicAudio == false }
}


/// What the app says about a recording's size against T3 Code's attachment limit.
enum AttachmentAdvice {
    /// "50 MB", as T3 Code names its limit.
    static let limitText = "\(Recording.maxAttachmentBytes / 1_048_576) MB"

    /// Minutes of recording that fit the limit at the recorder's bitrate, rounded down with a
    /// tenth held back (the encoder overshoots a little on busy screens).
    static func minutesThatFit(_ configuration: MovieWriter.Configuration = .init()) -> Int {
        Int(configuration.secondsThatFit(in: Recording.maxAttachmentBytes) * 0.9 / 60)
    }

    /// The warning on the detail screen, nil when the recording can be attached as it is.
    static func detail(for r: Recording) -> String? {
        guard r.isTooLargeToAttach else { return nil }
        if let n = r.attachableParts {
            return "Too large to attach in one file (\(Format.bytes(r.sizeBytes)); T3 Code's limit is \(limitText)). It is saved in Photos as \(n) parts: attach all \(n) with the pasted text."
        }
        if r.isSplitting { return "Too large to attach in one file. Splitting it into parts…" }
        return "Too large to attach in T3 Code: this video is \(Format.bytes(r.sizeBytes)) and the limit is \(limitText). It will only transfer on the same Wi-Fi as your Mac (or plugged in), with the phone unlocked. Copy still works."
    }

    /// Why the parts were not made, shown on the detail screen above "Try splitting again". Nil
    /// unless the last split failed.
    static func partsFailure(for r: Recording) -> String? {
        guard r.partsFailed else { return nil }
        return "Splitting it into parts failed\(r.partsNote.map { ": \($0)" } ?? ".")"
    }

    /// The short version for the list.
    static func row(for r: Recording) -> String? {
        guard r.isTooLargeToAttach else { return nil }
        if let n = r.attachableParts { return "Attach as \(n) parts" }
        return r.isSplitting ? "Splitting into parts to attach…" : "Too large to attach in T3 Code"
    }

    /// What the detail screen says after Copy.
    static func copied(for r: Recording) -> String {
        if let n = r.attachableParts {
            return "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach all \(n) parts of this video from Photos."
        }
        return r.isTooLargeToAttach
            ? "Copied. Paste it in your T3 Code thread. This video is too large to attach there: the Mac copies it from the phone on the same Wi-Fi."
            : "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach this video there from Photos."
    }

    /// The record control's title while recording. `fileBytes` is the movie's size so far, from
    /// the extension's heartbeat; without it the size is estimated from the time.
    static func recordingTitle(elapsed: TimeInterval, fileBytes: Int64? = nil,
                               configuration: MovieWriter.Configuration = .init()) -> String {
        let bytes = fileBytes.flatMap { $0 > 0 ? Double($0) : nil } ?? max(0, elapsed) * configuration.bytesPerSecond
        let tooLarge = bytes > Double(Recording.maxAttachmentBytes)
        return "Recording \(Format.duration(elapsed))  ·  \(tooLarge ? "will be split to attach" : "tap to stop")"
    }
}

enum Format {
    /// 0:07, 1:05, 12:30
    static func duration(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// [00:03], [01:12]; hours only when needed.
    static func timestamp(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60) }
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    /// "15 seconds", "2 min 5 s"
    static func spokenLength(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        if s < 60 { return "\(s) second\(s == 1 ? "" : "s")" }
        return s % 60 == 0 ? "\(s / 60) min" : "\(s / 60) min \(s % 60) s"
    }

    static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
    }

    static func dateTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.string(from: date)
    }
}
