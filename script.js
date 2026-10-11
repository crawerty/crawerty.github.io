import WebMscore from "https://cdn.jsdelivr.net/npm/webmscore/webmscore.mjs";
import { Midi } from "https://esm.sh/@tonejs/midi";
import { Frequency } from "https://esm.sh/tone";
import { PitchDetector } from 'https://esm.sh/pitchy';
const recordBtn = document.getElementById("record");
const stopBtn = document.getElementById("stop");
const player = document.getElementById("player");
const startMetronome = document.getElementById("startMetronome");
const stopMetronome = document.getElementById("stopMetronome");
const playPracticeTrackBtn = document.getElementById("playPracticeTrack");
const stopPracticeTrackBtn = document.getElementById("stopPracticeTrack");
const analyzeOutput = document.getElementById("analyze");
const bpmInput = document.getElementById("bpm");
const metronomeVolumeInput = document.getElementById("metronomeVolume");
const metronomeVolumeValue = document.getElementById("metronomeVolumeValue");
const countInBeatsInput = document.getElementById("countInBeats");
const loopStartMeasureInput = document.getElementById("loopStartMeasure");
const loopEndMeasureInput = document.getElementById("loopEndMeasure");
const setLoopBtn = document.getElementById("setLoop");
const clearLoopBtn = document.getElementById("clearLoop");
const loopStatus = document.getElementById("loopStatus");
const WTrackBtn = document.getElementById("WTrack");
const WOTrackBtn = document.getElementById("WOTrack");
let recorder;
let audioChunks = [];
recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
let ctx = new AudioContext();
let metInterval;
let nextMetronomeClickTime = 0;
let nextMetronomeBeat = 0;
let metronomeRange = null;
let mechanicalTickBuffer = null;
const metronomeLookAheadMs = 25;
const metronomeScheduleAheadSeconds = 0.1;
recordBtn.disabled = false;
stopBtn.disabled = true;
startMetronome.addEventListener("click", startMet);
stopMetronome.addEventListener("click", stopMet);
stopMetronome.disabled = true;
playPracticeTrackBtn.addEventListener("click", startPracticeTrack);
stopPracticeTrackBtn.addEventListener("click", stopPracticeTrack);
setLoopBtn?.addEventListener("click", setPracticeLoop);
clearLoopBtn?.addEventListener("click", clearPracticeLoop);
WTrackBtn?.addEventListener("click", () => setRecordingMode(true));
WOTrackBtn?.addEventListener("click", () => setRecordingMode(false));
metronomeVolumeInput?.addEventListener("input", updateMetronomeVolumeLabel);
let midiBpm = null;
let recordingBpm = null;
let activeLoopRange = null;
let recordingLoopRange = null;
let midiNotesData = null;
let midiTimeSignatures = [{ startBeat: 0, numerator: 4, denominator: 4 }];
let midiClef = "treble";
let currentScoreInstance = null;
let scoreSegmentPositions = null;
let scoreNoteAnchors = [];
let practiceOscillators = [];
let practiceTrackStopTimer = null;
let practiceTrackLoopId = 0;
let recordWithTrack = true;
let scoreGuideFrame = null;
let scoreGuideStartTime = 0;
let scoreGuideBpm = 120;
let scoreGuideRange = null;
let scoreGuideLoop = false;

// CC0 recording: go1dfish, “Metronome De Maezel” (ccMixter), trimmed to one tick at runtime.
fetch("assets/mechanical-metronome.mp3")
  .then((response) => {
    if (!response.ok) throw new Error("Mechanical metronome sample could not be loaded.");
    return response.arrayBuffer();
  })
  .then((audioData) => ctx.decodeAudioData(audioData))
  .then((recording) => {
    const channel = recording.getChannelData(0);
    let peakIndex = 0;
    for (let index = 1; index < channel.length; index += 1) {
      if (Math.abs(channel[index]) > Math.abs(channel[peakIndex])) peakIndex = index;
    }
    const start = Math.max(0, peakIndex - Math.floor(recording.sampleRate * 0.012));
    const length = Math.min(Math.floor(recording.sampleRate * 0.18), recording.length - start);
    mechanicalTickBuffer = ctx.createBuffer(recording.numberOfChannels, length, recording.sampleRate);
    for (let channelIndex = 0; channelIndex < recording.numberOfChannels; channelIndex += 1) {
      mechanicalTickBuffer.copyToChannel(recording.getChannelData(channelIndex).slice(start, start + length), channelIndex);
    }
  })
  .catch((error) => console.warn("Using the built-in metronome fallback:", error));

async function renderMuseScore(midiData) {
  const container = document.getElementById("sheet-music-container");
  container.replaceChildren();

  const loadingMessage = document.createElement("p");
  loadingMessage.textContent = "MuseScore is quantizing rhythms…";
  container.appendChild(loadingMessage);

  try {
    await WebMscore.ready;

    if (currentScoreInstance) {
      currentScoreInstance.destroy();
      currentScoreInstance = null;
    }

    currentScoreInstance = await WebMscore.load("midi", midiData);
    try {
      scoreSegmentPositions = await currentScoreInstance.segmentPositions();
    } catch (positionError) {
      console.warn("Could not load score positions for visual feedback:", positionError);
      scoreSegmentPositions = null;
    }
    const pageCount = await currentScoreInstance.npages();
    const svgPages = await Promise.all(
      Array.from({ length: pageCount }, (_, pageNumber) =>
        currentScoreInstance.saveSvg(pageNumber)
      )
    );

    container.replaceChildren();
    svgPages.forEach((svgString) => {
      const page = document.createElement("div");
      page.className = "musescore-page";
      page.innerHTML = svgString;
      container.appendChild(page);
    });
    scoreNoteAnchors = getScoreNoteAnchors();
  } catch (error) {
    console.error("MuseScore conversion failed:", error);
    container.innerHTML = "<p class=\"sheet-music-error\">Could not convert this MIDI file into sheet music.</p>";
  }
}

function getMeasureQuarterBeats(timeSignature) {
  return timeSignature.numerator * (4 / timeSignature.denominator);
}

function formatTimeSignature(timeSignature) {
  return `${timeSignature.numerator}/${timeSignature.denominator}`;
}

function getInternalVoiceSignature(timeSignature) {
  const supportedBeatValues = [16, 8, 4, 2, 1];

  for (const beatValue of supportedBeatValues) {
    const numBeats = timeSignature.numerator * (beatValue / timeSignature.denominator);
    if (Number.isInteger(numBeats) && numBeats > 0) {
      return { numBeats, beatValue };
    }
  }

  return {
    numBeats: getMeasureQuarterBeats(timeSignature) * 16,
    beatValue: 16
  };
}

function getTimeSignatureAtBeat(beatFromStart, timeSignatures = midiTimeSignatures) {
  let current = timeSignatures[0];

  for (const signature of timeSignatures) {
    if (signature.startBeat <= beatFromStart) {
      current = signature;
    } else {
      break;
    }
  }

  return current;
}

function chooseClef(notes) {
  const pitchedNotes = notes.filter(note => note.note !== "rest" && typeof note.midi === "number");
  if (pitchedNotes.length === 0) return "treble";

  const averageMidi = pitchedNotes.reduce((sum, note) => sum + note.midi, 0) / pitchedNotes.length;
  return averageMidi < 60 ? "bass" : "treble";
}

function parseNoteName(noteName) {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(noteName);
  if (!match) {
    return { key: "b/4", accidental: null };
  }

  return {
    key: `${match[1].toLowerCase()}/${match[3]}`,
    accidental: match[2] || null
  };
}

