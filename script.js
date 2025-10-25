import Vex from "https://cdn.skypack.dev/vexflow";
import { Midi } from "https://cdn.skypack.dev/@tonejs/midi";
import { PitchDetector } from 'https://esm.sh/pitchy';
import { Frequency } from "https://cdn.skypack.dev/tone";
const recordBtn = document.getElementById("record");
const stopBtn = document.getElementById("stop");
const player = document.getElementById("player");
const startMetronome = document.getElementById("startMetronome");
const stopMetronome = document.getElementById("stopMetronome");
const analyzeOutput = document.getElementById("analyze");
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
let midiNotesData = null; // ADD THIS - store parsed notes globally

function getLineAndBeat(time, bpm) { //function to get line and beat from time and bpm
    const quarter = 60/bpm;
    const beatsFromStart = time / quarter;
    const measure = Math.floor(beatsFromStart / 4) + 1; // 4 beats per measure
    const beat = (beatsFromStart % 4) + 1;
    return { line: measure, beat };
}

async function getTotalBeats() { //function to get total beats from midi notes
    let totalBeats = 0;
    const notes = await convertAllNotes();
    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        totalBeats += durationToBeats(note.duration);
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
    
    // ADD OCT 24: filter to remove metronome clicks
    let filtered = new Float32Array(slice.length);
    let prevSample = 0;
    const alpha = 0.95; // High-pass filter coefficient
    for (let i = 0; i < slice.length; i++) {
        filtered[i] = alpha * (filtered[i-1] || 0) + alpha * (slice[i] - prevSample);
        prevSample = slice[i];
    }
    slice = filtered;
    
    const rms = Math.sqrt(slice.reduce((sum, val) => sum + val * val, 0) / slice.length);
    if (rms < 0.0008) return null; // CHANGED: Lower from 0.002 to 0.0008
    
    const detector = PitchDetector.forFloat32Array(slice.length);
    const [freq, clarity] = detector.findPitch(slice, sampleRate);
    
    // ADD: Reject if detected frequency is too close to metronome (375Hz)
    if (freq && Math.abs(freq - 375) < 30) return null;
    
    if (!freq || clarity < 0.35) return null; // CHANGED: Lower from 0.5 to 0.35
    return freq;
}

async function compareNotes() {
    const res = await fetch(player.src);
    const arrayBuffer = await res.arrayBuffer();
    const recordingBuffer = await ctx.decodeAudioData(arrayBuffer);

    document.getElementById("output").innerText = "";
    
    for (let i = 0; i < midiNotesData.length; i++) {
        const midiNote = midiNotesData[i];
        let time = midiNote.time;
        
        let midiNoteName = Array.isArray(midiNote.note)
            ? midiNote.note[midiNote.note.length - 1]
            : midiNote.note;
        
        if (midiNoteName === "rest") continue;
        
        let detectedFreq = detectNote(recordingBuffer, time, midiNote.duration);
        
        if (!detectedFreq) {
            document.getElementById("output").innerText += `At line ${Math.ceil(getLineAndBeat(time,midiBpm).line / 4)} Measure ${((getLineAndBeat(time,midiBpm).line - 1) % 4) + 1}, Beat ${getLineAndBeat(time,midiBpm).beat.toFixed(1)}: No pitch detected\n`;
            continue;
        }
        
        const expectedFreq = Frequency(midiNoteName).toFrequency();
        const centsOff = 1200 * Math.log2(detectedFreq / expectedFreq);
        
        if (Math.abs(centsOff) > 80) {
            const direction = centsOff > 0 ? "sharp" : "flat";
            document.getElementById("output").innerText += `At line ${Math.ceil(getLineAndBeat(time,midiBpm).line / 4)} Measure ${((getLineAndBeat(time,midiBpm).line - 1) % 4) + 1}, Beat ${getLineAndBeat(time,midiBpm).beat.toFixed(1)}: ${Math.abs(centsOff).toFixed(0)} cents too ${direction} (Expected: ${midiNoteName})\n`;
            console.log(`${centsOff.toFixed(0)} cents ${direction}: Detected ${detectedFreq.toFixed(1)}Hz, Expected ${expectedFreq.toFixed(1)}Hz`);
        } else {
            console.log(`In tune: ${detectedFreq.toFixed(1)}Hz`);
        }
    }
}


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

  let melodyTrack = midi.tracks[0];
  if (midi.tracks.length > 1) {
    melodyTrack = midi.tracks.reduce((a, b) => 
      (a.notes.length > b.notes.length ? a : b) // FIX: choose track with MORE notes
    );
  }
  
  // Expand range or remove filter - typical vocal range is C3 to C6 (48 to 84 MIDI)
  const notes = melodyTrack.notes.filter(n => n.midi >= 48 && n.midi <= 84);
  const bpm = Math.round(midi.header.tempos.length > 0 ? midi.header.tempos[0].bpm : 120);

  let parsed = [];
  const quarter = 60 / bpm; 

  const timeGroups = {};
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const timeKey = n.time.toFixed(3);
    if (!timeGroups[timeKey]) timeGroups[timeKey] = [];
    timeGroups[timeKey].push(n);
  }
  
  const sortedTimes = Object.keys(timeGroups).map(Number).sort((a, b) => a - b);
  let prevEndTime = 0;
  
  for (let time of sortedTimes) {
    const group = timeGroups[time.toFixed(3)];
    const gap = time - prevEndTime;
    if (gap > quarter * 0.1 && prevEndTime > 0) {
      parsed.push({
        note: "rest",
        time: prevEndTime,
        duration: gap,
      });
    }

    let chosenNote = group[0];
    if (group.length > 1) {
      // FIX: Choose highest note (melody is typically on top)
      chosenNote = group.reduce((prev, curr) => 
        curr.midi > prev.midi ? curr : prev
      );
    }

    parsed.push({
      note: chosenNote.name,
      time: time,
      duration: chosenNote.duration,
      velocity: chosenNote.velocity,
    });

    prevEndTime = time + chosenNote.duration;
  }
  console.log({ bpm, notes: parsed });
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

  const groups = {};
  notes.forEach(note => {
    const quarter = 60 / bpm;
    const beatsFromStart = note.time / quarter;
    const t = Math.round(beatsFromStart * 4) / 4;
    if (!groups[t]) groups[t] = [];
    groups[t].push(note);
  });

  const afterNotes = Object.values(groups).map(group => {
    if (group[0].note === "rest") {
      const duration = getDuration(group[0].duration, bpm);
      return { keys: ["b/4"], duration: duration + "r" };
    }
    const n = group[0];
    const pitch = n.note.slice(0, -1).toLowerCase();
    const octave = n.note.slice(-1);
    return { 
      keys: [pitch + "/" + octave], 
      duration: getDuration(n.duration, bpm) 
    };
  });

  return afterNotes;
}





