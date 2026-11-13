import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        RecordControl()
                        Text("Tap Start Sharing, then switch to the app you are testing and talk. Turn Microphone on in the sheet; it stays on for next time. Recordings up to about \(AttachmentAdvice.minutesThatFit()) minutes attach as one file; longer ones are split into parts.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                }

                if !model.canReadPhotos {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("ScreenBrief needs full access to Photos", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                                .font(.subheadline.weight(.semibold))
                            Text("Recordings are saved to Photos, and the app shows them from there.")
                                .font(.footnote)
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }
                        }
                    }
                }

                Section("Recordings") {
                    if model.recordings.isEmpty {
                        Text(model.importing.isEmpty ? "No recordings yet. They appear here when you stop recording." : "Copying a recording from Photos...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.recordings) { r in
                        NavigationLink(value: r.id) { RecordingRow(recording: r) }
                            .accessibilityIdentifier("recording-\(r.id)")
                    }
                }

                if let error = model.lastError {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }

                Section {
                    DisclosureGroup("Debug") {
                        Text(model.diagnostics.map { "Last broadcast: \($0.summaryLine)\n" + $0.events.joined(separator: "\n") } ?? "No broadcast yet")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("debug-diagnostics")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("ScreenBrief")
            .navigationDestination(for: String.self) { id in
                RecordingDetailView(id: id)
            }
            .refreshable { await model.refresh() }
            .task { await model.runCapturePolling() }
        }
    }
}

/// The big record button. While the screen is being shared it says so, with a running timer,
/// and a tap opens the system sheet's Stop Sharing.
struct RecordControl: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let since = model.captureStartedAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                BroadcastPickerButton(title: AttachmentAdvice.recordingTitle(elapsed: context.date.timeIntervalSince(since),
                                                                             fileBytes: model.diagnostics?.fileBytes),
                                      isRecording: true)
                    .frame(height: 68)
            }
        } else {
            BroadcastPickerButton(title: "Start recording", isRecording: false)
                .frame(height: 68)
        }
    }
}

struct RecordingRow: View {
    @Environment(AppModel.self) private var model
    let recording: Recording

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let image = model.thumbnail(recording) {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Color.secondary.opacity(0.2)
                }
            }
            .frame(width: 48, height: 84)
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 4) {
                Text(recording.startedAt, format: .dateTime.weekday(.abbreviated).hour().minute())
                    .font(.headline)
                Text("\(Format.duration(recording.durationSec))  ·  \(Format.bytes(recording.sizeBytes))\(recording.source == "screen-recorder" ? "  ·  iOS recorder" : "")")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let tooLarge = AttachmentAdvice.row(for: recording) {
                    Label(tooLarge, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                }
                if recording.hasNoVoice {
                    Label("No voice: the microphone was off", systemImage: "mic.slash.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                } else if let preview = recording.transcriptPreview {
                    Text(preview).font(.footnote).lineLimit(2)
                } else {
                    Text(TranscriptStatusText.short(recording))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

enum TranscriptStatusText {
    static func short(_ r: Recording) -> String {
        switch r.transcriptStatus {
        case .pending: return "Waiting to transcribe"
        case .running: return "Transcribing..."
        case .done: return "No speech found"
        case .failed, .unavailable: return "No transcript on the phone (the Mac will transcribe)"
        }
    }
}
