# ScreenBrief

Record your iPhone screen while you talk, tap Copy, paste into a T3 Code thread. The agent fetches the
video from the phone and reads it as a timeline: what you said next to screenshots of what was on screen.

## How it works

1. **iPhone app** (`ios/`): one record button. A broadcast extension records the screen and your voice
   and saves the video on the phone (Photos, album "ScreenBrief"). The app lists recordings, plays them
   back, transcribes them on the phone, and has one **Copy** button.
2. **The copied text** holds the transcript and one instruction for the agent:
   `screenbrief pull <id>`. Paste it in T3 Code on the phone or on the Mac. It also tells the agent to
   wait for the video rather than work from the transcript alone.
3. **Mac CLI** (`mac/`): `screenbrief pull` gets the video, transcribes it with whisper.cpp, picks the
   frames that matter (each spoken phrase, each screen change, each touch mark) and writes a bundle
   with `FEEDBACK.md`. It looks in two places:
   - the iPhone, over the developer pairing the Mac already has with it (phone unlocked, same Wi-Fi
     or plugged in).
   - the videos attached in T3 Code (`~/.t3/userdata/attachments`), matched by the recording's start
     time. This is the route when you are away from the Mac: paste the text and attach the video.
4. **Touch overlay** (`overlays/`, optional): a debug-only component for the app you are testing that
   draws taps, long presses and finger trails in magenta, so they show up in the recording and on the
   timeline. iOS gives no other way to see touches in another app.

There is no pairing step and no service running on the Mac.

## Mac commands

```
screenbrief pull <id | latest>   # get a recording (phone or T3 Code attachment), process it, print FEEDBACK.md
screenbrief process <video>      # process any video file the same way
screenbrief frames <bundle> --at 12.5        # extra frames around a moment
screenbrief doctor               # checks ffmpeg, whisper and the rest
```

Bundles land in `~/ScreenBrief/recordings/`. The older `serve`, `pair` and `send` commands (a LAN
service with a Safari upload page and direct delivery to a thread) still exist but nothing uses them.

## Rebuilding the phone app

```
cd ios
/tmp/xcodegen-dl/xcodegen/bin/xcodegen generate        # after editing project.yml
xcodebuild build -project ScreenBrief.xcodeproj -scheme ScreenBrief \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/sb-dd-device
xcrun devicectl device install app --device <device id from: xcrun devicectl list devices> \
  /tmp/sb-dd-device/Build/Products/Debug-iphoneos/ScreenBrief.app
```

Signing is manual, with the profiles "ScreenBrief Dev", "ScreenBrief Broadcast Dev" and
"ScreenBrief UITests Dev". The signing certificate expires on 2026-12-13; after that the profiles must
be recreated with a new certificate.

## Tests

```
cd mac && npm test
cd ios && xcodebuild test -project ScreenBrief.xcodeproj -scheme ScreenBrief \
  -destination 'platform=iOS Simulator,name=ScreenBrief Test' -derivedDataPath /tmp/sb-dd
# On the real phone (drives the app with UI automation; the phone must be unlocked):
cd ios && xcodebuild test -project ScreenBrief.xcodeproj -scheme ScreenBriefDevice \
  -destination 'id=<iPhone UDID>' -derivedDataPath /tmp/sb-dd-device
```
