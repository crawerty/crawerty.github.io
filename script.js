import Vex from "https://cdn.skypack.dev/vexflow";
import { Midi } from "https://cdn.skypack.dev/@tonejs/midi";
// import { PitchDetector } from 'https://esm.sh/pitchy'; // Not used currently
const recordBtn = document.getElementById("record");
const stopBtn = document.getElementById("stop");
const player = document.getElementById("player");
const startMetronome = document.getElementById("startMetronome");
const stopMetronome = document.getElementById("stopMetronome");
let recorder;
let audioChunks = [];
recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
let ctx = new AudioContext();
let metInterval;
recordBtn.disabled = false;
stopBtn.disabled = true;
startMetronome.addEventListener("click", startMet);
stopMetronome.addEventListener("click", stopMet);
stopMetronome.disabled = true;
let midiBpm = null;

function durationToBeats(d) {
  d = d.replace('r', ''); // handle rests
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



//Notes for Midi
//Needed functions: parseMidiFile(), convertNote(), drawStaff()
//Looping through data is essential because a MIDI file is basically a long list of note objects.
//MIDI libraries give you objects with properties like { name: "C4", duration: 0.5 }

//new Midi(arrayBuffer) to parse a MIDI file into a Midi object

//midi.tracks to get an array of tracks

//track.notes is to get an array of note objects in a track

//note.name is to get the note name (e.g. "C4")

//note.time is to get the start time in seconds (e.g. 1, 1.5)

//note.duration is to get the duration in seconds (e.g. 0.5)
//Convert note names to VexFlow format (e.g., "C4" to { keys: ["c/4"], duration: "q" })
//Draw staff using VexFlow's Renderer and Stave classes

async function parseMidiFile() {
  const file = document.getElementById("midiFile").files[0];
  if (!file) return null;
  const arrayBuffer = await file.arrayBuffer();
  const midi = new Midi(arrayBuffer);
  const notes = midi.tracks[0].notes;
  const bpm = midi.header.tempos.length > 0 ? midi.header.tempos[0].bpm : 120;

  let parsed = [];
  const quarter = 60 / bpm; 
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (i > 0) {
      const prev = notes[i - 1];
      const gap = n.time - (prev.time + prev.duration);
      if (gap > quarter * 0.1) { // more sensitive rest detection
        parsed.push({
          note: "rest",
          time: prev.time + prev.duration,
          duration: gap,
        });
      }
    }
    parsed.push({
      note: n.name,
      time: n.time,
      duration: n.duration,
      velocity: n.velocity,
    });
  }

  return { bpm, notes: parsed }; 
}



//notes for duration conversion
//quarter note = "q" = 60/bpm seconds
//half note = "h" = 120/bpm seconds
//whole note = "w" = 240/bpm seconds
//eighth note = "8" = 30/bpm seconds
//sixteenth note = "16" = 15/bpm seconds
//thirty-second note = "32" = 7.5/bpm seconds
//dotted notes add half the value of the original note (e.g., dotted quarter = 90/bpm seconds)

function getDuration(duration, bpm) {
  const quarter = 60 / bpm;
  const tolerance = quarter * 0.15; // relative tolerance
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
  return "q"; // jus in case
}


async function convertAllNotes() {
  const { bpm, notes } = await parseMidiFile();

  // Group notes by time
  const groups = {};
  notes.forEach(note => {
    const quarter = 60 / bpm;
    const beatsFromStart = note.time / quarter;
    const t = Math.round(beatsFromStart * 4) / 4; // quantize by beats not time
    if (!groups[t]) groups[t] = [];
    groups[t].push(note);
  });

  // Convert each group to a chord or rest
  const afterNotes = Object.values(groups).map(group => {
    if (group[0].note === "rest") {
      const duration = getDuration(group[0].duration, bpm);
      return { keys: ["b/4"], duration: duration + "r" };
    }
    
    const keys = group.filter(n => n.note !== "rest").map(n => {
      const pitch = n.note.slice(0, -1).toLowerCase();
      const octave = n.note.slice(-1);
      return pitch + "/" + octave;
    });

    const duration = getDuration(group[0].duration, bpm);
    return { keys, duration };
  });

  return afterNotes;
}




