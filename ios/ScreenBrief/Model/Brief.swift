import Foundation

/// The plain-text brief the user pastes into their T3 Code thread (on the phone, or on the Mac
/// through Universal Clipboard). The agent gets the video with `screenbrief pull <id>` (from the
/// thread's attachments or from the phone) and must not start from the text alone.
enum Brief {
    static func text(for r: Recording, timeZone: TimeZone = .current) -> String {
        var lines: [String] = []
        lines.append("Phone feedback recording \(r.id): \(Format.spokenLength(r.durationSec)), recorded \(Format.dateTime(r.startedAt, timeZone: timeZone)) on \(deviceName(r.device)).")
        lines.append("I recorded my iPhone screen while using my app and said what I want changed.")
        lines.append("")
        lines.append("Agent: get the video before doing anything else. On the Mac run:  screenbrief pull \(r.id)")
        let result = "prints the path of a FEEDBACK.md: what I said on a timeline next to screenshots of the screen at each moment. Read it, open the frames, then make the changes I describe."
        if let n = r.attachableParts {
            lines.append("The video is \(Format.bytes(r.sizeBytes)), over T3 Code's \(AttachmentAdvice.limitText) attachment limit, so it is attached to this thread as \(n) parts (\(RecordingAlbum.partTitle(id: r.id, part: 1, of: n)) to part\(n)of\(n)). The command joins the parts (or copies the whole video from my iPhone when the phone is unlocked and on the same Wi-Fi as the Mac or plugged in) and \(result)")
            lines.append("If it cannot get the video, do not start on the changes and do not work from the transcript alone. Tell me what the command said is missing, ask me to attach all \(n) parts from Photos (album \"\(RecordingAlbum.title)\") to this thread, and wait. When I have attached them, run the command again.")
        } else if r.isTooLargeToAttach {
            lines.append("The video is \(Format.bytes(r.sizeBytes)), over T3 Code's \(AttachmentAdvice.limitText) attachment limit, so it is not attached to this thread: the command copies it from my iPhone, which must be unlocked and on the same Wi-Fi as the Mac or plugged in. It \(result)")
            lines.append("If it cannot get the video, do not start on the changes and do not work from the transcript alone. Tell me the Mac could not reach my iPhone, and wait until I say the phone is unlocked and near the Mac. Then run the command again.")
        } else {
            lines.append("It finds the video (attached to this thread, or copied from my iPhone when the phone is unlocked and on the same Wi-Fi as the Mac or plugged in) and \(result)")
            lines.append("If it cannot get the video, do not start on the changes and do not work from the transcript alone. Tell me you need the video, ask me to attach ScreenBrief-\(r.id) from Photos (album \"ScreenBrief\") to this thread, and wait. When I have attached it, run the command again.")
        }
        lines.append("")
        lines.append(contentsOf: transcriptSection(r))
        return lines.joined(separator: "\n")
    }

    static func transcriptSection(_ r: Recording) -> [String] {
        if r.hasMicAudio == false {
            return ["There is no voice in this recording (the microphone was off or silent), so there is no transcript. Work from the screenshots, and ask me what I wanted."]
        }
        if let transcript = r.transcript, !transcript.isEmpty {
            return ["What I said (transcribed on the phone, may have errors; times are from the start of the video):"]
                + transcript.map { "[\(Format.timestamp($0.t))] \($0.text)" }
        }
        switch r.transcriptStatus {
        case .done:
            return ["The phone found no speech in this recording. screenbrief pull transcribes it again on the Mac."]
        case .pending, .running:
            return ["The phone had not finished transcribing when I copied this. screenbrief pull transcribes it on the Mac."]
        case .failed, .unavailable:
            return ["The phone could not transcribe this recording. screenbrief pull transcribes it on the Mac."]
        }
    }

    /// "iPhone (iPhone14,3, iOS 27.0.1)"
    static func deviceName(_ d: DeviceDescription) -> String {
        "\(d.name) (\(d.model), \(d.os))"
    }
}
