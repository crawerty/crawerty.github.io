import Vex from "https://cdn.skypack.dev/vexflow";
import { Midi } from "https://cdn.skypack.dev/@tonejs/midi";
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

//note.name is to get the note name (e.g., "C4")

//note.time is to get the start time in seconds (e.g., 1.5)

//note.duration is to get the duration in seconds (e.g., 0.5)
//Convert note names to VexFlow format (e.g., "C4" to { keys: ["c/4"], duration: "q" })
//Draw staff using VexFlow's Renderer and Stave classes

async function parseMidiFile() {
  const file = document.getElementById("midiFile").files[0];
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
      if (gap > quarter*0.9) {
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
  const half = quarter * 2;
  const whole = quarter * 4;
  const eighth = quarter / 2;
  const sixteenth = quarter / 4;
  if (Math.abs(duration - whole) < 0.1) return "w";
  if (Math.abs(duration - half) < 0.1) return "h";
  if (Math.abs(duration - (half * 1.5)) < 0.1) return "hd";
  if (Math.abs(duration - quarter) < 0.1) return "q";
  if (Math.abs(duration - (quarter * 1.5)) < 0.1) return "qd";
  if (Math.abs(duration - eighth) < 0.1) return "8";
  if (Math.abs(duration - (eighth * 1.5)) < 0.1) return "8d";
  if (Math.abs(duration - sixteenth) < 0.1) return "16";
  if (Math.abs(duration - (sixteenth * 1.5)) < 0.1) return "16d";
  return "q"; // jus in case
}


async function convertAllNotes() {
  const { bpm, notes } = await parseMidiFile();

  // Group notes by time
  const groups = {};
  notes.forEach(note => {
    const t = Math.round(note.time * 4) / 4; // quantize to nearest quarter beat
    if (!groups[t]) groups[t] = [];
    groups[t].push(note);
  });

  // Convert each group to a chord
  const afterNotes = Object.values(groups).map(group => {
    const keys = group.map(n => {
      if (n.note === "rest") return "b/4"; // handle rests
      const pitch = n.note.slice(0, -1).toLowerCase();
      const octave = n.note.slice(-1);
      return pitch + "/" + octave;
    });

    const duration = getDuration(group[0].duration, bpm);
    const finalDuration = group[0].note === "rest" ? duration + "r" : duration;

    return { keys, duration: finalDuration };
  });

  return afterNotes;
}




async function processAndRender() {
  // updated to use bpm + notes destructuring
  const { bpm, notes } = await parseMidiFile();
  const convertedNotes = await convertAllNotes();
  drawStaff(convertedNotes);
}

function drawStaff(notes) {
  const VF = Vex;
  const container = document.getElementById("staff");
  container.innerHTML = "";

  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(800, 200);
  const context = renderer.getContext();

  const stave = new VF.Stave(10, 40, 700);
  stave.addClef("treble").addTimeSignature("4/4");
  stave.setContext(context).draw();

  // Split notes into measures of ~4 beats
  let measures = [];
  let current = [];
  let totalBeats = 0;

  notes.forEach(n => {
    const beats = durationToBeats(n.duration);
    if (totalBeats + beats > 4) {
      measures.push(current);
      current = [];
      totalBeats = 0;
    }
    current.push(n);
    totalBeats += beats;
  });
  if (current.length > 0) measures.push(current);

  // Render each measure separately
  let x = 10;
  measures.forEach(measure => {
    const stave = new VF.Stave(x, 40, 150);
    stave.setContext(context).draw();

    const vexNotes = measure.map(n => new VF.StaveNote({
      clef: "treble",
      keys: n.keys,
      duration: n.duration
    }));

    const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
    voice.addTickables(vexNotes);

    new VF.Formatter().joinVoices([voice]).format([voice], 120);
    voice.draw(context, stave);

    x += 160; // move the next stave to the right
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


document.getElementById("midiFile").addEventListener("change", () => {
  processAndRender();
});
