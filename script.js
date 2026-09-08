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
let recorder;
let audioChunks = [];
recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
let ctx = new AudioContext();
let metInterval;
let nextMetronomeClickTime = 0;
const metronomeLookAheadMs = 25;
const metronomeScheduleAheadSeconds = 0.1;
recordBtn.disabled = false;
stopBtn.disabled = true;
startMetronome.addEventListener("click", startMet);
stopMetronome.addEventListener("click", stopMet);
stopMetronome.disabled = true;
playPracticeTrackBtn.addEventListener("click", startPracticeTrack);
stopPracticeTrackBtn.addEventListener("click", stopPracticeTrack);
let midiBpm = null;
let recordingBpm = null;
let midiNotesData = null;
let midiTimeSignatures = [{ startBeat: 0, numerator: 4, denominator: 4 }];
let midiClef = "treble";
let currentScoreInstance = null;
let practiceOscillators = [];
let practiceTrackStopTimer = null;

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
    const svgOutput = await currentScoreInstance.saveSvg();
    const svgPages = Array.isArray(svgOutput) ? svgOutput : [svgOutput];

    container.replaceChildren();
    svgPages.forEach((svgString) => {
      const page = document.createElement("div");
      page.className = "musescore-page";
      page.innerHTML = svgString;
      container.appendChild(page);
    });
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

function detectNote(audioBuffer, timeInSeconds, duration) {
    const sampleRate = audioBuffer.sampleRate;
    const windowSize = 8192;
    
    const timingLeeway = 0.075;
    const skipStart = duration * 0.23 + timingLeeway;
    
    const startSample = Math.floor((timeInSeconds + skipStart) * sampleRate);
    const endSample = Math.min(startSample + windowSize, audioBuffer.length);
    
    if (startSample >= audioBuffer.length) return null;
    
    const channelData = audioBuffer.getChannelData(0);
    let slice = channelData.slice(startSample, endSample);
    
    let filtered = new Float32Array(slice.length);
    let prevSample = 0;
    const alpha = 0.95;
    for (let i = 0; i < slice.length; i++) {
        filtered[i] = alpha * (filtered[i-1] || 0) + alpha * (slice[i] - prevSample);
        prevSample = slice[i];
    }
    slice = filtered;
    
    const rms = Math.sqrt(slice.reduce((sum, val) => sum + val * val, 0) / slice.length);
    if (rms < 0.0008) return null;
    
    const detector = PitchDetector.forFloat32Array(slice.length);
    const [freq, clarity] = detector.findPitch(slice, sampleRate);
    
    if (freq && Math.abs(freq - 375) < 30) return null;
    
    if (!freq || clarity < 0.35) return null;
    return freq;
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
    
    // Use the tempo locked in when recording started. MIDI note.time is in the
    // source file's original seconds, so it cannot be used after a BPM change.
    const analysisBpm = recordingBpm ?? getCurrentBpm();
    const secondsPerBeat = 60 / analysisBpm;

    for (let i = 0; i < midiNotesData.length; i++) {
        const midiNote = midiNotesData[i];
        const startBeat = Number.isFinite(midiNote.startBeat) ? midiNote.startBeat : null;
        const durationBeats = Number.isFinite(midiNote.durationBeats)
          ? midiNote.durationBeats
          : midiNote.duration / (60 / (midiBpm ?? analysisBpm));
        const time = startBeat !== null
          ? startBeat * secondsPerBeat
          : midiNote.time * ((midiBpm ?? analysisBpm) / analysisBpm);
        const duration = durationBeats * secondsPerBeat;
        
        let midiNoteName = Array.isArray(midiNote.note)
            ? midiNote.note[midiNote.note.length - 1]
            : midiNote.note;
        
        if (midiNoteName === "rest") continue;
        
        let detectedFreq = detectNote(recordingBuffer, time, duration);
        
        const position = midiNote.startBeat !== undefined
          ? getScorePositionFromBeat(midiNote.startBeat, midiTimeSignatures)
          : getScorePosition(time, analysisBpm, midiTimeSignatures);

        if (!detectedFreq) {
            document.getElementById("output").innerText += `Measure ${position.measureNumber}, Beat ${position.beat.toFixed(1)}: No pitch detected\n`;
            continue;
        }
        
        const expectedFreq = Frequency(midiNoteName).toFrequency();
        const centsOff = 1200 * Math.log2(detectedFreq / expectedFreq);
        
        if (Math.abs(centsOff) > 50) {
            const direction = centsOff > 0 ? "sharp" : "flat";
            document.getElementById("output").innerText += `Measure ${position.measureNumber}, Beat ${position.beat.toFixed(1)}: ${Math.abs(centsOff).toFixed(0)} cents too ${direction} (Expected: ${midiNoteName})\n`;
            console.log(`${centsOff.toFixed(0)} cents ${direction}: Detected ${detectedFreq.toFixed(1)}Hz, Expected ${expectedFreq.toFixed(1)}Hz`);
        } else {
            console.log(`In tune: ${detectedFreq.toFixed(1)}Hz`);
        }
    }
    document.getElementById("output").innerText += '\nAnalysis complete. Remember that 100 cents is one semitone.\nIf you see no messages, you were in tune the whole time :)\n If not, don\'t be discouraged! Practice makes perfect, and practicing with OnSight might make more than perfect...';
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

function playClickAt(startTime) {
    const o = ctx.createOscillator();
    const gain = ctx.createGain();
    o.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.02);
    o.type = "sine";
    o.frequency.value = 375;
    o.start(startTime);
    o.stop(startTime + 0.02);
}

