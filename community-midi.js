// This is a publishable browser key. Row Level Security, rather than secrecy,
// determines what the website is allowed to read or change.
const SUPABASE_URL = "https://wskthkxdubkbmsnatncf.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Mun7Ed2gUD_FzujLq2v5zQ_umb0D6XZ";
const LIBRARY_BUCKET = "midi-submissions";

const library = document.getElementById("midiLibrary");
const catalogCount = document.getElementById("catalogCount");
const librarySearch = document.getElementById("librarySearch");
const showMoreFiles = document.getElementById("showMoreFiles");
const submissionForm = document.getElementById("midiSubmissionForm");
const submissionStatus = document.getElementById("submissionStatus");
const initialLibrarySize = 10;
const moreLibrarySize = 15;
let libraryFiles = [];
let visibleFileCount = initialLibrarySize;

function encodeStoragePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function renderFiles(files) {
  if (!files.length) {
    library.innerHTML = '<p class="library-empty">No approved MIDI files yet. Check back soon.</p>';
    return;
  }

  library.innerHTML = files.map((file) => {
    const title = escapeHtml(file.title || "Untitled MIDI");
    const part = escapeHtml(file.part || "Practice part");
    const composer = escapeHtml(file.composer || "Community submission");
    // The current Supabase column is named "storage path" (with a space).
    const path = encodeURIComponent(file["storage path"] || "");
    const disabled = path ? "" : "disabled";

    return `<article class="midi-card">
      <div class="midi-icon" aria-hidden="true">♫</div>
      <div class="midi-info">
        <p class="panel-label">${part}</p>
        <h3>${title}</h3>
        <p>${composer}</p>
      </div>
      <button class="button-link download-midi" type="button" data-path="${path}" ${disabled}>Download MIDI</button>
    </article>`;
  }).join("");
}

function renderLibrary() {
  const query = librarySearch.value.trim().toLowerCase();
  const matchingFiles = libraryFiles.filter((file) => [file.title, file.part, file.composer]
    .some((value) => String(value ?? "").toLowerCase().includes(query))
  );
  const visibleFiles = matchingFiles.slice(0, visibleFileCount);
  const matchingLabel = `${matchingFiles.length} ${matchingFiles.length === 1 ? "file" : "files"}`;

  catalogCount.textContent = query ? `${matchingLabel} found` : matchingLabel;
  renderFiles(visibleFiles);

  const remaining = matchingFiles.length - visibleFiles.length;
  showMoreFiles.hidden = remaining <= 0;
  if (remaining > 0) {
    showMoreFiles.innerHTML = `Show ${Math.min(moreLibrarySize, remaining)} more <span aria-hidden="true">↓</span>`;
  }
}

async function loadLibrary() {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/midi_files?select=title,part,composer,%22storage%20path%22,status&status=eq.approved&order=created_at.desc`,
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` } }
    );
    if (!response.ok) throw new Error(`Library request failed (${response.status})`);
    libraryFiles = await response.json();
    renderLibrary();
  } catch (error) {
    console.error(error);
    catalogCount.textContent = "Library unavailable";
    library.innerHTML = '<p class="library-empty">The practice library could not load. Please try again shortly.</p>';
  }
}

library?.addEventListener("click", async (event) => {
  const button = event.target.closest(".download-midi");
  if (!button?.dataset.path) return;

  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${LIBRARY_BUCKET}/${button.dataset.path}`,
      { method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }) }
    );
    if (!response.ok) throw new Error("Could not create download link");
    const { signedURL } = await response.json();
    window.location.assign(`${SUPABASE_URL}/storage/v1${signedURL}`);
  } catch (error) {
    console.error(error);
    button.textContent = "Download unavailable";
  } finally {
    button.disabled = false;
    window.setTimeout(() => { if (button.isConnected) button.textContent = "Download MIDI"; }, 2500);
  }
});

librarySearch?.addEventListener("input", () => {
  visibleFileCount = initialLibrarySize;
  renderLibrary();
});

showMoreFiles?.addEventListener("click", () => {
  visibleFileCount += moreLibrarySize;
  renderLibrary();
});

submissionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = document.getElementById("submissionTitle").value.trim();
  const part = document.getElementById("submissionPart").value.trim();
  const composer = submissionForm.elements.credit.value.trim();
  const file = document.getElementById("submissionFile").files[0];
  const submitButton = submissionForm.querySelector('button[type="submit"]');

  if (!file) return;
  if (!/\.(mid|midi)$/i.test(file.name)) {
    submissionStatus.textContent = "Please choose a MIDI file ending in .mid or .midi.";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    submissionStatus.textContent = "Please choose a MIDI file smaller than 5 MB.";
    return;
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
  const uploadId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storagePath = `pending/${uploadId}-${safeName}`;

  submitButton.disabled = true;
  submissionStatus.textContent = "Uploading your MIDI for review…";
  try {
    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${LIBRARY_BUCKET}/${encodeStoragePath(storagePath)}`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "Content-Type": file.type || "audio/midi",
          "x-upsert": "false"
        },
        body: file
      }
    );
    if (!uploadResponse.ok) throw new Error(`File upload failed (${uploadResponse.status})`);

    const rowResponse = await fetch(`${SUPABASE_URL}/rest/v1/midi_files`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ title, part, composer: composer || null, "storage path": storagePath, status: "pending" })
    });
    if (!rowResponse.ok) throw new Error(`Submission record failed (${rowResponse.status})`);

    submissionForm.reset();
    submissionStatus.textContent = "Submitted for review. It will appear in the library after approval.";
  } catch (error) {
    console.error(error);
    submissionStatus.textContent = "Upload could not be completed. Please try again shortly.";
  } finally {
    submitButton.disabled = false;
  }
});

loadLibrary();