function getScorePositionFromBeat(beatFromStart, timeSignatures = midiTimeSignatures) {
  let measureNumber = 1;

  for (let i = 0; i < timeSignatures.length; i++) {
    const currentSignature = timeSignatures[i];
    const nextSignature = timeSignatures[i + 1];
    const blockStartBeat = currentSignature.startBeat;
    const blockEndBeat = nextSignature ? nextSignature.startBeat : Infinity;
    const measureQuarterBeats = getMeasureQuarterBeats(currentSignature);

    if (beatFromStart >= blockEndBeat) {
      measureNumber += Math.floor((blockEndBeat - blockStartBeat) / measureQuarterBeats);
      continue;
    }

    const beatsIntoBlock = Math.max(0, beatFromStart - blockStartBeat);
    const measuresIntoBlock = Math.floor(beatsIntoBlock / measureQuarterBeats);
    // MIDI timing is measured in quarter notes, but singers read a beat using
    // the denominator printed in the time signature. For example, 3/2 has
    // three half-note beats rather than six quarter-note beats.
    const quarterNotesPerWrittenBeat = 4 / currentSignature.denominator;
    const beatInMeasure = ((beatsIntoBlock % measureQuarterBeats) / quarterNotesPerWrittenBeat) + 1;
    const absoluteMeasureNumber = measureNumber + measuresIntoBlock;
    return {
      measureNumber: absoluteMeasureNumber,
      beat: beatInMeasure,
      lineNumber: Math.ceil(absoluteMeasureNumber / 4),
      measureOnLine: ((absoluteMeasureNumber - 1) % 4) + 1,
      timeSignature: currentSignature
    };
  }

  const fallbackMeasureNumber = Math.max(1, measureNumber);
  return {
    measureNumber: fallbackMeasureNumber,
    beat: 1,
    lineNumber: Math.ceil(fallbackMeasureNumber / 4),
    measureOnLine: ((fallbackMeasureNumber - 1) % 4) + 1,
    timeSignature: timeSignatures[timeSignatures.length - 1]
  };
}

function getScorePosition(time, bpm, timeSignatures = midiTimeSignatures) {
  const quarter = 60 / bpm;
  return getScorePositionFromBeat(time / quarter, timeSignatures);
}

async function getTotalBeats() {
  const notes = await convertAllNotes();
  let totalBeats = 0;

  for (let i = 0; i < notes.length; i++) {
    totalBeats += notes[i].durationBeats;
  }

  return totalBeats;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function getMonoSlice(audioBuffer, startSample, length) {
    const slice = new Float32Array(length);
    const channelCount = audioBuffer.numberOfChannels;

    for (let channel = 0; channel < channelCount; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            slice[i] += channelData[startSample + i] / channelCount;
        }
    }

    // Remove DC offset and fade the edges so pitch detection is not biased by
    // microphone pops or a note transition at either edge of the sample.
    const average = slice.reduce((sum, sample) => sum + sample, 0) / slice.length;
    for (let i = 0; i < slice.length; i++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (slice.length - 1));
        slice[i] = (slice[i] - average) * window;
    }

    return slice;
}

function getCentsDifference(frequency, referenceFrequency) {
    return 1200 * Math.log2(frequency / referenceFrequency);
}

function detectNote(audioBuffer, timeInSeconds, duration, expectedFrequency) {
    const sampleRate = audioBuffer.sampleRate;
    const timingOffset = Math.min(0.12, duration * 0.18);
    const timingOffsets = [-timingOffset, -timingOffset / 2, 0, timingOffset / 2, timingOffset];
    const candidates = [];

    for (const offset of timingOffsets) {
        const noteStart = timeInSeconds + offset + Math.min(0.08, duration * 0.18);
        const noteEnd = timeInSeconds + offset + duration - Math.min(0.035, duration * 0.1);
        const availableSamples = Math.floor((noteEnd - noteStart) * sampleRate);
        const preferredWindowSize = Math.min(8192, Math.max(2048, Math.floor(duration * sampleRate * 0.42)));
        const windowSize = Math.min(preferredWindowSize, availableSamples);

        if (windowSize < 1024) continue;

        const firstSample = Math.max(0, Math.floor(noteStart * sampleRate));
        const lastStartSample = Math.min(
            audioBuffer.length - windowSize,
            Math.floor(noteEnd * sampleRate) - windowSize
        );
        if (lastStartSample < firstSample) continue;

        const sampleStarts = [firstSample, Math.round((firstSample + lastStartSample) / 2), lastStartSample];
        const detectedFrequencies = [];

        for (const startSample of new Set(sampleStarts)) {
            const slice = getMonoSlice(audioBuffer, startSample, windowSize);
            const rms = Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
            if (rms < 0.0008) continue;

            const detector = PitchDetector.forFloat32Array(slice.length);
            const [frequency, clarity] = detector.findPitch(slice, sampleRate);

            // The metronome is intentionally filtered out of the performance result.
            if (frequency && Math.abs(frequency - 375) < 30) continue;
            if (frequency && clarity >= 0.35) detectedFrequencies.push(frequency);
        }

        if (detectedFrequencies.length) {
            candidates.push({ frequency: median(detectedFrequencies), offset });
        }
    }

    // Prefer readings close to the expected note, but retain a lower-confidence
    // fallback so a normal microphone recording is never treated as silence.
    const plausibleCandidates = candidates.filter(({ frequency }) =>
        Math.abs(getCentsDifference(frequency, expectedFrequency)) <= 700
    );
    const candidatePool = plausibleCandidates.length ? plausibleCandidates : candidates;
    if (!candidatePool.length) return null;

    return candidatePool.reduce((best, candidate) => {
        const candidateScore = Math.abs(getCentsDifference(candidate.frequency, expectedFrequency)) + Math.abs(candidate.offset) * 100;
        const bestScore = Math.abs(getCentsDifference(best.frequency, expectedFrequency)) + Math.abs(best.offset) * 100;
        return candidateScore < bestScore ? candidate : best;
    }).frequency;
}

function detectPitchWindow(audioBuffer, timeInSeconds, duration) {
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = Math.min(4096, Math.floor(duration * sampleRate * 0.45));
    const startSample = Math.max(0, Math.floor((timeInSeconds + Math.min(0.08, duration * 0.22)) * sampleRate));

    if (windowSize < 1024 || startSample + windowSize > audioBuffer.length) return null;

    const slice = getMonoSlice(audioBuffer, startSample, windowSize);
    const rms = Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
    if (rms < 0.0008) return null;

    const detector = PitchDetector.forFloat32Array(slice.length);
    const [frequency, clarity] = detector.findPitch(slice, sampleRate);
    return frequency && clarity >= 0.3 && Math.abs(frequency - 375) >= 30 ? frequency : null;
}

function estimateRecordingOffset(audioBuffer, notes, analysisBpm) {
    const secondsPerBeat = 60 / analysisBpm;
    const offsets = Array.from({ length: 17 }, (_, index) => (index - 8) * 0.15);
    const sampleNotes = notes.filter((note) => note.note !== "rest").slice(0, 16);
    let best = { offset: 0, score: 0 };

    for (const offset of offsets) {
        let score = 0;
        for (const note of sampleNotes) {
            const startBeat = Number.isFinite(note.startBeat) ? note.startBeat : note.time / (60 / analysisBpm);
            const durationBeats = Number.isFinite(note.durationBeats)
                ? note.durationBeats
                : note.duration / (60 / analysisBpm);
            const time = startBeat * secondsPerBeat + offset;
            const frequency = detectPitchWindow(audioBuffer, time, durationBeats * secondsPerBeat);
            if (!frequency) continue;

            const cents = Math.abs(getCentsDifference(frequency, Frequency(note.note).toFrequency()));
            if (cents < 350) score += 1 - cents / 350;
        }
        if (score > best.score) best = { offset, score };
    }

    return best.score >= 1.5 ? best.offset : 0;
}

function buildExpectedNoteEvents(analysisBpm, range = recordingLoopRange) {
    const secondsPerBeat = 60 / analysisBpm;

    return getNotesInRange(range, analysisBpm).flatMap((midiNote) => {
        const noteName = Array.isArray(midiNote.note) ? midiNote.note[midiNote.note.length - 1] : midiNote.note;
        if (!noteName || noteName === "rest") return [];

        const startBeat = midiNote.startBeat;
        const durationBeats = midiNote.durationBeats;
        const time = (startBeat - (range?.startBeat ?? 0)) * secondsPerBeat;

        return [{
            noteIndex: midiNote.noteIndex,
            noteName,
            expectedFrequency: Frequency(noteName).toFrequency(),
            time,
            duration: durationBeats * secondsPerBeat,
            scoreTime: startBeat * (60 / (midiBpm ?? analysisBpm)),
            position: getScorePositionFromBeat(startBeat, midiTimeSignatures)
        }];
    });
}

