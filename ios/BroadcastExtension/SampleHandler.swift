import ReplayKit

/// ReplayKit Broadcast Upload Extension: records the screen and the microphone into a movie and,
/// when the broadcast stops, saves it to Photos (album "ScreenBrief"), where the app picks it up.
/// No network, no pairing. Keep this lean: the extension is killed above roughly 50 MB.
final class SampleHandler: RPBroadcastSampleHandler {
    private var recorder: BroadcastRecorder?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let recorder = BroadcastRecorder()
        recorder.diagnosticsSink = { try? $0.save() }
        if let message = recorder.start() {
            fail(message)
            return
        }
        self.recorder = recorder
        SharedSignals.post(SharedSignals.broadcastStarted)
        DispatchQueue.global(qos: .utility).async { recorder.recoverLeftovers() }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard let recorder else { return }
        switch sampleBufferType {
        case .video: recorder.appendVideo(sampleBuffer)
        case .audioMic: recorder.appendAudio(sampleBuffer)
        case .audioApp: break // only the user's voice is wanted
        @unknown default: break
        }
    }

    override func broadcastPaused() { recorder?.note("paused") }
    override func broadcastResumed() { recorder?.note("resumed") }

    override func broadcastFinished() {
        // Synchronous and bounded: iOS may end the process as soon as this returns.
        recorder?.finish(timeout: 6)
        SharedSignals.post(SharedSignals.broadcastFinished)
    }

    private func fail(_ message: String) {
        finishBroadcastWithError(NSError(domain: "ScreenBrief", code: 1, userInfo: [
            NSLocalizedDescriptionKey: message,
            NSLocalizedFailureReasonErrorKey: message,
        ]))
    }
}
