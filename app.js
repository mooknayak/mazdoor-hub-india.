// ============================================================
// Mazdoor Hub India — app.js
// Firebase v9 (modular SDK, loaded via CDN — no npm/build step needed)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ============================================================
// 1. FIREBASE CONFIG — paste your own config here
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBGjD-f_NnLlrKzRxuVZlGZrFrFJmLN7Dc",
  authDomain: "mazdoor-hub-india.firebaseapp.com",
  projectId: "mazdoor-hub-india",
  storageBucket: "mazdoor-hub-india.firebasestorage.app",
  messagingSenderId: "288623943980",
  appId: "1:288623943980:web:625253bab263bf622fcc89"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// ============================================================
// 2. SHARED HELPERS (used by both index.html and admin.html)
// ============================================================
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

const CATS = {
  Construction: ["Mason", "Helper Mason", "Plumber", "Electrician", "Painter", "Carpenter"],
  Agriculture: ["Farm Labor (Male)", "Farm Labor (Female)", "Tractor Driver", "Gardener"],
  "Domestic-Office": ["Office Boy", "Security Guard", "Driver", "House Helper"]
};

function fillMainCatOptions(selectEl) {
  selectEl.innerHTML = '<option value="">-- Select --</option>';
  for (const k in CATS) {
    selectEl.innerHTML += `<option value="${k}">${k}</option>`;
  }
}

function fillSubCatOptions(mainVal, subSelectEl, allOption) {
  subSelectEl.innerHTML = allOption ? '<option value="">All</option>' : '<option value="">-- Select --</option>';
  if (CATS[mainVal]) {
    CATS[mainVal].forEach((c) => {
      subSelectEl.innerHTML += `<option value="${c}">${c}</option>`;
    });
  }
}

function uploadFiles(fileInputId, folder, uid) {
  const files = document.getElementById(fileInputId).files;
  if (files.length === 0) return Promise.resolve(null);
  const promises = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.size > MAX_FILE_SIZE) {
      return Promise.reject(new Error(`${file.name} is larger than 5MB.`));
    }
    const path = `${folder}/${uid}/${Date.now()}_${i}_${file.name}`;
    const fileRef = ref(storage, path);
    promises.push(uploadBytes(fileRef, file).then((snap) => getDownloadURL(snap.ref)).then((url) => ({ url, path })));
  }
  return Promise.all(promises);
}

// Normalizes older records where wurl/vurl were plain URL strings (no path)
// into the newer { url, path } object form used for individual deletion.
function normalizeMediaArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => (typeof item === "string" ? { url: item, path: null } : item));
}

function deleteStorageFile(path) {
  if (!path) return Promise.resolve(); // older items with no known path can't be removed from Storage, only from the list
  return deleteObject(ref(storage, path)).catch((err) => {
    console.error("Storage delete error (continuing anyway):", err);
  });
}

let recaptchaVerifier = null;
function initRecaptcha(containerId) {
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
  }
  return recaptchaVerifier;
}

// ===== In-page media lightbox (used by search result galleries) =====
window.openMediaModal = function (url, kind) {
  const modal = document.getElementById("media-modal");
  const body = document.getElementById("media-modal-body");
  if (!modal || !body) return;
  body.innerHTML =
    kind === "video"
      ? `<video src="${escHtml(url)}" controls autoplay style="max-width:92vw; max-height:82vh;"></video>`
      : `<img src="${escHtml(url)}" style="max-width:92vw; max-height:82vh;" />`;
  modal.style.display = "flex";
};

window.closeMediaModal = function () {
  const modal = document.getElementById("media-modal");
  const body = document.getElementById("media-modal-body");
  if (!modal || !body) return;
  modal.style.display = "none";
  body.innerHTML = ""; // stops any playing video
};

// ============================================================
// 3. USER SIDE — index.html (registration / update profile / search)
// ============================================================
let currentUid = null;
let confirmationResult = null;
let existingUrls = { purl: null, purlPath: null, wurl: [], vurl: [] };

