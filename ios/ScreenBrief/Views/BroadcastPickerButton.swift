import ReplayKit
import SwiftUI
import UIKit

/// The system broadcast picker (ScreenBrief's extension preselected, microphone button shown),
/// drawn as a full-width red "Start recording" button. The picker's own button stays on top,
/// invisible, so a tap anywhere on the control opens the system sheet.
struct BroadcastPickerButton: UIViewRepresentable {
    static let extensionBundleID = "com.rostyslav.screenbrief.broadcast"
    var title = "Start recording"
    var isRecording = false

    func makeUIView(context: Context) -> PickerHost { PickerHost(title: title) }
    func updateUIView(_ view: PickerHost, context: Context) {
        view.setTitle(title)
        view.setRecording(isRecording)
    }

    final class PickerHost: UIView {
        private let picker = RPSystemBroadcastPickerView()
        private let label = UILabel()
        private let icon = UIImageView(image: UIImage(systemName: "record.circle"))

        init(title: String) {
            super.init(frame: .zero)
            backgroundColor = .systemRed
            layer.cornerRadius = 18
            layer.cornerCurve = .continuous
            clipsToBounds = true

            icon.tintColor = .white
            icon.preferredSymbolConfiguration = .init(pointSize: 26, weight: .semibold)
            label.font = .systemFont(ofSize: 22, weight: .bold)
            label.textColor = .white
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.6
            let stack = UIStackView(arrangedSubviews: [icon, label])
            stack.axis = .horizontal
            stack.spacing = 10
            stack.alignment = .center
            stack.isUserInteractionEnabled = false
            stack.translatesAutoresizingMaskIntoConstraints = false
            addSubview(stack)

            picker.preferredExtension = BroadcastPickerButton.extensionBundleID
            picker.showsMicrophoneButton = true
            picker.translatesAutoresizingMaskIntoConstraints = false
            addSubview(picker)
            NSLayoutConstraint.activate([
                stack.centerXAnchor.constraint(equalTo: centerXAnchor),
                stack.centerYAnchor.constraint(equalTo: centerYAnchor),
                stack.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -24),
                picker.leadingAnchor.constraint(equalTo: leadingAnchor),
                picker.trailingAnchor.constraint(equalTo: trailingAnchor),
                picker.topAnchor.constraint(equalTo: topAnchor),
                picker.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
            setTitle(title)
        }

        required init?(coder: NSCoder) { fatalError() }

        func setRecording(_ recording: Bool) {
            backgroundColor = recording ? .label : .systemRed
            label.textColor = recording ? .systemBackground : .white
            icon.tintColor = recording ? .systemRed : .white
            icon.image = UIImage(systemName: recording ? "stop.circle.fill" : "record.circle")
        }

        func setTitle(_ title: String) {
            label.text = title
            accessibilityLabel = title
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            // The picker's internal button: full size, its own glyph hidden, labelled for VoiceOver/tests.
            for case let button as UIButton in picker.subviews {
                button.frame = picker.bounds
                button.setImage(UIImage(), for: .normal)
                button.setImage(UIImage(), for: .highlighted)
                button.imageView?.alpha = 0
                button.accessibilityLabel = label.text
            }
        }
    }
}
