import AVFoundation
import Foundation
import Photos
import UIKit

/// The app's own copies of recordings: `Documents/Recordings/<id>.mov|mp4` plus `<id>.json`
/// (the contract with the Mac's `screenbrief pull`). Thumbnails and bookkeeping live outside
/// that folder, in Application Support.
struct RecordingFiles {
    var documents: URL
    var support: URL

    static var standard: RecordingFiles {
        let fm = FileManager.default
        return RecordingFiles(documents: fm.urls(for: .documentDirectory, in: .userDomainMask)[0],
                              support: fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
    }

    var recordings: URL { documents.appendingPathComponent("Recordings", isDirectory: true) }
    var thumbnails: URL { support.appendingPathComponent("Thumbnails", isDirectory: true) }
    var work: URL { support.appendingPathComponent("Work", isDirectory: true) }
    var dismissedFile: URL { support.appendingPathComponent("dismissed-assets.json") }

    func movie(_ r: Recording) -> URL { recordings.appendingPathComponent(r.file) }
    func sidecar(_ id: String) -> URL { recordings.appendingPathComponent("\(id).json") }
    func thumbnail(_ id: String) -> URL { thumbnails.appendingPathComponent("\(id).jpg") }

    func prepare() {
        for dir in [recordings, thumbnails, work] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    func loadAll() -> [Recording] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: recordings, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONCoding.decoder.decode(Recording.self, from: Data(contentsOf: $0)) }
            .filter { FileManager.default.fileExists(atPath: movie($0).path) }
            .sorted { $0.id > $1.id }
    }

    func save(_ r: Recording) throws {
        try JSONCoding.encoder.encode(r).write(to: sidecar(r.id), options: .atomic)
    }

    func delete(_ r: Recording) {
        try? FileManager.default.removeItem(at: movie(r))
        try? FileManager.default.removeItem(at: sidecar(r.id))
        try? FileManager.default.removeItem(at: thumbnail(r.id))
    }

    /// Deletes `<id>-mark-NN.jpg` images left by a build that had frame marking (removed).
    func removeLeftoverMarkImages() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: recordings.path)) ?? []
        for name in names where name.range(of: "-mark-[0-9]+\\.jpg$", options: .regularExpression) != nil {
            try? FileManager.default.removeItem(at: recordings.appendingPathComponent(name))
        }
    }

    func dismissed() -> Set<String> {
        (try? JSONDecoder().decode(Set<String>.self, from: Data(contentsOf: dismissedFile))) ?? []
    }

    func setDismissed(_ ids: Set<String>) {
        try? JSONEncoder().encode(ids).write(to: dismissedFile, options: .atomic)
    }
}

/// Finds recordings in the photo library: the ScreenBrief album, videos the extension saved
/// (by file name, in case the album step failed), and recent recordings from iOS's own screen
/// recorder.
enum PhotoSource {
    struct Candidate {
        var asset: PHAsset
        var source: String
        var fileName: String
    }

    static let screenRecorderWindow: TimeInterval = 3 * 24 * 3600
    static let screenRecorderLimit = 10

    static func candidates() -> [Candidate] {
        var found: [String: Candidate] = [:]
        if let album = RecordingAlbum.fetchAlbum() {
            let assets = PHAsset.fetchAssets(in: album, options: videoOptions(limit: 200))
            assets.enumerateObjects { asset, _, _ in
                found[asset.localIdentifier] = Candidate(asset: asset, source: "screenbrief", fileName: fileName(of: asset))
            }
        }
        let recent = PHAsset.fetchAssets(with: .video, options: videoOptions(limit: 60))
        var screenRecordings = 0
        recent.enumerateObjects { asset, _, _ in
            guard found[asset.localIdentifier] == nil else { return }
            let name = fileName(of: asset)
            if name.hasPrefix(RecordingAlbum.filePrefix) {
                found[asset.localIdentifier] = Candidate(asset: asset, source: "screenbrief", fileName: name)
            } else if asset.mediaSubtypes.contains(.videoScreenRecording),
                      screenRecordings < screenRecorderLimit,
                      Date().timeIntervalSince(asset.creationDate ?? .distantPast) < screenRecorderWindow {
                screenRecordings += 1
                found[asset.localIdentifier] = Candidate(asset: asset, source: "screen-recorder", fileName: name)
            }
        }
        return found.values.sorted { ($0.asset.creationDate ?? .distantPast) > ($1.asset.creationDate ?? .distantPast) }
    }

    private static func videoOptions(limit: Int) -> PHFetchOptions {
        let o = PHFetchOptions()
        o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        o.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue)
        o.fetchLimit = limit
        return o
    }

    static func fileName(of asset: PHAsset) -> String {
        let resources = PHAssetResource.assetResources(for: asset)
        return (resources.first { $0.type == .video } ?? resources.first)?.originalFilename ?? ""
    }

    /// Writes the asset's original video file to `url`.
    static func export(_ asset: PHAsset, to url: URL) async throws {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .video }) ?? resources.first(where: { $0.type == .fullSizeVideo }) else {
            throw Transcriber.Failure(message: "The video has no file in Photos.")
        }
        try? FileManager.default.removeItem(at: url)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options)
    }
}

enum Thumbnailer {
    static func make(movie: URL, to url: URL) async {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: movie))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 240, height: 240)
        guard let (image, _) = try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)),
              let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.7) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
