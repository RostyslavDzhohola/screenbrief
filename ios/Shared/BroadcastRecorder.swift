import CoreMedia
import Foundation
import Photos

/// One broadcast, as the extension runs it: `MovieWriter` writes a movie into the extension's own
/// container, and `finish` hands it to the photo library (the only place the app can find it, as
/// there is no App Group). Diagnostics go to `diagnosticsSink` (the shared Keychain item).
/// Photos access and saving are injected so tests can run without a photo library.
final class BroadcastRecorder {
    struct Outcome: Equatable {
        var summary: MovieWriter.Summary
        var saved: RecordingAlbum.SaveResult?
        var error: String?
    }

    struct PhotosAccess {
        var addOnly: PHAuthorizationStatus
        var readWrite: PHAuthorizationStatus
        var canSave: Bool { RecordingAlbum.canAdd(addOnly) || RecordingAlbum.canAdd(readWrite) }

        static var current: PhotosAccess {
            PhotosAccess(addOnly: PHPhotoLibrary.authorizationStatus(for: .addOnly),
                         readWrite: PHPhotoLibrary.authorizationStatus(for: .readWrite))
        }
    }

    typealias Saver = (_ movie: URL, _ fileName: String, _ creationDate: Date) throws -> RecordingAlbum.SaveResult

    static let finishTimedOutMessage = "Finishing took too long. The recording will be saved to Photos the next time you start recording."
    static let cannotSaveMessage = "ScreenBrief can't save recordings to Photos. Open ScreenBrief, allow access to Photos (Settings > ScreenBrief > Photos > Full Access), then record again."

    let id: String
    let startedAt: Date
    let fileName: String
    let fileURL: URL
    let directory: URL
    let writer: MovieWriter
    var diagnosticsSink: ((BroadcastDiagnostics) -> Void)?
    var diagnosticsInterval: TimeInterval = 3

    private let saver: Saver
    private let access: () -> PhotosAccess
    private let lock = NSLock()
    private var diagnostics: BroadcastDiagnostics
    private var lastDiagnostics = Date.distantPast
    private var finished = false
    private var heartbeat: DispatchSourceTimer?

    init(directory: URL = BroadcastRecorder.defaultDirectory,
         startedAt: Date = Date(),
         writerConfiguration: MovieWriter.Configuration = .init(),
         access: @escaping () -> PhotosAccess = { .current },
         saver: @escaping Saver = RecordingAlbum.save) {
        self.directory = directory
        self.startedAt = startedAt
        id = RecordingID.make(for: startedAt)
        let ext = writerConfiguration.fileType == .mp4 ? "mp4" : "mov"
        fileName = "\(RecordingAlbum.filePrefix)\(id).\(ext)"
        fileURL = directory.appendingPathComponent(fileName)
        // The id travels inside the movie too: the Mac matches an attached video on this title.
        var configuration = writerConfiguration
        configuration.title = "\(RecordingAlbum.filePrefix)\(id)"
        writer = MovieWriter(outputURL: fileURL, configuration: configuration)
        self.saver = saver
        self.access = access
        diagnostics = BroadcastDiagnostics(recordingId: id, startedAt: startedAt, updatedAt: startedAt, phase: "started")
    }

