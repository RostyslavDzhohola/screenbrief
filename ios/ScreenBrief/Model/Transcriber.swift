import AVFoundation
import Foundation
import Speech

/// A recognised word (or short run of words) with its time in the video.
struct TimedWord: Equatable {
    var start: Double
    var end: Double
    var text: String
}

/// Groups timed words into phrases for the transcript. A phrase ends at a pause or at the end of
/// a sentence. Once it is long (`softWords` / `softSeconds`) it also ends at a clause break (a
/// comma, or a short pause). It is never longer than `maxSeconds` / `maxWords`: then it is cut at
/// the best earlier break (sentence end, clause end, longest gap) and the rest carries over.
enum PhraseGrouper {
    static func group(_ words: [TimedWord], pause: Double = 0.8, softSeconds: Double = 7, softWords: Int = 14,
                      shortPause: Double = 0.35, maxSeconds: Double = 12, maxWords: Int = 30) -> [TranscriptPhrase] {
        var phrases: [TranscriptPhrase] = []
        var current: [TimedWord] = []
        func emit(_ ws: [TimedWord]) {
            guard let first = ws.first else { return }
            let text = ws.map { $0.text.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
                .replacingOccurrences(of: " ,", with: ",").replacingOccurrences(of: " .", with: ".")
            if !text.isEmpty { phrases.append(TranscriptPhrase(t: (first.start * 10).rounded(.down) / 10, text: text)) }
        }
        for word in words {
            if let last = current.last, let first = current.first {
                let gap = word.start - last.end
                let count = wordCount(current)
                let long = count >= softWords || last.end - first.start >= softSeconds
                if gap >= pause || (endsSentence(last) && count >= 3) || (long && (endsClause(last) || gap >= shortPause)) {
                    emit(current)
                    current = []
                }
            }
            // Too long with this word: cut at the best earlier break, keep the rest.
            while let first = current.first,
                  word.end - first.start > maxSeconds || wordCount(current) + wordCount([word]) > maxWords {
                let cut = bestBreak(current, next: word)
                emit(Array(current[..<cut]))
                current = Array(current[cut...])
            }
            current.append(word)
        }
        emit(current)
        return phrases
    }

    /// Index to split `ws` before (1...ws.count): the latest of the strongest breaks.
    private static func bestBreak(_ ws: [TimedWord], next: TimedWord) -> Int {
        var best = ws.count
        // Gaps count in 50 ms steps, so near-equal gaps tie and the latest break wins.
        func gap(_ a: TimedWord, _ b: TimedWord) -> Double { ((b.start - a.end) * 20).rounded() / 20 }
        var bestKey = (rank(ws[ws.count - 1]), gap(ws[ws.count - 1], next))
        for i in stride(from: ws.count - 1, through: 1, by: -1) {
            let key = (rank(ws[i - 1]), gap(ws[i - 1], ws[i]))
            if key > bestKey { best = i; bestKey = key }
        }
        return best
    }

    private static func rank(_ w: TimedWord) -> Int { endsSentence(w) ? 2 : endsClause(w) ? 1 : 0 }

    private static func wordCount(_ ws: [TimedWord]) -> Int {
        ws.reduce(0) { $0 + $1.text.split(separator: " ").count }
    }

    private static func endsSentence(_ w: TimedWord) -> Bool {
        w.text.trimmingCharacters(in: .whitespaces).last.map { ".?!".contains($0) } ?? false
    }

    private static func endsClause(_ w: TimedWord) -> Bool {
        w.text.trimmingCharacters(in: .whitespaces).last.map { ",;:".contains($0) } ?? false
    }
}

/// On-device transcription of a recording: SpeechAnalyzer/SpeechTranscriber where available
/// (iOS 26+), otherwise SFSpeechRecognizer with on-device recognition required. Best-effort:
/// callers treat any error as "the Mac will transcribe".
enum Transcriber {
    struct Result {
        var phrases: [TranscriptPhrase]
        var engine: String
        /// No audio track, or only digital silence.
        var noVoice: Bool
        var peakLevel: Double
    }

