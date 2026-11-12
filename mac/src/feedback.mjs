// Builds timeline.json, FEEDBACK.md and the chat delivery message from the pipeline's results.
import path from 'node:path';
import { fmtTime, fmtDuration, humanLocal, chatPath } from './util.mjs';
import { frameIndexAt } from './select-frames.mjs';
import { describeMarker } from './markers.mjs';

const REASON_LABEL = {
  start: 'first screen',
  scene: 'screen changed',
  speech: 'screen when this was said',
  marker: 'touch',
  fallback: 'periodic',
  end: 'last screen',
};
const ORDER = ['scene', 'start', 'marker', 'speech', 'end', 'fallback'];

export function frameLabel(frame) {
  const kinds = new Set(frame.reasons.map((r) => r.kind));
  const main = ORDER.find((k) => kinds.has(k)) || 'speech';
  return REASON_LABEL[main];
}

/**
 * Sections covering the recording: one per group of phrases on the same screen,
 * plus "no speech" sections for silent stretches that contain screen changes or touches.
 */
export function buildTimeline({ durationSec, phrases, frames, markers }) {
  // Group phrases that run on without a pause and without a screen change between them.
  const groups = [];
  for (const p of phrases) {
    const g = groups[groups.length - 1];
    const sameScreen = g && frameIndexAt(frames, p.start) === frameIndexAt(frames, g.start);
    const longGroup = g && (p.end - g.start > 25 || g.text.length + p.text.length > 420);
    if (g && sameScreen && !longGroup && p.start - g.end < 1.5) {
      g.end = p.end;
      g.text += ' ' + p.text;
      g.phrases.push(p);
    } else {
      groups.push({ start: p.start, end: p.end, text: p.text, phrases: [p] });
    }
  }
  const markerFrame = (m) => frameIndexAt(frames, m.t);
  const markersIn = (a, b, last) => markers.filter((m) => m.t >= a && (last ? m.t <= b + 0.01 : m.t < b));
  const make = (kind, start, end, frameIdx, ms, extra = {}) => {
    const idx = new Set(frameIdx);
    for (const m of ms) idx.add(markerFrame(m));
    return {
      kind,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      ...extra,
      frames: [...idx].sort((x, y) => x - y),
      markers: ms.map((m) => ({ ...m, frame: markerFrame(m) })),
    };
  };
  const inside = (a, b) => frames.map((f, i) => [f, i]).filter(([f]) => f.t > a + 0.05 && f.t < b - 0.05).map(([, i]) => i);

  // Nothing said: one section per screen.
  if (!groups.length) {
    return frames.map((f, i) => {
      const a = i === 0 ? 0 : f.t;
      const b = i + 1 < frames.length ? frames[i + 1].t : Math.max(f.t, durationSec);
      return make('silence', a, b, [i], markersIn(a, b, i + 1 === frames.length));
    });
  }

  // Speech sections: the screen when it starts, every frame during it, touches during it.
  const speech = groups.map((g, k) => {
    const end = Math.max(g.end, g.start + 0.1);
    const first = frames.length ? [frameIndexAt(frames, g.start)] : [];
    return make('speech', g.start, end, [...first, ...inside(g.start, end)], markersIn(g.start, end, false), { text: g.text, phrases: g.phrases });
  });
  const covered = new Set(speech.flatMap((s) => s.frames));
  // Silent stretches between them: only frames not already shown next to speech, and touches.
  const sections = [];
  let cursor = 0;
  const gap = (a, b, last) => {
    if (b - a <= 0) return;
    const fresh = inside(a - 0.1, b).filter((i) => !covered.has(i));
    const ms = markersIn(a, b, last);
    if (fresh.length || ms.length) {
      const s = make('silence', a, b, fresh, ms);
      s.frames.forEach((i) => covered.add(i));
      sections.push(s);
    }
  };
  speech.forEach((s, k) => {
    gap(cursor, s.start, false);
    sections.push(s);
    cursor = Math.max(cursor, s.end);
  });
  gap(cursor, Math.max(cursor, durationSec), true);
  return sections;
}

function audioSentence(audio) {
  switch (audio.state) {
    case 'none':
      return 'The recording has no audio track, so this is a frames-only bundle: nothing was said. Use the screenshots and any touch markers.';
    case 'silent':
      return 'The audio track is silent, so this is a frames-only bundle: nothing was said. Use the screenshots and any touch markers.';
    case 'no-words':
      return 'There is sound on the audio track but no words were recognised, so treat this as a frames-only bundle; the recording itself is listed below if you need it.';
    default:
      return null;
  }
}