    static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Recordings", isDirectory: true)
    }

    /// Nil when recording may go ahead, otherwise the message to end the broadcast with.
    func start() -> String? {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let a = access()
        update(force: true) {
            $0.photosAddOnly = RecordingAlbum.statusName(a.addOnly)
            $0.photosReadWrite = RecordingAlbum.statusName(a.readWrite)
            $0.note("start; photos add=\($0.photosAddOnly ?? "?") rw=\($0.photosReadWrite ?? "?")")
        }
        guard a.canSave else {
            update(force: true) { $0.phase = "failed"; $0.error = "no Photos access"; $0.note("refused: no Photos access") }
            return Self.cannotSaveMessage
        }
        // The app reads `updatedAt` to show "Recording..."; ReplayKit sends no frames on a static
        // screen, so refresh on a timer too.
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in self?.refreshIfDue(force: true) }
        timer.resume()
        heartbeat = timer
        return nil
    }

    /// Seconds after which a "recording" item without an update means the extension is gone.
    static let heartbeatTimeout: TimeInterval = 8

    func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        writer.appendVideo(sampleBuffer)
        refreshIfDue()
    }

    func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        writer.appendAudio(sampleBuffer)
    }

    /// Finishes the movie and saves it to Photos. Synchronous and bounded (for `broadcastFinished`).
    /// A movie whose finish timed out is left in place for the next broadcast to save.
    @discardableResult
    func finish(timeout: TimeInterval = 5) -> Outcome {
        lock.lock()
        if finished { lock.unlock(); return Outcome(summary: writer.snapshot(), saved: nil, error: "already finished") }
        finished = true
        heartbeat?.cancel()
        heartbeat = nil
        lock.unlock()

        update(force: true) { $0.phase = "finishing"; $0.note("finish") }
        let summary = writer.finish(timeout: timeout)
        let bytes = Self.fileSize(fileURL)
        update(force: true) {
            $0.apply(summary)
            $0.fileBytes = bytes
            $0.note("writer \(summary.finished ? "done" : "failed: \(summary.error ?? "?")"), \(bytes) bytes")
        }
        // The writer may still be changing the file: it is neither saved nor deleted now. It stays
        // where it is, and `recoverLeftovers` of the next broadcast saves it.
        if summary.finishTimedOut {
            let error = Self.finishTimedOutMessage
            update(force: true) { $0.phase = "failed"; $0.error = error; $0.note(error) }
            return Outcome(summary: summary, saved: nil, error: error)
        }
        // An unfinished fragmented movie is still readable up to its last fragment: save it anyway.
        guard bytes > 0, summary.videoFramesAppended > 0 else {
            let error = summary.error ?? "Nothing was recorded."
            update(force: true) { $0.phase = "failed"; $0.error = error }
            try? FileManager.default.removeItem(at: fileURL)
            return Outcome(summary: summary, saved: nil, error: error)
        }
        do {
            let saved = try saver(fileURL, fileName, startedAt)
            try? FileManager.default.removeItem(at: fileURL)
            update(force: true) {
                $0.phase = "saved"
                $0.savedAssetId = saved.localIdentifier
                $0.inAlbum = saved.inAlbum
                $0.note("saved to Photos\(saved.inAlbum ? " (album)" : "; album failed: \(saved.albumError ?? "?")")")
            }
            return Outcome(summary: summary, saved: saved, error: nil)
        } catch {
            let message = "Saving to Photos failed: \(error.localizedDescription)"
            update(force: true) { $0.phase = "failed"; $0.error = message; $0.note(message) }
            return Outcome(summary: summary, saved: nil, error: message)
        }
    }

    /// Movies an earlier broadcast left behind (the extension was killed before saving, finishing
    /// took too long, or saving failed): saves each to Photos and deletes it. One that cannot be
    /// saved stays for the next broadcast to try again, however old it is: it is the only copy of
    /// that recording. Returns how many were saved.
    @discardableResult
    func recoverLeftovers() -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey])) ?? []
        var saved = 0
        for url in files where url != fileURL && url.lastPathComponent.hasPrefix(RecordingAlbum.filePrefix) {
            let date = (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date()
            let outcome: String
            if Self.fileSize(url) == 0 {
                try? FileManager.default.removeItem(at: url)
                outcome = "dropped (empty)"
            } else {
                do {
                    _ = try saver(url, url.lastPathComponent, date)
                    try? FileManager.default.removeItem(at: url)
                    saved += 1
                    outcome = "saved"
                } catch {
                    outcome = "kept (save failed: \(error.localizedDescription))"
                }
            }
            update(force: true) { $0.note("leftover \(url.lastPathComponent): \(outcome)") }
        }
        return saved
    }

    func note(_ text: String) {
        update(force: true) { $0.note(text) }
    }

    var currentDiagnostics: BroadcastDiagnostics {
        lock.lock(); defer { lock.unlock() }
        return diagnostics
    }

    private func refreshIfDue(force: Bool = false) {
        lock.lock()
        let due = !finished && (force || Date().timeIntervalSince(lastDiagnostics) >= diagnosticsInterval)
        lock.unlock()
        guard due else { return }
        let snap = writer.snapshot()
        let bytes = Self.fileSize(fileURL)
        update(force: true) {
            $0.fileBytes = bytes
            if $0.phase == "started", snap.videoFramesAppended > 0 { $0.phase = "recording"; $0.note("first frames \(snap.width)x\(snap.height)") }
            $0.apply(snap)
        }
    }

    private func update(force: Bool, _ change: (inout BroadcastDiagnostics) -> Void) {
        let memory = MemoryProbe.footprintMB()
        lock.lock()
        change(&diagnostics)
        diagnostics.memoryMB = memory
        diagnostics.peakMemoryMB = max(diagnostics.peakMemoryMB, memory)
        diagnostics.updatedAt = Date()
        lastDiagnostics = Date()
        let copy = diagnostics
        lock.unlock()
        diagnosticsSink?(copy)
    }

    static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }
}

extension BroadcastDiagnostics {
    mutating func apply(_ s: MovieWriter.Summary) {
        videoFrames = s.videoFramesAppended
        keepaliveFrames = s.keepaliveFrames
        videoFramesDropped = s.videoFramesDropped
        frameCopiesFailed = s.frameCopiesFailed
        audioBuffers = s.audioBuffersAppended
        silenceBuffers = s.silenceBuffersAppended
        hasMicAudio = s.hasMicAudio
        peakAudioLevel = s.peakAudioLevel
        durationSec = s.durationSec
        if let e = s.error { error = e }
    }
}