    struct Failure: LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    typealias Work = @Sendable (_ movie: URL, _ workDirectory: URL) async throws -> Result

    static let timedOutNote = "Transcription timed out on the phone. screenbrief pull transcribes it on the Mac."

    /// Seconds one transcription may take before the app gives up on it and moves on.
    static func deadline(forDuration seconds: Double) -> TimeInterval { max(120, 3 * seconds) }

    static func requestAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        if SFSpeechRecognizer.authorizationStatus() != .notDetermined { return SFSpeechRecognizer.authorizationStatus() }
        return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
    }

    static func transcribe(movie: URL, workDirectory: URL) async throws -> Result {
        try? FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        let audioURL = workDirectory.appendingPathComponent(UUID().uuidString + ".caf")
        defer { try? FileManager.default.removeItem(at: audioURL) }
        guard let peak = try await AudioExtractor.extract(from: movie, to: audioURL) else {
            return Result(phrases: [], engine: "none", noVoice: true, peakLevel: 0)
        }
        if peak < 0.0005 { return Result(phrases: [], engine: "none", noVoice: true, peakLevel: peak) }
        try Task.checkCancellation()

        var errors: [String] = []
        if #available(iOS 26.0, *) {
            do {
                let words = try await AnalyzerEngine.words(audioURL: audioURL)
                return Result(phrases: PhraseGrouper.group(words), engine: "SpeechAnalyzer", noVoice: false, peakLevel: peak)
            } catch {
                errors.append("SpeechAnalyzer: \(error.localizedDescription)")
            }
        }
        // Cancelled (its deadline passed): do not start over with the other engine.
        try Task.checkCancellation()
        do {
            let words = try await RecognizerEngine.words(audioURL: audioURL)
            return Result(phrases: PhraseGrouper.group(words), engine: "SFSpeechRecognizer", noVoice: false, peakLevel: peak)
        } catch {
            errors.append("SFSpeechRecognizer: \(error.localizedDescription)")
        }
        throw Failure(message: errors.joined(separator: "; "))
    }
}

/// A time limit for work that may never complete.
enum Deadline {
    struct TimedOut: Error {}

    /// The result of `work`, or `TimedOut` once `seconds` have passed. `work` is then cancelled
    /// but not waited for, so work that ignores cancellation cannot hold the caller up.
    static func run<T: Sendable>(seconds: TimeInterval, priority: TaskPriority? = nil,
                                 _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let job = Task.detached(priority: priority, operation: work)
        let answered = Once()
        return try await withCheckedThrowingContinuation { c in
            let timer = Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                if !Task.isCancelled, answered.claim() {
                    job.cancel()
                    c.resume(throwing: TimedOut())
                }
            }
            Task.detached {
                let result = await job.result
                timer.cancel()
                if answered.claim() { c.resume(with: result) }
            }
        }
    }

    /// True for the first caller only.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var claimed = false

        func claim() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if claimed { return false }
            claimed = true
            return true
        }
    }
}

/// The movie's audio as 16 kHz mono float PCM in a CAF file, plus its peak level. Nil if the
/// movie has no audio track.
enum AudioExtractor {
    static func extract(from movie: URL, to output: URL) async throws -> Double? {
        let asset = AVURLAsset(url: movie)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(out)
        guard reader.startReading() else { throw reader.error ?? Transcriber.Failure(message: "Could not read the audio") }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false) else {
            throw Transcriber.Failure(message: "No audio format")
        }
        let file = try AVAudioFile(forWriting: output, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        var peak: Float = 0
        while let sample = out.copyNextSampleBuffer() {
            if Task.isCancelled {
                reader.cancelReading()
                throw CancellationError()
            }
            let frames = CMSampleBufferGetNumSamples(sample)
            guard frames > 0, let block = CMSampleBufferGetDataBuffer(sample),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { continue }
            buffer.frameLength = AVAudioFrameCount(frames)
            let status = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: frames * 4, destination: buffer.floatChannelData![0])
            guard status == noErr else { continue }
            let p = buffer.floatChannelData![0]
            for i in 0..<frames { peak = max(peak, abs(p[i])) }
            try file.write(from: buffer)
        }
        if reader.status == .failed { throw reader.error ?? Transcriber.Failure(message: "Reading the audio failed") }
        return Double(peak)
    }
}