function initUserPage() {
  const regPhoneEl = document.getElementById("reg-phone");
  if (!regPhoneEl) return; // Not on index.html, skip

  window.showMazdoorForm = function () {
    document.getElementById("mazdoor-form-root").style.display = "block";
  };

  document.getElementById("send-otp-btn").addEventListener("click", sendOtp);
  document.getElementById("verify-otp-btn").addEventListener("click", verifyOtp);
  document.getElementById("submit-btn").addEventListener("click", submitProfile);
  document.getElementById("search-btn").addEventListener("click", runSearch);

  document.getElementById("f-maincat").addEventListener("change", function () {
    fillSubCatOptions(this.value, document.getElementById("f-subcat"), false);
  });
  document.getElementById("s-maincat").addEventListener("change", function () {
    fillSubCatOptions(this.value, document.getElementById("s-subcat"), true);
  });

  const sMainSel = document.getElementById("s-maincat");
  fillMainCatOptions(sMainSel);
  sMainSel.insertAdjacentHTML("afterbegin", '<option value="">All Categories</option>');

  async function sendOtp() {
    const phone = regPhoneEl.value.trim();
    if (!/^[0-9]{10}$/.test(phone)) {
      alert("Please enter a valid 10-digit mobile number.");
      return;
    }
    const btn = document.getElementById("send-otp-btn");
    const status = document.getElementById("otp-status-msg");
    btn.disabled = true;
    btn.innerText = "Sending...";
    status.style.color = "#777";
    status.innerText = "";

    try {
      const verifier = initRecaptcha("recaptcha-container");
      confirmationResult = await signInWithPhoneNumber(auth, "+91" + phone, verifier);
      document.getElementById("otp-input-area").style.display = "block";
      btn.innerText = "Resend OTP";
      btn.disabled = false;
      status.style.color = "green";
      status.innerText = "OTP sent — please check your SMS.";
    } catch (err) {
      status.style.color = "red";
      status.innerText = `Error: ${err.message} (code: ${err.code})`;
      btn.disabled = false;
      btn.innerText = "Send OTP";
      console.error("OTP send error:", err);
    }
  }

  async function verifyOtp() {
    const code = document.getElementById("otp-code").value.trim();
    if (!code) { alert("Please enter the OTP."); return; }
    if (!confirmationResult) { alert("Please send the OTP first."); return; }

    try {
      const result = await confirmationResult.confirm(code);
      currentUid = result.user.uid;
      document.getElementById("otp-step").style.display = "none";
      document.getElementById("profile-form-area").style.display = "block";
      fillMainCatOptions(document.getElementById("f-maincat"));
      await loadExistingProfile();
    } catch (err) {
      alert("Incorrect OTP: " + err.message);
      console.error("OTP verify error:", err);
    }
  }

  async function loadExistingProfile() {
    const hint = document.getElementById("mode-hint");
    const snap = await getDoc(doc(db, "workers", currentUid));
    if (snap.exists()) {
      const d = snap.data();
      hint.innerText = "Your existing profile was found — update your details below.";
      document.getElementById("f-name").value = d.name || "";
      document.getElementById("f-state").value = d.state || "";
      document.getElementById("f-dist").value = d.dist || "";
      document.getElementById("f-pin").value = d.pin || "";
      document.getElementById("f-exp").value = d.exp || "";
      document.getElementById("f-min").value = d.min || "";
      document.getElementById("f-max").value = d.max || "";
      document.getElementById("f-basis").value = d.basis || "Daily";
      document.getElementById("f-status").value = d.status || "Available";
      if (d.mainCat) {
        document.getElementById("f-maincat").value = d.mainCat;
        fillSubCatOptions(d.mainCat, document.getElementById("f-subcat"), false);
        document.getElementById("f-subcat").value = d.subCat || "";
      }
      existingUrls.purl = d.purl || null;
      existingUrls.purlPath = d.purlPath || null;
      existingUrls.wurl = normalizeMediaArray(d.wurl);
      existingUrls.vurl = normalizeMediaArray(d.vurl);
      renderProfilePhotoBox();
      renderMediaGallery("existing-work-photos", "wurl", "image");
      renderMediaGallery("existing-work-videos", "vurl", "video");
    } else {
      hint.innerText = "Creating a new profile — please fill in all details.";
      renderProfilePhotoBox();
      renderMediaGallery("existing-work-photos", "wurl", "image");
      renderMediaGallery("existing-work-videos", "vurl", "video");
    }
  }

  function renderProfilePhotoBox() {
    const box = document.getElementById("existing-profile-photo");
    if (!box) return;
    if (existingUrls.purl) {
      box.innerHTML = `
        <div class="d-flex align-items-center gap-2 mb-2">
          <img src="${escHtml(existingUrls.purl)}" class="profile-thumb" />
          <button type="button" class="btn btn-sm btn-outline-danger" id="remove-purl-btn">Remove Photo</button>
        </div>`;
      document.getElementById("remove-purl-btn").addEventListener("click", async () => {
        await deleteStorageFile(existingUrls.purlPath);
        existingUrls.purl = null;
        existingUrls.purlPath = null;
        renderProfilePhotoBox();
      });
    } else {
      box.innerHTML = "";
    }
  }

  function renderMediaGallery(containerId, type, kind) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = "";
    existingUrls[type].forEach((item, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "gallery-edit-item";
      wrap.innerHTML =
        kind === "image"
          ? `<img src="${escHtml(item.url)}" class="gallery-edit-thumb" />`
          : `<video src="${escHtml(item.url)}" class="gallery-edit-thumb" controls></video>`;
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "gallery-edit-del";
      delBtn.innerText = "✕";
      delBtn.addEventListener("click", async () => {
        await deleteStorageFile(item.path);
        existingUrls[type].splice(idx, 1);
        renderMediaGallery(containerId, type, kind);
      });
      wrap.appendChild(delBtn);
      box.appendChild(wrap);
    });
    const countLabel = document.getElementById(containerId + "-count");
    if (countLabel) {
      const max = type === "wurl" ? 10 : 5;
      countLabel.innerText = `${existingUrls[type].length} / ${max}`;
    }
  }

  async function submitProfile() {
    const name = document.getElementById("f-name").value.trim();
    const mainCat = document.getElementById("f-maincat").value;
    const subCat = document.getElementById("f-subcat").value;
    const consent = document.getElementById("f-consent").checked;

    if (!name) { alert("Name is required."); return; }
    if (!mainCat || !subCat) { alert("Please select a category."); return; }
    if (!consent) { alert("Please check the consent box."); return; }

    // ===== Enforce media limits: max 10 work photos, max 5 work videos =====
    const newPhotoCount = document.getElementById("f-wfile").files.length;
    const newVideoCount = document.getElementById("f-vfile").files.length;
    const totalPhotosAfter = existingUrls.wurl.length + newPhotoCount;
    const totalVideosAfter = existingUrls.vurl.length + newVideoCount;

    if (totalPhotosAfter > 10) {
      alert(
        `You can have a maximum of 10 work photos. You currently have ${existingUrls.wurl.length} saved ` +
        `and are trying to add ${newPhotoCount} more (total ${totalPhotosAfter}). ` +
        `Please delete some existing photos above (✕) before adding new ones.`
      );
      return;
    }
    if (totalVideosAfter > 5) {
      alert(
        `You can have a maximum of 5 work videos. You currently have ${existingUrls.vurl.length} saved ` +
        `and are trying to add ${newVideoCount} more (total ${totalVideosAfter}). ` +
        `Please delete some existing videos above (✕) before adding new ones.`
      );
      return;
    }

    const btn = document.getElementById("submit-btn");
    btn.disabled = true;
    btn.innerText = "Submitting...";

    try {
      const [purlResult, wurlResult, vurlResult] = await Promise.all([
        uploadFiles("f-pfile", "profiles", currentUid),
        uploadFiles("f-wfile", "work_photos", currentUid),
        uploadFiles("f-vfile", "work_videos", currentUid)
      ]);

      const data = {
        name,
        mob: document.getElementById("reg-phone").value.trim(),
        mainCat,
        subCat,
        state: document.getElementById("f-state").value.trim(),
        dist: document.getElementById("f-dist").value.trim(),
        pin: document.getElementById("f-pin").value.trim(),
        exp: document.getElementById("f-exp").value,
        basis: document.getElementById("f-basis").value,
        min: document.getElementById("f-min").value,
        max: document.getElementById("f-max").value,
        status: document.getElementById("f-status").value,
        purl: purlResult ? purlResult[0].url : existingUrls.purl,
        purlPath: purlResult ? purlResult[0].path : existingUrls.purlPath,
        wurl: wurlResult ? existingUrls.wurl.concat(wurlResult) : existingUrls.wurl,
        vurl: vurlResult ? existingUrls.vurl.concat(vurlResult) : existingUrls.vurl,
        updatedAt: serverTimestamp()
      };

      await setDoc(doc(db, "workers", currentUid), data, { merge: true });
      alert("Saved successfully!");
      location.reload();
    } catch (err) {
      alert("Error: " + err.message);
      btn.disabled = false;
      btn.innerText = "Submit";
      console.error("Submit error:", err);
    }
  }

  async function runSearch() {
    const display = document.getElementById("results-display");
    display.innerHTML = "<p class='text-center'>Searching...</p>";

    const state = document.getElementById("s-state").value.trim();
    const dist = document.getElementById("s-dist").value.trim();
    const mainCat = document.getElementById("s-maincat").value;
    const subCat = document.getElementById("s-subcat").value;
    const pin = document.getElementById("s-pin").value.trim();

    try {
      const constraints = [];
      if (state) constraints.push(where("state", "==", state));
      if (dist) constraints.push(where("dist", "==", dist));
      if (mainCat) constraints.push(where("mainCat", "==", mainCat));
      if (subCat) constraints.push(where("subCat", "==", subCat));
      if (pin) constraints.push(where("pin", "==", pin));

      const q = query(collection(db, "workers"), ...constraints);
      const snapshot = await getDocs(q);

      display.innerHTML = "";
      if (snapshot.empty) {
        display.innerHTML = "<p class='text-center'>No workers found.</p>";
        return;
      }

      snapshot.forEach((docSnap) => {
        const w = docSnap.data();
        const badgeIcon = w.badge === "Diamond" ? "💎" : w.badge === "Gold" ? "🥇" : "🥈";
        const photos = normalizeMediaArray(w.wurl);
        const videos = normalizeMediaArray(w.vurl);
        const galleryHtml = (photos.length || videos.length)
          ? `<div class="worker-gallery">
              ${photos.map((p) => `<img src="${escHtml(p.url)}" class="gallery-thumb" onclick="window.openMediaModal('${escHtml(p.url)}','image')" />`).join("")}
              ${videos.map((v) => `<div class="video-thumb" onclick="window.openMediaModal('${escHtml(v.url)}','video')">▶</div>`).join("")}
            </div>`
          : `<p class="hint small mb-0">No work photos/videos uploaded yet.</p>`;
        const card = document.createElement("div");
        card.className = "worker-id-card mb-3";
        card.innerHTML = `
          <div class="badge-corner">${badgeIcon}</div>
          <div class="id-header">
            <img class="profile-thumb" src="${escHtml(w.purl || "")}" onerror="this.style.visibility='hidden'" />
            <div><div class="w-name">${escHtml(w.name)}</div><div class="reg-id-box">ID: ${docSnap.id.slice(-6)}</div></div>
          </div>
          ${w.tag ? `<div class="admin-tag">${escHtml(w.tag)}</div>` : ""}
          <div class="w-cat">${escHtml(w.mainCat)} — ${escHtml(w.subCat)}</div>
          <div class="info-line"><b>Experience:</b> ${escHtml(w.exp)} years</div>
          <div class="info-line"><b>Rate:</b> ₹${escHtml(w.min)} - ₹${escHtml(w.max)} (${escHtml(w.basis)})</div>
          <div class="info-line"><b>Location:</b> ${escHtml(w.dist)}, ${escHtml(w.state)} - ${escHtml(w.pin)}</div>
          <div class="info-line"><b>Status:</b> ${escHtml(w.status)}</div>
          ${galleryHtml}
          <button class="call-btn" data-id="${docSnap.id}">📞 Reveal Number &amp; Call</button>
        `;
        card.querySelector(".call-btn").addEventListener("click", (e) => revealNumber(e.target));
        display.appendChild(card);
      });
    } catch (err) {
      display.innerHTML = `<p class="text-center text-danger">Error: ${escHtml(err.message)} (a Firestore composite index may be required — check the browser console for a link)</p>`;
      console.error("Search error:", err);
    }
  }

  async function revealNumber(btn) {
    const docId = btn.getAttribute("data-id");
    btn.innerText = "Loading...";
    try {
      const snap = await getDoc(doc(db, "workers", docId));
      const mob = snap.data().mob;
      const link = document.createElement("a");
      link.className = "call-btn";
      link.href = "tel:" + encodeURIComponent(mob);
      link.innerText = "📞 Call: " + mob;
      btn.replaceWith(link);
    } catch (err) {
      btn.innerText = "Could not load number";
      console.error("Reveal number error:", err);
    }
  }
}

