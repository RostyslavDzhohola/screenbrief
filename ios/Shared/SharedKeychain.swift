import Foundation
import Security
import UIKit

/// Generic-password items in the Keychain access group both targets are entitled to
/// (`$(AppIdentifierPrefix)com.rostyslav.screenbrief.shared`). There is no App Group, so this is
/// the only state the extension and the app share, and nothing essential depends on it: it
/// carries the extension's diagnostics so a broadcast that died leaves a trace in the app.
struct SharedKeychain {
    static let groupSuffix = "com.rostyslav.screenbrief.shared"
    static let diagnosticsAccount = "broadcast-diagnostics"

    /// `<TeamID>.com.rostyslav.screenbrief.shared`, from the `AppIdentifierPrefix` Info.plist key.
    static var defaultAccessGroup: String? {
        guard let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
              !prefix.isEmpty, !prefix.contains("$(") else { return nil }
        return prefix + groupSuffix
    }

    var service: String = "com.rostyslav.screenbrief.shared"
    var accessGroup: String? = SharedKeychain.defaultAccessGroup

    struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
            return "Keychain error \(status): \(text)"
        }
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    func read(_ account: String) throws -> Data? {
        var q = baseQuery(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    func write(_ data: Data, _ account: String) throws {
        let update: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(baseQuery(account) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery(account)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete(_ account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    func readJSON<T: Decodable>(_ type: T.Type, _ account: String) throws -> T? {
        guard let data = try read(account) else { return nil }
        return try JSONCoding.decoder.decode(T.self, from: data)
    }

    func writeJSON<T: Encodable>(_ value: T, _ account: String) throws {
        try write(JSONCoding.encoder.encode(value), account)
    }
}

/// What the extension last did, written at start, every few seconds while recording, and at the
/// end. The app shows it in a debug line.
struct BroadcastDiagnostics: Codable, Equatable {
    var recordingId: String
    var startedAt: Date
    var updatedAt: Date
    /// started, recording, finishing, saved, failed
    var phase: String
    var photosAddOnly: String?
    var photosReadWrite: String?
    var videoFrames: Int = 0
    var keepaliveFrames: Int = 0
    /// Optional so an item written by an older build still decodes.
    var videoFramesDropped: Int?
    var frameCopiesFailed: Int?
    var audioBuffers: Int = 0
    var silenceBuffers: Int = 0
    var hasMicAudio: Bool = false
    var peakAudioLevel: Double = 0
    var durationSec: Double = 0
    var fileBytes: Int64 = 0
    var memoryMB: Double = 0
    var peakMemoryMB: Double = 0
    var savedAssetId: String?
    var inAlbum: Bool?
    var error: String?
    /// Short timestamped notes, newest last (capped).
    var events: [String] = []

    mutating func note(_ text: String, at date: Date = Date()) {
        let t = String(format: "%.1f", date.timeIntervalSince(startedAt))
        events.append("+\(t)s \(text)")
        if events.count > 16 { events.removeFirst(events.count - 16) }
    }

    static func load(from keychain: SharedKeychain = SharedKeychain()) -> BroadcastDiagnostics? {
        try? keychain.readJSON(BroadcastDiagnostics.self, SharedKeychain.diagnosticsAccount)
    }

    func save(to keychain: SharedKeychain = SharedKeychain()) throws {
        try keychain.writeJSON(self, SharedKeychain.diagnosticsAccount)
    }

    /// The extension is recording right now (it refreshes this item every 2 s while it does).
    func isRecording(now: Date = Date(), timeout: TimeInterval = 8) -> Bool {
        (phase == "started" || phase == "recording") && now.timeIntervalSince(updatedAt) < timeout
    }

    /// One line for the app's debug area.
    var summaryLine: String {
        var parts = ["\(phase) \(recordingId)", String(format: "%.0fs", durationSec),
                     "frames \(videoFrames)", "audio \(audioBuffers)\(hasMicAudio ? "" : " (no mic)")",
                     String(format: "peak mem %.0f MB", peakMemoryMB)]
        parts.append("keepalive \(keepaliveFrames) dropped \(videoFramesDropped ?? 0) copy-fail \(frameCopiesFailed ?? 0) silence \(silenceBuffers)")
        if fileBytes > 0 { parts.append(String(format: "%.1f MB", Double(fileBytes) / 1_000_000)) }
        if let photosAddOnly { parts.append("photos add:\(photosAddOnly) rw:\(photosReadWrite ?? "?")") }
        if let savedAssetId { parts.append("saved \(savedAssetId.prefix(8))\(inAlbum == true ? " in album" : "")") }
        if let error { parts.append("error: \(error)") }
        return parts.joined(separator: " | ")
    }
}

struct DeviceDescription: Codable, Equatable, Hashable {
    var name: String
    var model: String
    var os: String
}

enum DeviceInfo {
    static var current: DeviceDescription {
        DeviceDescription(name: UIDevice.current.name, model: modelIdentifier, os: "iOS \(UIDevice.current.systemVersion)")
    }

    static var modelIdentifier: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
}

enum MemoryProbe {
    /// Physical footprint of this process in MB (what jetsam counts).
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : 0
    }
}
