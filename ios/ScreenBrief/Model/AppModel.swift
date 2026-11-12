import AVFoundation
import Observation
import Photos
import Speech
import SwiftUI
import UIKit

/// The app's state: recordings found in Photos are copied into `Documents/Recordings/` (where the
/// Mac pulls them from), thumbnailed and transcribed on the phone, one at a time.
@MainActor @Observable
final class AppModel {
    private(set) var recordings: [Recording] = []
    private(set) var photosStatus: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    private(set) var speechStatus: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()
    private(set) var diagnostics: BroadcastDiagnostics?
    private(set) var importing: Set<String> = []
    private(set) var lastError: String?
    /// The screen is being recorded or broadcast right now.
    private(set) var isCapturing = false
    /// When the current screen capture started (as seen by the app), nil when not capturing.
    private(set) var captureStartedAt: Date?

    let files: RecordingFiles
    private var refreshing = false
    private var transcribeQueue: [String] = []
    private var transcribing = false
    private var started = false

    init(files: RecordingFiles = .standard) {
        self.files = files
    }

    var canReadPhotos: Bool { RecordingAlbum.canAdd(photosStatus) }

    func start() async {
        guard !started else { return }
        started = true
        files.prepare()
        files.removeLeftoverMarkImages()
        recordings = files.loadAll()
        NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.updateCapture()
                Task { await self?.refresh() }
            }
        }
        BroadcastFinishedObserver.install { [weak self] in Task { @MainActor in await self?.refresh() } }

        if photosStatus == .notDetermined {
            photosStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        if canReadPhotos { try? RecordingAlbum.ensureAlbum() }
        if speechStatus == .notDetermined {
            speechStatus = await Transcriber.requestAuthorization()
        }
        // Anything a previous launch left half done.
        for r in recordings where r.transcriptStatus == .pending || r.transcriptStatus == .running { enqueueTranscription(r.id) }
        await refresh()
    }

    func refresh() async {
        photosStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        updateCapture()
        guard canReadPhotos, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let known = Set(recordings.map(\.assetId)).union(files.dismissed())
        for candidate in PhotoSource.candidates() where !known.contains(candidate.asset.localIdentifier) {
            await importRecording(candidate)
        }
    }

    /// Recording state comes from the extension's heartbeat in the shared Keychain, not from
    /// `UIScreen.isCaptured` (which is also true for AirPlay mirroring and Xcode's screen capture).
    private func updateCapture() {
        let d = BroadcastDiagnostics.load()
        diagnostics = d
        let recording = d?.isRecording() ?? false
        let wasRecording = captureStartedAt != nil
        captureStartedAt = recording ? d?.startedAt : nil
        isCapturing = recording
        if wasRecording, !recording { Task { await refresh() } }
    }

    /// Polls the heartbeat while the app is in front (one small Keychain read a second).
    func runCapturePolling() async {
        while !Task.isCancelled {
            updateCapture()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func importRecording(_ c: PhotoSource.Candidate) async {
        let created = c.asset.creationDate ?? Date()
        let taken = Set(recordings.map(\.id))
        let base = Self.recordingID(fileName: c.fileName, created: created)
        let id = RecordingID.unique(base, taken: taken)
        let ext = ["mov", "mp4", "m4v"].contains((c.fileName as NSString).pathExtension.lowercased())
            ? (c.fileName as NSString).pathExtension.lowercased() : "mov"
        var r = Recording(id: id, startedAt: created, durationSec: c.asset.duration, device: DeviceInfo.current,
                          hasMicAudio: nil, transcript: nil, file: "\(id).\(ext)", source: c.source,
                          assetId: c.asset.localIdentifier, sizeBytes: 0, transcriptStatus: .pending)
        importing.insert(id)
        defer { importing.remove(id) }
        do {
            try await PhotoSource.export(c.asset, to: files.movie(r))
            r.sizeBytes = BroadcastRecorder.fileSize(files.movie(r))
            let asset = AVURLAsset(url: files.movie(r))
            if let duration = try? await asset.load(.duration), duration.seconds.isFinite, duration.seconds > 0 {
                r.durationSec = duration.seconds
            }
            if (try? await asset.loadTracks(withMediaType: .audio))?.isEmpty ?? false {
                r.hasMicAudio = false
            }
            try files.save(r)
        } catch {
            lastError = "Couldn't copy a recording from Photos: \(error.localizedDescription)"
            files.delete(r)
            return
        }
        await Thumbnailer.make(movie: files.movie(r), to: files.thumbnail(r.id))
        insert(r)
        enqueueTranscription(r.id)
    }

    /// The extension's own id (from "ScreenBrief-<id>.mov"), otherwise one from the creation time.
    static func recordingID(fileName: String, created: Date) -> String {
        let stem = (fileName as NSString).deletingPathExtension
        if stem.hasPrefix(RecordingAlbum.filePrefix) {
            let id = String(stem.dropFirst(RecordingAlbum.filePrefix.count)).lowercased()
            if RecordingID.isValid(id), id.count >= 3 { return id }
        }
        return RecordingID.make(for: created)
    }

    private func insert(_ r: Recording) {
        recordings.removeAll { $0.id == r.id }
        recordings.append(r)
        recordings.sort { $0.id > $1.id }
    }

    private func update(_ id: String, _ change: (inout Recording) -> Void) {
        guard let i = recordings.firstIndex(where: { $0.id == id }) else { return }
        change(&recordings[i])
        try? files.save(recordings[i])
    }

    // MARK: Transcription

    func enqueueTranscription(_ id: String) {
        guard !transcribeQueue.contains(id) else { return }
        transcribeQueue.append(id)
        guard !transcribing else { return }
        transcribing = true
        Task { await drainTranscriptions() }
    }

    private func drainTranscriptions() async {
        while !transcribeQueue.isEmpty {
            let id = transcribeQueue.removeFirst()
            guard let r = recordings.first(where: { $0.id == id }) else { continue }
            if r.hasMicAudio == false {
                update(id) { $0.transcriptStatus = .done; $0.transcript = [] }
                continue
            }
            update(id) { $0.transcriptStatus = .running }
            let movie = files.movie(r)
            let work = files.work
            let began = Date()
            do {
                let result = try await Task.detached(priority: .utility) {
                    try await Transcriber.transcribe(movie: movie, workDirectory: work)
                }.value
                update(id) {
                    $0.transcript = result.phrases
                    $0.hasMicAudio = !result.noVoice
                    $0.peakAudioLevel = result.peakLevel
                    $0.transcriptStatus = .done
                    $0.transcribeSec = (Date().timeIntervalSince(began) * 10).rounded() / 10
                    $0.transcriptNote = result.noVoice ? nil : "on-device (\(result.engine), took \(Format.spokenLength(Date().timeIntervalSince(began))))"
                }
            } catch {
                update(id) {
                    $0.transcriptStatus = .failed
                    $0.transcriptNote = error.localizedDescription
                }
            }
        }
        transcribing = false
    }

    // MARK: Actions

    func copyBrief(_ r: Recording) {
        UIPasteboard.general.string = Brief.text(for: r)
    }

    func delete(_ r: Recording) {
        files.delete(r)
        var dismissed = files.dismissed()
        dismissed.insert(r.assetId)
        files.setDismissed(dismissed)
        recordings.removeAll { $0.id == r.id }
        transcribeQueue.removeAll { $0 == r.id }
    }

    func thumbnail(_ r: Recording) -> UIImage? {
        UIImage(contentsOfFile: files.thumbnail(r.id).path)
    }
}

/// Forwards the extension's "broadcast finished" Darwin notification to a closure.
enum BroadcastFinishedObserver {
    nonisolated(unsafe) private static var handler: (() -> Void)?

    static func install(_ handler: @escaping () -> Void) {
        let first = self.handler == nil
        self.handler = handler
        guard first else { return }
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(), nil,
            { _, _, _, _, _ in DispatchQueue.main.async { BroadcastFinishedObserver.handler?() } },
            SharedSignals.broadcastFinished as CFString, nil, .deliverImmediately)
    }
}