function click() {
    playClickAt(ctx.currentTime);
}

function scheduleMetronomeClicks() {
    const bpm = getCurrentBpm();
    const secondsPerBeat = 60 / bpm;

    while (nextMetronomeClickTime < ctx.currentTime + metronomeScheduleAheadSeconds) {
        playClickAt(nextMetronomeClickTime);
        nextMetronomeClickTime += secondsPerBeat;
    }

    metInterval = setTimeout(scheduleMetronomeClicks, metronomeLookAheadMs);
}

function startMet() {
    if (ctx.state === "suspended") ctx.resume();
    clearTimeout(metInterval);
    nextMetronomeClickTime = ctx.currentTime;
    scheduleMetronomeClicks();
    startMetronome.disabled = true;
    stopMetronome.disabled = false;
}

function stopMet() {
    clearTimeout(metInterval);
    metInterval = null;
    startMetronome.disabled = false;
    stopMetronome.disabled = true;
}

function playPracticeNoteAt(noteName, startTime, duration) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = Frequency(noteName).toFrequency();
  oscillator.connect(gain);
  gain.connect(ctx.destination);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(0.12, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.max(0.03, duration));
  oscillator.start(startTime);
  oscillator.stop(startTime + Math.max(0.04, duration) + 0.02);

  practiceOscillators.push(oscillator);
  oscillator.onended = () => {
    practiceOscillators = practiceOscillators.filter((item) => item !== oscillator);
  };
}

function finishPracticeTrack() {
  practiceTrackStopTimer = null;
  practiceOscillators = [];
  playPracticeTrackBtn.disabled = midiNotesData === null || midiNotesData.length === 0;
  stopPracticeTrackBtn.disabled = true;
}

async function startPracticeTrack() {
  if (!midiNotesData || midiNotesData.length === 0) {
    alert("Please upload a MIDI file before starting the practice track.");
    return;
  }

  stopPracticeTrack();
  if (ctx.state === "suspended") await ctx.resume();

  const bpm = getCurrentBpm();
  const secondsPerBeat = 60 / bpm;
  const startTime = ctx.currentTime + 0.08;
  let trackEnd = 0;

  midiNotesData.forEach((note) => {
    const noteName = Array.isArray(note.note) ? note.note[note.note.length - 1] : note.note;
    if (!noteName || noteName === "rest") return;

    const startBeat = Number.isFinite(note.startBeat)
      ? note.startBeat
      : note.time / (60 / (midiBpm ?? bpm));
    const durationBeats = Number.isFinite(note.durationBeats)
      ? note.durationBeats
      : note.duration / (60 / (midiBpm ?? bpm));
    const duration = Math.max(0.05, durationBeats * secondsPerBeat);

    playPracticeNoteAt(noteName, startTime + startBeat * secondsPerBeat, duration);
    trackEnd = Math.max(trackEnd, (startBeat * secondsPerBeat) + duration);
  });

  playPracticeTrackBtn.disabled = true;
  stopPracticeTrackBtn.disabled = false;
  practiceTrackStopTimer = setTimeout(finishPracticeTrack, (trackEnd + 0.15) * 1000);
}

function stopPracticeTrack() {
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

function playStartingNoteAt(noteName, startTime, duration = 1) {
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = Frequency(noteName).toFrequency();
  gain.gain.setValueAtTime(0.5, startTime);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playStartingNote(noteName, duration = 1) {
  playStartingNoteAt(noteName, ctx.currentTime, duration);
}

function startRecording() {
    if (midiNotesData === null) {
        alert("Please upload a MIDI file before recording.");
        return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            document.getElementById("SheetMusic").scrollIntoView({
            behavior: "smooth",
            block: "start"
            });
            if (ctx.state === "suspended") {
                ctx.resume();
            }
            let countdownDiv = document.createElement('div');
            countdownDiv.id = 'countdown';
            countdownDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 120px; font-weight: bold; color: #6ac47e; z-index: 9999; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);';
            document.body.appendChild(countdownDiv);
            
            let count = 4;
            countdownDiv.innerText = count;
            const firstNote = Array.isArray(midiNotesData[0].note)
                    ? midiNotesData[0].note[midiNotesData[0].note.length - 1]
                : midiNotesData[0].note;
            
            const bpm = getCurrentBpm();
            recordingBpm = bpm;
            const secondsPerBeat = 60 / bpm;
            const firstClickTime = ctx.currentTime + 0.05;

            for (let beat = 0; beat < count; beat++) {
                playClickAt(firstClickTime + beat * secondsPerBeat);
            }
            playStartingNoteAt(firstNote, firstClickTime, 1);

            for (let beat = 1; beat < count; beat++) {
                setTimeout(() => {
                    countdownDiv.innerText = count - beat;
                }, beat * secondsPerBeat * 1000);
            }

            setTimeout(() => {
                countdownDiv.remove();
                
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
                startMet();
            }, count * secondsPerBeat * 1000);
        });
}

function stopRecording() {
    recorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    bpmInput.disabled = false;
    stopMet();
}

analyzeOutput.addEventListener("click", compareNotes);

document.getElementById("midiFile").addEventListener("change", async () => {
  console.log("File selected! Processing as we speak...");
  await processAndRender();
});