function buildPitchTrack(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = 4096;
    const hopSize = 2048;
    const detector = PitchDetector.forFloat32Array(windowSize);
    const track = [];

    for (let startSample = 0; startSample + windowSize <= audioBuffer.length; startSample += hopSize) {
        const slice = getMonoSlice(audioBuffer, startSample, windowSize);
        const rms = Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
        if (rms < 0.0008) continue;

        const [frequency, clarity] = detector.findPitch(slice, sampleRate);
        if (!frequency || clarity < 0.35 || frequency < 60 || frequency > 1200) continue;
        if (Math.abs(frequency - 375) < 30) continue;

        track.push({ time: (startSample + windowSize / 2) / sampleRate, frequency, clarity });
    }

    return track;
}

function framesForNote(track, note, offset) {
    const start = note.time + offset + Math.min(0.06, note.duration * 0.2);
    const end = note.time + offset + note.duration - Math.min(0.04, note.duration * 0.12);
    return track.filter((frame) => frame.time >= start && frame.time <= end);
}

function estimateTrackOffset(track, expectedNotes) {
    const alignmentNotes = expectedNotes.filter((note) => note.time < 24).slice(0, 32);
    const offsets = Array.from({ length: 61 }, (_, index) => (index - 30) * 0.05);
    let best = { offset: 0, score: 0 };

    for (const offset of offsets) {
        let score = 0;
        for (const note of alignmentNotes) {
            const closestCents = framesForNote(track, note, offset).reduce((closest, frame) =>
                Math.min(closest, Math.abs(getCentsDifference(frame.frequency, note.expectedFrequency))),
                Infinity
            );
            if (closestCents < 300) score += 1 - closestCents / 300;
        }
        if (score > best.score) best = { offset, score };
    }

    return best.score >= 2 ? best.offset : 0;
}

function getScoreSegmentAtTime(timeInSeconds) {
    if (!scoreSegmentPositions?.events?.length || !scoreSegmentPositions?.elements?.length) {
        return null;
    }

    const targetPosition = timeInSeconds * 1000;
    const nearestEvent = scoreSegmentPositions.events.reduce((nearest, event) =>
        Math.abs(event.position - targetPosition) < Math.abs(nearest.position - targetPosition)
            ? event
            : nearest
    );

    return scoreSegmentPositions.elements.find((element) => element.id === nearestEvent.elid) ?? null;
}

function getScoreNoteAnchors() {
    const pages = document.querySelectorAll("#sheet-music-container svg");
    const anchors = [];

    pages.forEach((page, pageIndex) => {
        const noteheads = [...page.querySelectorAll(".Note")].map((notehead) => {
            const transform = notehead.getAttribute("transform") ?? "";
            const values = transform.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
            return { page: pageIndex, x: values.at(-2), y: values.at(-1), sx: 36, sy: 27 };
        }).filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y));

        // SVG output has no stable note IDs. Group noteheads into horizontal staff
        // systems, then read each system left-to-right as a reliable fallback.
        const systems = [];
        for (const anchor of noteheads.sort((a, b) => a.y - b.y)) {
            const system = systems.find((candidate) => Math.abs(candidate.centerY - anchor.y) < 170);
            if (system) {
                system.anchors.push(anchor);
                system.centerY = (system.centerY * (system.anchors.length - 1) + anchor.y) / system.anchors.length;
            } else {
                systems.push({ centerY: anchor.y, anchors: [anchor] });
            }
        }

        systems
            .sort((a, b) => a.centerY - b.centerY)
            .forEach((system) => anchors.push(...system.anchors.sort((a, b) => a.x - b.x)));
    });

    return anchors;
}

function clearScoreFeedback() {
    document.querySelectorAll(".score-feedback, .score-feedback-legend").forEach((element) => element.remove());
}

function renderScoreFeedback(feedback) {
    clearScoreFeedback();

    const container = document.getElementById("sheet-music-container");
    const pages = container.querySelectorAll("svg");
    const markedFeedback = [];

    for (const item of feedback) {
        const segment = getScoreSegmentAtTime(item.scoreTime) ?? scoreNoteAnchors[item.noteIndex];
        const page = segment ? pages[segment.page] : null;
        if (!page) continue;

        const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
        marker.classList.add("score-feedback", `score-feedback--${item.type}`);
        marker.setAttribute("tabindex", "0");
        marker.setAttribute("role", "img");
        marker.setAttribute("aria-label", item.message);

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", String(segment.x + segment.sx / 2));
        circle.setAttribute("cy", String(Math.max(36, segment.y - 38)));
        circle.setAttribute("r", "26");
        const markerColor = item.type === "flat" ? "#c9473b" : item.type === "sharp" ? "#d07b18" : "#6b7280";
        circle.setAttribute("style", `fill: ${markerColor} !important; stroke: #ffffff !important; stroke-width: 4px;`);

        const symbol = document.createElementNS("http://www.w3.org/2000/svg", "text");
        symbol.setAttribute("x", String(segment.x + segment.sx / 2));
        symbol.setAttribute("y", String(Math.max(45, segment.y - 28)));
        symbol.setAttribute("text-anchor", "middle");
        symbol.setAttribute("style", "fill: #ffffff !important; font-family: Arial, sans-serif; font-size: 34px; font-weight: 800;");
        symbol.textContent = item.type === "missing" ? "?" : item.type === "sharp" ? "↑" : "↓";

        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = item.message;
        marker.append(circle, symbol, title);
        page.appendChild(marker);
        markedFeedback.push(item);
    }

    if (!markedFeedback.length) return;

    const legend = document.createElement("div");
    legend.className = "score-feedback-legend";
    legend.innerHTML = `
        <span><i class="score-feedback-key score-feedback-key--flat">↓</i> Flat</span>
        <span><i class="score-feedback-key score-feedback-key--sharp">↑</i> Sharp</span>
        <span><i class="score-feedback-key score-feedback-key--missing">?</i> No pitch</span>
    `;
    container.before(legend);
}

