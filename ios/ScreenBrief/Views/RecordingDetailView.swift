import AVKit
import SwiftUI

struct RecordingDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var player: AVPlayer?
    @State private var copied = false
    @State private var confirmDelete = false

    private var recording: Recording? { model.recordings.first { $0.id == id } }

    var body: some View {
        if let r = recording {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VideoPlayer(player: player)
                        .frame(height: 420)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("player")

                    Text("\(r.id)  ·  \(Format.duration(r.durationSec))  ·  \(Format.bytes(r.sizeBytes))")
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("recording-facts")

                    if let warning = AttachmentAdvice.detail(for: r) {
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("too-large")
                    }

                    if let failure = AttachmentAdvice.partsFailure(for: r) {
                        Text(failure).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("parts-failure")
                        Button("Try splitting again") { model.retrySplit(r.id) }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("retry-split")
                    }

                    Button {
                        model.copyBrief(r)
                        withAnimation { copied = true }
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.title3.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("copy")

                    if copied {
                        Text(AttachmentAdvice.copied(for: r))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("copied")
                    }

                    transcript(r)
                }
                .padding()
            }
            .navigationTitle(Text(r.startedAt, format: .dateTime.weekday(.abbreviated).hour().minute()))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                        .accessibilityLabel("Delete")
                }
            }
            .confirmationDialog("Delete this recording from ScreenBrief?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    player?.pause()
                    model.delete(r)
                    dismiss()
                }
            } message: {
                Text("The copy in Photos stays.")
            }
            .onAppear {
                if player == nil { player = AVPlayer(url: model.files.movie(r)) }
            }
            .onDisappear { player?.pause() }
        } else {
            Text("This recording was deleted.").foregroundStyle(.secondary)
        }
    }

    private func seek(_ t: Double) {
        player?.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        player?.play()
    }

    @ViewBuilder
    private func transcript(_ r: Recording) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What you said").font(.headline)
            if r.hasNoVoice {
                Label("No voice in this recording: the microphone was off or silent. Turn Microphone on in the sharing sheet next time.",
                      systemImage: "mic.slash.fill")
                    .foregroundStyle(.orange)
            } else if let phrases = r.transcript, !phrases.isEmpty {
                ForEach(Array(phrases.enumerated()), id: \.offset) { i, p in
                    Button {
                        seek(p.t)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(Format.timestamp(p.t)).font(.footnote.monospaced()).foregroundStyle(.secondary)
                            Text(p.text).foregroundStyle(.primary).multilineTextAlignment(.leading)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("phrase-\(i)")
                }
            } else {
                Text(TranscriptStatusText.short(r)).foregroundStyle(.secondary)
                    .accessibilityIdentifier("transcript-status")
            }
            if let note = r.transcriptNote {
                Text("Transcript: \(note)").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
