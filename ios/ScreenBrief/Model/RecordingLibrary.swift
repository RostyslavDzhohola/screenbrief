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
    /// Where the parts of a too-large recording are written before they go to Photos. In the
    /// caches, not in `recordings`: the Mac lists that folder and would take them for recordings.
    var parts: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Parts", isDirectory: true)

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

    /// The extension a movie carries while it is being copied out of Photos. The Mac lists
    /// `recordings` and takes any file ending .mov/.mp4/.m4v, so a copy in progress must not
    /// end in one of those (or in .json).
    static let partialExtension = "part"

    /// Has `write` fill `<name>.part` next to `url`, then moves it into place. `url` only ever
    /// holds a complete file, and nothing is left behind when `write` throws.
    static func writeThenMove(to url: URL, _ write: (URL) async throws -> Void) async throws {
        let partial = url.appendingPathExtension(partialExtension)
        try? FileManager.default.removeItem(at: partial)
        do {
            try await write(partial)
            if FileManager.default.fileExists(atPath: url.path) {
                // Swaps the files in one step: if it fails, the movie that was there is still there.
                _ = try FileManager.default.replaceItemAt(url, withItemAt: partial)
            } else {
                try FileManager.default.moveItem(at: partial, to: url)
            }
        } catch {
            try? FileManager.default.removeItem(at: partial)
            throw error
        }
    }

    /// Deletes `*.part` files: copies out of Photos that an earlier launch did not finish.
    func removeStalePartials() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: recordings.path)) ?? []
        for name in names where (name as NSString).pathExtension == Self.partialExtension {
            try? FileManager.default.removeItem(at: recordings.appendingPathComponent(name))
        }
    }

    /// Deletes part files that an earlier launch wrote and did not get to Photos.
    func removeLeftoverParts() {
        try? FileManager.default.removeItem(at: parts)
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
            for (asset, name) in newest(PHAsset.fetchAssets(in: album, options: videoOptions()), limit: 200) {
                found[asset.localIdentifier] = Candidate(asset: asset, source: "screenbrief", fileName: name)
            }
        }
        var screenRecordings = 0
        for (asset, name) in newest(PHAsset.fetchAssets(with: .video, options: videoOptions()), limit: 60)
        where found[asset.localIdentifier] == nil {
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

    /// The newest `limit` videos that are not parts of a split recording, with their file names.
    /// The count is kept here and not as a fetch limit, which the parts would use up: a few long
    /// recordings would then hide every older one. At most ten times `limit` videos are looked at.
    private static func newest(_ videos: PHFetchResult<PHAsset>, limit: Int) -> [(PHAsset, String)] {
        var taken: [(PHAsset, String)] = []
        var looked = 0
        videos.enumerateObjects { asset, _, stop in
            looked += 1
            let name = fileName(of: asset)
            if !RecordingAlbum.isPart(fileName: name) { taken.append((asset, name)) }
            if taken.count >= limit || looked >= limit * 10 { stop.pointee = true }
        }
        return taken
    }

    private static func videoOptions() -> PHFetchOptions {
        let o = PHFetchOptions()
        o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        o.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue)
        return o
    }

    static func fileName(of asset: PHAsset) -> String {
        let resources = PHAssetResource.assetResources(for: asset)
        return (resources.first { $0.type == .video } ?? resources.first)?.originalFilename ?? ""
    }

    /// Writes the asset's original video file to `url` (under a temporary name until it is complete).
    static func export(_ asset: PHAsset, to url: URL) async throws {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .video }) ?? resources.first(where: { $0.type == .fullSizeVideo }) else {
            throw Transcriber.Failure(message: "The video has no file in Photos.")
        }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await RecordingFiles.writeThenMove(to: url) { partial in
            try await PHAssetResourceManager.default().writeData(for: resource, toFile: partial, options: options)
        }
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