async function compareNotes() {
    const res = await fetch(player.src);
    const arrayBuffer = await res.arrayBuffer();
    let recordingBuffer;

    try {
        recordingBuffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (error) {
        document.getElementById("output").innerText =
            "The recording could not be decoded. Please try recording again.\n";
        console.error("Audio decode failed:", error);
        return;
    }

    document.getElementById("output").innerText = "";
    const feedback = [];
    const analysisBpm = recordingBpm ?? getCurrentBpm();
    const expectedNotes = buildExpectedNoteEvents(analysisBpm);
    const pitchTrack = buildPitchTrack(recordingBuffer);

    if (!pitchTrack.length) {
        document.getElementById("output").innerText = "No reliable sung pitch was found. Use headphones and record a clear, single voice.\n";
        return;
    }

    const recordingOffset = estimateTrackOffset(pitchTrack, expectedNotes);
    if (recordingOffset !== 0) {
        document.getElementById("output").innerText += `Aligned recording by ${recordingOffset > 0 ? "+" : ""}${recordingOffset.toFixed(2)} seconds.\n`;
    }

    let inTuneCount = 0;
    let unmatchedCount = 0;
    let recordingEnded = false;

    for (const note of expectedNotes) {
        if (note.time + recordingOffset >= recordingBuffer.duration - 0.03) {
            document.getElementById("output").innerText += `Recording ended after Measure ${note.position.measureNumber}, Beat ${note.position.beat.toFixed(1)}.\n`;
            recordingEnded = true;
            break;
        }

        const plausibleFrames = framesForNote(pitchTrack, note, recordingOffset).filter((frame) =>
            Math.abs(getCentsDifference(frame.frequency, note.expectedFrequency)) <= 700
        );

        if (plausibleFrames.length < 2) {
            unmatchedCount++;
            continue;
        }

        const detectedFrequency = median(plausibleFrames.map((frame) => frame.frequency));
        const centsOff = getCentsDifference(detectedFrequency, note.expectedFrequency);

        if (Math.abs(centsOff) <= 50) {
            inTuneCount++;
            continue;
        }

        const direction = centsOff > 0 ? "sharp" : "flat";
        const message = `Measure ${note.position.measureNumber}, Beat ${note.position.beat.toFixed(1)}: ${Math.abs(centsOff).toFixed(0)} cents too ${direction} (Expected: ${note.noteName})`;
        document.getElementById("output").innerText += `${message}\n`;
        feedback.push({ type: direction, message, noteIndex: note.noteIndex, scoreTime: note.scoreTime });
    }

    renderScoreFeedback(feedback);
    const reviewedCount = inTuneCount + feedback.length;
    document.getElementById("output").innerText += `\nContinuous pitch review complete: ${inTuneCount} in tune, ${feedback.length} confirmed pitch issues, ${unmatchedCount} unconfirmed notes.${recordingEnded ? "" : ` ${reviewedCount} notes were assessed.`}`;
}

function durationToBeats(d) {
  d = d.replace('r', '');
  switch (d) {
    case "w": return 4;
    case "h": return 2;
    case "q": return 1;
    case "8": return 0.5;
    case "16": return 0.25;
    case "qd": return 1.5;
    case "hd": return 3;
    case "8d": return 0.75;
    case "16d": return 0.375;
    default: return 1;
  }
}

function beatsToDuration(beats) {
  const durationMap = [
    { beats: 4, duration: "w" },
    { beats: 3, duration: "hd" },
    { beats: 2, duration: "h" },
    { beats: 1.5, duration: "qd" },
    { beats: 1, duration: "q" },
    { beats: 0.75, duration: "8d" },
    { beats: 0.5, duration: "8" },
    { beats: 0.375, duration: "16d" },
    { beats: 0.25, duration: "16" }
  ];
  const tolerance = 0.01;

  for (const option of durationMap) {
    if (Math.abs(beats - option.beats) < tolerance) {
      return option.duration;
    }
  }

  return null;
}

function splitBeatsIntoDurations(totalBeats) {
  const parts = [];
  let remaining = Math.round(totalBeats * 1000) / 1000;
  const options = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.375, 0.25];
  const tolerance = 0.01;

  while (remaining > tolerance) {
    const nextBeatValue = options.find(option => option <= remaining + tolerance);
    if (!nextBeatValue) {
      break;
    }

    const duration = beatsToDuration(nextBeatValue);
    if (!duration) {
      break;
    }

    parts.push(duration);
    remaining = Math.round((remaining - nextBeatValue) * 1000) / 1000;
  }

  return parts;
}

function createRestSegments(totalBeats) {
  return splitBeatsIntoDurations(totalBeats).map(duration => ({
    keys: ["b/4"],
    duration: `${duration}r`
  }));
}

function createTiedNoteSegments(noteKey, totalBeats) {
  const durations = splitBeatsIntoDurations(totalBeats);

  return durations.map((duration, index) => ({
    keys: [noteKey],
    duration,
    tieStart: index < durations.length - 1,
    tieEnd: index > 0
  }));
}

function getCurrentBpm() {
  const typedBpm = Number(bpmInput.value);

  // A user-entered tempo should override the MIDI file's suggested tempo.
  if (Number.isFinite(typedBpm) && typedBpm > 0) {
    return typedBpm;
  }

  return midiBpm ?? 120;
}

function setRecordingMode(withTrack) {
  recordWithTrack = withTrack;
  WTrackBtn?.classList.toggle("is-selected", withTrack);
  WOTrackBtn?.classList.toggle("is-selected", !withTrack);
  WTrackBtn?.setAttribute("aria-pressed", String(withTrack));
  WOTrackBtn?.setAttribute("aria-pressed", String(!withTrack));
}

function getMetronomeVolume() {
  return Math.max(0, Math.min(1, Number(metronomeVolumeInput?.value ?? 75) / 100));
}

function updateMetronomeVolumeLabel() {
  if (metronomeVolumeValue && metronomeVolumeInput) {
    metronomeVolumeValue.value = `${metronomeVolumeInput.value}%`;
    metronomeVolumeValue.textContent = `${metronomeVolumeInput.value}%`;
  }
}

function getCountInBeats() {
  const typedValue = countInBeatsInput?.value.trim();
  const typedCount = Number(typedValue);

  if (typedValue && Number.isFinite(typedCount) && typedCount >= 0) {
    return Math.floor(typedCount);
  }

  return 4;
}

function getNoteBeatTiming(note, bpm) {
  return {
    startBeat: Number.isFinite(note.startBeat)
      ? note.startBeat
      : note.time / (60 / (midiBpm ?? bpm)),
    durationBeats: Number.isFinite(note.durationBeats)
      ? note.durationBeats
      : note.duration / (60 / (midiBpm ?? bpm))
  };
}

function getMeasureRanges() {
  if (!midiNotesData?.length) return [];

  const finalBeat = Math.max(...midiNotesData.map((note) => {
    const timing = getNoteBeatTiming(note, midiBpm ?? getCurrentBpm());
    return timing.startBeat + timing.durationBeats;
  }));
  const ranges = [];
  let measureNumber = 1;
  let startBeat = 0;

  while (startBeat < finalBeat - 0.001) {
    const signature = getTimeSignatureAtBeat(startBeat, midiTimeSignatures);
    const measureBeats = getMeasureQuarterBeats(signature);
    const nextSignature = midiTimeSignatures.find((item) => item.startBeat > startBeat + 0.001);
    const endBeat = Math.min(startBeat + measureBeats, nextSignature?.startBeat ?? Infinity);

    if (endBeat <= startBeat + 0.001) break;
    ranges.push({ measureNumber, startBeat, endBeat });
    startBeat = endBeat;
    measureNumber += 1;
  }

  return ranges;
}

function updateLoopControls() {
  const measures = getMeasureRanges();
  const hasMeasures = measures.length > 0;
  const lastMeasure = measures.length || 1;

  [loopStartMeasureInput, loopEndMeasureInput].forEach((input) => {
    if (!input) return;
    input.disabled = !hasMeasures;
    input.max = String(lastMeasure);
  });
  if (setLoopBtn) setLoopBtn.disabled = !hasMeasures;
  if (clearLoopBtn) clearLoopBtn.disabled = !activeLoopRange;

  if (!hasMeasures) return;
  if (!loopStartMeasureInput.value) loopStartMeasureInput.value = "1";
  if (!loopEndMeasureInput.value) loopEndMeasureInput.value = String(lastMeasure);
}

function setPracticeLoop() {
  const measures = getMeasureRanges();
  const startMeasure = Number(loopStartMeasureInput?.value);
  const endMeasure = Number(loopEndMeasureInput?.value);

  if (!Number.isInteger(startMeasure) || !Number.isInteger(endMeasure) || startMeasure < 1 || endMeasure < startMeasure || endMeasure > measures.length) {
    loopStatus.textContent = `Choose measures between 1 and ${measures.length}, with the end at or after the start.`;
    loopStatus.classList.remove("is-active");
    return;
  }

  activeLoopRange = {
    startMeasure,
    endMeasure,
    startBeat: measures[startMeasure - 1].startBeat,
    endBeat: measures[endMeasure - 1].endBeat
  };
  loopStatus.textContent = `Looping measures ${startMeasure}–${endMeasure}. Practice-track playback and recording review will use this range.`;
  loopStatus.classList.add("is-active");
  updateLoopControls();
}

function clearPracticeLoop() {
  activeLoopRange = null;
  const measures = getMeasureRanges();
  if (loopStartMeasureInput) loopStartMeasureInput.value = "1";
  if (loopEndMeasureInput) loopEndMeasureInput.value = String(measures.length || 1);
  if (loopStatus) {
    loopStatus.textContent = "No loop is set. The full score will play and be reviewed.";
    loopStatus.classList.remove("is-active");
  }
  updateLoopControls();
}