// ============================================================
// 4. ADMIN SIDE — admin.html (login + worker list + badge update)
// ============================================================
// IMPORTANT: This client-side check is for UI convenience only.
// Real security MUST come from Firestore Security Rules that check
// whether request.auth.uid exists in an "admins" collection —
// otherwise anyone could bypass this page and write to Firestore directly.
let adminConfirmationResult = null;
let adminUid = null;

function initAdminPage() {
  const adminPhoneEl = document.getElementById("admin-phone");
  if (!adminPhoneEl) return; // Not on admin.html, skip

  document.getElementById("admin-send-otp-btn").addEventListener("click", adminSendOtp);
  document.getElementById("admin-verify-otp-btn").addEventListener("click", adminVerifyOtp);
  document.getElementById("admin-refresh-btn").addEventListener("click", loadWorkerList);

  async function adminSendOtp() {
    const phone = adminPhoneEl.value.trim();
    if (!/^[0-9]{10}$/.test(phone)) {
      alert("Please enter a valid 10-digit mobile number.");
      return;
    }
    const btn = document.getElementById("admin-send-otp-btn");
    const status = document.getElementById("admin-otp-status-msg");
    btn.disabled = true;
    btn.innerText = "Sending...";
    status.style.color = "#777";
    status.innerText = "";

    try {
      const verifier = initRecaptcha("recaptcha-container");
      adminConfirmationResult = await signInWithPhoneNumber(auth, "+91" + phone, verifier);
      document.getElementById("admin-otp-input-area").style.display = "block";
      btn.innerText = "Resend OTP";
      btn.disabled = false;
      status.style.color = "green";
      status.innerText = "OTP sent — please check your SMS.";
    } catch (err) {
      status.style.color = "red";
      status.innerText = `Error: ${err.message} (code: ${err.code})`;
      btn.disabled = false;
      btn.innerText = "Send OTP";
      console.error("Admin OTP send error:", err);
    }
  }

  async function adminVerifyOtp() {
    const code = document.getElementById("admin-otp-code").value.trim();
    if (!code) { alert("Please enter the OTP."); return; }
    if (!adminConfirmationResult) { alert("Please send the OTP first."); return; }

    try {
      const result = await adminConfirmationResult.confirm(code);
      adminUid = result.user.uid;

      // Check the "admins" collection to confirm this user is actually an admin.
      // Add your own UID here as a document: admins/{uid} => { role: "admin" }
      const adminDoc = await getDoc(doc(db, "admins", adminUid));
      if (!adminDoc.exists()) {
        alert("This number is not registered as an admin. Ask the site owner to add your UID to the 'admins' collection in Firestore.\n\nYour UID: " + adminUid);
        return;
      }

      document.getElementById("admin-login-card").style.display = "none";
      document.getElementById("admin-dashboard").style.display = "block";
      await loadWorkerList();
    } catch (err) {
      alert("Incorrect OTP: " + err.message);
      console.error("Admin OTP verify error:", err);
    }
  }

  async function loadWorkerList() {
    const listEl = document.getElementById("admin-worker-list");
    listEl.innerHTML = "<p class='text-center'>Loading...</p>";

    const state = document.getElementById("admin-filter-state").value.trim();
    const dist = document.getElementById("admin-filter-dist").value.trim();

    try {
      const constraints = [];
      if (state) constraints.push(where("state", "==", state));
      if (dist) constraints.push(where("dist", "==", dist));

      const q = query(collection(db, "workers"), ...constraints);
      const snapshot = await getDocs(q);

      listEl.innerHTML = "";
      if (snapshot.empty) {
        listEl.innerHTML = "<p class='text-center'>No workers found.</p>";
        return;
      }

      snapshot.forEach((docSnap) => {
        const w = docSnap.data();
        const col = document.createElement("div");
        col.className = "col-12 col-md-6 col-lg-4";
        col.innerHTML = `
          <div class="worker-id-card">
            <div class="w-name">${escHtml(w.name)}</div>
            <div class="w-cat">${escHtml(w.mainCat)} — ${escHtml(w.subCat)}</div>
            <div class="info-line"><b>Mobile:</b> ${escHtml(w.mob)}</div>
            <div class="info-line"><b>Location:</b> ${escHtml(w.dist)}, ${escHtml(w.state)}</div>
            <div class="info-line"><b>Current Badge:</b> ${escHtml(w.badge || "Silver")}</div>
            <div class="info-line"><b>Current Tag:</b> ${w.tag ? escHtml(w.tag) : "(none)"}</div>
            <div class="badge-btn-row">
              <button class="badge-btn silver ${w.badge === "Silver" || !w.badge ? "active-badge" : ""}" data-id="${docSnap.id}" data-badge="Silver">Silver</button>
              <button class="badge-btn gold ${w.badge === "Gold" ? "active-badge" : ""}" data-id="${docSnap.id}" data-badge="Gold">Gold</button>
              <button class="badge-btn diamond ${w.badge === "Diamond" ? "active-badge" : ""}" data-id="${docSnap.id}" data-badge="Diamond">Diamond</button>
            </div>
            <div class="input-group input-group-sm mt-2">
              <input type="text" class="form-control tag-input" placeholder="e.g. Verified, Top Rated, Blacklisted" value="${w.tag ? escHtml(w.tag) : ""}" maxlength="30" />
              <button class="btn btn-outline-primary set-tag-btn" data-id="${docSnap.id}">Set Tag</button>
              ${w.tag ? `<button class="btn btn-outline-secondary clear-tag-btn" data-id="${docSnap.id}">Clear</button>` : ""}
            </div>
          </div>
        `;
        col.querySelectorAll(".badge-btn").forEach((btn) => {
          btn.addEventListener("click", () => updateBadge(btn.getAttribute("data-id"), btn.getAttribute("data-badge")));
        });
        const tagInput = col.querySelector(".tag-input");
        col.querySelector(".set-tag-btn").addEventListener("click", (e) => {
          updateTag(e.target.getAttribute("data-id"), tagInput.value.trim());
        });
        const clearBtn = col.querySelector(".clear-tag-btn");
        if (clearBtn) {
          clearBtn.addEventListener("click", (e) => updateTag(e.target.getAttribute("data-id"), ""));
        }
        listEl.appendChild(col);
      });
    } catch (err) {
      listEl.innerHTML = `<p class="text-center text-danger">Error: ${escHtml(err.message)}</p>`;
      console.error("Admin list error:", err);
    }
  }

  async function updateBadge(workerId, newBadge) {
    try {
      await updateDoc(doc(db, "workers", workerId), { badge: newBadge });
      await loadWorkerList();
    } catch (err) {
      alert("Error updating badge: " + err.message);
      console.error("Badge update error:", err);
    }
  }

  async function updateTag(workerId, newTag) {
    try {
      await updateDoc(doc(db, "workers", workerId), { tag: newTag });
      await loadWorkerList();
    } catch (err) {
      alert("Error updating tag: " + err.message);
      console.error("Tag update error:", err);
    }
  }
}

// ============================================================
// 5. Run the correct init function depending on which page loaded
// ============================================================
initUserPage();
initAdminPage();