@available(iOS 26.0, *)
private enum AnalyzerEngine {
    static func words(audioURL: URL) async throws -> [TimedWord] {
        guard SpeechTranscriber.isAvailable else { throw Transcriber.Failure(message: "not available on this device") }
        var locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
        guard let locale else { throw Transcriber.Failure(message: "no supported language") }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                            attributeOptions: [.audioTimeRange])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task { () throws -> [TimedWord] in
            var words: [TimedWord] = []
            for try await result in transcriber.results {
                for run in result.text.runs {
                    let text = String(result.text[run.range].characters)
                    guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                    if let range = run.audioTimeRange {
                        words.append(TimedWord(start: range.start.seconds, end: range.end.seconds, text: text))
                    } else {
                        words.append(TimedWord(start: result.range.start.seconds, end: result.range.end.seconds, text: text))
                    }
                }
            }
            return words
        }
        let file = try AVAudioFile(forReading: audioURL)
        return try await withTaskCancellationHandler {
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            let words = try await collector.value
            try Task.checkCancellation()
            return words
        } onCancel: {
            // Ends the analysis, and with it the results the collector is waiting for.
            collector.cancel()
            Task { await analyzer.cancelAndFinishNow() }
        }
    }
}

private enum RecognizerEngine {
    static func words(audioURL: URL) async throws -> [TimedWord] {
        guard await Transcriber.requestAuthorization() == .authorized else {
            throw Transcriber.Failure(message: "speech recognition not allowed")
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else { throw Transcriber.Failure(message: "recognizer unavailable") }
        guard recognizer.supportsOnDeviceRecognition else { throw Transcriber.Failure(message: "no on-device recognition for this language") }
        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        let recognition = Recognition()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { c in
                recognition.begin(c) {
                    recognizer.recognitionTask(with: request) { result, error in
                        if let result, result.isFinal {
                            recognition.resume(with: .success(result.bestTranscription.segments.map {
                                TimedWord(start: $0.timestamp, end: $0.timestamp + $0.duration, text: $0.substring)
                            }))
                        } else if let error {
                            // "No speech detected" is not a failure: there is just nothing to show.
                            let ns = error as NSError
                            let nothingSaid = ns.domain == "kAFAssistantErrorDomain" && ns.code == 1110
                            recognition.resume(with: nothingSaid ? .success([]) : .failure(error))
                        }
                    }
                }
            }
        } onCancel: {
            recognition.cancel()
        }
    }

    /// One recognition: its task and the caller waiting for it. The recogniser's callback and a
    /// cancellation arrive on different threads; whichever comes first answers the caller.
    private final class Recognition: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<[TimedWord], Error>?
        private var task: SFSpeechRecognitionTask?
        private var cancelled = false

        func begin(_ c: CheckedContinuation<[TimedWord], Error>, start: () -> SFSpeechRecognitionTask) {
            lock.lock()
            if cancelled {
                lock.unlock()
                c.resume(throwing: CancellationError())
                return
            }
            continuation = c
            lock.unlock()
            let started = start()
            lock.lock()
            task = started
            let cancelledMeanwhile = cancelled
            lock.unlock()
            if cancelledMeanwhile { started.cancel() }
        }

        /// Only the first answer reaches the caller.
        func resume(with result: Swift.Result<[TimedWord], Error>) {
            lock.lock()
            let c = continuation
            continuation = nil
            lock.unlock()
            c?.resume(with: result)
        }

        /// Stops the recogniser and answers the caller now, in case the recogniser never calls back.
        func cancel() {
            lock.lock()
            cancelled = true
            let running = task
            lock.unlock()
            running?.cancel()
            resume(with: .failure(CancellationError()))
        }
    }
}