function getNotesInRange(range, bpm) {
  return midiNotesData.flatMap((note, noteIndex) => {
    const { startBeat, durationBeats } = getNoteBeatTiming(note, bpm);
    const endBeat = startBeat + durationBeats;
    const rangeStart = range?.startBeat ?? 0;
    const rangeEnd = range?.endBeat ?? Infinity;
    const trimmedStartBeat = Math.max(startBeat, rangeStart);
    const trimmedEndBeat = Math.min(endBeat, rangeEnd);

    if (trimmedEndBeat <= trimmedStartBeat + 0.001) return [];
    return [{ ...note, noteIndex, startBeat: trimmedStartBeat, durationBeats: trimmedEndBeat - trimmedStartBeat }];
  });
}

function getStaveWidth(measure, isFirstInLine, shouldShowTimeSignature) {
  const baseWidth = isFirstInLine ? 350 : 330;
  const noteWidth = measure.length * 55 + 100;
  const timeSignatureWidth = shouldShowTimeSignature ? 35 : 0;

  return Math.max(baseWidth, noteWidth + timeSignatureWidth);
}

function createNoteEvents(notes, bpm) {
  const quarter = 60 / bpm;

  return notes.map((note, index) => {
    const startBeat = note.startBeat !== undefined ? note.startBeat : note.time / quarter;
    const durationBeats = note.durationBeats !== undefined ? note.durationBeats : note.duration / quarter;

    if (note.note === "rest") {
      return {
        type: "rest",
        keys: ["b/4"],
        startBeat,
        durationBeats,
        sourceId: `rest-${index}`
      };
    }

    const parsedNote = parseNoteName(note.note);

    return {
      type: "note",
      keys: [parsedNote.key],
      accidental: parsedNote.accidental,
      startBeat,
      durationBeats,
      sourceId: `note-${index}`
    };
  });
}

function readVariableLengthValue(bytes, state) {
  let value = 0;
  let currentByte;

  do {
    currentByte = bytes[state.index++];
    value = (value << 7) | (currentByte & 0x7f);
  } while (currentByte & 0x80);

  return value;
}

function parseTimeSignatures(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 14) {
    return [{ startBeat: 0, numerator: 4, denominator: 4 }];
  }

  const division = (bytes[12] << 8) | bytes[13];
  const signatures = [{ startBeat: 0, numerator: 4, denominator: 4 }];
  let index = 14;

  while (index + 8 <= bytes.length) {
    const chunkType = String.fromCharCode(bytes[index], bytes[index + 1], bytes[index + 2], bytes[index + 3]);
    const chunkLength =
      (bytes[index + 4] << 24) |
      (bytes[index + 5] << 16) |
      (bytes[index + 6] << 8) |
      bytes[index + 7];
    index += 8;

    if (chunkType !== "MTrk") {
      index += chunkLength;
      continue;
    }

    const trackEnd = index + chunkLength;
    const state = { index };
    let absoluteTicks = 0;
    let runningStatus = null;

    while (state.index < trackEnd) {
      absoluteTicks += readVariableLengthValue(bytes, state);
      let status = bytes[state.index++];

      if (status < 0x80) {
        state.index--;
        status = runningStatus;
      } else {
        runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[state.index++];
        const metaLength = readVariableLengthValue(bytes, state);

        if (metaType === 0x58 && metaLength >= 2) {
          const numerator = bytes[state.index];
          const denominator = 2 ** bytes[state.index + 1];
          signatures.push({
            startBeat: absoluteTicks / division,
            numerator,
            denominator
          });
        }

        state.index += metaLength;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVariableLengthValue(bytes, state);
        state.index += sysexLength;
        continue;
      }

      const command = status & 0xf0;
      if (command === 0xc0 || command === 0xd0) {
        state.index += 1;
      } else {
        state.index += 2;
      }
    }

    index = trackEnd;
  }

  const uniqueSignatures = signatures
    .sort((a, b) => a.startBeat - b.startBeat)
    .filter((signature, idx, array) => {
      if (idx === 0) return true;
      const previous = array[idx - 1];
      return (
        signature.startBeat !== previous.startBeat ||
        signature.numerator !== previous.numerator ||
        signature.denominator !== previous.denominator
      );
    });

  return uniqueSignatures.length > 0 ? uniqueSignatures : [{ startBeat: 0, numerator: 4, denominator: 4 }];
}

function buildMeasures(events, timeSignatures) {
  const measures = [];
  let currentMeasure = [];
  let currentMeasureStartBeat = 0;
  let currentMeasureIndex = 0;
  let beatsUsedInMeasure = 0;
  let cursorBeat = 0;
  let currentTimeSignature = getTimeSignatureAtBeat(0, timeSignatures);
  let currentMeasureBeats = getMeasureQuarterBeats(currentTimeSignature);

  function pushRestsToFillMeasure() {
    const remaining = Math.round((currentMeasureBeats - beatsUsedInMeasure) * 1000) / 1000;
    if (remaining <= 0.01) return;
    currentMeasure.push(...createRestSegments(remaining));
    beatsUsedInMeasure = currentMeasureBeats;
  }

  function closeMeasure() {
    pushRestsToFillMeasure();
    measures.push({
      notes: currentMeasure,
      timeSignature: currentTimeSignature,
      measureIndex: currentMeasureIndex,
      startBeat: currentMeasureStartBeat
    });
    currentMeasureStartBeat += currentMeasureBeats;
    currentMeasureIndex += 1;
    currentMeasure = [];
    beatsUsedInMeasure = 0;
    currentTimeSignature = getTimeSignatureAtBeat(currentMeasureStartBeat, timeSignatures);
    currentMeasureBeats = getMeasureQuarterBeats(currentTimeSignature);
  }

  function addSegmentToMeasures(segment, segmentStartBeat) {
    let remainingBeats = segment.durationBeats;
    let firstChunkForSegment = true;

    while (remainingBeats > 0.01) {
      const availableBeats = Math.round((currentMeasureBeats - beatsUsedInMeasure) * 1000) / 1000;

      if (availableBeats <= 0.01) {
        closeMeasure();
        continue;
      }

      const segmentBeats = Math.min(remainingBeats, availableBeats);
      const durations = splitBeatsIntoDurations(segmentBeats);
      const segmentStartIndex = currentMeasure.length;
      const stillHasRemaining = remainingBeats - segmentBeats > 0.01;

      durations.forEach((duration, index) => {
        const isRest = segment.type === "rest";
        currentMeasure.push({
          type: segment.type,
          keys: [...segment.keys],
          duration,
          accidental: segment.type !== "rest" && firstChunkForSegment && index === 0 ? segment.accidental : null,
          sourceId: segment.sourceId,
          startBeat: segmentStartBeat,
          tieEnd: !isRest && (!firstChunkForSegment || index > 0),
          tieStart: false
        });
        beatsUsedInMeasure += durationToBeats(duration);
      });

      if (currentMeasure[segmentStartIndex]) {
        currentMeasure[segmentStartIndex].tieEnd = segment.type !== "rest" && !firstChunkForSegment;
      }

      if (currentMeasure[currentMeasure.length - 1]) {
        currentMeasure[currentMeasure.length - 1].tieStart = segment.type !== "rest" && stillHasRemaining;
      }

      remainingBeats = Math.round((remainingBeats - segmentBeats) * 1000) / 1000;
      firstChunkForSegment = false;

      if (Math.abs(beatsUsedInMeasure - currentMeasureBeats) < 0.01) {
        closeMeasure();
      }
    }
  }

  events
    .filter(event => event.durationBeats > 0.01)
    .sort((a, b) => a.startBeat - b.startBeat)
    .forEach(event => {
      const gapBeats = Math.round((event.startBeat - cursorBeat) * 1000) / 1000;

      if (gapBeats > 0.01) {
        addSegmentToMeasures({
          type: "rest",
          keys: ["b/4"],
          durationBeats: gapBeats,
          sourceId: `gap-${cursorBeat}`
        }, cursorBeat);
        cursorBeat = event.startBeat;
      }

      if (event.startBeat + event.durationBeats <= cursorBeat + 0.01) {
        return;
      }

      const trimmedStartBeat = Math.max(event.startBeat, cursorBeat);
      const trimmedDurationBeats = event.durationBeats - Math.max(0, cursorBeat - event.startBeat);

      addSegmentToMeasures({
        ...event,
        startBeat: trimmedStartBeat,
        durationBeats: trimmedDurationBeats
      }, trimmedStartBeat);
      cursorBeat = trimmedStartBeat + trimmedDurationBeats;
    });

  if (currentMeasure.length > 0) {
    pushRestsToFillMeasure();
    measures.push({
      notes: currentMeasure,
      timeSignature: currentTimeSignature,
      measureIndex: currentMeasureIndex,
      startBeat: currentMeasureStartBeat
    });
  }

  return measures;
}