async function processAndRender() {
  const { bpm, notes } = await parseMidiFile();
  if (!notes) return; // Handle null case
  midiBpm = bpm; // store bpm for metronome
  const convertedNotes = await convertAllNotes();
  drawStaff(convertedNotes);
  document.getElementById("bpm").value = Math.round(midiBpm);
}

function drawStaff(notes) {
  const VF = Vex;
  const container = document.getElementById("staff");
  container.innerHTML = "";

  // Split notes into measures of ~4 beats
  let measures = [];
  let current = [];
  let totalBeats = 0;

  notes.forEach(n => {
    const beats = durationToBeats(n.duration);
    if (totalBeats + beats > 4) {
      // Pad current measure to exactly 4 beats before pushing
      while (totalBeats < 4) {
        const remaining = 4 - totalBeats;
        let restDuration;
        if (remaining >= 4) restDuration = "w";
        else if (remaining >= 2) restDuration = "h";
        else if (remaining >= 1) restDuration = "q";
        else if (remaining >= 0.5) restDuration = "8";
        else restDuration = "16";
        current.push({ keys: ["b/4"], duration: restDuration + "r" });
        totalBeats += durationToBeats(restDuration);
      }
      measures.push(current);
      current = [];
      totalBeats = 0;
    }
    current.push(n);
    totalBeats += beats;
  });
  // Pad last measure
  if (current.length > 0) {
    while (totalBeats < 4) {
      const remaining = 4 - totalBeats;
      let restDuration;
      if (remaining >= 4) restDuration = "w";
      else if (remaining >= 2) restDuration = "h";
      else if (remaining >= 1) restDuration = "q";
      else if (remaining >= 0.5) restDuration = "8";
      else restDuration = "16";
      current.push({ keys: ["b/4"], duration: restDuration + "r" });
      totalBeats += durationToBeats(restDuration);
    }
    measures.push(current);
  }

  // Calculate how many measures fit per line and total height needed
  const measuresPerLine = 4;
  const lineHeight = 200;
  const numLines = Math.ceil(measures.length / measuresPerLine);
  
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(1400, numLines * lineHeight + 50);
  const context = renderer.getContext();

  // Render measures with line wrapping
  let x = 10;
  let y = 40;
  measures.forEach((measure, i) => {
    const isFirstInLine = i % measuresPerLine === 0;
    const isSecondInLine = i % measuresPerLine === 1;
    const isFourthInLine = i % measuresPerLine === 3;

    // Start new line if we've hit the limit
    if (i > 0 && isFirstInLine) {
      x = 10;
      y += lineHeight;
    }

    const staveWidth = isFirstInLine ? 350 : 330;
    const formatWidth = isFirstInLine ? 280 : (isSecondInLine ? 310 : (isFourthInLine ? 310 : 310));

    const stave = new VF.Stave(x, y, staveWidth);
    if (isFirstInLine) {
      stave.addClef("treble").addTimeSignature("4/4");
    }
    stave.setContext(context).draw();

    const vexNotes = measure.map(n => new VF.StaveNote({
      clef: "treble",
      keys: n.keys,
      duration: n.duration
    }));

    const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
    voice.addTickables(vexNotes);

    new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);
    voice.draw(context, stave);

    x += isFirstInLine ? 350 : 330;
  });
}



function click() {
    const o = ctx.createOscillator();
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.02);
    o.type = "sine";
    o.frequency.value = 375;
}

function startMet() {
    let bpm = midiBpm !== null ? midiBpm : parseInt(document.getElementById("bpm").value);
    metInterval = setInterval(click, (60 / bpm) * 1000);
    startMetronome.disabled = true;
    stopMetronome.disabled = false;
}

function stopMet() {
    clearInterval(metInterval);
    startMetronome.disabled = false;
    stopMetronome.disabled = true;
}

function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            recorder = new MediaRecorder(stream);
            recorder.ondataavailable = event => {
                audioChunks.push(event.data);
            };
            recorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: "audio/wav" });
                const audioUrl = URL.createObjectURL(audioBlob);
                player.src = audioUrl;
                audioChunks = [];
            };
            recorder.start();
            recordBtn.disabled = true;
            stopBtn.disabled = false;
        });
}

function stopRecording() {
    recorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
}

document.getElementById("midiFile").addEventListener("change", () => {
  console.log("File selected! Processing...");
  processAndRender();
});
