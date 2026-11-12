import Foundation
import Photos

/// Where finished recordings go: the photo library, in an album named "ScreenBrief". The
/// extension saves there; the app finds them there (and by file name if the album step failed).
enum RecordingAlbum {
    static let title = "ScreenBrief"
    static let filePrefix = "ScreenBrief-"

    static func statusName(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .limited: return "limited"
        @unknown default: return "unknown"
        }
    }

    static func canAdd(_ status: PHAuthorizationStatus) -> Bool {
        status == .authorized || status == .limited
    }

    static func fetchAlbum() -> PHAssetCollection? {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "title == %@", title)
        return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options).firstObject
    }

    /// Creates the album if it is missing (needs read-write access; the app does this at launch).
    static func ensureAlbum() throws {
        guard fetchAlbum() == nil else { return }
        try PHPhotoLibrary.shared().performChangesAndWait {
            PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title)
        }
    }

    struct SaveResult: Equatable {
        var localIdentifier: String
        var inAlbum: Bool
        /// Why the album step was skipped, if it was.
        var albumError: String?
    }

    /// Saves the movie as a new video asset (synchronously). Tries with the album first, then
    /// without it, so a recording is never lost to an album problem.
    static func save(movie url: URL, fileName: String, creationDate: Date) throws -> SaveResult {
        var albumError: String?
        do {
            let album = fetchAlbum()
            let id = try create(url, fileName: fileName, creationDate: creationDate) { placeholder in
                if let album {
                    PHAssetCollectionChangeRequest(for: album)?.addAssets([placeholder] as NSArray)
                } else {
                    PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: title)
                        .addAssets([placeholder] as NSArray)
                }
            }
            return SaveResult(localIdentifier: id, inAlbum: true)
        } catch {
            albumError = error.localizedDescription
        }
        let id = try create(url, fileName: fileName, creationDate: creationDate, extra: { _ in })
        return SaveResult(localIdentifier: id, inAlbum: false, albumError: albumError)
    }

    private static func create(_ url: URL, fileName: String, creationDate: Date,
                               extra: @escaping (PHObjectPlaceholder) -> Void) throws -> String {
        var identifier: String?
        try PHPhotoLibrary.shared().performChangesAndWait {
            let request = PHAssetCreationRequest.forAsset()
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = fileName
            request.addResource(with: .video, fileURL: url, options: options)
            request.creationDate = creationDate
            if let placeholder = request.placeholderForCreatedAsset {
                identifier = placeholder.localIdentifier
                extra(placeholder)
            }
        }
        guard let identifier else { throw WriterError("Photos did not return the new video's identifier.") }
        return identifier
    }
}