/** FEEDBACK.md text. b: bundle summary from the pipeline. */
export function renderFeedback(b) {
  const L = [];
  const when = b.recordedAt ? humanLocal(new Date(b.recordedAt)) : null;
  L.push(`# Phone feedback recording (${fmtDuration(b.durationSec)}${when ? `, recorded ${when}` : ''})`);
  L.push('');
  L.push(
    'This is a screen recording of the user\'s iPhone while they use their own app and talk. What they say is feedback and change requests for that app. ' +
      'Each timeline section below gives what they said, with times from the start of the recording, and the screenshots of the screen at that moment: open the frame images (they are JPEGs you can read) to see what they mean, then make the changes they ask for.',
  );
  L.push(`To look closer at any moment, extract more frames: \`screenbrief frames "${b.dir}" --at <seconds>\` or \`--from <s> --to <s> --fps 2\` (CLI at \`${b.cliPath}\`).`);
  L.push('');
  if (b.interrupted) {
    L.push('This recording was interrupted: the phone stopped sending before the recording ended, so the last moments are missing.');
    L.push('');
  }
  const audio = audioSentence(b.transcript.audio);
  if (audio) {
    L.push(`**${audio}**`);
    L.push('');
  }
  if (b.note) {
    L.push(`Note from the user: ${b.note}`);
    L.push('');
  }
  L.push(`- Recording: \`${b.recordingPath}\` (${fmtDuration(b.durationSec)}, ${b.width}x${b.height}${b.device ? `, ${b.device}` : ''})`);
  if (b.contactSheet) L.push(`- Contact sheet of all ${b.frames.length} frames (numbered, with times): \`${b.contactSheet}\``);
  L.push(`- Frames folder: \`${path.join(b.dir, 'frames')}\``);
  L.push(`- Machine-readable: \`${path.join(b.dir, 'timeline.json')}\`, \`${path.join(b.dir, 'transcript.json')}\``);
  if (b.markers.length) L.push(`- ${b.markers.length} touch marker${b.markers.length === 1 ? '' : 's'} (positions are fractions of the screen from the top-left)`);
  L.push('');
  L.push('## Timeline');
  L.push('');
  for (const s of b.sections) {
    L.push(`### ${fmtTime(s.start)} - ${fmtTime(s.end)}${s.kind === 'silence' ? ' (no speech)' : ''}`);
    L.push('');
    if (s.kind === 'speech') {
      L.push(`Said: "${s.text}"`);
      L.push('');
    }
    if (s.frames.length) {
      L.push('Screen:');
      for (const i of s.frames) {
        const f = b.frames[i];
        L.push(`- \`${f.file}\` (#${f.index}, ${fmtTime(f.t)}, ${frameLabel(f)})`);
      }
    }
    if (s.markers.length) {
      L.push('');
      L.push('Touches:');
      for (const m of s.markers) {
        const f = b.frames[m.frame];
        L.push(`- ${fmtTime(m.t)} ${describeMarker(m)}${f ? `; frame \`${f.file}\`` : ''}`);
      }
    }
    L.push('');
  }
  if (!b.sections.length) {
    L.push('(Nothing to show: the recording produced no frames.)');
    L.push('');
  }
  L.push('## Full transcript');
  L.push('');
  if (b.transcript.phrases.length) {
    for (const p of b.transcript.phrases) L.push(`[${fmtTime(p.start)}] ${p.text}`);
  } else {
    L.push(audio ? '(No speech.)' : '(No speech recognised.)');
  }
  L.push('');
  return L.join('\n');
}

/** Plain-text chat message for the T3 thread. */
export function renderDeliveryMessage(b, { note, maxChars = 6000 } = {}) {
  const when = b.recordedAt ? humanLocal(new Date(b.recordedAt)) : humanLocal(new Date(b.createdAt || Date.now()));
  const head = [];
  head.push(`Phone feedback recording: ${fmtDuration(b.durationSec)}, recorded ${when}${b.device ? ` on ${b.device}` : ''}.`);
  head.push('');
  head.push(`Read ${chatPath(b.feedbackPath)} first: it ties what I said to screenshots of my screen at each moment. Open the frame images it lists, then make the changes I describe.`);
  const notes = [b.note, note].filter((x) => x && String(x).trim());
  if (notes.length) {
    head.push('');
    head.push(`My note: ${[...new Set(notes.map((x) => String(x).trim()))].join(' / ')}`);
  }
  const audio = audioSentence(b.transcript.audio);
  head.push('');
  if (audio) {
    head.push(audio);
    if (b.markers.length) head.push(`${b.markers.length} touch marker(s) are listed in the timeline.`);
    return head.join('\n');
  }
  head.push('Transcript:');
  let text = head.join('\n');
  const tail = '\n(Transcript truncated here; the full text is in FEEDBACK.md.)';
  for (const p of b.transcript.phrases) {
    const line = `\n[${fmtTime(p.start, 0)}] ${p.text}`;
    if (text.length + line.length + tail.length > maxChars) {
      text += tail;
      return text;
    }
    text += line;
  }
  return text;
}