async function processAndRender() {
  const { bpm, notes } = await parseMidiFile();
  if (!notes) return; // Handle null case
  midiBpm = bpm; // store bpm for metronome
  midiNotesData = notes; // global var
  const convertedNotes = await convertAllNotes();
  drawStaff(convertedNotes);
  document.getElementById("bpm").value = midiBpm;
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
    const gain = ctx.createGain();
    o.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.25;
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

function playStartingNote(noteName, duration = 1) {
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = Frequency(noteName).toFrequency();
  gain.gain.setValueAtTime(0.5, ctx.currentTime);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
}

window.playStartingNote = function(noteName, duration = 1) {
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = Frequency(noteName).toFrequency();
  gain.gain.setValueAtTime(0.5, ctx.currentTime);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
};


function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            if (ctx.state === "suspended") {
                ctx.resume();
            }
            // Create countdown display
            let countdownDiv = document.createElement('div');
            countdownDiv.id = 'countdown';
            countdownDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 120px; font-weight: bold; color: #6ac47e; z-index: 9999; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);';
            document.body.appendChild(countdownDiv);
            
            let count = 4;
            countdownDiv.innerText = count;
            click();
            const firstNote = Array.isArray(midiNotesData[0].note)
                    ? midiNotesData[0].note[midiNotesData[0].note.length - 1]
                : midiNotesData[0].note;
                playStartingNote(firstNote, 1);
            
            // Play metronome clicks during countdown
            let bpm = midiBpm !== null ? midiBpm : parseInt(document.getElementById("bpm").value);
            let countdownInterval = setInterval(() => {
                click(); // metronome click
                count--;

                if (count > 0) {
                    countdownDiv.innerText = count;
                } else {
                    clearInterval(countdownInterval);
                    countdownDiv.remove();
                    
                    // Start actual recording after countdown
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
                    startMet();
                }
            }, (60 / bpm) * 1000); // one beat interval
        });
}

function stopRecording() {
    recorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    stopMet();
}

// FIX: add event listener for analyze button
analyzeOutput.addEventListener("click", compareNotes);

document.getElementById("midiFile").addEventListener("change", async () => {
  console.log("File selected! Processing as we speak...");
  processAndRender();
  const notes = await convertAllNotes();
  console.log(notes[4].duration);
  console.log(await getTotalBeats());
});