async function parseMidiFile() {
  const file = document.getElementById("midiFile").files[0];
  if (!file) return null;
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);
  const timeSignatures = parseTimeSignatures(arrayBuffer);

  let melodyTrack = midi.tracks[0];
  if (midi.tracks.length > 1) {
    melodyTrack = midi.tracks.reduce((a, b) => 
      (a.notes.length > b.notes.length ? a : b)
    );
  }
  
  const notes = melodyTrack.notes.filter(n => n.midi >= 48 && n.midi <= 84);
  const bpm = Math.round(midi.header.tempos.length > 0 ? midi.header.tempos[0].bpm : 120);
  const ppq = midi.header.ppq || 480;

  let parsed = [];

  function getNoteStartBeat(note) {
    return typeof note.ticks === "number" ? note.ticks / ppq : note.time / (60 / bpm);
  }

  function getNoteDurationBeats(note) {
    return typeof note.durationTicks === "number" ? note.durationTicks / ppq : note.duration / (60 / bpm);
  }

  const beatGroups = {};
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const beatKey = getNoteStartBeat(n).toFixed(6);
    if (!beatGroups[beatKey]) beatGroups[beatKey] = [];
    beatGroups[beatKey].push(n);
  }
  
  const sortedBeats = Object.keys(beatGroups).map(Number).sort((a, b) => a - b);
  
  for (let startBeat of sortedBeats) {
    const group = beatGroups[startBeat.toFixed(6)];
    let chosenNote = group[0];
    if (group.length > 1) {
      chosenNote = group.reduce((prev, curr) => 
        curr.midi > prev.midi ? curr : prev
      );
    }

    parsed.push({
      note: chosenNote.name,
      midi: chosenNote.midi,
      time: chosenNote.time,
      duration: chosenNote.duration,
      startBeat,
      durationBeats: getNoteDurationBeats(chosenNote),
      velocity: chosenNote.velocity,
    });
  }
  console.log({ bpm, timeSignatures, notes: parsed });
  return { bpm, notes: parsed, timeSignatures };
}

function getDuration(duration, bpm) {
  const quarter = 60 / bpm;
  const tolerance = quarter * 0.15;
  const half = quarter * 2;
  const whole = quarter * 4;
  const eighth = quarter / 2;
  const sixteenth = quarter / 4;
  if (Math.abs(duration - whole) < tolerance) return "w";
  if (Math.abs(duration - half) < tolerance) return "h";
  if (Math.abs(duration - (half * 1.5)) < tolerance) return "hd";
  if (Math.abs(duration - quarter) < tolerance) return "q";
  if (Math.abs(duration - (quarter * 1.5)) < tolerance) return "qd";
  if (Math.abs(duration - eighth) < tolerance) return "8";
  if (Math.abs(duration - (eighth * 1.5)) < tolerance) return "8d";
  if (Math.abs(duration - sixteenth) < tolerance) return "16";
  if (Math.abs(duration - (sixteenth * 1.5)) < tolerance) return "16d";

  const beats = duration / quarter;
  const splitDurations = splitBeatsIntoDurations(beats);
  return splitDurations[0] || "q";
}

async function convertAllNotes() {
  const parsedMidi = await parseMidiFile();
  if (!parsedMidi) return [];

  return createNoteEvents(parsedMidi.notes, parsedMidi.bpm);
}

async function processAndRender() {
  const file = document.getElementById("midiFile").files[0];
  if (!file) return;

  const [parsedMidi, midiData] = await Promise.all([
    parseMidiFile(),
    file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  ]);
  if (!parsedMidi) return;

  const { bpm, notes, timeSignatures } = parsedMidi;
  midiBpm = bpm;
  midiNotesData = notes;
  midiTimeSignatures = timeSignatures;
  bpmInput.value = midiBpm;
  recordingBpm = null;
  activeLoopRange = null;
  recordingLoopRange = null;
  if (loopStartMeasureInput) loopStartMeasureInput.value = "1";
  if (loopEndMeasureInput) loopEndMeasureInput.value = "";
  updateLoopControls();
  if (loopStatus) {
    loopStatus.textContent = "No loop is set. The full score will play and be reviewed.";
    loopStatus.classList.remove("is-active");
  }
  playPracticeTrackBtn.disabled = notes.length === 0;
  await renderMuseScore(midiData);
}

function drawStaff(events, timeSignatures = midiTimeSignatures) {
  const VF = Vex;
  const container = document.getElementById("staff");
  container.innerHTML = "";
  const measures = buildMeasures(events, timeSignatures);
  const clef = midiClef;

  const measuresPerLine = 4;
  const lineHeight = 200;
  const numLines = Math.ceil(measures.length / measuresPerLine);
  const measureWidths = measures.map((measureData, i) => {
    const isFirstInLine = i % measuresPerLine === 0;
    const previousMeasure = i > 0 ? measures[i - 1] : null;
    const shouldShowTimeSignature =
      i === 0 ||
      !previousMeasure ||
      previousMeasure.timeSignature.numerator !== measureData.timeSignature.numerator ||
      previousMeasure.timeSignature.denominator !== measureData.timeSignature.denominator;

    return getStaveWidth(measureData.notes, isFirstInLine, shouldShowTimeSignature);
  });
  const lineWidths = [];

  for (let i = 0; i < measureWidths.length; i++) {
    const lineIndex = Math.floor(i / measuresPerLine);
    lineWidths[lineIndex] = (lineWidths[lineIndex] || 20) + measureWidths[i];
  }
  
  const rendererWidth = Math.max(1400, Math.max(...lineWidths, 0) + 20);
  
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(rendererWidth, numLines * lineHeight + 50);
  const context = renderer.getContext();

  let allVexNotes = [];
  let allNoteData = [];
  let x = 10;
  let y = 40;
  measures.forEach((measureData, i) => {
    const measure = measureData.notes;
    const isFirstInLine = i % measuresPerLine === 0;
    const previousMeasure = i > 0 ? measures[i - 1] : null;
    const shouldShowTimeSignature =
      i === 0 ||
      !previousMeasure ||
      previousMeasure.timeSignature.numerator !== measureData.timeSignature.numerator ||
      previousMeasure.timeSignature.denominator !== measureData.timeSignature.denominator;

    if (i > 0 && isFirstInLine) {
      x = 10;
      y += lineHeight;
    }

    const staveWidth = measureWidths[i];
    const formatWidth = Math.max(100, staveWidth - (isFirstInLine ? 70 : 30));

    const stave = new VF.Stave(x, y, staveWidth);
    if (isFirstInLine) {
      stave.addClef(clef);
    }
    if (shouldShowTimeSignature) {
      stave.addTimeSignature(formatTimeSignature(measureData.timeSignature));
    }
    stave.setContext(context).draw();

    const vexNotes = measure.map(n => {
      const note = new VF.StaveNote({
        clef,
        keys: n.keys,
        duration: n.duration
      });
      
      if (n.accidental) {
        note.addModifier(new VF.Accidental(n.accidental), 0);
      }
      
      if (n.duration.includes('d') && !n.duration.includes('r')) {
        VF.Dot.buildAndAttach([note], { all: true });
      }
      
      return note;
    });

    const internalVoiceSignature = getInternalVoiceSignature(measureData.timeSignature);
    const voice = new VF.Voice({
      numBeats: internalVoiceSignature.numBeats,
      beatValue: internalVoiceSignature.beatValue
    });
    voice.addTickables(vexNotes);

    new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);
    voice.draw(context, stave);

    allVexNotes.push(...vexNotes);
    allNoteData.push(...measure.map(note => ({
      ...note,
      lineIndex: Math.floor(i / measuresPerLine)
    })));

    x += staveWidth;
  });

  for (let i = 0; i < allNoteData.length - 1; i++) {
    const currentNote = allNoteData[i];
    const nextNote = allNoteData[i + 1];
    const currentVexNote = allVexNotes[i];
    const nextVexNote = allVexNotes[i + 1];

    if (!currentNote || !nextNote || !currentVexNote || !nextVexNote) continue;
    if (currentNote.duration.includes('r') || nextNote.duration.includes('r')) continue;
    if (!currentNote.keys || !nextNote.keys) continue;
    if (currentNote.sourceId !== nextNote.sourceId) continue;
    if (currentNote.keys[0] !== nextNote.keys[0]) continue;
    if (currentNote.lineIndex !== nextNote.lineIndex) continue;
    if (!currentNote.tieStart || !nextNote.tieEnd) continue;

    const tie = new VF.StaveTie({
      firstNote: currentVexNote,
      lastNote: nextVexNote
    });
    tie.setContext(context).draw();
  }
}

