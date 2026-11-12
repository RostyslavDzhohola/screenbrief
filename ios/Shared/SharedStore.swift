import Foundation

/// Cross-process signals (Darwin notifications need no entitlement) and JSON/date helpers shared
/// by the app and the broadcast extension.
enum SharedSignals {
    static let broadcastStarted = "com.rostyslav.screenbrief.broadcast.started"
    /// The extension finished (and saved, or failed to save) a recording.
    static let broadcastFinished = "com.rostyslav.screenbrief.broadcast.finished"

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString),
            nil, nil, true
        )
    }
}

enum JSONCoding {
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(ISO8601.string(from: date))
        }
        e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self), let date = ISO8601.date(from: s) { return date }
            if let n = try? c.decode(Double.self) { return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n) }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date")
        }
        return d
    }()
}

enum ISO8601 {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func string(from date: Date) -> String { withFraction.string(from: date) }
    static func date(from string: String) -> Date? {
        withFraction.date(from: string) ?? plain.date(from: string)
    }
}

/// Recording ids: `yyyyMMdd-HHmmss` in local time; short, lowercase-safe, and sorting by time.
enum RecordingID {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()

    static func make(for date: Date, timeZone: TimeZone = .current) -> String {
        formatter.timeZone = timeZone
        return formatter.string(from: date)
    }

    /// `base`, or `base-2`, `base-3`, ... if taken.
    static func unique(_ base: String, taken: Set<String>) -> String {
        guard taken.contains(base) else { return base }
        var n = 2
        while taken.contains("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }

    static func isValid(_ id: String) -> Bool {
        !id.isEmpty && id.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}
