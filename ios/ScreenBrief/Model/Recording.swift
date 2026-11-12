import Foundation

/// One phrase of the transcript: seconds from the start of the video, and what was said.
struct TranscriptPhrase: Codable, Equatable, Hashable {
    var t: Double
    var text: String
}

enum TranscriptStatus: String, Codable, Equatable {
    case pending, running, done, failed, unavailable
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

    /// The largest file T3 Code attaches to a thread (50 MiB).
    static let maxAttachmentBytes: Int64 = 50 * 1_048_576

    /// Too large to attach in T3 Code: it can only reach the Mac straight from the phone.
    var isTooLargeToAttach: Bool { sizeBytes > Recording.maxAttachmentBytes }

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

    /// The warning on the detail screen, nil when the recording can be attached.
    static func detail(for r: Recording) -> String? {
        guard r.isTooLargeToAttach else { return nil }
        return "Too large to attach in T3 Code: this video is \(Format.bytes(r.sizeBytes)) and the limit is \(limitText). It will only transfer on the same Wi-Fi as your Mac (or plugged in), with the phone unlocked. Copy still works."
    }

    /// The short version for the list.
    static func row(for r: Recording) -> String? {
        r.isTooLargeToAttach ? "Too large to attach in T3 Code" : nil
    }

    /// What the detail screen says after Copy.
    static func copied(for r: Recording) -> String {
        r.isTooLargeToAttach
            ? "Copied. Paste it in your T3 Code thread. This video is too large to attach there: the Mac copies it from the phone on the same Wi-Fi."
            : "Copied. Paste it in your T3 Code thread. Away from your Mac? Also attach this video there from Photos."
    }

    /// The record control's title while recording. `fileBytes` is the movie's size so far, from
    /// the extension's heartbeat; without it the size is estimated from the time.
    static func recordingTitle(elapsed: TimeInterval, fileBytes: Int64? = nil,
                               configuration: MovieWriter.Configuration = .init()) -> String {
        let bytes = fileBytes.flatMap { $0 > 0 ? Double($0) : nil } ?? max(0, elapsed) * configuration.bytesPerSecond
        let tooLarge = bytes > Double(Recording.maxAttachmentBytes)
        return "Recording \(Format.duration(elapsed))  ·  \(tooLarge ? "too large to attach" : "tap to stop")"
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