function clearScoreGuide() {
  if (scoreGuideFrame) cancelAnimationFrame(scoreGuideFrame);
  scoreGuideFrame = null;
  document.querySelectorAll(".metronome-guide").forEach((guide) => guide.remove());
}

function getGuidePosition(beat) {
  if (!midiNotesData?.length || !scoreNoteAnchors.length) return null;

  let noteIndex = 0;
  for (let index = 0; index < midiNotesData.length; index += 1) {
    const timing = getNoteBeatTiming(midiNotesData[index], scoreGuideBpm);
    if (timing.startBeat <= beat + 0.001) noteIndex = index;
    else break;
  }

  const current = scoreNoteAnchors[noteIndex];
  const next = scoreNoteAnchors[noteIndex + 1];
  if (!current) return null;

  const timing = getNoteBeatTiming(midiNotesData[noteIndex], scoreGuideBpm);
  const nextTiming = midiNotesData[noteIndex + 1]
    ? getNoteBeatTiming(midiNotesData[noteIndex + 1], scoreGuideBpm)
    : null;
  const progress = next && nextTiming && next.page === current.page && nextTiming.startBeat > timing.startBeat
    ? Math.max(0, Math.min(1, (beat - timing.startBeat) / (nextTiming.startBeat - timing.startBeat)))
    : 0;

  // Anchor the guide to the notehead's left edge at the exact moment the note starts.
  return { page: current.page, x: current.x + ((next?.x ?? current.x) - current.x) * progress };
}

function startScoreGuide(startTime, bpm, range = null, loop = true) {
  clearScoreGuide();
  scoreGuideStartTime = startTime;
  scoreGuideBpm = bpm;
  scoreGuideRange = range ? { ...range } : null;
  scoreGuideLoop = loop;

  const updateGuide = () => {
    const secondsPerBeat = 60 / scoreGuideBpm;
    const rangeStart = scoreGuideRange?.startBeat ?? 0;
    const rangeEnd = scoreGuideRange?.endBeat ?? getMeasureRanges().at(-1)?.endBeat ?? 0;
    const rangeLength = Math.max(0.001, rangeEnd - rangeStart);
    const elapsedBeats = Math.max(0, (ctx.currentTime - scoreGuideStartTime) / secondsPerBeat);
    const beat = rangeStart + (scoreGuideLoop ? elapsedBeats % rangeLength : elapsedBeats);

    if (!scoreGuideLoop && beat > rangeEnd + 0.05) {
      clearScoreGuide();
      return;
    }

    const position = getGuidePosition(beat);
    if (position) {
      const pages = document.querySelectorAll("#sheet-music-container svg");
      const page = pages[position.page];
      if (page) {
        let guide = page.querySelector(".metronome-guide");
        if (!guide) {
          document.querySelectorAll(".metronome-guide").forEach((item) => item.remove());
          guide = document.createElementNS("http://www.w3.org/2000/svg", "g");
          guide.classList.add("metronome-guide");
          guide.setAttribute("aria-hidden", "true");
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          const viewBox = page.viewBox.baseVal;
          line.setAttribute("y1", "0");
          line.setAttribute("y2", String(viewBox.height || page.clientHeight));
          guide.appendChild(line);
          page.appendChild(guide);
        }
        guide.querySelector("line").setAttribute("x1", String(position.x));
        guide.querySelector("line").setAttribute("x2", String(position.x));
      }
    }
    scoreGuideFrame = requestAnimationFrame(updateGuide);
  };
  scoreGuideFrame = requestAnimationFrame(updateGuide);
}

function playClickAt(startTime, isMeasureStart = false) {
    const volume = getMetronomeVolume();
    if (volume === 0) return;
    if (mechanicalTickBuffer) {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = mechanicalTickBuffer;
        // The accented downbeat is slightly lower and fuller, like a mechanical pendulum's weighted swing.
        source.playbackRate.value = isMeasureStart ? 0.88 : 1;
        gain.gain.setValueAtTime((isMeasureStart ? 0.95 : 0.68) * volume, startTime);
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(startTime);
        return;
    }

    // Layer a pitched strike and a tiny burst of noise for a woodblock-style click.
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(isMeasureStart ? 1450 : 1950, startTime);
    oscillator.frequency.exponentialRampToValueAtTime(isMeasureStart ? 850 : 1250, startTime + 0.045);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime((isMeasureStart ? 0.3 : 0.18) * volume, startTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.055);
    oscillator.start(startTime);
    oscillator.stop(startTime + 0.06);

    const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.025), ctx.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index += 1) noise[index] = (Math.random() * 2 - 1) * (1 - index / noise.length);
    const noiseSource = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    noiseSource.buffer = noiseBuffer;
    noiseSource.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseGain.gain.setValueAtTime((isMeasureStart ? 0.09 : 0.045) * volume, startTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.025);
    noiseSource.start(startTime);
}

function click() {
    playClickAt(ctx.currentTime);
}

function scheduleMetronomeClicks() {
    const bpm = getCurrentBpm();
    const secondsPerBeat = 60 / bpm;

    while (nextMetronomeClickTime < ctx.currentTime + metronomeScheduleAheadSeconds) {
        const scorePosition = getScorePositionFromBeat(nextMetronomeBeat, midiTimeSignatures);
        playClickAt(nextMetronomeClickTime, Math.abs(scorePosition.beat - 1) < 0.001);
        nextMetronomeClickTime += secondsPerBeat;
        nextMetronomeBeat += 1;
        if (metronomeRange && nextMetronomeBeat >= metronomeRange.endBeat - 0.001) {
            nextMetronomeBeat = metronomeRange.startBeat;
        }
    }

    metInterval = setTimeout(scheduleMetronomeClicks, metronomeLookAheadMs);
}

function startMet({ guideStartTime = nextMetronomeClickTime || ctx.currentTime, guideRange = activeLoopRange, guideLoop = true } = {}) {
    if (ctx.state === "suspended") ctx.resume();
    clearTimeout(metInterval);
    if (nextMetronomeClickTime == 0) nextMetronomeClickTime = ctx.currentTime;
    metronomeRange = guideLoop && guideRange ? { ...guideRange } : null;
    nextMetronomeBeat = metronomeRange?.startBeat ?? 0;
    scheduleMetronomeClicks();
    startScoreGuide(guideStartTime, getCurrentBpm(), guideRange, guideLoop);
    startMetronome.disabled = true;
    stopMetronome.disabled = false;
}

function stopMet() {
    clearTimeout(metInterval);
    metInterval = null;
    nextMetronomeClickTime = 0;
    nextMetronomeBeat = 0;
    metronomeRange = null;
    startMetronome.disabled = false;
    stopMetronome.disabled = true;
    clearScoreGuide();
}

function playPianoNoteAt(noteName, startTime, duration = 1, volume = 0.14) {
  const output = ctx.createGain();
  const releaseTime = Math.max(0.18, duration);
  output.connect(ctx.destination);
  output.gain.setValueAtTime(0.0001, startTime);
  output.gain.exponentialRampToValueAtTime(volume, startTime + 0.012);
  output.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.18), startTime + Math.min(0.35, releaseTime * 0.28));
  output.gain.exponentialRampToValueAtTime(0.0001, startTime + releaseTime);

  const harmonics = [[1, 1], [2, 0.42], [3, 0.2], [4, 0.08]];
  return harmonics.map(([multiple, level]) => {
    const oscillator = ctx.createOscillator();
    const harmonicGain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = Frequency(noteName).toFrequency() * multiple;
    harmonicGain.gain.value = level;
    oscillator.connect(harmonicGain);
    harmonicGain.connect(output);
    oscillator.start(startTime);
    oscillator.stop(startTime + releaseTime + 0.03);
    return oscillator;
  });
}

function playPracticeNoteAt(noteName, startTime, duration) {
  const oscillators = playPianoNoteAt(noteName, startTime, duration, 0.12);
  practiceOscillators.push(...oscillators);
  oscillators.forEach((oscillator) => {
    oscillator.onended = () => {
      practiceOscillators = practiceOscillators.filter((item) => item !== oscillator);
    };
  });
}

function finishPracticeTrack() {
  practiceTrackStopTimer = null;
  practiceOscillators = [];
  playPracticeTrackBtn.disabled = midiNotesData === null || midiNotesData.length === 0;
  stopPracticeTrackBtn.disabled = true;
  stopMet();
}

function schedulePracticeRange(range, bpm, startTime) {
  const secondsPerBeat = 60 / bpm;
  const rangeStartBeat = range?.startBeat ?? 0;
  const notes = getNotesInRange(range, bpm);
  let trackEnd = range ? (range.endBeat - range.startBeat) * secondsPerBeat : 0;

  notes.forEach((note) => {
    const noteName = Array.isArray(note.note) ? note.note[note.note.length - 1] : note.note;
    if (!noteName || noteName === "rest") return;

    const duration = Math.max(0.05, note.durationBeats * secondsPerBeat);
    const noteStart = (note.startBeat - rangeStartBeat) * secondsPerBeat;
    playPracticeNoteAt(noteName, startTime + noteStart, duration);
    trackEnd = Math.max(trackEnd, noteStart + duration);
  });

  return trackEnd;
}

async function startPracticeTrack() {
  if (!midiNotesData || midiNotesData.length === 0) {
    alert("Please upload a MIDI file before starting the practice track.");
    return;
  }

  stopPracticeTrack();
  if (ctx.state === "suspended") await ctx.resume();

  const bpm = getCurrentBpm();
  const startTime = ctx.currentTime + 0.08;

  nextMetronomeClickTime = startTime;
  startMet({ guideStartTime: startTime, guideRange: activeLoopRange, guideLoop: Boolean(activeLoopRange) });

  playPracticeTrackBtn.disabled = true;
  stopPracticeTrackBtn.disabled = false;
  if (!activeLoopRange) {
    const trackEnd = schedulePracticeRange(null, bpm, startTime);
    practiceTrackStopTimer = setTimeout(finishPracticeTrack, (trackEnd + 0.15) * 1000);
    return;
  }

  const loopId = practiceTrackLoopId;
  const range = { ...activeLoopRange };
  const scheduleLoopPass = (passStartTime) => {
    if (loopId !== practiceTrackLoopId) return;
    const passDuration = schedulePracticeRange(range, bpm, passStartTime);
    practiceTrackStopTimer = setTimeout(
      () => scheduleLoopPass(passStartTime + passDuration),
      Math.max(0, (passStartTime + passDuration - ctx.currentTime - 0.06) * 1000)
    );
  };
  scheduleLoopPass(startTime);
}

function stopPracticeTrack() {
  practiceTrackLoopId += 1;
  if (practiceTrackStopTimer) {
    clearTimeout(practiceTrackStopTimer);
    practiceTrackStopTimer = null;
  }

  practiceOscillators.forEach((oscillator) => {
    try {
      oscillator.stop(ctx.currentTime);
    } catch (error) {
      // The oscillator may already have finished naturally.
    }
  });
  finishPracticeTrack();
}

function playStartingNoteAt(noteName, startTime, duration = 2.5) {
  if (ctx.state === "suspended") ctx.resume();
  playPianoNoteAt(noteName, startTime, duration, 0.24);
}

function playStartingNote(noteName, duration = 2.5) {
  playStartingNoteAt(noteName, ctx.currentTime, duration);
}

function startRecording() {
    if (midiNotesData === null) {
        alert("Please upload a MIDI file before recording.");
        return;
    }

    navigator.mediaDevices.getUserMedia({
        audio: {
            autoGainControl: true,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
        }
    })
        .then(stream => {
            recordingLoopRange = activeLoopRange ? { ...activeLoopRange } : null;
            document.getElementById("SheetMusic").scrollIntoView({
                behavior: "smooth",
                block: "start"
            });
            if (ctx.state === "suspended") {
                ctx.resume();
            }
            const count = getCountInBeats();
            const firstPracticeNote = getNotesInRange(recordingLoopRange, getCurrentBpm())[0] ?? midiNotesData[0];
            const firstNote = Array.isArray(firstPracticeNote.note)
                    ? firstPracticeNote.note[firstPracticeNote.note.length - 1]
                : firstPracticeNote.note;
            const bpm = getCurrentBpm();
            recordingBpm = bpm;
            const secondsPerBeat = 60 / bpm;
            recordBtn.disabled = true;

            // Let singers hear and match their pitch before the score and count-in appear.
            playStartingNoteAt(firstNote, ctx.currentTime + 0.05, 3);

            setTimeout(() => {
                let countdownDiv = null;
                if (count > 0) {
                    countdownDiv = document.createElement('div');
                    countdownDiv.id = 'countdown';
                    countdownDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 120px; font-weight: bold; color: #6ac47e; z-index: 9999; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);';
                    countdownDiv.innerText = count;
                    document.body.appendChild(countdownDiv);
                }

                const firstClickTime = ctx.currentTime + 0.05;
                for (let beat = 0; beat < count; beat++) {
                    playClickAt(firstClickTime + beat * secondsPerBeat, beat === 0);
                }
                for (let beat = 1; beat < count; beat++) {
                    setTimeout(() => {
                        if (countdownDiv) countdownDiv.innerText = count - beat;
                    }, beat * secondsPerBeat * 1000);
                }

                setTimeout(() => {
                    if (countdownDiv) countdownDiv.remove();

                recorder = new MediaRecorder(stream);
                recorder.ondataavailable = event => {
                    audioChunks.push(event.data);
                };
                recorder.onstop = () => {
                    const mimeType = recorder.mimeType || "audio/webm";
                    const audioBlob = new Blob(audioChunks, { type: mimeType });
                    const audioUrl = URL.createObjectURL(audioBlob);
                    player.src = audioUrl;
                    audioChunks = [];
                };
                recorder.start();
                recordBtn.disabled = true;
                stopBtn.disabled = false;
                bpmInput.disabled = true;
                if (countInBeatsInput) countInBeatsInput.disabled = true;
                if (recordWithTrack) {
                  WTrackBtn && (WTrackBtn.disabled = true);
                  WOTrackBtn && (WOTrackBtn.disabled = true);
                  startPracticeTrack();
                } else {
                  startMet({ guideRange: recordingLoopRange, guideLoop: true });
                }
                }, count * secondsPerBeat * 1000);
            }, 3050);
        });
}

function stopRecording() {
    stopPracticeTrack();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    bpmInput.disabled = false;
    if (countInBeatsInput) countInBeatsInput.disabled = false;
    if (WTrackBtn) WTrackBtn.disabled = false;
    if (WOTrackBtn) WOTrackBtn.disabled = false;
    stopMet();
}

analyzeOutput.addEventListener("click", compareNotes);

document.getElementById("midiFile").addEventListener("change", async () => {
  console.log("File selected! Processing as we speak...");
  await processAndRender();
});
